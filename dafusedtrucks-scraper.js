#!/usr/bin/env node
// Scrapes DAF's official used-truck inventory from dafusedtrucks.com — plain
// HTTP, no browser. The site is a Next.js SSR app: every /en/assets page embeds
// the full structured listing data for that page in its __NEXT_DATA__ JSON blob
// (under componentProps.<uid>.fallback.<swrKey>.assets). We paginate through the
// SSR pages and parse that embedded JSON — far cleaner than scraping HTML.
//
// Pagination: the site shows 23 for-sale assets per page and exposes the page
// via ?page=N (1-based). The embedded SWR key encodes the API offset (0, 23, 46…)
// and the site's own "#sold:false" filter + totalCount, which we read to know
// when to stop. Probed 2026-08: totalCount ≈ 1,263 assets across ~55 pages.
//
// Each asset carries: make (DAF), productRangeDescription (XF/XG/CF/… = our
// model), firstRegistrationDateYear, milage (KM), price (EUR), countryCode
// (ISO2), location, enginePowerDescriptionHp, axleConfiguration, vinNumber,
// cabinDescription, and photos[] (Cloudinary ids). We build the model string as
// "<range> <hp>" (e.g. "XG 480") so normalize-model.js folds it to a uniform
// canonical name like the rest of the DAF stock.
//
// Writes output/dafusedtrucks-trucks/listings.json; load with:
//   node load-listings.js dafusedtrucks-trucks dafusedtrucks
//
// Usage:
//   node dafusedtrucks-scraper.js                 # all pages, all countries
//   node dafusedtrucks-scraper.js --max-pages 5   # cap pages (testing)
//   node dafusedtrucks-scraper.js --include-sold  # also include sold assets

import { normaliseRecord, writeOutputs, loadExisting, randomDelay } from "./lib/scrape-core.js";

const SLUG = "dafusedtrucks-trucks";
const BASE = "https://www.dafusedtrucks.com";
const PAGE_URL = (p) => `${BASE}/en/assets?page=${p}`;
const DETAIL_BASE = BASE; // asset.url is already a site-relative "/en/assets/details/..."

