#!/usr/bin/env node
// Scrapes truck listings from truckscout24.com — plain HTTP (no browser).
//
// The .com search endpoint is a server-rendered Yii2 page (unlike the .de host,
// which is JS/reCAPTCHA-gated). The search results page lists 25 detail links per
// page as /tsp/ts-<id>, paginated with ?page=N, over ~12k trucks. Each detail
// page (/tsp/ts-...) is server-rendered HTML with a <dt>/<dd> spec table
// (Manufacturer, Model, Year of construction, Power, Fuel type, Axle
// configuration, Gearing type, Emission class, Color, Location, dimensions...)
// plus a price in a bold heading span, and a JSON-LD Product for name/category.
//
// Strategy (same as truck7/truck1): harvest detail IDs from each search page,
// then fetch + parse each detail page. Writes output/truckscout24-trucks/
// listings.json; load with:
//   node load-listings.js truckscout24-trucks truckscout24
//
// The default search is mainCategoryIds=246 (trucks over 7.5t). Prices are shown
// only on listings that publish one (some are "on request") — left blank then.
// A reCAPTCHA widget appears in the page footer but does NOT gate the content
// (the full HTML is served to plain requests).
//
// Usage:
//   node truckscout24-scraper.js --max-pages 20
//   node truckscout24-scraper.js --search "<full search URL>" --max-pages 5
//   node truckscout24-scraper.js --no-details   # list-page ids only, faster

import {
  fetchText,
  normaliseRecord,
  writeOutputs,
  loadExisting,
  randomDelay,
  mapPool,
} from "./lib/scrape-core.js";
import { stripTags, firstMatch, digits } from "./lib/html-utils.js";

const SLUG = "truckscout24-trucks";
const BASE = "https://www.truckscout24.com";
const CATEGORY = "mainCategoryIds=246"; // trucks > 7.5t

// truckscout24's anonymous search caps at 8 pages (200 listings) PER QUERY, no
// matter the true total (~12,400). To reach more without logging in, we run one
// query PER COUNTRY (the `countries=<CC>` filter genuinely narrows results and
// gives each country its own 8-page window). These are the codes with stock
// (probed 2026-07); "" is the catch-all unfiltered query run first.
const COUNTRIES = [
  "",
  "DE",
  "NL",
  "IT",
  "BE",
  "PL",
  "AT",
  "EE",
  "FR",
  "DK",
  "ES",
  "HU",
  "CZ",
  "LV",
  "LT",
  "RO",
  "SE",
  "PT",
  "SK",
];

// ISO country code → English name. Because we crawl one query PER country, we
// already know each listing's country from the search window — so we can set it
// even on a --no-details run (the detail page is the only OTHER source of
// location, so without this, --no-details left country_origin blank).
const CC_NAME = {
  DE: "Germany",
  NL: "Netherlands",
  IT: "Italy",
  BE: "Belgium",
  PL: "Poland",
  AT: "Austria",
  EE: "Estonia",
  FR: "France",
  DK: "Denmark",
  ES: "Spain",
  HU: "Hungary",
  CZ: "Czechia",
  LV: "Latvia",
  LT: "Lithuania",
  RO: "Romania",
  SE: "Sweden",
  PT: "Portugal",
  SK: "Slovakia",
};

function searchUrl(country) {
  const q = country ? `${CATEGORY}&countries=${country}` : CATEGORY;
  return `${BASE}/main/search/index?${q}`;
}

function parseArgs(argv) {
  // maxPages caps pages PER country query (site hard-limits to 8 anyway).
  const args = { maxPages: 8, concurrency: 4, details: true, search: null, countries: COUNTRIES };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (a === "--concurrency") args.concurrency = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--no-details") args.details = false;
    else if (a === "--search") args.search = argv[++i];
    else if (a === "--countries") args.countries = argv[++i].split(",").map((c) => c.trim());
  }
  return args;
}

function searchPageUrl(search, page) {
  if (page <= 1) return search;
  return `${search}${search.includes("?") ? "&" : "?"}page=${page}`;
}

// Detail links look like /tsp/ts-219-75-158 — capture the ts-<id> slug.
function listingSlugs(html) {
  return [...new Set([...html.matchAll(/\/tsp\/(ts-[\d-]+)/g)].map((m) => m[1]))];
}

// Flatten the detail page's <dt>Label:</dt><dd>Value</dd> spec list into
// { lowercased label: value }.
function specMap(html) {
  const map = {};
  const re = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g;
  let m;
  while ((m = re.exec(html))) {
    const label = stripTags(m[1]).replace(/:\s*$/, "").toLowerCase();
    const value = stripTags(m[2]);
    if (label) map[label] = value;
  }
  return map;
}

// "309 kW (420.12 HP)" → "420" (keep HP; fall back to the leading number).
function powerHp(value) {
  const hp = firstMatch(value, /\(([\d.]+)\s*HP\)/i);
  if (hp) return String(Math.round(parseFloat(hp)));
  return digits(firstMatch(value, /^([\d\s.,]+)/));
}

