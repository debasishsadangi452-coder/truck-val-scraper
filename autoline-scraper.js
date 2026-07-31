#!/usr/bin/env node
// Scrapes used-truck listings from autoline.info.
//
// autoline.info embeds the full result set of each list page as a JSON-LD
// ItemList of Product nodes — no HTML selectors needed for the core fields.
// Each Product carries name, brand, image gallery, url, a human description
// string that also encodes year / country / mileage / load capacity, an
// additionalProperty list (Power, Fuel, Axle configuration, Suspension...),
// and an offers object (price + currency). That single list-page payload is
// richer than the detail page, so this scraper does NOT fetch detail pages —
// one request per page of 21 listings.
//
// Pagination is ?page=N. The source id is the long numeric suffix on the ad
// URL (…--26072318255338120900), which is stable and used for dedup / the DB
// (source, source_id) upsert key.
//
// robots.txt note: autoline.info allows /-/ listing paths (only /account/,
// search-refinement, and mirror-locale paths are disallowed). This crawls the
// canonical https://autoline.info/-/trucks--c2 category politely (jittered
// delays, one page at a time).
//
// Usage:
//   node scripts/autoline-trucks-scraper.js
//   node scripts/autoline-trucks-scraper.js --max-pages 40
//   node scripts/autoline-trucks-scraper.js --category truck-tractors--c42
//
// No dependencies beyond Node's built-in fetch (Node 18+).

import { fetchText, normaliseRecord, runScrape, IMAGE_URL_SEPARATOR } from "./lib/scrape-core.js";
import { extractJsonLd, findJsonLd, propMap, firstMatch, digits } from "./lib/html-utils.js";

const SLUG = "autoline-trucks";
const BASE = "https://autoline.info";

function parseArgs(argv) {
  const args = { maxPages: 50, category: "trucks--c2" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (a === "--category") args.category = argv[++i];
  }
  return args;
}

// The stable ad id is the numeric run at the very end of the ad URL, after the
// final "--". Falls back to the whole URL if the shape ever changes.
function adId(url) {
  return firstMatch(url, /--(\d+)(?:[/?#]|$)/) || url;
}

// autoline packs structured facts into the description string, e.g.
//   "MAN tgx 18.400 chassis truck sale advertisement from Poland ➤ Price:
//    €15,000 ✓ Year of manufacture: 2015-11 ✓ Mileage: 462000 km ✓ ..."
// Pull what the JSON fields don't already give us (year, country, mileage,
// load capacity). Regexes are anchored on autoline's fixed labels.
function parseDescription(desc) {
  // Country reads like "…advertisement from Romania ➤" or, for some countries,
  // "…from the Netherlands ➤" / "…from the United Kingdom ➤". Allow an optional
  // lowercase article ("the ") before the capitalised name, then drop it — the
  // old regex required the match to start with a capital, so every "the X"
  // country (Netherlands, UK, USA, UAE, …) silently produced no location.
  const rawCountry = firstMatch(desc, /\bfrom\s+((?:the\s+)?[A-Z][A-Za-z .'-]+?)\s*(?:➤|✓|$)/);
  return {
    country: rawCountry ? rawCountry.replace(/^the\s+/i, "").trim() : "",
    year: firstMatch(desc, /Year of manufacture:\s*(\d{4})/),
    mileage: digits(firstMatch(desc, /Mileage:\s*([\d\s.,]+)\s*km/i)),
    payload: digits(firstMatch(desc, /Load capacity:\s*([\d\s.,]+)\s*kg/i)),
  };
}

function productToRecord(item, scrapedAt) {
  const props = propMap(item.additionalProperty);
  const parsed = parseDescription(item.description);
  const offer = item.offers ?? {};
  const images = Array.isArray(item.image) ? item.image : item.image ? [item.image] : [];
  // brand.name is usually present, but some ads omit it. Fall back to the make
  // segment of the ad URL (…/sale/<category>/<MAKE>/<model>--id) and finally to
  // the first word of the name — make is NOT NULL in the DB, so it must resolve.
  const brand =
    item.brand?.name ||
    firstMatch(item.url, /\/sale\/[^/]+\/([^/]+)\//).replace(/-/g, " ") ||
    (item.name ?? "").split(/\s+/)[0] ||
    "Unknown";

  // additionalProperty power reads like "400 HP (294 kW)" — keep the HP number.
  const powerHp = digits(firstMatch(String(props.power ?? ""), /(\d+)\s*HP/i));

  return normaliseRecord(
    {
      id: adId(item.url),
      url: item.url,
      title: item.name ?? "",
      make: brand,
      // name is "MAN tgx 18.400 chassis truck" — strip the leading brand to
      // approximate the model; leave blank if we can't cleanly split it.
      model:
        brand && item.name?.toLowerCase().startsWith(brand.toLowerCase())
          ? item.name.slice(brand.length).trim()
          : "",
      year: parsed.year,
      mileage_km: parsed.mileage,
      fuel_type: props.fuel ?? "",
      engine_power_hp: powerHp,
      axle_configuration: props["axle configuration"] ?? "",
      payload_kg: parsed.payload,
      country_origin: parsed.country,
      // autoline only exposes the seller's country (not a sub-region), so use
      // it for both country_origin and region — the frontend groups/maps by
      // region and falls back to a country centroid when there's no finer geo.
      region: parsed.country,
      price_amount: offer.price != null ? String(offer.price) : "",
      price_currency: offer.priceCurrency ?? "",
      thumbnail_url: images[0] ?? "",
      image_urls: images.slice(0, 8).join(IMAGE_URL_SEPARATOR),
    },
    scrapedAt,
  );
}

async function* listPages(args) {
  const scrapedAt = new Date().toISOString();
  for (let page = 1; page <= args.maxPages; page++) {
    const url = `${BASE}/-/${args.category}${page > 1 ? `?page=${page}` : ""}`;
    console.log(`fetching page ${page}: ${url}`);
    const html = await fetchText(url);
    if (!html) {
      yield { records: [], done: true };
      return;
    }
    const list = findJsonLd(extractJsonLd(html), "ItemList");
    const elements = list?.itemListElement ?? [];
    const items = elements.map((e) => e.item).filter(Boolean);
    // Stop only when a page has NO listings at all. Page size varies (14–21
    // seen), so a short page is NOT the end — and past the real last page
    // autoline clamps back to the last page's items, which runScrape's per-run
    // dedup then drops to zero-new, so the crawl still terminates naturally.
    if (elements.length === 0) {
      yield { records: [], done: true };
      return;
    }
    yield { records: items.map((it) => productToRecord(it, scrapedAt)) };
  }
}

const source = { slug: SLUG, listPages, pageDelay: [1500, 3000], stopOnEmptyPage: true };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `--- autoline.info scrape: category=${args.category}, max ${args.maxPages} pages ---`,
  );
  await runScrape(source, args);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