// Cloudinary transform used by the site's card images — a reasonable stored size.
const IMG = (id) =>
  `https://res.cloudinary.com/daf-usedtrucks/image/upload/f_auto,c_limit,w_1080,q_auto/assets/${id}`;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ISO2 country code → the full country name the app buckets on (mirrors the
// naming the other scrapers store; unknown codes fall back to the code itself).
const COUNTRY_NAMES = {
  BE: "Belgium",
  NL: "Netherlands",
  DE: "Germany",
  FR: "France",
  ES: "Spain",
  IT: "Italy",
  PT: "Portugal",
  PL: "Poland",
  CZ: "Czechia",
  SK: "Slovakia",
  HU: "Hungary",
  AT: "Austria",
  CH: "Switzerland",
  RO: "Romania",
  BG: "Bulgaria",
  HR: "Croatia",
  SI: "Slovenia",
  LT: "Lithuania",
  LV: "Latvia",
  EE: "Estonia",
  GB: "United Kingdom",
  IE: "Ireland",
  DK: "Denmark",
  SE: "Sweden",
  NO: "Norway",
  FI: "Finland",
  LU: "Luxembourg",
  GR: "Greece",
  RS: "Serbia",
  UA: "Ukraine",
  TR: "Turkey",
};

function parseArgs(argv) {
  const args = { maxPages: Infinity, includeSold: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (argv[i] === "--include-sold") args.includeSold = true;
  }
  return args;
}

// Pull the embedded per-page listing payload out of a Next.js SSR page. The
// assets live under props.pageProps.componentProps.<uid>.fallback.<swrKey>, so
// we walk componentProps looking for a fallback whose value has an `assets`
// array. Returns { assets, totalCount } (or null if the blob is absent).
function extractPayload(html) {
  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const cp = data?.props?.pageProps?.componentProps ?? {};
  for (const key of Object.keys(cp)) {
    const fb = cp[key]?.fallback;
    if (!fb) continue;
    for (const swrKey of Object.keys(fb)) {
      const val = fb[swrKey];
      if (val && Array.isArray(val.assets)) {
        return { assets: val.assets, totalCount: val.totalCount ?? null };
      }
    }
  }
  return null;
}

async function fetchPage(pageNum) {
  const res = await fetch(PAGE_URL(pageNum), {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// asset.firstRegistrationDateYear is already a number; fall back to parsing the
// ISO firstRegistrationDate if it's ever missing.
function yearFrom(a) {
  if (a.firstRegistrationDateYear) return String(a.firstRegistrationDateYear);
  const m = String(a.firstRegistrationDate || "").match(/(\d{4})/);
  return m ? m[1] : "";
}

function toRecord(a, scrapedAt) {
  const make = a.make || "DAF";
  const hp = a.enginePowerDescriptionHp ? String(a.enginePowerDescriptionHp) : "";
  // Model = range + HP ("XG 480"), which normalize-model.js folds to a uniform
  // canonical name. Range alone (e.g. "XF") is kept when HP is absent.
  const range = a.productRangeDescription || "";
  const model = [range, hp].filter(Boolean).join(" ").trim();

  // Price: `price` is the live sale price; fall back to listPrice. Only DAF EUR
  // prices are present. A null price becomes "" (→ NULL / "Request Info").
  const priceRaw = a.price ?? a.listPrice ?? null;
  const price = typeof priceRaw === "number" && priceRaw > 0 ? String(priceRaw) : "";
  const currency = price ? a.priceCurrency || a.listPriceCurrency || "EUR" : "";

  const countryName = COUNTRY_NAMES[a.countryCode] || a.countryCode || "";
  const photos = Array.isArray(a.photos)
    ? a.photos.map((p) => (p?.url ? IMG(p.url) : "")).filter(Boolean)
    : [];

  return normaliseRecord(
    {
      // asset.id already carries a "_en" language suffix — stable + unique.
      id: String(a.id),
      url: a.url ? `${DETAIL_BASE}${a.url}` : `${BASE}/en/assets`,
      title: a.title || `${make} ${model}`.trim(),
      make,
      model,
      year: yearFrom(a),
      mileage_km: a.milage ? String(a.milage) : "",
      engine_power_hp: hp,
      axle_configuration: a.axleConfiguration || "",
      country_origin: countryName,
      region: countryName,
      city: a.location || "",
      price_amount: price,
      price_currency: currency,
      vin: a.vinNumber || "",
      thumbnail_url: photos[0] || "",
      image_urls: photos.slice(0, 8).join("|"),
      seller_name: "DAF Used Trucks",
      dealer_website: BASE,
    },
    scrapedAt,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scrapedAt = new Date().toISOString();
  const byId = await loadExisting(SLUG);
  const startCount = byId.size;
  const counts = { added: 0, updated: 0 };

  console.log(`--- dafusedtrucks.com SSR scrape (${args.includeSold ? "incl. sold" : "for-sale only"}) ---`);

  let total = Infinity;
  let seen = 0;
  for (let page = 1; page <= args.maxPages; page++) {
    let html;
    try {
      html = await fetchPage(page);
    } catch (err) {
      console.error(`  page ${page} failed: ${err.message}, stopping.`);
      break;
    }
    const payload = extractPayload(html);
    if (!payload) {
      console.warn(`  page ${page}: no __NEXT_DATA__ payload, stopping.`);
      break;
    }
    if (payload.totalCount != null) total = payload.totalCount;
    const assets = payload.assets;
    if (assets.length === 0) {
      console.log(`  page ${page}: empty, end of results.`);
      break;
    }

    let newThisPage = 0;
    for (const a of assets) {
      if (!args.includeSold && a.sold) continue;
      const rec = toRecord(a, scrapedAt);
      const key = String(rec.id);
      if (byId.has(key)) counts.updated++;
      else {
        counts.added++;
        newThisPage++;
      }
      byId.set(key, rec);
    }
    seen += assets.length;
    console.log(
      `  page ${page}: ${assets.length} assets (${newThisPage} new) — ${seen}/${total}`,
    );

    // Stop once we've walked the whole for-sale set (by the site's own
    // totalCount). We deliberately DON'T stop on "no new this page" — a re-run
    // legitimately re-sees every page. The empty-page check above ends a crawl
    // where the site runs out of results before totalCount is reached.
    if (total !== Infinity && seen >= total) {
      console.log("  reached totalCount — done.");
      break;
    }

    await writeOutputs(SLUG, byId); // checkpoint each page
    await randomDelay([800, 1600]);
  }

  await writeOutputs(SLUG, byId);
  console.log(
    `--- dafusedtrucks: ${counts.added} new, ${counts.updated} refreshed, ${byId.size} total (was ${startCount}) ---`,
  );
  console.log(`Next: node load-listings.js ${SLUG} dafusedtrucks`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
