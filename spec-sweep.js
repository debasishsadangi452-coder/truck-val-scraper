#!/usr/bin/env node
// Targeted sweep for the business's BUYING SPEC — every (model, max price, year
// window) line, pushed into each source as far as that source allows.
//
// Why this exists: the weekly refresh crawls broadly and we then filter the DB.
// That finds what happens to have been scraped. This does the opposite — it asks
// each site directly for "this model, this year, at or under this price", so the
// crawl budget is spent only on trucks that could actually be bought.
//
// HOW FAR EACH SOURCE CAN BE PUSHED (probed 2026-08):
//   otomoto.pl   — full server-side filtering: year (filter_float_year:from/to),
//                  make, free-text model query AND price (filter_float_price:to,
//                  in PLN — the scraper converts from the spec's EUR). Verified:
//                  DAF 2021-22 = 222 ads; with a 95 000 PLN cap = 1.
//   planet-trucks— make + year only (--makes, no price param on the site).
//   everything   — no server-side year or price filter at all. For those the
//   else           only lever is a deeper crawl; filtering happens in the DB.
//
// So this is deliberately NOT "force every source to filter" — most sites simply
// don't expose those parameters, and pretending otherwise would silently return
// unfiltered pages. It pushes the filter as deep as each source supports and
// reports what it could not constrain.
//
// Usage:
//   node spec-sweep.js                 # all spec lines, otomoto + planet-trucks
//   node spec-sweep.js --dry-run       # print the plan, fetch nothing
//   node spec-sweep.js --model "XF 480"
//   node spec-sweep.js --max-pages 10

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The buying spec: model label, otomoto make slug, the free-text query that
// isolates the model on-site, and the target price in EUR. Year window is
// 2021-2022 for every line, so it's a constant below.
const SPEC = [
  { label: "DAF XF 106.480", make: "daf", query: "XF 480", priceEur: 22000 },
  { label: "DAF XF 106.530", make: "daf", query: "XF 530", priceEur: 26000 },
  { label: "DAF CF", make: "daf", query: "CF", priceEur: 12000 },
  { label: "VOLVO FH 500", make: "volvo", query: "FH 500", priceEur: 48000 },
  { label: "VOLVO FH 460", make: "volvo", query: "FH 460", priceEur: 40000 },
  { label: "VOLVO FH 750", make: "volvo", query: "FH 750", priceEur: 65000 },
  { label: "VOLVO FH 540", make: "volvo", query: "FH 540", priceEur: 48000 },
  { label: "MAN TGX 18.510", make: "man", query: "TGX 18.510", priceEur: 30000 },
  { label: "MAN TGX 18.470", make: "man", query: "TGX 18.470", priceEur: 27000 },
  { label: "Ford F-MAX 500", make: "ford", query: "F-MAX", priceEur: 13000 },
];

// Trailer brands are matched by make alone (no model line in the spec).
const TRAILER_SPEC = [
  { label: "Kogel", make: "kogel", priceEur: 13000 },
  { label: "Krone", make: "krone", priceEur: 11000 },
  { label: "Fliegl", make: "fliegl", priceEur: 9000 },
  { label: "Wielton", make: "wielton", priceEur: 9000 },
];

const YEAR_FROM = 2021;
const YEAR_TO = 2022;

function parseArgs(argv) {
  const args = { dryRun: false, maxPages: 5, model: null, trailers: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--no-trailers") args.trailers = false;
  }
  return args;
}

function run(label, scriptArgs, { dryRun }) {
  console.log(`\n=== ${label} ===`);
  if (dryRun) {
    console.log(`  [dry run] node ${scriptArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`);
    return true;
  }
  const res = spawnSync(process.execPath, scriptArgs, { stdio: "inherit", cwd: __dirname });
  if (res.status !== 0) {
    // One spec line failing must not abort the sweep — report and continue.
    console.error(`  [skip] ${label} exited ${res.status}`);
    return false;
  }
  return true;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const lines = args.model
    ? SPEC.filter((s) => s.label.toLowerCase().includes(args.model.toLowerCase()))
    : SPEC;

  if (lines.length === 0) {
    console.error(`No spec line matches --model "${args.model}".`);
    process.exit(1);
  }

  console.log(
    `--- spec sweep: ${lines.length} model line(s), years ${YEAR_FROM}-${YEAR_TO}, ` +
      `max ${args.maxPages} page(s) each ---`,
  );

  // ---- otomoto.pl: year + make + model query + PRICE, all server-side --------
  for (const line of lines) {
    run(
      `otomoto — ${line.label} <= EUR ${line.priceEur}`,
      [
        path.join(__dirname, "otomoto-scraper.js"),
        "--year-from", String(YEAR_FROM),
        "--year-to", String(YEAR_TO),
        "--makes", line.make,
        "--query", line.query,
        "--price-to", String(line.priceEur),
        "--max-pages", String(args.maxPages),
        "--no-details",
      ],
      args,
    );
  }

  // ---- otomoto trailers: make + price (trailers live in their own category) --
  if (args.trailers && !args.model) {
    for (const line of TRAILER_SPEC) {
      run(
        `otomoto trailers — ${line.label} <= EUR ${line.priceEur}`,
        [
          path.join(__dirname, "otomoto-scraper.js"),
          "--category", "trailers",
          "--year-from", String(YEAR_FROM),
          "--year-to", String(YEAR_TO),
          "--makes", line.make,
          "--price-to", String(line.priceEur),
          "--max-pages", String(args.maxPages),
          "--no-details",
        ],
        args,
      );
    }
  }

  // ---- planet-trucks: make + year only (site exposes no price filter) -------
  // Run once for the distinct makes rather than per spec line, since without a
  // price param the per-line crawls would be identical work repeated.
  const makes = [...new Set(lines.map((l) => l.make))].join(",");
  run(
    `planet-trucks — makes=[${makes}] (no server-side price filter)`,
    [
      path.join(__dirname, "planet-trucks-scraper.js"),
      "--makes", makes,
      "--max-pages", String(args.maxPages),
    ],
    args,
  );

  // ---- load everything the sweep produced ------------------------------------
  run("Load into Postgres", [path.join(__dirname, "load-listings.js")], args);

  console.log("\n--- spec sweep complete ---");
  console.log(
    "NOTE: autoline, truckscout24, via-mobilis, mobile.bg, autovit, sauto.cz and\n" +
      "dafusedtrucks expose NO server-side year or price filter — their rows are\n" +
      "filtered in the database instead. Only otomoto supports the full\n" +
      "(model + year + price) cut at the source.",
  );
}

main();
