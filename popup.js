/**
 * popup.js — Currency Converter Settings & Live Converter
 *
 * UI layout:
 *   • "My currencies" list — each row has an inline number input.
 *   • The OUTLINED row is the default source currency (saved to storage).
 *   • Clicking a row's badge/name → sets that row as the outlined default.
 *   • Typing in ANY row's input → converts to all other rows AND makes that
 *     row the outlined default (same concept, saves the separate selector).
 *   • ＋ Add currency → searchable dropdown of all remaining currencies.
 *   • Save → persists settings to chrome.storage.sync.
 *
 * Settings schema (chrome.storage.sync key "settings"):
 *   {
 *     autoDetect:       boolean   — auto-detect on pages
 *     defaultCurrency:  string    — ISO 4217 fallback + outline in list
 *     targetCurrencies: string[]  — ordered list shown in the list
 *   }
 */

"use strict";

// ── Currency metadata ─────────────────────────────────────────────────────────

const CURRENCY_DATA = {
  USD: { name: "US Dollar"          },
  EUR: { name: "Euro"               },
  GBP: { name: "British Pound"      },
  JPY: { name: "Japanese Yen"       },
  CAD: { name: "Canadian Dollar"    },
  AUD: { name: "Australian Dollar"  },
  CHF: { name: "Swiss Franc"        },
  ILS: { name: "Israeli Shekel"     },
  INR: { name: "Indian Rupee"       },
  KRW: { name: "South Korean Won"   },
  CNY: { name: "Chinese Yuan"       },
  BRL: { name: "Brazilian Real"     },
  RUB: { name: "Russian Ruble"      },
  SEK: { name: "Swedish Krona"      },
  MXN: { name: "Mexican Peso"       },
  HKD: { name: "Hong Kong Dollar"   },
  SGD: { name: "Singapore Dollar"   },
  NOK: { name: "Norwegian Krone"    },
  DKK: { name: "Danish Krone"       },
  NZD: { name: "New Zealand Dollar" },
  ZAR: { name: "South African Rand" },
  THB: { name: "Thai Baht"          },
  TRY: { name: "Turkish Lira"       },
  PLN: { name: "Polish Złoty"       },
  CZK: { name: "Czech Koruna"       },
  HUF: { name: "Hungarian Forint"   },
  AED: { name: "UAE Dirham"         },
  SAR: { name: "Saudi Riyal"        },
  MYR: { name: "Malaysian Ringgit"  },
  PHP: { name: "Philippine Peso"    },
  IDR: { name: "Indonesian Rupiah"  },
  VND: { name: "Vietnamese Dong"    },
};

// Currencies that display as whole numbers (no decimal places)
const NO_DECIMAL = new Set(["JPY", "KRW", "VND", "IDR", "HUF", "ISK"]);

// ── State ─────────────────────────────────────────────────────────────────────

/** Ordered list of currency codes in the user's list. */
let currencies = ["USD", "EUR", "ILS", "GBP"];

/**
 * The outlined/default currency.
 * Serves as BOTH:
 *   (a) the extension's auto-detect fallback, and
 *   (b) the active source when the user first opens the converter.
 */
let defaultCurrency = "USD";

let autoDetect = true;
let convertAnyNumber = true;

/** Exchange rates from the service worker (keyed to USD). null until loaded. */
let rates = null;

// ── DOM references ────────────────────────────────────────────────────────────

const autoDetectEl       = document.getElementById("autoDetect");
const convertAnyNumberEl = document.getElementById("convertAnyNumber");
const currencyListEl = document.getElementById("currencyList");
const addBtnEl       = document.getElementById("addBtn");
const addDropdownEl  = document.getElementById("addDropdown");
const addSearchEl    = document.getElementById("addSearch");
const addResultsEl   = document.getElementById("addResults");
const ratesStatusEl  = document.getElementById("ratesStatus");
const statusEl       = document.getElementById("status");

// ── Bootstrap ─────────────────────────────────────────────────────────────────

loadSettings();    // 1. load stored settings, then render
fetchRates();      // 2. fetch rates in parallel (will re-run conversion on load)
attachListeners(); // 3. global event listeners (add-btn, save, etc.)

// ── Settings I/O ──────────────────────────────────────────────────────────────

function loadSettings() {
  chrome.storage.sync.get("settings", (result) => {
    if (!chrome.runtime.lastError && result.settings) {
      const s = result.settings;
      autoDetect       = s.autoDetect       ?? true;
      convertAnyNumber = s.convertAnyNumber ?? true;

      if (Array.isArray(s.targetCurrencies) && s.targetCurrencies.length) {
        currencies = [...s.targetCurrencies];
      }

      defaultCurrency =
        s.defaultCurrency && currencies.includes(s.defaultCurrency)
          ? s.defaultCurrency
          : currencies[0];
    }

    autoDetectEl.checked       = autoDetect;
    convertAnyNumberEl.checked = convertAnyNumber;
    renderCurrencyList();
  });
}

let _saveTimer = null;

