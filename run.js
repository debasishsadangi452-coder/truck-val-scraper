#!/usr/bin/env node
// One-shot entrypoint for the standalone browser scraper (Railway cron / local).
//
// Runs the Truck1 Playwright crawl, then loads the result into Postgres, then
// exits. Railway's cron schedule re-runs the whole container on its cadence, so
// this must terminate (non-zero on failure so a bad run shows up in Railway).
//
// Config via env (set on the Railway service or a local .env):
//   DATABASE_URL       required — SAME DB as the TruckVal web app
//   TRUCK1_PAGES       result pages to crawl (default 20)
//   TRUCK1_START       optional start/category URL (default: all trucks)
//   TRUCK1_CONCURRENCY detail-page pool size (default 3 — keep it polite)
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PAGES = process.env.TRUCK1_PAGES || "20";
const CONCURRENCY = process.env.TRUCK1_CONCURRENCY || "3";
const START = process.env.TRUCK1_START;

function run(label, args) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit", cwd: __dirname });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

// --- autoline.bg (plain HTTP, no browser — cheap, run it every time) ---------
const AUTOLINE_BG_PAGES = process.env.AUTOLINE_BG_PAGES || "60";
run(`Scrape autoline.bg (${AUTOLINE_BG_PAGES} pages)`, [
  path.join(__dirname, "autoline-bg-scraper.js"),
  "--max-pages",
  String(AUTOLINE_BG_PAGES),
]);
run("Load autoline.bg", [
  path.join(__dirname, "load-listings.js"),
  "autoline-bg-trucks",
  "autoline_bg",
]);

// --- truck1.eu (Playwright; heavier, anti-bot risk on datacenter IPs) --------
const scraperArgs = [
  path.join(__dirname, "truck1-scraper.js"),
  "--pages",
  String(PAGES),
  "--concurrency",
  String(CONCURRENCY),
];
if (START) scraperArgs.push("--start-url", START);

run(`Scrape truck1.eu (${PAGES} pages)`, scraperArgs);
run("Load truck1", [path.join(__dirname, "load-listings.js"), "truck1-trucks", "truck1"]);

console.log("\n=== refresh complete ===");
