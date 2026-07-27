# TruckVal Scraper (standalone)

A self-contained scraper package for truck marketplaces. It upserts normalized
listings into the **same `truck_listings` Postgres table** the TruckVal web app
reads — deduped on `(source, source_id)`, so re-running never duplicates.

Sources in this package:

| Scraper | Site | Method | source tag |
|---------|------|--------|-----------|
| `truck1-scraper.js` | truck1.eu | Playwright (JS-gated) | `truck1` |
| `autoline-bg-scraper.js` | autoline.bg (Bulgaria) | plain HTTP + JSON-LD | `autoline_bg` |
| `trucksnl-scraper.js` | trucksnl.com | Playwright (reCAPTCHA-gated) | `trucksnl` |

autoline.bg needs **no browser** — same Autoline JSON-LD platform as
autoline.info, just Bulgarian labels. Truck1 and TrucksNL need Playwright/Chromium
(hence the Playwright base image).

> **⚠️ TrucksNL reCAPTCHA caveat:** trucksnl.com is behind **Google reCAPTCHA
> Enterprise on every URL** (even its API). A headless browser may or may not
> clear it — reCAPTCHA Enterprise often blocks headless automation from
> datacenter IPs. So `trucksnl-scraper.js` may return 0 listings on Railway even
> though it works locally on a residential connection. It is deliberately NOT in
> the automatic `run.js` cron flow (it would fail silently). Run it manually, and
> the FIRST run needs live verification: `node trucksnl-scraper.js --headful
> --pages 1 --debug` — confirm it clears the gate and the parser finds listings,
> tuning `extractListings()` if not. The **Chrome extension** (your real browser)
> is the reliable path for this site if the server-side route is blocked.

This folder is fully independent of the main app: it has its own `package.json`,
Dockerfile, and DB pool. Drop it into its own GitHub repo and deploy it as its
own Railway service (or run it locally).

## Why a separate package

Truck1 serves an anti-bot JS challenge to plain HTTP, so it needs a real browser
(Playwright + Chromium). That's a heavy, Debian-based image — keeping it apart
from the small Alpine web app image means the web app stays lean and a scraper
crash can never affect the live site.

> **Datacenter-IP caveat:** Truck1's anti-bot is more likely to challenge a cloud
> (Railway) IP than your home browser. It may work, it may degrade over time. If
> results go empty, that's why — the TruckVal Chrome extension (real browser +
> IP) is the more reliable path for this site. Run this politely: modest
> `TRUCK1_PAGES` / `TRUCK1_CONCURRENCY`, watch the logs.

## Layout

```
truckval-scraper/
  truck1-scraper.js   Playwright crawler (JSON-LD Product + .specs-item)
  load-listings.js    upserts output/*/listings.json → truck_listings
  run.js              one-shot: crawl → load → exit (Railway cron entrypoint)
  lib/
    browser.js        Playwright launch/render wrapper
    scrape-core.js    record shape, dedup, JSON/CSV output helpers
    html-utils.js     JSON-LD / small parsing helpers
    db.js             Postgres pool (reads DATABASE_URL)
  Dockerfile          official Playwright image; builds from this folder
  railway.toml        build + weekly cron config
  output/             written listings (gitignored)
```

## Local use

```sh
npm install
npx playwright install chromium         # first time only (Docker already has it)
cp .env.example .env                      # set DATABASE_URL to the shared DB

# smoke test — scrape ONE detail page and print the parsed record (no DB write):
node truck1-scraper.js --url "https://www.truck1.eu/trucks/<...>-a1234567.html"

# small crawl + load:
node truck1-scraper.js --pages 2 --limit 10
node load-listings.js truck1-trucks truck1

# everything in one shot (what Railway runs):
npm run run
```

CLI flags: `--pages N`, `--concurrency N`, `--limit N`, `--url <detailUrl>`,
`--start-url <url>`, `--headful` (watch the browser).

## Deploy as its own Railway service

1. Push this folder to its own GitHub repo (its root = this folder).
2. Railway → **New Project** (or add a service to an existing project) → **Deploy
   from GitHub repo** → pick it. Railway auto-detects the Dockerfile.
3. **Variables**: `DATABASE_URL` = the shared TruckVal DB. If the Postgres lives
   in another Railway project, paste its **public** connection string (this
   service will use SSL automatically for non-internal hosts). Optional:
   `TRUCK1_PAGES`, `TRUCK1_CONCURRENCY`, `TRUCK1_START`.
4. **Cron Schedule**: `railway.toml` sets weekly (`0 3 * * 1`); or set it in
   Settings → Cron Schedule. Set **Restart Policy: Never**.
5. Deploy. Test with a manual **Redeploy** and watch the logs for
   `=== truck1 refresh complete ===`, then check the DB:
   `SELECT count(*) FROM truck_listings WHERE source='truck1';`

## Keep versions in sync

`Dockerfile`'s base tag (`mcr.microsoft.com/playwright:vX.Y.Z-jammy`) must match
the `playwright` version in `package.json`. Bump both together.

## Adding another browser-gated site

Write `<site>-scraper.js` (copy `truck1-scraper.js`), have it write
`output/<slug>/listings.json` via the `lib/` helpers, add the slug to `SOURCES`
in `load-listings.js`, and add a `run()` step in `run.js`.