// "Chassis cabAstra HD9" (H1 = category + name). We don't rely on it — make and
// model come from the dt spec fields, which are clean.
async function enrichDetail(record) {
  const html = await fetchText(record.url);
  if (!html) return;
  const spec = specMap(html);

  const make = spec["manufacturer"] || spec["make"] || spec["brand"] || "";
  const model = spec["model"] || "";
  const title = stripTags((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ?? [])[1] ?? "");

  // Location is ", Country" or "City, Country".
  const loc = (spec["location"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const country = loc.length ? loc[loc.length - 1] : "";
  const city = loc.length > 1 ? loc.slice(0, -1).join(", ") : "";

  // Price: a bold heading span like "€109,000" (JSON-LD offers is empty).
  const priceText = firstMatch(html, /€\s?([\d.,]{3,})/);
  const price = digits(priceText);

  // make comes from the Manufacturer spec field. If it's absent, fall back to
  // the model's first word (NOT the "Description"/category, which is e.g.
  // "Chassis cab"), then "Unknown" — make is NOT NULL in the DB.
  record.title = title || `${make} ${model}`.trim();
  record.make = make || (model ? model.split(/\s+/)[0] : "") || "Unknown";
  record.model = model;
  record.year = firstMatch(spec["year of construction"] || spec["year"] || "", /(\d{4})/);
  record.mileage_km = digits(spec["mileage"] || spec["kilometer"] || spec["kilometre"] || "");
  record.fuel_type = spec["fuel type"] || spec["fuel"] || "";
  record.engine_power_hp = powerHp(spec["power"] || "");
  record.axle_configuration = spec["axle configuration"] || "";
  record.gearbox = spec["gearing type"] || spec["gearbox"] || spec["transmission"] || "";
  record.gross_weight_kg = digits(
    firstMatch(spec["gross weight"] || spec["permissible total weight"] || "", /([\d.,]+)/),
  );
  // NB: "Emission class" here is a Euro category (euro3/euro6), not g/km CO2, so
  // co2_g_km is deliberately left blank rather than mis-mapped.
  // Prefer detail-page location, but don't clobber the country the search
  // window already gave us when the detail page has none.
  if (country) {
    record.country_origin = country;
    record.region = country;
  }
  if (city) record.city = city;
  record.price_amount = price;
  record.price_currency = price ? "EUR" : "";
  record.vin = spec["vin"] || "";
}

// Crawl one search query (a country window, up to the site's 8-page cap),
// enriching + upserting into the shared byId map. `processed` is shared across
// all queries so a listing that appears under several filters is fetched once.
async function crawlQuery(baseUrl, args, ctx, countryName = "") {
  const { byId, processed, counts, scrapedAt } = ctx;
  for (let page = 1; page <= args.maxPages; page++) {
    const url = searchPageUrl(baseUrl, page);
    const html = await fetchText(url);
    if (!html) break;
    const slugs = listingSlugs(html).filter((s) => !processed.has(s));
    const raw = listingSlugs(html).length;
    if (raw === 0) break; // past the last page (404) for this query
    if (slugs.length === 0) {
      // All already seen under another filter — keep paging in case later pages
      // hold fresh ones, but stop if the whole page is dupes AND it's short.
      if (raw < 25) break;
      await randomDelay([800, 1600]);
      continue;
    }
    slugs.forEach((s) => processed.add(s));
    console.log(`  page ${page}: ${slugs.length} new`);

    const records = slugs.map((slug) =>
      normaliseRecord(
        {
          id: slug,
          url: `${BASE}/tsp/${slug}`,
          // From the country search window — placeable even without details.
          // enrichDetail may later overwrite with a more precise city+country.
          country_origin: countryName,
          region: countryName,
        },
        scrapedAt,
      ),
    );
    if (args.details) {
      await mapPool(records, args.concurrency, async (record) => {
        try {
          await enrichDetail(record);
        } catch (err) {
          console.warn(`  detail failed for ${record.url}: ${err.message}`);
        }
        await randomDelay([500, 1200]);
      });
    }
    for (const record of records) {
      const key = String(record.id);
      if (byId.has(key)) counts.updated++;
      else counts.added++;
      byId.set(key, record);
    }
    if (raw < 25) break; // last page for this query
    await randomDelay([1200, 2500]);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scrapedAt = new Date().toISOString();
  const byId = await loadExisting(SLUG);
  const startCount = byId.size;
  const ctx = { byId, processed: new Set(), counts: { added: 0, updated: 0 }, scrapedAt };

  // A single explicit --search overrides the country loop.
  const queries = args.search ? [args.search] : args.countries.map(searchUrl);
  console.log(
    `--- truckscout24.com: ${queries.length} quer${queries.length === 1 ? "y" : "ies"}, ≤${args.maxPages} pages each, details=${args.details} ---`,
  );

  for (let i = 0; i < queries.length; i++) {
    const cc = args.search ? "" : args.countries[i] || "";
    const label = args.search ? "custom" : cc || "all";
    console.log(`[${i + 1}/${queries.length}] country=${label}`);
    await crawlQuery(queries[i], args, ctx, CC_NAME[cc] || "");
    await writeOutputs(SLUG, byId); // checkpoint after each country
  }

  console.log(
    `--- truckscout24: ${ctx.counts.added} new, ${ctx.counts.updated} refreshed, ${byId.size} total (was ${startCount}) ---`,
  );
  console.log(`Next: node load-listings.js ${SLUG} truckscout24`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
