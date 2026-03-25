# Data Point Extractor

AI-powered tool to extract and classify data points from corporate sustainability reports and annual filings (20-F, 10-K, etc.).

Uses **Python-style text extraction** in the browser via PDF.js, then sends pages to the **Claude API** for intelligent classification of what qualifies as a data point vs noise (years, page numbers, standards, etc.).

## Features

- 📄 Upload any PDF report
- 🤖 Claude AI classifies data points page-by-page
- ✅ Review & remove false positives with one click
- 🔍 Search/filter results
- 📥 Export to CSV or JSON
- ⚡ Configurable batch size (accuracy vs speed)

## Setup

### 1. Clone & install

```bash
git clone https://github.com/YOUR_USERNAME/data-point-extractor.git
cd data-point-extractor
npm install
```

### 2. Run locally

```bash
npm run dev
```

Open http://localhost:5173

### 3. Enter your Anthropic API key

The app will prompt for your API key on first use. It's stored in your browser's localStorage only.

Get a key at: https://console.anthropic.com/

## Deploy to Vercel

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → New Project → Import your repo
3. Framework: **Vite** (auto-detected)
4. Click **Deploy**

That's it — no environment variables needed. The API key is entered by each user in the browser.

## How it works

1. **PDF.js** extracts text from each page in the browser
2. The PDF is sent as base64 to **Claude Sonnet** in batches (configurable: 5-20 pages)
3. Claude identifies data points using a detailed system prompt trained on highlighted examples from Sony's Sustainability Report
4. Results are displayed in a reviewable table with page numbers and context
5. Users can remove false positives and export the final list

## Customizing the prompt

Edit the `SYSTEM_PROMPT` constant in `src/App.jsx` to adjust what counts as a data point for your specific report type.

## Tech stack

- React 18 + Vite
- PDF.js for client-side PDF parsing
- Anthropic Claude API (Sonnet) for classification
- Zero backend — runs entirely in the browser
