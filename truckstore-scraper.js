#!/usr/bin/env node
// Scrapes truck listings from truckstore.com (Mercedes-Benz used trucks) via its
// JSON API — plain HTTP, no browser.
//
// The public site is an AngularJS SPA, but its data comes from a clean JHipster
// backend: POST https://proxyprod.tso-aws.com/tsoApp/widget/truck/search/en_EN
// with a JSON body { "pageNumber": N }. The response is
//   { pageNumber, totalPageNumber, pageSize, currency, results: [ {...vehicle} ] }
// where each vehicle has title (make+model), km, priceNet/priceTotal,
// dateOfRegistration ("M/YYYY"), engineType (fuel), emmissionsStandard, body,
// center {country, region, name}, image, and uvid (stable id). ~116 pages × 15 ≈
// 1,740 vehicles (all Mercedes-Benz — this is the MB used-truck marketplace).
//
// Writes output/truckstore-trucks/listings.json; load with:
//   node load-listings.js truckstore-trucks truckstore
//
// Usage:
//   node truckstore-scraper.js                 # all pages
//   node truckstore-scraper.js --max-pages 20  # cap
//
// No browser, no dependencies beyond Node fetch.

import { normaliseRecord, writeOutputs, loadExisting, randomDelay } from "./lib/scrape-core.js";
import { digits } from "./lib/html-utils.js";

const SLUG = "truckstore-trucks";
const API = "https://proxyprod.tso-aws.com/tsoApp/widget/truck/search/en_EN";
const ORIGIN = "https://www.truckstore.com";

function parseArgs(argv) {
  const args = { maxPages: Infinity };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max-pages") args.maxPages = Number(argv[++i]);
  }
  return args;
}

async function fetchPage(pageNumber) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
    body: JSON.stringify({ pageNumber }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// "Mercedes-Benz Trucks Atego 816 4x2" → make "Mercedes-Benz", model "Atego 816
// 4x2". The catalog is all Mercedes-Benz, so peel that known brand off the front.
function splitTitle(title) {
  const t = String(title ?? "").trim();
  const m = t.match(/^(Mercedes-Benz(?:\s+Trucks)?)\s+(.*)$/i);
  if (m) return { make: "Mercedes-Benz", model: m[2].trim() };
  const parts = t.split(/\s+/);
  return { make: parts[0] || "Mercedes-Benz", model: parts.slice(1).join(" ") };
}

// "9/2020" → "2020".
function yearFrom(dateOfRegistration) {
  const m = String(dateOfRegistration ?? "").match(/(\d{4})/);
  return m ? m[1] : "";
}

function toRecord(v, currency, scrapedAt) {
  const { make, model } = splitTitle(v.title);
  const center = v.center ?? {};
  // priceTotal (gross) preferred; fall back to net. Values arrive as "28,441".
  const price = digits(v.priceTotal || v.priceNet || "");
  return normaliseRecord(
    {
      id: v.uvid || `${make}-${model}-${v.dateOfRegistration}`,
      // No per-vehicle public URL in the API; link to the SPA detail by uvid.
      url: v.uvid ? `${ORIGIN}/search/#/detail=${v.uvid}` : `${ORIGIN}/search/`,
      title: v.title || "",
      make,
      model,
      year: yearFrom(v.dateOfRegistration),
      mileage_km: digits(v.km),
      fuel_type: v.engineType || "",
      country_origin: center.country || "",
      region: center.country || "",
      city: center.name || "",
      price_amount: price,
      price_currency: price ? currency || "EUR" : "",
      thumbnail_url: v.image || "",
    },
    scrapedAt,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scrapedAt = new Date().toISOString();
  const byId = await loadExisting(SLUG);
  const startCount = byId.size;
  let added = 0;
  let updated = 0;

  console.log(`--- truckstore.com (Mercedes-Benz) API scrape ---`);

  let page = 0;
  let totalPages = 1;
  while (page < totalPages && page < args.maxPages) {
    let data;
    try {
      data = await fetchPage(page);
    } catch (err) {
      console.error(`  page ${page} failed: ${err.message}, stopping.`);
      break;
    }
    totalPages = data.totalPageNumber ?? totalPages;
    const results = data.results ?? [];
    console.log(`page ${page + 1}/${totalPages}: ${results.length} vehicles`);
    if (results.length === 0) break;

    for (const v of results) {
      const rec = toRecord(v, data.currency, scrapedAt);
      const key = String(rec.id);
      if (byId.has(key)) updated++;
      else added++;
      byId.set(key, rec);
    }
    page++;
    await randomDelay([600, 1400]);
  }

  await writeOutputs(SLUG, byId);
  console.log(
    `--- truckstore: ${added} new, ${updated} refreshed, ${byId.size} total (was ${startCount}) ---`,
  );
  console.log(`Next: node load-listings.js ${SLUG} truckstore`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