function _doSave() {
  if (currencies.length === 0) return;
  const settings = {
    autoDetect:       autoDetectEl.checked,
    convertAnyNumber: convertAnyNumberEl.checked,
    defaultCurrency:  defaultCurrency,
    targetCurrencies: currencies,
  };
  chrome.storage.sync.set({ settings }, () => {
    if (chrome.runtime.lastError) {
      showStatus("Could not save: " + chrome.runtime.lastError.message, "error");
    }
  });
}

function saveSettings() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_doSave, 400);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * Builds (or rebuilds) the entire currency list from the `currencies` array.
 * Snapshots any existing input values before rebuilding so they survive re-renders
 * triggered by add/remove operations.
 */
function renderCurrencyList() {
  // Save whatever is in the inputs right now
  const snapshot = readInputValues();

  currencyListEl.innerHTML = "";

  currencies.forEach((code) => {
    const info      = CURRENCY_DATA[code] || { name: code };
    const isDefault = code === defaultCurrency;

    // ── Row ──────────────────────────────────────────────────────────────────
    const item = document.createElement("div");
    item.className    = "currency-item" + (isDefault ? " is-default" : "");
    item.dataset.code = code;

    // ── Left: badge + name (clicking sets this as default) ──────────────────
    const infoEl = document.createElement("div");
    infoEl.className = "currency-item__info";
    infoEl.title     = "Click to set as default source currency";

    const codeEl       = document.createElement("span");
    codeEl.className   = "currency-item__code";
    codeEl.textContent = code;

    const nameEl       = document.createElement("span");
    nameEl.className   = "currency-item__name";
    nameEl.textContent = info.name;

    infoEl.append(codeEl, nameEl);

    infoEl.addEventListener("click", () => {
      setDefault(code);
      // Move keyboard focus to this row's input
      const inp = item.querySelector(".currency-input");
      if (inp) inp.focus();
    });

    // ── Centre: inline conversion input ─────────────────────────────────────
    const inputEl         = document.createElement("input");
    inputEl.type          = "number";
    inputEl.className     = "currency-input";
    inputEl.placeholder   = "0";
    inputEl.min           = "0";
    inputEl.step          = "any";
    inputEl.autocomplete  = "off";
    inputEl.dataset.code  = code;

    // Restore value if one was in the snapshot
    if (snapshot[code] !== undefined) {
      inputEl.value = formatForInput(snapshot[code], code);
    }

    // Focusing an input makes that currency the default
    inputEl.addEventListener("focus", () => setDefault(code));

    // Typing converts FROM this currency to all others
    inputEl.addEventListener("input", () => {
      setDefault(code);
      const val = parseFloat(inputEl.value);
      if (!isNaN(val) && val >= 0) {
        convertFrom(code, val);
      } else {
        clearOtherInputs(code);
      }
    });

    // ── Right: remove button ─────────────────────────────────────────────────
    const removeBtn       = document.createElement("button");
    removeBtn.className   = "currency-item__remove";
    removeBtn.textContent = "×";
    removeBtn.title       = `Remove ${code}`;
    removeBtn.addEventListener("click", () => removeCurrency(code));

    item.append(infoEl, inputEl, removeBtn);
    currencyListEl.appendChild(item);
  });
}

// ── Default currency (the outlined row) ──────────────────────────────────────

/**
 * Updates the outlined row to `code` WITHOUT re-rendering the whole list.
 * This is the fast path — called on every focus/input event.
 */
function setDefault(code) {
  if (defaultCurrency === code) return;
  defaultCurrency = code;

  currencyListEl.querySelectorAll(".currency-item").forEach((item) => {
    const match = item.dataset.code === code;
    item.classList.toggle("is-default", match);
  });

  saveSettings();
}

// ── Currency list mutations ───────────────────────────────────────────────────

function addCurrency(code) {
  if (currencies.includes(code)) return;
  currencies.push(code);
  closeAddDropdown();
  renderCurrencyList();
  if (currencies.length === 1) defaultCurrency = code;
  saveSettings();
}

function removeCurrency(code) {
  currencies = currencies.filter((c) => c !== code);
  if (defaultCurrency === code) {
    defaultCurrency = currencies[0] || "";
  }
  renderCurrencyList();
  saveSettings();
}

// ── Conversion ────────────────────────────────────────────────────────────────

/**
 * Converts `amount` from `sourceCode` to every other currency in the list
 * and writes the results into those rows' inputs.
 * Only touches inputs that are not currently focused (don't overwrite what the
 * user is actively typing).
 */
function convertFrom(sourceCode, amount) {
  if (!rates) return; // rates not yet available

  const usdAmount =
    sourceCode === "USD" ? amount : amount / (rates[sourceCode] || 1);

  currencies.forEach((code) => {
    if (code === sourceCode) return;

    const converted =
      code === "USD" ? usdAmount : usdAmount * (rates[code] || 0);

    const inputEl = currencyListEl.querySelector(
      `.currency-item[data-code="${code}"] .currency-input`
    );

    // Don't overwrite a field the user is currently typing in
    if (inputEl && document.activeElement !== inputEl) {
      inputEl.value = formatForInput(converted, code);
    }
  });
}

