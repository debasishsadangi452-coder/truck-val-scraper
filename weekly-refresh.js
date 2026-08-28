#!/usr/bin/env node
// Weekly data-refresh job: re-scrape the working sources and upsert the result
// into Postgres.
//
// Both layers are upsert-based, so re-running this never creates duplicates:
//   - each <source>-scraper.js upserts by listing id into its own
//     scripts-output/<slug>/listings.json (existing entries get refreshed with
//     the latest scrape, e.g. price changes; new listings get added).
//   - load-listings.js upserts into truck_listings on (source, source_id).
//
// Sources that run here (verified scrapable with plain requests, 2026-07):
//   otomoto.pl, autoline.info, truck7.eu.
// The other six target sites (truck1, trucks.nl, truckstore, man-topused,
// usedvolvotrucks, oktrucks) are documented stubs that need a headless browser
// and/or residential IP — see their scripts/*-trucks-scraper.js. Add them here
// once enabled.
//
// otomoto runs list-page fields only (--no-details) by default — full
// detail-page enrichment for the whole scope every week is a much heavier
// crawl. Pass --details to also refresh axle config / dealer address / flags.
//
// Usage:
//   node scripts/weekly-refresh.js
//   node scripts/weekly-refresh.js --details
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const withDetails = process.argv.includes("--details");

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_FROM = CURRENT_YEAR - 7;
const MAKES = "volvo,scania,daf,man,mercedes-benz";

// Priority tractor-unit models the business actively sources. otomoto gets a
// second, targeted pass on these queries so we pull MORE of them than the broad
// make-sweep alone would (deeper into the result set, model-specific). Comma-
// separated; each becomes its own otomoto search[qr] query.
const PRIORITY_TRUCK_QUERIES = [
  "XF 480",
  "XF 530",
  "CF",
  "FH 500",
  "FH 460",
  "FH 540",
  "FH 750",
  "TGX 18.510",
  "TGX 18.470",
  "F-MAX",
].join(",");

// Priority trailer brands as otomoto make slugs, for the /przyczepy category
// pass. These are curtainside/reefer semi-trailers, a separate category from
// tractor units — see the trailer pass below.
const PRIORITY_TRAILER_MAKES = ["kogel", "krone", "fliegl", "wielton"].join(",");

function run(label, command, args) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: __dirname,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

// ---- otomoto.pl (scoped by brand + year window) ----------------------------
const otomotoArgs = [
  path.join(__dirname, "otomoto-scraper.js"),
  "--year-from",
  String(YEAR_FROM),
  "--year-to",
  String(CURRENT_YEAR),
  "--makes",
  MAKES,
  "--max-pages",
  "120",
];
if (!withDetails) otomotoArgs.push("--no-details");
run(`Scrape otomoto.pl (${YEAR_FROM}-${CURRENT_YEAR}, ${MAKES})`, process.execPath, otomotoArgs);

// ---- otomoto.pl targeted pass: pull MORE of the priority models ------------
// A second scoped crawl on the specific models we sell. Each query is its own
// search, so together they reach deeper into each model's result set than the
// single broad make-sweep above (which is capped by --max-pages across ALL
// makes). Upsert-by-id means this only adds/refreshes — never duplicates.
const otomotoPriorityArgs = [
  path.join(__dirname, "otomoto-scraper.js"),
  "--year-from", String(YEAR_FROM),
  "--year-to", String(CURRENT_YEAR),
  "--makes", MAKES,
  "--query", PRIORITY_TRUCK_QUERIES,
  "--max-pages", "40",
];
if (!withDetails) otomotoPriorityArgs.push("--no-details");
run("Scrape otomoto.pl (priority models)", process.execPath, otomotoPriorityArgs);

// ---- otomoto.pl trailer brands (the /przyczepy category, make-scoped) -------
// Trailers live in a different otomoto category than tractor units, so this pass
// targets /przyczepy with the trailer brands as make filters (search[qr] is
// ignored there). Writes to its own otomoto-trailers output folder.
const otomotoTrailerArgs = [
  path.join(__dirname, "otomoto-scraper.js"),
  "--category", "trailers",
  "--year-from", String(YEAR_FROM),
  "--year-to", String(CURRENT_YEAR),
  "--makes", PRIORITY_TRAILER_MAKES,
  "--max-pages", "30",
];
if (!withDetails) otomotoTrailerArgs.push("--no-details");
run("Scrape otomoto.pl trailers (Kögel/Krone/Fliegl/Wielton)", process.execPath, otomotoTrailerArgs);

