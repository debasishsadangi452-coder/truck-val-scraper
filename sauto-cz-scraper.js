#!/usr/bin/env node
// Scrapes truck & trailer listings from sauto.cz (Czechia) via its JSON API —
// plain HTTP, no browser. sauto.cz is a Seznam property with a clean public API:
//   GET https://www.sauto.cz/api/v1/items/search?category_id=<C>&per_page=100&offset=N
//   → { pagination:{limit,offset,total}, results:[ {...item} ] }
// Each item has manufacturer_cb.name (make), model_cb.name + additional_model_name
// (model), price (CZK), manufacturing_date / in_operation_date (year), tachometer
// (km), fuel_cb.name, locality (Czech district), images[], and a stable id.
//
// Two categories, both business-relevant:
//   840 = Nákladní (trucks)            — DAF / Volvo / MAN / Mercedes / Iveco…
//   843 = Přívěsy a návěsy (trailers)  — Kögel / Krone / Schmitz / Wielton…
//
// Prices are Czech koruna; we convert to EUR at a fixed rate (the app's price
// column expects EUR-or-PLN, and only PLN is converted downstream), storing
// price_currency='EUR' so the value displays correctly everywhere.
//
// Writes output/sauto-cz-trucks/listings.json; load with:
//   node load-listings.js sauto-cz-trucks sauto_cz
//
// Usage:
//   node sauto-cz-scraper.js                    # trucks + trailers, all pages
//   node sauto-cz-scraper.js --max-pages 5      # cap pages per category
//   node sauto-cz-scraper.js --category 840     # one category only

import { normaliseRecord, writeOutputs, loadExisting, randomDelay } from "./lib/scrape-core.js";
import { digits } from "./lib/html-utils.js";

const SLUG = "sauto-cz-trucks";
const API = "https://www.sauto.cz/api/v1/items/search";
const PER_PAGE = 100;
const CZK_PER_EUR = 24.5; // approximate; converts CZK list prices to EUR for storage

// Category ids on sauto.cz that we ingest, with a friendly label.
const CATEGORIES = [
  { id: 840, label: "Nákladní (trucks)" },
  { id: 843, label: "Přívěsy a návěsy (trailers)" },
];

function parseArgs(argv) {
  const args = { maxPages: Infinity, categories: CATEGORIES };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (argv[i] === "--category") {
      const id = Number(argv[++i]);
      args.categories = CATEGORIES.filter((c) => c.id === id);
    }
  }
  return args;
}

async function fetchPage(categoryId, offset) {
  const url = `${API}?category_id=${categoryId}&per_page=${PER_PAGE}&offset=${offset}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Language": "cs,en;q=0.8",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// "2016-07-01" | "2020-01-01" → "2016". Prefer manufacturing_date, then
// in_operation_date (first registration) as a fallback.
function yearFrom(item) {
  const raw = item.manufacturing_date || item.in_operation_date || "";
  const m = String(raw).match(/(\d{4})/);
  return m ? m[1] : "";
}

// Czech district (e.g. "Praha-západ") is the finest location the API gives; the
// country is always Czechia for sauto.cz.
// A few make names arrive with local diacritics that break exact-match filters
// downstream (e.g. the priority-models preset uses lower(make)='kogel'). Fold the
// ones that matter to their canonical ASCII spelling.
const MAKE_ALIASES = { Kögel: "Kogel", "Kögel Trailer": "Kogel" };

function toRecord(item, scrapedAt) {
  const rawMake = item.manufacturer_cb?.name || "";
  const make = MAKE_ALIASES[rawMake] || rawMake;
  // model_cb is the model line (e.g. "Actros"); additional_model_name carries the
  // variant/spec ("1848 LowDeck"). Combine for a richer model string.
  const model = [item.model_cb?.name, item.additional_model_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  const czk = Number(item.price) || 0;
  const priceEur = czk > 0 ? Math.round(czk / CZK_PER_EUR) : "";
  const images = Array.isArray(item.images)
    ? item.images.map((im) => (im.url?.startsWith("//") ? `https:${im.url}` : im.url)).filter(Boolean)
    : [];
  const district = item.locality?.district || "";

  return normaliseRecord(
    {
      id: String(item.id),
      url: `https://www.sauto.cz/osobni/detail/${item.category?.seo_name || "nakladni"}/${item.id}`,
      title: item.name || `${make} ${model}`.trim(),
      make: make || "Unknown",
      model,
      year: yearFrom(item),
      mileage_km: digits(String(item.tachometer ?? "")),
      fuel_type: item.fuel_cb?.name || "",
      country_origin: "Czechia",
      region: district || "Czechia",
      city: district,
      price_amount: priceEur,
      price_currency: priceEur ? "EUR" : "",
      thumbnail_url: images[0] || "",
      image_urls: images.slice(0, 8).join("|"),
      seller_name: item.premise?.name || "",
    },
    scrapedAt,
  );
}

async function crawlCategory(cat, args, ctx) {
  const { byId, counts, scrapedAt } = ctx;
  let offset = 0;
  let total = Infinity;
  let page = 0;
  while (offset < total && page < args.maxPages) {
    let data;
    try {
      data = await fetchPage(cat.id, offset);
    } catch (err) {
      console.error(`  ${cat.label} offset ${offset} failed: ${err.message}, stopping.`);
      break;
    }
    total = data.pagination?.total ?? 0;
    const results = data.results ?? [];
    if (results.length === 0) break;
    console.log(`  ${cat.label} page ${page + 1}: ${results.length} (offset ${offset}/${total})`);
    for (const item of results) {
      const rec = toRecord(item, scrapedAt);
      const key = String(rec.id);
      if (byId.has(key)) counts.updated++;
      else counts.added++;
      byId.set(key, rec);
    }
    offset += PER_PAGE;
    page++;
    await randomDelay([500, 1200]);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scrapedAt = new Date().toISOString();
  const byId = await loadExisting(SLUG);
  const startCount = byId.size;
  const ctx = { byId, counts: { added: 0, updated: 0 }, scrapedAt };

  console.log(`--- sauto.cz API scrape: ${args.categories.map((c) => c.label).join(", ")} ---`);
  for (const cat of args.categories) {
    await crawlCategory(cat, args, ctx);
    await writeOutputs(SLUG, byId); // checkpoint after each category
  }

  console.log(
    `--- sauto.cz: ${ctx.counts.added} new, ${ctx.counts.updated} refreshed, ${byId.size} total (was ${startCount}) ---`,
  );
  console.log(`Next: node load-listings.js ${SLUG} sauto_cz`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
