#!/usr/bin/env node
// Scrapes truck listings from mobile.bg (Bulgaria) — plain HTTP, no browser.
//
// The /obiavi/kamioni search path is NOT Cloudflare-gated (unlike the homepage):
// it returns server-rendered HTML with 20 listings per page, paginated at
// /obiavi/kamioni/p-N, linking to detail pages /obiava-<id>-<slug>.
//
// TWO quirks handled here:
//   1. ENCODING: mobile.bg serves windows-1251 (Cyrillic), not UTF-8 — we fetch
//      raw bytes and decode with TextDecoder("windows-1251").
//   2. No JSON-LD. Detail pages carry a spec block of
//      <div class="item"><div>Label</div><div>Value</div></div> pairs in
//      Bulgarian (Дата на производство, Пробег, Мощност, Двигател, Скоростна
//      кутия, Евростандарт), plus make+model in the <h1> and a "50 000 €" price.
//
// Strategy (like truck7/truckscout24): harvest obiava ids from each search page,
// then fetch + parse each detail page. Writes output/mobilebg-trucks/
// listings.json; load with:
//   node load-listings.js mobilebg-trucks mobilebg
//
// Usage:
//   node mobilebg-scraper.js --max-pages 20
//   node mobilebg-scraper.js --no-details    # ids/title only, faster

import {
  normaliseRecord,
  writeOutputs,
  loadExisting,
  randomDelay,
  mapPool,
} from "./lib/scrape-core.js";
import { digits, firstMatch } from "./lib/html-utils.js";

const SLUG = "mobilebg-trucks";
const BASE = "https://www.mobile.bg";
const LIST = `${BASE}/obiavi/kamioni`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const decoder = new TextDecoder("windows-1251");

function parseArgs(argv) {
  const args = { maxPages: 20, concurrency: 4, details: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (a === "--concurrency") args.concurrency = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--no-details") args.details = false;
  }
  return args;
}

// Fetch + decode windows-1251 to a JS string. Returns null on failure/retries.
async function fetchCp1251(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept-Language": "bg-BG,bg;q=0.9,en;q=0.8" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return decoder.decode(await res.arrayBuffer());
    } catch (err) {
      console.warn(`  attempt ${attempt}/${retries} failed for ${url}: ${err.message}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  return null;
}

// Bulgarian → English maps so values match the rest of the DB.
const FUEL_BG = {
  дизелов: "Diesel",
  бензинов: "Petrol",
  електрически: "Electric",
  хибриден: "Hybrid",
};
const GEARBOX_BG = { ръчна: "Manual", автоматична: "Automatic", полуавтоматична: "Semi-automatic" };
function mapBg(table, v) {
  const key = String(v ?? "")
    .trim()
    .toLowerCase();
  return table[key] ?? v ?? "";
}

const listingIds = (html) => [
  ...new Set([...html.matchAll(/obiava-(\d+)-([^"'\s]+)/g)].map((m) => `${m[1]}-${m[2]}`)),
];

// Flatten the detail spec block: <div class="item"><div>Label</div><div>Value</div></div>.
function specMap(html) {
  const map = {};
  const re = /<div class="item">\s*<div>([^<]+)<\/div>\s*<div>([^<]*)<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    map[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return map;
}

// "май 2015" / "2015" → "2015".
const yearOf = (v) => firstMatch(v, /(\d{4})/);

async function enrichDetail(record) {
  const html = await fetchCp1251(record.url);
  if (!html) return;
  const spec = specMap(html);
  const h1 = firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i)
    .replace(/<[^>]+>/g, " ")
    .replace(/Обява:.*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const make = h1.split(/\s+/)[0] || "Unknown";

  record.title = h1;
  record.make = make;
  record.model = h1.startsWith(make) ? h1.slice(make.length).trim() : "";
  record.year = yearOf(spec["дата на производство"] || "");
  record.mileage_km = digits(spec["пробег [км]"] || spec["пробег"] || "");
  record.fuel_type = mapBg(FUEL_BG, spec["двигател"]);
  record.engine_power_hp = digits(firstMatch(spec["мощност"] || "", /(\d+)\s*к\.с\./i));
  record.gearbox = mapBg(GEARBOX_BG, spec["скоростна кутия"]);
  record.country_origin = "Bulgaria";
  record.region = "Bulgaria";
  // Price: "50 000 €" (EUR shown first, лв. second). Prefer the € figure.
  const price = digits(firstMatch(html, /([\d\s]+)\s*€/));
  record.price_amount = price;
  record.price_currency = price ? "EUR" : "";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scrapedAt = new Date().toISOString();
  const byId = await loadExisting(SLUG);
  const startCount = byId.size;
  const processed = new Set();
  let added = 0;
  let updated = 0;

  console.log(`--- mobile.bg scrape: max ${args.maxPages} pages, details=${args.details} ---`);

  for (let page = 1; page <= args.maxPages; page++) {
    const url = page === 1 ? LIST : `${LIST}/p-${page}`;
    console.log(`fetching page ${page}: ${url}`);
    const html = await fetchCp1251(url);
    if (!html) break;
    const slugs = listingIds(html).filter((s) => !processed.has(s));
    if (slugs.length === 0) {
      console.log("  no new listings — end of results.");
      break;
    }
    slugs.forEach((s) => processed.add(s));
    console.log(`  ${slugs.length} listings on page`);

    const records = slugs.map((slug) =>
      normaliseRecord({ id: slug.split("-")[0], url: `${BASE}/obiava-${slug}` }, scrapedAt),
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
      if (byId.has(key)) updated++;
      else added++;
      byId.set(key, record);
    }

    if (slugs.length < 20) {
      console.log("  reached last page.");
      break;
    }
    await randomDelay([1200, 2500]);
  }

  await writeOutputs(SLUG, byId);
  console.log(
    `--- mobilebg: ${added} new, ${updated} refreshed, ${byId.size} total (was ${startCount}) ---`,
  );
  console.log(`Next: node load-listings.js ${SLUG} mobilebg`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
