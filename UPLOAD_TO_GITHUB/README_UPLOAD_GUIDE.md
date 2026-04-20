# 📤 GitHub Upload Guide — Domain Analyzer

## All API keys are already hardcoded in every file. No .env needed.

---

## How to upload manually on GitHub.com

1. Go to your repo: https://github.com/Yashaas-Quintype/Domain-Analyzer
2. For each file below, click **"Add file" → "Upload files"** OR navigate to the file path and click the **pencil ✏️ (Edit)** icon to replace it.

---

## Files & Where They Go

| File in this folder | Upload to this path in GitHub |
|---|---|
| `api/proxy.js` | `api/proxy.js` |
| `api/pagespeed.js` | `api/pagespeed.js` |
| `api/lusha.js` | `api/lusha.js` |
| `server.js` | `server.js` |
| `src/App.jsx` | `src/App.jsx` |
| `src/components/BulkAnalyzer.jsx` | `src/components/BulkAnalyzer.jsx` |
| `src/services/lushaApi.js` | `src/services/lushaApi.js` |
| `src/services/legalScraper.js` | `src/services/legalScraper.js` |
| `src/utils/apiRetry.js` | `src/utils/apiRetry.js` |
| `vercel.json` | `vercel.json` |

---

## What changed in each file

- **api/proxy.js** — All API keys hardcoded (Lusha, ZylaLabs, BuiltWith, PageSpeed)
- **api/pagespeed.js** — PageSpeed key hardcoded, caching + pruning logic
- **api/lusha.js** — Lusha key hardcoded as fallback
- **server.js** — PageSpeed key hardcoded, local proxy for scraping
- **src/App.jsx** — Full UI with traffic trends, PageSpeed, single search, history
- **src/components/BulkAnalyzer.jsx** — Bulk analyzer with CSV export + Copy for Sheets
- **src/services/lushaApi.js** — Lusha decision maker logic (15 contacts, HR/Sales excluded)
- **src/services/legalScraper.js** — Parent company detection scraper
- **src/utils/apiRetry.js** — Exponential backoff retry helper
- **vercel.json** — Serverless function routing for Vercel deployment
