/**
 * background.js — Service Worker
 *
 * Handles exchange rate fetching and caching for the Currency Converter extension.
 * Rates are fetched from the free exchangerate-api.com endpoint, keyed to USD as the
 * pivot currency, and cached in chrome.storage.local for 1 hour before refreshing.
 *
 * Message API (from content.js):
 *   Request:  { type: "GET_RATES" }
 *   Response: { type: "RATES_RESPONSE", success: true,  data: { base, rates, timestamp, fromCache } }
 *           | { type: "RATES_RESPONSE", success: false, error: "<message>" }
 */

"use strict";

const RATES_URL    = "https://api.exchangerate-api.com/v4/latest/USD";
const CACHE_KEY    = "ratesCache";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "GET_RATES") return false;

  // Return true immediately to keep the message channel open while we await
  // the async operations below. Without this, the port closes and sendResponse
  // becomes a no-op.
  handleGetRates(sendResponse);
  return true;
});

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Attempts to serve rates from cache; falls back to a live fetch if the
 * cache is absent or older than CACHE_TTL_MS.
 *
 * @param {function} sendResponse  The content-script reply callback.
 */
async function handleGetRates(sendResponse) {
  try {
    const cached = await getCachedRates();
    if (cached) {
      sendResponse({
        type: "RATES_RESPONSE",
        success: true,
        data: { ...cached, fromCache: true }
      });
      return;
    }

    const fresh = await fetchRates();
    await cacheRates(fresh);
    sendResponse({
      type: "RATES_RESPONSE",
      success: true,
      data: { ...fresh, fromCache: false }
    });
  } catch (err) {
    sendResponse({
      type: "RATES_RESPONSE",
      success: false,
      error: err.message || "Unknown error"
    });
  }
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

/**
 * Returns cached rates if present and not yet stale, otherwise null.
 *
 * @returns {Promise<{base:string, rates:object, timestamp:number}|null>}
 */
async function getCachedRates() {
  const result = await chrome.storage.local.get(CACHE_KEY);
  const cache  = result[CACHE_KEY];
  if (!cache) return null;
  if (Date.now() - cache.timestamp > CACHE_TTL_MS) return null; // stale
  return cache;
}

/**
 * Fetches fresh rates from the API.
 *
 * @returns {Promise<{base:string, rates:object, timestamp:number}>}
 */
async function fetchRates() {
  const response = await fetch(RATES_URL);
  if (!response.ok) {
    throw new Error(`Rate fetch failed: HTTP ${response.status}`);
  }
  const json = await response.json();
  if (!json.rates || typeof json.rates !== "object") {
    throw new Error("Invalid API response: missing rates object");
  }
  return {
    base:      "USD",
    rates:     json.rates,
    timestamp: Date.now()
  };
}

/**
 * Persists rates to chrome.storage.local.
 * If storage fails, we swallow the error — the fetch result is still used
 * for the current conversion, it just won't be cached for next time.
 *
 * @param {{base:string, rates:object, timestamp:number}} data
 */
async function cacheRates(data) {
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: data });
  } catch (err) {
    console.warn("[CurrencyConverter] Could not cache rates:", err.message);
  }
}
