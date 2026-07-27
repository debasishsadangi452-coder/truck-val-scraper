# Scrapers (truckval-scraper)

All TruckVal source scrapers live here — the main app repo holds none. Each
scraper writes `output/<slug>/listings.{json,csv}` (deduped, upsert-by-id), and
`load-listings.js` upserts that JSON into the shared `truck_listings` Postgres
table on `(source, source_id)`. Re-running never duplicates.

Shared code in `lib/`:
- `scrape-core.js` — fetch+retry, jittered delays, bounded-parallel detail
  fetches, canonical record shape (`FIELDNAMES`), dedup Map, JSON/CSV output,
  cookie session, the `runScrape` driver.
- `browser.js` — Playwright launch/render wrapper (lazy-imports playwright, so
  the plain-HTTP scrapers run without it installed).
- `html-utils.js` — JSON-LD extraction + small parsing helpers.
- `blocked-source.js` — guard the blocked-stub scrapers use.
- `db.js` — Postgres pool (reads `DATABASE_URL`).

## Sources

| Scraper | Site | Method | source tag | Status |
|---------|------|--------|-----------|--------|
| `otomoto-scraper.js` | otomoto.pl | plain HTTP (`__NEXT_DATA__`) | `otomoto` | working |
| `autoline-scraper.js` | autoline.info | plain HTTP (JSON-LD) | `autoline` | working |
| `truck7-scraper.js` | truck7.eu | plain HTTP (Livewire) | `truck7` | working |
| `autoline-bg-scraper.js` | autoline.bg | plain HTTP (JSON-LD, Bulgarian) | `autoline_bg` | working |
| `truck1-scraper.js` | truck1.eu | Playwright (JS challenge) | `truck1` | built; run locally, verify selectors |
| `trucksnl-scraper.js` | trucksnl.com | Playwright (reCAPTCHA Enterprise) | `trucksnl` | built; gate may block — see README |
| `mantopused-scraper.js` | man-topused.com | — | — | stub (site retired) |
| `oktrucks-scraper.js` | oktrucks.com | — | — | stub (needs browser + residential IP) |
| `truckstore-scraper.js` | truckstore.com | — | — | stub (XHR/JS) |
| `usedscania-scraper.js` | used.scania.com | — | — | stub (SPA/API) |
| `usedvolvo-scraper.js` | usedvolvotrucks.com | — | — | stub (needs browser + residential IP) |

Blocked stubs are runnable and exit non-zero with an explanation — not silent no-ops.

## Running

```sh
npm install                              # pg + playwright
npx playwright install chromium          # only needed for truck1 / trucksnl
cp .env.example .env                      # set DATABASE_URL to the shared DB

# individual source (scrape -> then load):
npm run scrape:autoline-bg -- --max-pages 60
node load-listings.js autoline-bg-trucks autoline_bg

# aggregate entrypoints:
npm run refresh:http     # otomoto + autoline + truck7 + autoline.bg -> load
npm run run:browser      # autoline.bg + truck1 (Playwright) -> load

# load all sources that have output/:
npm run load
```

## Playwright notes

- Only `truck1` and `trucksnl` need a browser. The Docker image ships Chromium;
  locally, `npx playwright install chromium` once.
- `trucksnl.com` is behind reCAPTCHA Enterprise on every URL — a headless
  browser may not clear it from a datacenter IP. See the README's TrucksNL
  caveat; the Chrome extension is the reliable path for that site.

## Deploy

This whole folder is meant to be its own GitHub repo + Railway service — see
`README.md`. The main app repo only handles the scheduling/trigger side (later).

## Adding a source

1. Write `<site>-scraper.js` using the `lib/` helpers; write to
   `output/<slug>/listings.json` via `writeOutputs`.
2. Add `{ slug, source }` to `SOURCES` in `load-listings.js`.
3. Add it to `weekly-refresh.js` (plain HTTP) or `run.js` (browser) if it should
   run on the schedule.
