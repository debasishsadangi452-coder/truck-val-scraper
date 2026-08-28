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
| `mascus-scraper.js` | mascus.com | Apify actor (metered) | `mascus` | working, opt-in |

Blocked stubs are runnable and exit non-zero with an explanation — not silent no-ops.

## Auction sources (separate table)

Auction lots are **not** dealer ads: a lot has a live bid that moves, a bid
count, and a close date after which it's history. They load into their own
`auction_listings` table (`scripts/db/auction-schema.sql`) via
`load-auctions.js`, writing `output/<slug>/auctions.{json,csv}`. Keeping them
apart matters — folding live bids into `truck_listings` would corrupt every
asking-price average the dashboard computes there.

Shared code: `lib/auction-core.js` (canonical `AUCTION_FIELDNAMES`, output
helpers, and `isPriorityModel()` — the same wishlist the web app filters by,
duplicated here because this package is standalone; keep the two in sync).

| Scraper | Site | Method | source tag | Status |
|---------|------|--------|-----------|--------|
| `tbauctions-scraper.js` | surplex.com | plain HTTP (Next.js `_next/data`) | `surplex` | working |
| `tbauctions-scraper.js` | troostwijkauctions.com | plain HTTP (same platform) | `troostwijk` | working |
| `apify-auctions-scraper.js` | rbauction.com | Apify actor (metered) | `rbauction` | working, opt-in |

Surplex and Troostwijk are the **same TBAuctions app** (identical category
UUIDs and lot shape), so one scraper serves both via `--platform`.

```sh
# plain-HTTP auction sources (also run by npm run refresh:http):
node tbauctions-scraper.js --platform surplex    --category trucks
node tbauctions-scraper.js --platform troostwijk --category trailers
node tbauctions-scraper.js --platform surplex --category trucks --priority-only

node load-auctions.js                     # load every auction source
node load-auctions.js surplex-trucks surplex
```

`--priority-only` keeps just the business's wishlist models (DAF XF/CF, Volvo
FH 460/500/540/750, MAN TGX 18.470/18.510, Ford F-MAX, and the Kögel/Krone/
Fliegl/Wielton trailer brands). It filters **before** fetching detail pages, so
it's also the cheap way to run.

### rbauction via Apify (costs credits — opt in deliberately)

rbauction.com, basworld, openlane.eu, plc.auction and euroauctions' backend all
answer a plain request with 403. Apify actors run behind their own proxy pool
and get through, so `apify-auctions-scraper.js` runs one and reshapes its
dataset into our record. Needs `APIFY_TOKEN` in `.env`.

Two constraints worth knowing before using it:
- The account is on the **FREE** plan ($5/month of credits), so this scraper is
  **not** in `weekly-refresh.js` — run it by hand, and keep `--max-items` low.
- **Apify Proxy is not usable directly** on this plan: `proxy.apify.com` returns
  `403 x-apify-proxy-error` for every group. Running *actors* is the only route
  that works — don't write code that proxies our own fetches through Apify.

```sh
node apify-auctions-scraper.js --source rbauction --max-items 50
node apify-auctions-scraper.js --source rbauction --make DAF --year-from 2016
node apify-auctions-scraper.js --source rbauction --dry-run   # cost check
```

Note RB's European catalogue is heavily construction/plant equipment; road
tractors are a thin slice, so `--make`-targeted runs return few but relevant
lots.

### Auction sites that stay blocked

| Site | Blocker |
|------|---------|
| euroauctions.com | listings are JS-rendered; its `euroauctionslive.com/servlet/Search.do` backend is Cloudflare-gated |
| basworld.com / auction.basworld.com | Cloudflare 403 on every path |
| openlane.eu | Cloudflare 403 |
| plc.auction | 403 JS challenge on every path, incl. `/api/*` |

These need a residential proxy or a per-site Apify actor (none exists for them
in the store today).

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

For an **auction** source, the same three steps apply against the auction side:
build on `lib/auction-core.js`, write `output/<slug>/auctions.json` via
`writeAuctionOutputs`, and add `{ slug, source }` to `SOURCES` in
`load-auctions.js`.

## Mascus (Apify, dealer listings — not auctions)

`mascus-scraper.js` reaches mascus.com, which answers a plain request with 403,
by running the `rastriq/mascus-scraper` Apify actor.

It writes to **`truck_listings`**, not `auction_listings`, even though it uses
the same Apify path as the auction sources. Mascus is a dealer marketplace: a
live 25-item sample came back with `es_subasta` (is_auction) `false` on every
row, each carrying an asking price and no bid / lot number / close date. Those
are `truck_listings` rows by definition. The actor does expose an
`enlace_subasta` (auction link) field, so if genuine auction rows ever appear
they can be split out to `auction_listings` then.

Two quirks of the actor's output, both handled in the scraper:
- `images` is a JSON-encoded **string**, not an array.
- `hours` carries machine-hours OR road kilometres in one column — mileage is
  only read when the unit says `km`, so an excavator's hour count can't be
  stored as a truck's mileage.
- Every non-transport category defaults to `true` in the actor's input, so the
  scraper explicitly disables construction/agriculture/forestry/etc. Leaving
  them on burns credit on machinery we don't sell.

```sh
node mascus-scraper.js --max-items 300
node load-listings.js mascus-trucks mascus
```

## Coverage notes (probed 2026-08, save yourself the work)

**Do NOT add vavato.com or bva-auctions.com.** They run the same TBAuctions
Next.js app as Surplex/Troostwijk (BVA even serves the same `buildId`) and are
served from ONE shared catalogue. Checked live: 144 lots across three sampled
Vavato pages were **100% already in our DB by lot id** — zero new. The brands
are storefronts over the same inventory, not separate sources.

**The TBAuctions catalogue is near-exhausted.** As of the last full sweep we
hold 407/405 troostwijk trucks and 290/290 trailers (the total moves as lots
open and close). Raising `--max-pages` gains nothing; new lots only arrive as
new auctions are published, so the win is running the refresh more often, not
crawling deeper.

**rbauction is poor value for trucks.** Its European catalogue is construction
plant: a 40-lot pull spanned 21 categories with 6 excavators, 6 haul trucks and
exactly **1** truck tractor; a `--make DAF` run returned 1 lot. Prefer Mascus.
