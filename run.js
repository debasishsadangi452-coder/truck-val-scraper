#!/usr/bin/env node
// One-shot weekly entrypoint for the standalone scraper (Railway cron / local).
//
// Scrapes every verified-working source, then loads them all into Postgres in a
// single pass, then exits. Railway's cron re-runs the whole container on its
// cadence, so this must terminate. It exits non-zero only if the *load* step
// fails — the individual scrapers are best-effort, because one flaky site (or a
// datacenter IP tripping a browser source's anti-bot gate) shouldn't fail the
// whole weekly refresh.
//
// Both layers are upsert-based, so re-running never duplicates:
//   - each <source>-scraper.js upserts by listing id into output/<slug>/.
//   - load-listings.js upserts into truck_listings on (source, source_id).
//
// Config via env (set on the Railway service or a local .env):
//   DATABASE_URL          required — SAME DB as the TruckVal web app
//   <SOURCE>_PAGES        result pages to crawl per source (defaults below)
//   TRUCK1_CONCURRENCY    truck1 detail-page pool size (default 3 — stay polite)
//   TRUCK1_START          optional truck1 start/category URL
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Run a step. `required:false` logs the failure and continues instead of
// aborting the whole run (used for the per-source scrapers).
function run(label, args, { required = true } = {}) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit", cwd: __dirname });
  if (result.status !== 0) {
    const msg = `${label} failed with exit code ${result.status}`;
    if (required) throw new Error(msg);
    console.error(`[skip] ${msg} — continuing (best-effort source).`);
    return false;
  }
  return true;
}

const script = (name) => path.join(__dirname, name);
const pages = (envName, def) => String(process.env[envName] || def);

// --- Plain-HTTP sources (cheap, reliable — run every time) -------------------
// [envVar, defaultPages, scraperFile, extraArgs]
const HTTP_SOURCES = [
  ["OTOMOTO_PAGES", "40", "otomoto-scraper.js", ["--no-details"]],
  ["AUTOLINE_PAGES", "40", "autoline-scraper.js", []],
  ["TRUCK7_PAGES", "40", "truck7-scraper.js", ["--no-details"]],
  ["AUTOLINE_BG_PAGES", "60", "autoline-bg-scraper.js", []],
  ["AUTOVIT_PAGES", "40", "autovit-scraper.js", []],
  ["MOBILEBG_PAGES", "40", "mobilebg-scraper.js", ["--no-details"]],
  ["TRUCKSCOUT24_PAGES", "8", "truckscout24-scraper.js", ["--no-details"]],
];

for (const [envVar, def, file, extra] of HTTP_SOURCES) {
  const p = pages(envVar, def);
  run(`Scrape ${file} (${p} pages)`, [script(file), "--max-pages", p, ...extra], {
    required: false, // one flaky site shouldn't fail the whole weekly refresh
  });
}

// --- Browser (Playwright) source — best-effort on datacenter IPs -------------
const TRUCK1_PAGES = pages("TRUCK1_PAGES", "20");
const truck1Args = [
  script("truck1-scraper.js"),
  "--pages",
  TRUCK1_PAGES,
  "--concurrency",
  pages("TRUCK1_CONCURRENCY", "3"),
];
if (process.env.TRUCK1_START) truck1Args.push("--start-url", process.env.TRUCK1_START);
run(`Scrape truck1.eu (${TRUCK1_PAGES} pages)`, truck1Args, { required: false });

// --- Load everything that produced output/ into Postgres --------------------
// load-listings.js with no args upserts every registered source that has a file.
run("Load all sources into Postgres", [script("load-listings.js")]);

// --- AUCTION sources (own table) --------------------------------------------
// Auction lots go to auction_listings, not truck_listings (see
// scripts/db/auction-schema.sql for why). They MUST be re-scraped on the same
// cadence as everything else — more so, in fact: a lot's `current_bid_amount`
// and `bidding_status` are live values that go stale the moment bidding moves,
// and lots close and disappear within days. The upsert refreshes the bid on
// every existing lot and adds newly-published ones, so a weekly tick keeps the
// table self-correcting rather than accumulating dead rows.
//
// Both TBAuctions platforms are plain HTTP, so they're cheap enough to run every
// time. rbauction/mascus are NOT here — they need metered Apify credits and are
// run by hand (see SCRAPERS.md).
const AUCTION_PAGES = pages("AUCTION_PAGES", "15");
for (const platform of ["surplex", "troostwijk"]) {
  for (const category of ["trucks", "trailers"]) {
    run(
      `Scrape ${platform} auctions (${category}, ${AUCTION_PAGES} pages)`,
      [
        script("tbauctions-scraper.js"),
        "--platform",
        platform,
        "--category",
        category,
        "--max-pages",
        AUCTION_PAGES,
      ],
      { required: false },
    );
  }
}

run("Load auctions into Postgres", [script("load-auctions.js")]);

console.log("\n=== refresh complete ===");