// ---- autoline.info (whole trucks category, JSON-LD list pages) -------------
run("Scrape autoline.info", process.execPath, [
  path.join(__dirname, "autoline-scraper.js"),
  "--max-pages",
  "60",
]);

// ---- truck7.eu (Livewire-paginated, detail pages; trucks only) -------------
// --type truck is the scraper default but set explicitly here. ~2,470 trucks /
// 10 per page ≈ 250 pages; the crawl stops early at the last page regardless.
run("Scrape truck7.eu (trucks)", process.execPath, [
  path.join(__dirname, "truck7-scraper.js"),
  "--type",
  "truck",
  "--max-pages",
  "300",
]);

// ---- autoline.bg (Bulgaria, plain HTTP JSON-LD) ----------------------------
run("Scrape autoline.bg", process.execPath, [
  path.join(__dirname, "autoline-bg-scraper.js"),
  "--max-pages",
  "60",
]);

// ---- truckscout24.com (trucks > 7.5t, plain HTTP + detail pages) -----------
run("Scrape truckscout24.com", process.execPath, [
  path.join(__dirname, "truckscout24-scraper.js"),
  "--max-pages",
  "40",
]);

// ---- truckstore.com (Mercedes-Benz used trucks, JSON API) ------------------
run("Scrape truckstore.com", process.execPath, [path.join(__dirname, "truckstore-scraper.js")]);

// ---- autovit.ro (Romania, OLX __NEXT_DATA__ list pages) --------------------
run("Scrape autovit.ro", process.execPath, [
  path.join(__dirname, "autovit-scraper.js"),
  "--max-pages",
  "40",
]);

// ---- mobile.bg (Bulgaria, cp1251 HTML + detail pages) ----------------------
run("Scrape mobile.bg", process.execPath, [
  path.join(__dirname, "mobilebg-scraper.js"),
  "--max-pages",
  "40",
]);

// ---- sauto.cz (Czechia, JSON API — trucks + trailers) ----------------------
run("Scrape sauto.cz (Czechia)", process.execPath, [path.join(__dirname, "sauto-cz-scraper.js")]);

// ---- planet-trucks.com (France, priority makes) ----------------------------
run("Scrape planet-trucks.com (France)", process.execPath, [
  path.join(__dirname, "planet-trucks-scraper.js"),
  "--concurrency",
  "2",
]);

// ---- autoplius.lt (Lithuania, Playwright + residential proxy) ---------------
// Cloudflare-gated: only runs when PROXY_URL points at a residential proxy.
// Skipped (not failed) otherwise, so the scheduled refresh never breaks on it.
if (process.env.PROXY_URL) {
  run("Scrape autoplius.lt (Lithuania)", process.execPath, [
    path.join(__dirname, "autoplius-lt-scraper.js"),
    "--pages",
    "15",
  ]);
} else {
  console.log("\n=== Skip autoplius.lt (Lithuania): set PROXY_URL (residential proxy) to enable ===");
}

// ---- load everything into Postgres (all sources, upsert) -------------------
run("Load into Postgres", process.execPath, [path.join(__dirname, "load-listings.js")]);

// ---- AUCTIONS: surplex + troostwijk (the TBAuctions platform) --------------
// These are auction lots, not dealer ads, so they load into their own table via
// load-auctions.js — see scripts/db/auction-schema.sql for why they're kept out
// of truck_listings. Both platforms are plain HTTP, so they belong in this
// weekly pass. rbauction is NOT here: it needs metered Apify credits, so it's
// run by hand (apify-auctions-scraper.js — see SCRAPERS.md).
for (const platform of ["surplex", "troostwijk"]) {
  for (const category of ["trucks", "trailers"]) {
    run(`Scrape ${platform} auctions (${category})`, process.execPath, [
      path.join(__dirname, "tbauctions-scraper.js"),
      "--platform",
      platform,
      "--category",
      category,
      "--max-pages",
      "15",
    ]);
  }
}

run("Load auctions into Postgres", process.execPath, [path.join(__dirname, "load-auctions.js")]);

console.log("\n=== weekly refresh complete ===");
