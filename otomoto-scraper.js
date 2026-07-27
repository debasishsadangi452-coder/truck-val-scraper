#!/usr/bin/env node
// Scrapes truck listings (category "ciezarowe") from otomoto.pl.
//
// List pages embed the full result set as structured JSON in a __NEXT_DATA__
// script tag (a GraphQL/urql cache) — no HTML scraping/selectors needed for
// the core fields (make, model, year, mileage, power, price, location).
//
// A thumbnail image URL (list-page, cheap) is captured for every listing
// regardless of --details. Detail pages (--details, on by default) add
// fields only available per-ad: axle configuration (wheel_formula), gearbox,
// weights, CO2, country of origin, condition flags, full dealer address, and
// up to 8 full-size gallery photo URLs.
//
// Every run re-fetches the full requested scope and upserts by listing id —
// existing entries get their fields refreshed (price/mileage changes etc.),
// new ones get added, and scripts-output/otomoto-trucks/listings.{json,csv}
// are rewritten from that single deduped map, so there's never a duplicate
// row. (scripts/db/load-listings.js upserts the same way into Postgres, on
// (source, source_id) — the two layers can't drift into duplicates.)
//
// Deliberately NOT collected, because the source doesn't expose them:
//   - VIN: only a boolean "has VIN" filter exists on otomoto.pl; the actual
//     number is never published in the ad.
//   - First registration date: present on the page but encrypted
//     (`date_registration` is a ciphertext blob), gated behind a paid
//     vehicle-history check — not recoverable by scraping.
//   - Euro emission standard: not a tracked field for the trucks category on
//     otomoto.pl at all (checked against the site's full filter schema).
//
// robots.txt for otomoto.pl allows crawling /ciezarowe with query strings
// (verified: only /catalog/*/*/, /account/, /api/, etc. are disallowed).
//
// Usage:
//   node scripts/otomoto-trucks-scraper.js
//   node scripts/otomoto-trucks-scraper.js --year-from 2020 --year-to 2025 --max-pages 40
//   node scripts/otomoto-trucks-scraper.js --makes volvo,scania,daf,man,mercedes-benz
//   node scripts/otomoto-trucks-scraper.js --query "FH,R450,XF 480,TGX 18.510,Actros"
//   node scripts/otomoto-trucks-scraper.js --no-details   # list-page fields only, faster
//   node scripts/otomoto-trucks-scraper.js --concurrency 4 # detail pages fetched N-at-a-time (default 4)
//
// No dependencies beyond Node's built-in fetch (Node 18+).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = "https://www.otomoto.pl/ciezarowe";
const OUTPUT_DIR = path.join(__dirname, "..", "scripts-output", "otomoto-trucks");
const CSV_FILE = path.join(OUTPUT_DIR, "listings.csv");
const JSON_FILE = path.join(OUTPUT_DIR, "listings.json");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const FIELDNAMES = [
  "id",
  "url",
  "title",
  "make",
  "model",
  "year",
  "mileage_km",
  "fuel_type",
  "engine_capacity_cc",
  "engine_power_hp",
  "axle_configuration",
  "wheel_axis",
  "gearbox",
  "gross_weight_kg",
  "payload_kg",
  "co2_g_km",
  "country_origin",
  "condition_registered",
  "condition_no_accident",
  "condition_service_record",
  "price_amount",
  "price_currency",
  "city",
  "region",
  "dealer_address",
  "dealer_postal_code",
  "seller_name",
  "dealer_website",
  "latitude",
  "longitude",
  "thumbnail_url",
  "image_urls",
  "created_at",
  "scraped_at",
];

// Detail-page photo URLs join with this when flattened into the CSV/JSON
// record; the DB loader splits back into a Postgres TEXT[] on load.
const IMAGE_URL_SEPARATOR = "|";

function parseArgs(argv) {
  const args = {
    yearFrom: 2021,
    yearTo: 2022,
    maxPages: 50,
    delayMs: [1500, 3000],
    detailDelayMs: [1000, 2000],
    details: true,
    // How many detail pages to fetch in parallel per list page. Kept low by
    // default — otomoto.pl throttles (502/520) under bursty load, and a small
    // pool with jittered delays is both faster than serial and safe. Raise with
    // --concurrency N at your own risk of getting rate-limited.
    concurrency: 4,
    makes: [],
    queries: [""],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--year-from") args.yearFrom = Number(argv[++i]);
    else if (a === "--year-to") args.yearTo = Number(argv[++i]);
    else if (a === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (a === "--concurrency") args.concurrency = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--no-details") args.details = false;
    else if (a === "--makes")
      args.makes = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === "--query")
      args.queries = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay([min, max]) {
  return sleep(min + Math.random() * (max - min));
}

// Runs `worker(item)` over `items` with at most `limit` in flight at once —
// bounded parallelism. A fixed pool of workers each pull the next index from a
// shared cursor, so slow requests don't stall the others. Results are collected
// in input order. Used to fetch several detail pages concurrently per list page.
async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

function buildPageUrl(yearFrom, yearTo, page, makes, query) {
  const params = new URLSearchParams();
  params.set("search[filter_float_year:from]", String(yearFrom));
  params.set("search[filter_float_year:to]", String(yearTo));
  makes.forEach((make, i) => params.set(`search[filter_enum_make][${i}]`, make));
  if (query) params.set("search[qr]", query);
  if (page > 1) params.set("page", String(page));
  return `${BASE_URL}?${params.toString()}`;
}

async function fetchPage(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      console.warn(`  attempt ${attempt}/${retries} failed for ${url}: ${err.message}`);
      if (attempt < retries) await sleep(2000 * attempt);
    }
  }
  return null;
}

function extractNextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  return match ? JSON.parse(match[1]) : null;
}

function extractAdvertSearch(html) {
  const data = extractNextData(html);
  const urqlState = data?.props?.pageProps?.urqlState;
  if (!urqlState) return null;
  for (const key of Object.keys(urqlState)) {
    // A throttled/partial page can have a urql entry with no `.data` string —
    // guard the parse so one bad page returns null (caller stops that query)
    // instead of crashing the whole crawl.
    const raw = urqlState[key]?.data;
    if (typeof raw !== "string") continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed?.advertSearch) return parsed.advertSearch;
  }
  return null;
}

function extractAdvertDetails(html) {
  const data = extractNextData(html);
  return data?.props?.pageProps?.advert ?? null;
}

function paramValue(parameters, key) {
  return parameters?.find((p) => p.key === key)?.value ?? "";
}

// `existing` is this listing's previously-stored record, if any. Fields only
// available from the detail page (axle config, gearbox, weights, condition,
// dealer address, gallery images...) default to whatever was already known
// rather than blanking, so a --no-details run never erases data a prior
// --details run collected — enrichWithDetail() overwrites them with fresh
// values when this run does fetch the detail page.
function toRecord(edge, scrapedAt, existing) {
  const node = edge.node;
  const params = node.parameters;
  return {
    id: node.id,
    url: node.url,
    title: node.title,
    make: paramValue(params, "make"),
    model: paramValue(params, "model"),
    year: paramValue(params, "year"),
    mileage_km: paramValue(params, "mileage"),
    fuel_type: paramValue(params, "fuel_type"),
    engine_capacity_cc: paramValue(params, "engine_capacity"),
    engine_power_hp: paramValue(params, "engine_power"),
    axle_configuration: existing?.axle_configuration ?? "",
    wheel_axis: existing?.wheel_axis ?? "",
    gearbox: existing?.gearbox ?? "",
    gross_weight_kg: existing?.gross_weight_kg ?? "",
    payload_kg: existing?.payload_kg ?? "",
    co2_g_km: existing?.co2_g_km ?? "",
    country_origin: existing?.country_origin ?? "",
    condition_registered: existing?.condition_registered ?? "",
    condition_no_accident: existing?.condition_no_accident ?? "",
    condition_service_record: existing?.condition_service_record ?? "",
    price_amount: node.price?.amount?.value ?? "",
    price_currency: node.price?.amount?.currencyCode ?? "",
    city: node.location?.city?.name ?? "",
    region: node.location?.region?.name ?? "",
    dealer_address: existing?.dealer_address ?? "",
    dealer_postal_code: existing?.dealer_postal_code ?? "",
    seller_name: node.sellerLink?.name ?? "",
    dealer_website: existing?.dealer_website ?? "",
    // Dealer coordinates are only on the detail page (advert.seller.location.map);
    // preserve any previously-scraped value on a --no-details run.
    latitude: existing?.latitude ?? "",
    longitude: existing?.longitude ?? "",
    // x1 (320x240) — cheap, present on every list-page result regardless of
    // --details. The frontend derives larger sizes by swapping the ";s=WxH"
    // suffix, so this alone covers small-thumbnail use everywhere.
    thumbnail_url: node.thumbnail?.x1 ?? "",
    image_urls: existing?.image_urls ?? "",
    created_at: node.createdAt ?? "",
    scraped_at: scrapedAt,
  };
}

function detailValue(details, key) {
  return details?.find((d) => d.key === key)?.value ?? "";
}

function stripUnit(value) {
  return value.replace(/[^\d]/g, "");
}