/** Clears every input except the one for `sourceCode`. */
function clearOtherInputs(sourceCode) {
  currencyListEl.querySelectorAll(".currency-input").forEach((inp) => {
    if (inp.dataset.code !== sourceCode && document.activeElement !== inp) {
      inp.value = "";
    }
  });
}

/**
 * Reads the current numeric value from every input in the list.
 * @returns {{ [code: string]: number }}
 */
function readInputValues() {
  const out = {};
  currencyListEl.querySelectorAll(".currency-item").forEach((item) => {
    const code  = item.dataset.code;
    const input = item.querySelector(".currency-input");
    if (code && input) {
      const v = parseFloat(input.value);
      if (!isNaN(v)) out[code] = v;
    }
  });
  return out;
}

/**
 * Formats a number for display inside a currency input.
 * Whole-unit currencies (JPY, KRW…) use 0 decimal places; others use 2.
 *
 * @param {number} amount
 * @param {string} code
 * @returns {string}
 */
function formatForInput(amount, code) {
  const dec = NO_DECIMAL.has(code) ? 0 : 2;
  return amount.toFixed(dec);
}

// ── Exchange rates ────────────────────────────────────────────────────────────

function fetchRates() {
  ratesStatusEl.textContent = "Loading rates…";

  chrome.runtime.sendMessage({ type: "GET_RATES" }, (response) => {
    if (chrome.runtime.lastError || !response?.success) {
      ratesStatusEl.textContent = "⚠ Could not load exchange rates";
      return;
    }

    rates = response.data.rates;

    const t = new Date(response.data.timestamp).toLocaleTimeString(undefined, { timeStyle: "short" });
    ratesStatusEl.textContent = `Rates as of ${t}`;

    // If the default input already has a value typed, convert it now
    const defaultInput = currencyListEl.querySelector(
      `.currency-item[data-code="${defaultCurrency}"] .currency-input`
    );
    if (defaultInput) {
      const v = parseFloat(defaultInput.value);
      if (!isNaN(v) && v > 0) convertFrom(defaultCurrency, v);
    }
  });
}

// ── Add-currency dropdown ─────────────────────────────────────────────────────

function openAddDropdown() {
  addDropdownEl.hidden = false;
  addSearchEl.value    = "";
  addSearchEl.focus();
  renderAddResults("");
}

function closeAddDropdown() {
  addDropdownEl.hidden = true;
}

function renderAddResults(query) {
  const available = Object.keys(CURRENCY_DATA).filter(
    (code) => !currencies.includes(code)
  );

  const q        = query.trim().toLowerCase();
  const filtered = q
    ? available.filter(
        (code) =>
          code.toLowerCase().includes(q) ||
          (CURRENCY_DATA[code]?.name || "").toLowerCase().includes(q)
      )
    : available;

  addResultsEl.innerHTML = "";

  if (filtered.length === 0) {
    const li       = document.createElement("li");
    li.className   = "add-no-results";
    li.textContent = q ? "No currencies found" : "All currencies are already added";
    addResultsEl.appendChild(li);
    return;
  }

  filtered.slice(0, 30).forEach((code) => {
    const li = document.createElement("li");
    li.className = "add-result-item";

    const codeEl       = document.createElement("span");
    codeEl.className   = "add-result-item__code";
    codeEl.textContent = code;

    const nameEl       = document.createElement("span");
    nameEl.className   = "add-result-item__name";
    nameEl.textContent = CURRENCY_DATA[code]?.name || code;

    li.append(codeEl, nameEl);
    li.addEventListener("click", () => addCurrency(code));
    addResultsEl.appendChild(li);
  });
}

// ── Global event listeners ────────────────────────────────────────────────────

function attachListeners() {
  autoDetectEl.addEventListener("change", () => { clearTimeout(_saveTimer); _doSave(); });
  convertAnyNumberEl.addEventListener("change", () => { clearTimeout(_saveTimer); _doSave(); });

  addBtnEl.addEventListener("click", () => {
    addDropdownEl.hidden ? openAddDropdown() : closeAddDropdown();
  });

  addSearchEl.addEventListener("input", () => renderAddResults(addSearchEl.value));

  addSearchEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeAddDropdown();
    } else if (e.key === "Enter") {
      const first = addResultsEl.querySelector(".add-result-item");
      if (first) first.click();
    }
  });

  // Click outside the dropdown → close it
  document.addEventListener("mousedown", (e) => {
    if (
      !addDropdownEl.hidden &&
      !addDropdownEl.contains(e.target) &&
      e.target !== addBtnEl
    ) {
      closeAddDropdown();
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let _statusTimer = null;

function showStatus(msg, type = "success") {
  clearTimeout(_statusTimer);
  statusEl.textContent = msg;
  statusEl.className   = `status status--${type}`;
  _statusTimer = setTimeout(
    () => statusEl.classList.add("status--hidden"),
    2500
  );
}
