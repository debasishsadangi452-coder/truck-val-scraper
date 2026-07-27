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

// ---- load everything into Postgres (all sources, upsert) -------------------
run("Load into Postgres", process.execPath, [path.join(__dirname, "load-listings.js")]);

console.log("\n=== weekly refresh complete ===");
