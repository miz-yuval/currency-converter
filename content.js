/**
 * content.js — Content Script
 *
 * Injected into every webpage. Listens for text selections, parses any number
 * found, auto-detects the surrounding currency, fetches exchange rates from the
 * service worker, and renders a semi-transparent floating tooltip in the
 * top-right corner of the viewport.
 *
 * All code is wrapped in an IIFE so it never pollutes the host page's globals.
 */

(function () {
  "use strict";

  // ── Currency symbol table (module-level so both formatCurrency and
  //    processConversion can use it) ──────────────────────────────────────────

  const SYM = {
    USD:"$",   EUR:"€",   GBP:"£",   JPY:"¥",   CAD:"CA$", AUD:"A$",
    CHF:"Fr",  ILS:"₪",   INR:"₹",   KRW:"₩",   CNY:"¥",   BRL:"R$",
    RUB:"₽",   SEK:"kr",  MXN:"MX$", HKD:"HK$", SGD:"S$",  NOK:"kr",
    DKK:"kr",  NZD:"NZ$", ZAR:"R",   THB:"฿",   TRY:"₺",   PLN:"zł",
    CZK:"Kč",  HUF:"Ft",  AED:"AED", SAR:"SAR", MYR:"RM",  PHP:"₱",
    IDR:"Rp",  VND:"₫",
  };

  // ── State ───────────────────────────────────────────────────────────────────

  /** @type {HTMLElement|null} The currently visible tooltip element, if any. */
  let tooltipEl = null;

  /** @type {{autoDetect:boolean, defaultCurrency:string, targetCurrencies:string[]}} */
  let settings = {
    autoDetect:        true,
    defaultCurrency:   "USD",
    targetCurrencies:  ["EUR", "ILS", "GBP", "JPY"]
  };

  // ── Initialisation ──────────────────────────────────────────────────────────

  // Load user settings on script startup
  chrome.storage.sync.get("settings", (result) => {
    if (result.settings) settings = result.settings;
  });

  // Keep settings in sync if the user changes them while this tab is open
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.settings) {
      settings = changes.settings.newValue;
    }
  });

  // ── Event listeners ─────────────────────────────────────────────────────────

  // Main trigger: fires after any mouse-based text selection
  document.addEventListener("mouseup", handleSelectionEvent);

  // Also handle keyboard-driven selections (Shift+Arrow keys, etc.)
  document.addEventListener("keyup", (e) => {
    if (e.key === "Escape") {
      dismissTooltip();
      return;
    }
    if (e.shiftKey) handleSelectionEvent(e);
  });

  // Dismiss when clicking outside the tooltip
  document.addEventListener("mousedown", (e) => {
    if (tooltipEl && !tooltipEl.contains(e.target)) {
      dismissTooltip();
    }
  });

  // ── Selection handler ───────────────────────────────────────────────────────

  function handleSelectionEvent(e) {
    // Don't react to clicks inside the tooltip itself
    if (tooltipEl && tooltipEl.contains(e.target)) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      // Give the browser a tick to settle before checking — prevents flicker
      // when a user clicks within an already-selected region
      setTimeout(() => {
        if (window.getSelection().isCollapsed) dismissTooltip();
      }, 150);
      return;
    }

    const rawText = selection.toString().trim();
    if (!rawText) return;

    const amount = parseSelectedNumber(rawText);
    if (amount === null || amount === 0) return;

    // Grab the bounding rect of the selection for potential future positioning use
    const range = selection.getRangeAt(0);
    const rect  = range.getBoundingClientRect();

    processConversion(amount, rawText, selection, rect);
  }

  // ── Conversion pipeline ─────────────────────────────────────────────────────

  /**
   * Detects the source currency, fetches rates, converts, and shows the tooltip.
   *
   * @param {number}    amount   Parsed numeric value from the selection
   * @param {string}    rawText  The raw selected text (for display)
   * @param {Selection} selection
   * @param {DOMRect}   rect
   */
  async function processConversion(amount, rawText, selection, rect) {
    // ── Step 1: Detect source currency ──────────────────────────────────────
    let sourceCurrency = null;

    if (settings.autoDetect) {
      // Phase 1: scan ±50 chars of plain text surrounding the selection
      const anchorNode = selection.anchorNode;
      const context    = getExpandedContext(anchorNode, rawText, 50);
      sourceCurrency   = detectCurrencyInText(context);

      // Phase 2: walk up the DOM tree looking for currency hints
      if (!sourceCurrency) {
        sourceCurrency = detectCurrencyFromDOM(anchorNode);
      }
    }

    // Phase 3: fall back to the user's configured default
    if (!sourceCurrency) sourceCurrency = settings.defaultCurrency;

    // ── Step 2: Ensure we have target currencies ─────────────────────────────
    const targets = (settings.targetCurrencies || []).filter(
      (c) => c !== sourceCurrency
    );
    if (targets.length === 0) {
      // Nothing to convert to — silently skip
      return;
    }

    // ── Step 3: Fetch exchange rates ─────────────────────────────────────────
    let rateData;
    try {
      rateData = await getRates();
    } catch (err) {
      showErrorTooltip(`Could not fetch rates: ${err.message}`);
      return;
    }

    // ── Step 4: Guard against unknown currency codes ─────────────────────────
    if (sourceCurrency !== "USD" && !rateData.rates[sourceCurrency]) {
      showErrorTooltip(`Unknown source currency: ${sourceCurrency}`);
      return;
    }

    // ── Step 5: Convert and display ──────────────────────────────────────────
    const conversions = convertAmount(amount, sourceCurrency, targets, rateData.rates);

    // Always show a clean formatted number + symbol in the header,
    // regardless of what extra text (words, stray symbols, foreign separators)
    // the user may have included in their selection.
    const displayOriginal = formatCurrency(amount, sourceCurrency);

    showTooltip({
      original:       displayOriginal,
      rawSelection:   rawText,
      sourceCurrency: sourceCurrency,
      conversions:    conversions,
      amount:         amount,            // parsed number — needed for re-conversion
      rates:          rateData.rates,    // rates — needed for re-conversion
      timestamp:      rateData.timestamp,
      fromCache:      rateData.fromCache
    });
  }

  // ── Number parsing ──────────────────────────────────────────────────────────

  /**
   * Extracts a numeric value from the selected text.
   * Handles both European (1.234,56) and American (1,234.56) number formats.
   *
   * @param {string} rawText
   * @returns {number|null}  null if no valid number found
   */
  function parseSelectedNumber(rawText) {
    // Strip all characters that aren't digits, commas, dots, or a leading minus
    let cleaned = rawText.replace(/[^\d.,\-]/g, "").trim();
    if (!cleaned) return null;

    // European format: "1.234,56" — dot as thousands, comma as decimal
    if (/\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(cleaned)) {
      cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    }
    // American format: "1,234.56" — comma as thousands, dot as decimal
    else if (/\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(cleaned)) {
      cleaned = cleaned.replace(/,/g, "");
    }
    // Ambiguous single separator
    else if (cleaned.includes(",") && !cleaned.includes(".")) {
      const afterComma = cleaned.split(",").pop() || "";
      if (afterComma.length <= 2) {
        // "12,50" → likely a decimal comma (European)
        cleaned = cleaned.replace(",", ".");
      } else {
        // "1,234" → likely a thousands comma
        cleaned = cleaned.replace(/,/g, "");
      }
    }

    const value = parseFloat(cleaned);
    return isNaN(value) ? null : value;
  }

  // ── Currency detection ──────────────────────────────────────────────────────

  /**
   * Ordered from most-specific to least-specific to prevent partial matches.
   * For example, "CA$" must be checked before "$" so Canadian dollars are
   * correctly identified rather than defaulting to USD.
   */
  const CURRENCY_SYMBOLS = [
    { code: "CAD", patterns: ["CA$", "C$"]         },
    { code: "AUD", patterns: ["AU$", "A$"]          },
    { code: "HKD", patterns: ["HK$"]                },
    { code: "SGD", patterns: ["S$"]                  },
    { code: "MXN", patterns: ["MX$", "Mex$"]        },
    { code: "BRL", patterns: ["R$"]                  },
    { code: "CHF", patterns: ["CHF", "Fr."]          },
    { code: "EUR", patterns: ["€"]                   },
    { code: "GBP", patterns: ["£"]                   },
    { code: "ILS", patterns: ["₪"]                   },
    { code: "INR", patterns: ["₹"]                   },
    { code: "CNY", patterns: ["CN¥", "元", "¥¥"]     },
    { code: "JPY", patterns: ["JP¥", "¥"]            }, // bare ¥ defaults to JPY
    { code: "KRW", patterns: ["₩"]                   },
    { code: "RUB", patterns: ["₽"]                   },
    { code: "SEK", patterns: ["kr"]                  }, // also NOK/DKK — low confidence
    { code: "USD", patterns: ["US$", "$"]            }, // bare $ checked last
  ];

  /**
   * Scans a string for known currency symbols.
   *
   * @param {string} text
   * @returns {string|null}  ISO 4217 code, or null
   */
  function detectCurrencyInText(text) {
    if (!text) return null;
    for (const { code, patterns } of CURRENCY_SYMBOLS) {
      for (const pat of patterns) {
        if (text.includes(pat)) return code;
      }
    }
    return null;
  }

  /**
   * Returns a window of text centred on the selected text within its text node,
   * padded by `charPad` characters on each side.
   *
   * @param {Node}   anchorNode
   * @param {string} selectedText
   * @param {number} charPad
   * @returns {string}
   */
  function getExpandedContext(anchorNode, selectedText, charPad) {
    if (!anchorNode || anchorNode.nodeType !== Node.TEXT_NODE) return selectedText;
    const full = anchorNode.textContent || "";
    const idx  = full.indexOf(selectedText);
    if (idx === -1) return selectedText;
    const start = Math.max(0, idx - charPad);
    const end   = Math.min(full.length, idx + selectedText.length + charPad);
    return full.slice(start, end);
  }

  /**
   * Walks up the DOM from the selection's anchor node looking for currency
   * signals in data attributes, aria labels, lang attributes, or element text.
   *
   * @param {Node} anchorNode
   * @returns {string|null}  ISO 4217 code, or null
   */
  function detectCurrencyFromDOM(anchorNode) {
    let el = anchorNode
      ? (anchorNode.nodeType === Node.TEXT_NODE ? anchorNode.parentElement : anchorNode)
      : null;

    const MAX_DEPTH = 6;

    for (let depth = 0; depth < MAX_DEPTH && el && el !== document.body; depth++, el = el.parentElement) {
      // 1. Explicit data attribute (e.g. data-currency="EUR")
      const dataCurrency = el.dataset && (el.dataset.currency || el.dataset.currencyCode);
      if (dataCurrency) {
        const code = dataCurrency.toUpperCase().trim();
        if (code.length === 3) return code;
      }

      // 2. aria-label containing an ISO currency code
      const ariaLabel = el.getAttribute("aria-label") || "";
      const ariaMatch = ariaLabel.match(/\b(USD|EUR|GBP|JPY|CAD|AUD|CHF|ILS|INR|KRW|CNY|BRL|RUB|SEK|MXN|HKD|SGD)\b/i);
      if (ariaMatch) return ariaMatch[1].toUpperCase();

      // 3. Short element text — scan for symbols (skip large blocks of text)
      const text = (el.textContent || "").trim();
      if (text.length > 0 && text.length < 300) {
        const found = detectCurrencyInText(text);
        if (found) return found;
      }

      // 4. lang attribute — infer likely currency from locale
      const lang = el.getAttribute("lang") || "";
      if (lang) {
        const langCurrency = langToCurrency(lang);
        if (langCurrency) return langCurrency;
      }
    }

    // 5. Check the document-level lang as a last DOM resort
    const docLang = document.documentElement.getAttribute("lang") || "";
    return langToCurrency(docLang);
  }

  /**
   * Maps BCP-47 language tags to a likely default currency.
   *
   * @param {string} lang
   * @returns {string|null}
   */
  function langToCurrency(lang) {
    const l = lang.toLowerCase();
    if (l.startsWith("he"))    return "ILS";
    if (l.startsWith("ja"))    return "JPY";
    if (l.startsWith("ko"))    return "KRW";
    if (l.startsWith("ru"))    return "RUB";
    if (l.startsWith("zh"))    return "CNY";
    if (l === "en-gb")         return "GBP";
    if (l === "en-au")         return "AUD";
    if (l === "en-ca")         return "CAD";
    if (l === "fr-ch" || l === "de-ch" || l === "it-ch") return "CHF";
    if (l.startsWith("pt-br")) return "BRL";
    return null;
  }

  // ── Conversion math ─────────────────────────────────────────────────────────

  /**
   * Converts `amount` from `fromCurrency` to each currency in `toCurrencies`
   * using the USD-pivot approach: everything goes through USD first.
   *
   * @param {number}   amount
   * @param {string}   fromCurrency  ISO 4217 code
   * @param {string[]} toCurrencies  ISO 4217 codes
   * @param {object}   rates         Rate map (all relative to USD)
   * @returns {{currency:string, amount:number, formatted:string}[]}
   */
  function convertAmount(amount, fromCurrency, toCurrencies, rates) {
    // Normalise to USD first
    const usdAmount = fromCurrency === "USD"
      ? amount
      : amount / rates[fromCurrency];

    return toCurrencies
      .filter((to) => rates[to] !== undefined)
      .map((to) => {
        const converted = to === "USD" ? usdAmount : usdAmount * rates[to];
        return {
          currency:  to,
          amount:    converted,
          formatted: formatCurrency(converted, to)
        };
      });
  }

  /**
   * Formats a converted amount as "1,234.56 €" — symbol ALWAYS on the RIGHT.
   *
   * Strategy: format the number with a fixed en-US locale (consistent, no
   * RTL/locale surprises), then look up the symbol from a hardcoded table and
   * append it. This is 100% predictable regardless of the browser/OS locale.
   *
   * Whole-unit currencies (JPY, KRW, VND …) show zero decimal places.
   *
   * @param {number} amount
   * @param {string} currencyCode
   * @returns {string}  e.g. "1,234.56 €"  or  "370 ₪"  or  "1,026.44 £"
   */
  function formatCurrency(amount, currencyCode) {
    // Currencies that use no decimal places
    const NO_DEC = new Set(["JPY","KRW","VND","IDR","HUF","ISK","CLP","GNF"]);
    const decimals = NO_DEC.has(currencyCode) ? 0 : 2;

    try {
      const numStr = new Intl.NumberFormat("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(amount);

      const symbol = SYM[currencyCode] ?? currencyCode;

      return `${numStr}${symbol}`;
    } catch {
      return `${amount.toFixed(decimals)}${SYM[currencyCode] ?? currencyCode}`;
    }
  }

  // ── Rate fetching (message to service worker) ───────────────────────────────

  /**
   * Sends a GET_RATES message to the service worker and returns a promise that
   * resolves with the rate data or rejects with an error.
   *
   * @returns {Promise<{base:string, rates:object, timestamp:number, fromCache:boolean}>}
   */
  function getRates() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "GET_RATES" }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || !response.success) {
          reject(new Error(response?.error || "Unknown error from background"));
          return;
        }
        resolve(response.data);
      });
    });
  }

  // ── Tooltip rendering ───────────────────────────────────────────────────────

  /**
   * Builds and displays the conversion tooltip.
   * The source-currency badge is clickable — clicking it opens a small
   * currency picker so the user can correct a mis-detection on the fly.
   */
  function showTooltip(data) {
    dismissTooltip();

    tooltipEl = document.createElement("div");
    tooltipEl.className = "cc-tooltip";
    tooltipEl.setAttribute("role",       "dialog");
    tooltipEl.setAttribute("aria-label", "Currency conversion results");
    tooltipEl.setAttribute("aria-live",  "polite");

    // ── Header ────────────────────────────────────────────────────────────────
    const header = document.createElement("div");
    header.className = "cc-tooltip__header";

    // Selected text (may have a symbol appended)
    const origEl = document.createElement("span");
    origEl.className   = "cc-tooltip__original";
    origEl.textContent = data.original;

    // Badge wrapper — gives the picker a positioned parent
    const badgeWrapper = document.createElement("div");
    badgeWrapper.className = "cc-tooltip__badge-wrapper";

    const badge = document.createElement("span");
    badge.className   = "cc-tooltip__source-badge";
    badge.textContent = data.sourceCurrency;
    badge.title       = "Click to change detected currency";

    // ── Badge click → currency picker ─────────────────────────────────────────
    badge.addEventListener("click", (e) => {
      e.stopPropagation();

      // Toggle: clicking again closes the picker
      const existing = badgeWrapper.querySelector(".cc-tooltip__currency-picker");
      if (existing) { existing.remove(); return; }

      const picker = document.createElement("div");
      picker.className = "cc-tooltip__currency-picker";

      Object.keys(SYM).forEach((code) => {
        const item = document.createElement("div");
        item.className   = "cc-tooltip__picker-item"
          + (code === data.sourceCurrency ? " cc-tooltip__picker-item--active" : "");
        item.textContent = code;

        item.addEventListener("click", (ev) => {
          ev.stopPropagation();

          const newSource = code;
          const oldSource = data.sourceCurrency;

          // New targets = previous rows − new source + old source
          const prevTargets = data.conversions.map((c) => c.currency);
          const newTargets  = [
            ...prevTargets.filter((c) => c !== newSource),
            ...(oldSource !== newSource &&
                (data.rates[oldSource] !== undefined || oldSource === "USD")
              ? [oldSource] : []),
          ];

          const newConversions = convertAmount(
            data.amount, newSource, newTargets, data.rates
          );

          // Update badge + stored source
          badge.textContent   = newSource;
          data.sourceCurrency = newSource;
          data.conversions    = newConversions;

          // Update header to show the same clean format with the new symbol
          origEl.textContent = formatCurrency(data.amount, newSource);

          // Rebuild conversion rows
          list.innerHTML = "";
          for (const { currency, formatted } of newConversions) {
            const li      = document.createElement("li");
            li.className  = "cc-tooltip__row";
            const codeEl  = document.createElement("span");
            codeEl.className   = "cc-tooltip__currency-code";
            codeEl.textContent = currency;
            const amtEl   = document.createElement("span");
            amtEl.className    = "cc-tooltip__amount";
            amtEl.textContent  = formatted;
            li.append(codeEl, amtEl);
            list.appendChild(li);
          }

          picker.remove();
        });

        picker.appendChild(item);
      });

      badgeWrapper.appendChild(picker);
    });

    badgeWrapper.appendChild(badge);

    const closeBtn = document.createElement("button");
    closeBtn.className   = "cc-tooltip__close";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", dismissTooltip);

    header.append(origEl, badgeWrapper, closeBtn);

    // ── Conversion rows (hoisted so badge picker can rebuild them) ────────────
    const list = document.createElement("ul");
    list.className = "cc-tooltip__list";

    for (const { currency, formatted } of data.conversions) {
      const li      = document.createElement("li");
      li.className  = "cc-tooltip__row";
      const codeEl  = document.createElement("span");
      codeEl.className   = "cc-tooltip__currency-code";
      codeEl.textContent = currency;
      const amtEl   = document.createElement("span");
      amtEl.className    = "cc-tooltip__amount";
      amtEl.textContent  = formatted;
      li.append(codeEl, amtEl);
      list.appendChild(li);
    }

    // ── Footer: timestamp ─────────────────────────────────────────────────────
    const footer = document.createElement("div");
    footer.className = "cc-tooltip__footer";
    const timeStr = new Date(data.timestamp).toLocaleTimeString(undefined, {
      hour: "2-digit", minute: "2-digit"
    });
    footer.textContent = `Rates updated ${timeStr}${data.fromCache ? "" : " (just now)"}`;

    tooltipEl.append(header, list, footer);
    document.body.appendChild(tooltipEl);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (tooltipEl) tooltipEl.classList.add("cc-tooltip--visible");
      });
    });
  }

  /**
   * Shows a brief error tooltip that auto-dismisses after 4 seconds.
   *
   * @param {string} message
   */
  function showErrorTooltip(message) {
    dismissTooltip();

    tooltipEl = document.createElement("div");
    tooltipEl.className   = "cc-tooltip cc-tooltip--error";
    tooltipEl.textContent = message;
    tooltipEl.setAttribute("role", "alert");
    document.body.appendChild(tooltipEl);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (tooltipEl) tooltipEl.classList.add("cc-tooltip--visible");
      });
    });

    setTimeout(dismissTooltip, 4000);
  }

  /**
   * Fades out and removes the current tooltip (if any).
   * Waits for the CSS transition to finish before removing from the DOM.
   */
  function dismissTooltip() {
    if (!tooltipEl) return;

    const el = tooltipEl;
    tooltipEl = null; // prevent double-dismiss

    el.classList.remove("cc-tooltip--visible");

    // Remove after transition; fallback timeout handles cases where the
    // element is removed before the transition fires (e.g. rapid selections).
    const cleanup = () => el.remove();
    el.addEventListener("transitionend", cleanup, { once: true });
    setTimeout(cleanup, 400);
  }

})(); // end IIFE
