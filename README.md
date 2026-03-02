# Currency Converter — Chrome Extension

A lightweight Chrome extension that converts any number you highlight on a webpage into your chosen currencies — instantly, with a sleek floating tooltip.

---

## Features

- **Highlight any number** on any webpage → a tooltip appears with live conversions
- **Auto-detects the source currency** from surrounding symbols, page context, or DOM attributes
- **Clickable currency badge** — if the auto-detection is wrong, click the blue badge to override it
- **Frosted-glass tooltip** — dark, transparent, stays out of your way
- **Settings popup** — manage your currency list, type in any field to convert between all currencies simultaneously
- **Outlined row = fallback currency** — used automatically when no symbol can be detected on the page
- Exchange rates cached for 1 hour (via [exchangerate-api.com](https://www.exchangerate-api.com/))

---

## Installation (Developer Mode / Load Unpacked)

Chrome extensions that are not published to the Chrome Web Store must be loaded manually. Here's how:

### 1. Download the extension

- Download the latest `currency-converter-v*.zip` from the [Releases](../../releases) page
- Unzip it to a permanent folder on your computer (don't delete this folder — Chrome needs it)

### 2. Enable Developer Mode in Chrome

1. Open Chrome and go to: **`chrome://extensions`**
2. In the top-right corner, toggle **Developer mode** ON

   ![Developer Mode toggle](https://i.imgur.com/placeholder-devmode.png)

### 3. Load the extension

1. Click the **"Load unpacked"** button (top-left)
2. Browse to the folder where you unzipped the extension
3. Click **Select Folder**

The extension icon will appear in your Chrome toolbar. 🎉

### 4. Pin it (optional)

Click the puzzle-piece icon (🧩) in the Chrome toolbar → find **Currency Converter** → click the 📌 pin icon.

---

## Usage

1. On any webpage, **highlight a number** (e.g. a price, salary, or amount)
2. A floating tooltip appears in the top-right corner showing conversions
3. **Click the blue badge** (e.g. `USD`) to correct the detected currency
4. Click **×** or click elsewhere to dismiss

### Settings

Click the extension icon in your toolbar to open Settings:

- **Auto-detect** toggle — let the extension read currency symbols from the page
- **My currencies** — add or remove currencies from your list
- **Inline converter** — type any amount in any row to convert to all others simultaneously
- **Outlined row** — click a row to mark it as the fallback source currency (used when auto-detect finds nothing)

---

## Supported Currencies

USD, EUR, GBP, JPY, CAD, AUD, CHF, ILS, INR, KRW, CNY, BRL, RUB, SEK, MXN, HKD, SGD, NOK, DKK, NZD, ZAR, THB, TRY, PLN, CZK, HUF, AED, SAR, MYR, PHP, IDR, VND

---

## Updating

When a new version is released:
1. Download the new ZIP from [Releases](../../releases)
2. Unzip and **replace** the contents of your existing folder
3. Go to `chrome://extensions` → click the **↺ reload** button on the extension
4. Refresh any open tabs

---

## License

MIT — free to use, modify, and distribute.
