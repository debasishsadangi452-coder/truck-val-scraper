#!/usr/bin/env node
// Scrapes used-truck listings from autoline.bg (Bulgaria).
//
// autoline.bg is the same OLX/Autoline platform as autoline.info — the list
// pages embed a JSON-LD ItemList of Product nodes with name, brand, images,
// url, an offers object (price + currency), an additionalProperty list, and a
// human description. The ONLY difference from autoline.info is the language:
// the description labels and additionalProperty names are in Bulgarian, so the
// regexes/keys below are anchored on Cyrillic labels:
//   Дата на производство: → year     Пробег: → mileage (km)
//   Цена: → price (also in offers)    в България → country
//   Мощност → power   Гориво → fuel   Колесна формула → axle   Товаропод. → payload
//
// Plain HTTP (no browser) — but it lives in this package so all the Bulgarian
// Autoline sources sit together. Writes output/autoline-bg-trucks/listings.json;
// `node load-listings.js autoline-bg-trucks autoline_bg` upserts it into
// truck_listings on (source, source_id).
//
// Pagination is ?page=N; source id is the numeric suffix after the final "--".
//
// Usage:
//   node autoline-bg-scraper.js
//   node autoline-bg-scraper.js --max-pages 40
//   node autoline-bg-scraper.js --category kamioni--c2

import { fetchText, normaliseRecord, runScrape, IMAGE_URL_SEPARATOR } from "./lib/scrape-core.js";
import { extractJsonLd, findJsonLd, firstMatch, digits } from "./lib/html-utils.js";

const SLUG = "autoline-bg-trucks";
const BASE = "https://autoline.bg";

function parseArgs(argv) {
  const args = { maxPages: 50, category: "kamioni--c2" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (a === "--category") args.category = argv[++i];
  }
  return args;
}

function adId(url) {
  return firstMatch(url, /--(\d+)(?:[/?#]|$)/) || url;
}

// Bulgarian fuel labels → the English values the rest of the app filters on.
const FUEL_BG_EN = {
  дизел: "Diesel",
  бензин: "Petrol",
  електрически: "Electric",
  хибрид: "Hybrid",
  газ: "LPG",
};
function normaliseFuel(bg) {
  const key = String(bg ?? "")
    .trim()
    .toLowerCase();
  return FUEL_BG_EN[key] ?? bg ?? "";
}

// additionalProperty → { lowercased Cyrillic name: value }.
function bgPropMap(additionalProperty) {
  const map = {};
  for (const p of additionalProperty ?? []) {
    if (p?.name != null) map[String(p.name).toLowerCase()] = p.value;
  }
  return map;
}

// Bulgarian → English country names. autoline.bg writes the seller's country in
// Bulgarian as either "в България" (in Bulgaria, local) or "от <страна>" (from
// <country>, foreign origin). Only "в България" was handled before, so every
// foreign-origin ad (the bulk of the site) got no location. Map the common
// exporter countries so they geocode.
const BG_COUNTRY = {
  България: "Bulgaria",
  Нидерландия: "Netherlands",
  Холандия: "Netherlands",
  Германия: "Germany",
  Полша: "Poland",
  Белгия: "Belgium",
  Франция: "France",
  Италия: "Italy",
  Испания: "Spain",
  Португалия: "Portugal",
  Австрия: "Austria",
  Швейцария: "Switzerland",
  Швеция: "Sweden",
  Норвегия: "Norway",
  Дания: "Denmark",
  Финландия: "Finland",
  Естония: "Estonia",
  Латвия: "Latvia",
  Литва: "Lithuania",
  Румъния: "Romania",
  Унгария: "Hungary",
  Чехия: "Czechia",
  Словакия: "Slovakia",
  Словения: "Slovenia",
  Хърватия: "Croatia",
  Сърбия: "Serbia",
  Гърция: "Greece",
  Украйна: "Ukraine",
  Русия: "Russia",
  Турция: "Turkey",
  Великобритания: "United Kingdom",
  Ирландия: "Ireland",
  Люксембург: "Luxembourg",
  Китай: "China",
};

// The Bulgarian description string, e.g.
//   "...Mercedes-Benz Antos в България ➤ ..."  (local)
//   "...Volvo FH от Нидерландия ➤ ..."          (foreign origin)
// Pull year + mileage, and resolve the country from either the "в"/"от" phrase.
function parseDescription(desc) {
  const s = String(desc ?? "");
  // Match "в <Country>" or "от <Country>" right before the ➤/✓ separator.
  // NB: no leading \b — JS \b is ASCII-only, so it never fires before the
  // Cyrillic "в"/"от"; use Unicode property escapes for the country name.
  const bg = firstMatch(s, /(?:^|\s)(?:в|от)\s+(\p{Lu}[\p{L} .'-]+?)\s*(?:➤|✓|$)/u);
  return {
    year: firstMatch(s, /Дата на производство:\s*(\d{4})/),
    mileage: digits(firstMatch(s, /Пробег:\s*([\d\s.,]+)\s*км/i)),
    // Map the Bulgarian name to English; fall back to the raw name if unknown
    // (Nominatim can still resolve many native-language country names).
    country: bg ? BG_COUNTRY[bg] || bg : "",
  };
}

function productToRecord(item, scrapedAt) {
  const props = bgPropMap(item.additionalProperty);
  const parsed = parseDescription(item.description);
  const offer = item.offers ?? {};
  const images = Array.isArray(item.image) ? item.image : item.image ? [item.image] : [];
  const brand =
    item.brand?.name ||
    firstMatch(item.url, /\/[^/]+\/([^/]+)\/[^/]*--\d+/).replace(/-/g, " ") ||
    (item.name ?? "").split(/\s+/)[0] ||
    "Unknown";

  // "300 к.с. (221 kW)" — к.с. is Bulgarian for HP; keep the number before it.
  const powerHp = digits(firstMatch(String(props["мощност"] ?? ""), /(\d[\d\s]*)\s*к\.с\./i));
  // "18 000 кг" load capacity.
  const payload = digits(firstMatch(String(props["товаропод."] ?? ""), /([\d\s.,]+)\s*кг/i));

  return normaliseRecord(
    {
      id: adId(item.url),
      url: item.url,
      title: item.name ?? "",
      make: brand,
      model:
        brand && item.name?.toLowerCase().startsWith(brand.toLowerCase())
          ? item.name.slice(brand.length).trim()
          : "",
      year: parsed.year,
      mileage_km: parsed.mileage,
      fuel_type: normaliseFuel(props["гориво"]),
      engine_power_hp: powerHp,
      axle_configuration: props["колесна формула"] ?? "",
      payload_kg: payload,
      country_origin: parsed.country,
      // Country-level location — plotted at the Bulgaria centroid on the map.
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
  console.log(`--- autoline.bg scrape: category=${args.category}, max ${args.maxPages} pages ---`);
  await runScrape(source, args);
  console.log(`Next: node load-listings.js ${SLUG} autoline_bg`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