function enrichWithDetail(record, advert) {
  const details = advert.details;
  record.axle_configuration = detailValue(details, "wheel_formula");
  record.wheel_axis = detailValue(details, "wheel_axis");
  record.gearbox = detailValue(details, "gearbox");
  record.gross_weight_kg = stripUnit(detailValue(details, "permissible_total_weight"));
  record.payload_kg = stripUnit(detailValue(details, "max_weight"));
  record.co2_g_km = stripUnit(detailValue(details, "co2_emissions"));
  record.country_origin = detailValue(details, "country_origin");
  record.condition_registered = detailValue(details, "registered");
  record.condition_no_accident = detailValue(details, "no_accident");
  record.condition_service_record = detailValue(details, "service_record");
  const loc = advert.seller?.location;
  if (loc) {
    record.dealer_address = loc.address ?? "";
    record.dealer_postal_code = loc.postalCode ?? "";
    // Exact dealer coordinates, e.g. { latitude: 50.86, longitude: 15.79 }.
    record.latitude = loc.map?.latitude ?? "";
    record.longitude = loc.map?.longitude ?? "";
  }
  record.dealer_website = advert.seller?.website ?? "";
  const photos = advert.images?.photos ?? [];
  record.image_urls = photos
    .slice(0, 8)
    .map((p) => p.url)
    .join(IMAGE_URL_SEPARATOR);
  return record;
}

function csvEscape(value) {
  const str = String(value ?? "");
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

async function loadExisting() {
  if (!existsSync(JSON_FILE)) return new Map();
  try {
    const records = JSON.parse(await readFile(JSON_FILE, "utf8"));
    return new Map(records.map((r) => [r.id, r]));
  } catch {
    return new Map();
  }
}

async function writeOutputs(byId) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const records = [...byId.values()];
  await writeFile(JSON_FILE, JSON.stringify(records, null, 2));

  const lines = [FIELDNAMES.join(",")];
  for (const rec of records) {
    lines.push(FIELDNAMES.map((f) => csvEscape(rec[f])).join(","));
  }
  await writeFile(CSV_FILE, lines.join("\n") + "\n");
}

async function runQuery(
  { yearFrom, yearTo, maxPages, delayMs, detailDelayMs, details, concurrency, makes, query },
  byId,
  processedInRun,
  scrapedAt,
  counts,
) {
  const label = query ? `query="${query}"` : "(no query)";
  console.log(
    `--- otomoto.pl scrape: years ${yearFrom}-${yearTo}, makes=[${makes.join(",") || "any"}], ${label} ---`,
  );

  for (let page = 1; page <= maxPages; page++) {
    const url = buildPageUrl(yearFrom, yearTo, page, makes, query);
    console.log(`fetching page ${page}: ${url}`);
    const html = await fetchPage(url);
    if (!html) {
      console.error(`  failed to fetch page ${page}, stopping.`);
      break;
    }

    const search = extractAdvertSearch(html);
    if (!search || search.edges.length === 0) {
      console.log(`  no listings on page ${page}, end of results.`);
      break;
    }

    const totalCount = search.totalCount;
    // Pagination can drift (new ads land on page 1 mid-crawl, pushing others
    // forward) — skip anything already handled earlier in *this* run so we
    // don't double-fetch its detail page, without permanently blacklisting
    // ids across runs the way a persisted seen-ids file would.
    const edges = search.edges.filter((e) => !processedInRun.has(e.node.id));
    console.log(
      `  ${search.edges.length} listings on page (${edges.length} not yet processed this run)`,
    );

    // Build the base records first (cheap, from list-page data), marking each
    // processed so a later page's drift doesn't re-handle it.
    const pageRecords = edges.map((edge) => {
      processedInRun.add(edge.node.id);
      const existing = byId.get(edge.node.id);
      return { record: toRecord(edge, scrapedAt, existing), isUpdate: existing !== undefined };
    });

    if (details) {
      // Fetch this page's detail pages with bounded parallelism — several at a
      // time instead of one after another. A small jittered delay per fetch
      // keeps the aggregate request rate polite even while running concurrently.
      await mapPool(pageRecords, concurrency, async ({ record }) => {
        const detailHtml = await fetchPage(record.url);
        if (detailHtml) {
          const advert = extractAdvertDetails(detailHtml);
          if (advert) enrichWithDetail(record, advert);
        }
        await randomDelay(detailDelayMs);
      });
    }

    // Commit sequentially — Map/counter writes stay single-threaded and safe.
    for (const { record, isUpdate } of pageRecords) {
      byId.set(record.id, record);
      if (isUpdate) counts.updated++;
      else counts.added++;
    }

    const { pageSize, currentOffset } = search.pageInfo;
    if (currentOffset + pageSize >= totalCount) {
      console.log("  reached last page.");
      break;
    }

    await randomDelay(delayMs);
  }
}

async function runScrape(args) {
  const byId = await loadExisting();
  const startCount = byId.size;
  const processedInRun = new Set();
  const scrapedAt = new Date().toISOString();
  const counts = { added: 0, updated: 0 };

  for (const query of args.queries) {
    await runQuery({ ...args, query }, byId, processedInRun, scrapedAt, counts);
  }

  await writeOutputs(byId);

  console.log(
    `--- done: ${counts.added} new, ${counts.updated} refreshed, ${byId.size} total (was ${startCount}) ---`,
  );
  return counts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await runScrape(args);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
