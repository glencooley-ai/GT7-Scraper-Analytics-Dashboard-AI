# GT7 Leaderboard Analytics Toolkit

A lightweight browser-native toolkit for acquiring, storing and analysing Gran Turismo 7 leaderboard data.

This project began as an experiment in understanding GT7 leaderboard ecology and evolved into a resilient local-first analytical workflow using:

- Tampermonkey
- IndexedDB
- Local browser storage
- HTML/JS dashboards
- Lightweight CSV metadata enrichment

The goal is not to create a cloud platform or SaaS product, but to explore how modern browser tooling and AI-assisted workflows can rapidly evolve functional analytical tools with minimal infrastructure overhead.

---

## Features

### Scraper
- Automated GT7 leaderboard scraping
- Burst-mode page acquisition
- Retry handling
- Resume support
- IndexedDB persistence
- Duplicate-safe storage
- Optional localStorage legacy mode
- CSV/JSON export

### Dashboard / Analyzer
- Medal distribution analysis
- Time bucket density analysis
- Manufacturer distribution
- Car usage analysis
- Pace spread visualisation
- Personal result lookup
- Interactive filtering

### Metadata Enrichment
- Car → Group mapping
- Manufacturer mapping
- Derived leaderboard statistics

---

## Architecture

```text
GT7 Leaderboard
    ↓
Tampermonkey Scraper
    ↓
IndexedDB / localStorage
    ↓
Exported Dataset
    ↓
HTML Dashboard Analyzer
```

Everything runs locally in the browser.

- No backend
- No hosted database
- No external telemetry services

---

## Repository Structure

```text
/dashboard
    GT7_Leaderboard_Analyzer.html

/scraper
    gt7_scraper_indexeddb.user.js
    ~gt7_scraper_localstorage.user.js~

/data
    cars.csv
    cargrp.csv
    maker.csv

/examples
    sample_export.json
```

---

## Requirements

- Google Chrome or compatible browser
- Tampermonkey extension

---

## Usage

### 1. Install Tampermonkey
Install the Tampermonkey browser extension.

### 2. Install Scraper Script
Load one of the userscripts from the `/scraper` folder.

### 3. Open GT7 Leaderboard
Navigate to a supported GT7 leaderboard page.

### 4. Start Scraping
Use the scraper UI controls to begin acquisition.

### 5. Export Data
Export JSON/CSV once acquisition is complete.

### 6. Load Into Analyzer
Open the dashboard HTML file and import the exported dataset.

---

## Notes

- Large events may contain 100k–200k+ leaderboard rows
- IndexedDB mode is recommended for long unattended runs
- Car group mappings may require periodic updates as GT7 content expands

---

## Why This Exists

This project explores:

- Local-first tooling
- AI-assisted product development
- Lightweight analytical systems
- Browser-native application architecture
- Exploratory UX for competitive systems

It also serves as a portfolio case study demonstrating how modern AI-assisted workflows can help individuals rapidly prototype and evolve complete functional products — not just static UI concepts.

---

## Disclaimer

This is an unofficial fan-made project and is not affiliated with:

- Polyphony Digital
- Sony Interactive Entertainment
- Gran Turismo

Use responsibly.
