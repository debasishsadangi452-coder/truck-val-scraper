#!/usr/bin/env node
// planet-trucks.com scraper — plain HTTP (no browser). A via-mobilis European
// truck marketplace with strong FRANCE stock and clean, make + country-scoped
// SEO URLs. Used here to fill the France gap for the priority makes.
//
// Category list pages are server-rendered HTML. URL scheme (verified 2026-08):
//   /<make>-tractor-unit/france/~a1b31e<code>nFR/<make>-france.html   (tractors)
//   /<make>-truck/france/~a1b32e<code>nFR/<make>-france.html          (rigid trucks)
// where <code> is the make id (DAF 180, Volvo 774, MAN 496). Each page inlines
// ~21 result cards carrying data-id, data-name ("DAF XF FT 480 tractor unit"),
// data-price ("26,900 EUR"), and a detail href /…/ts-vi<id>/used.html whose
// second path segment encodes the location (e.g. pyrenees-orientales, estonie).
// Detail pages add Date of first registration (year), Mileage, Power, Gearbox.
//
// Only cards whose location resolves to France are kept (the "france" filter is
// soft — some foreign stock leaks in). Prices are EUR (French market).
//
// Writes output/planet-trucks-trucks/listings.json; load with:
//   node load-listings.js planet-trucks-trucks planet_trucks

import { Agent, setGlobalDispatcher } from "undici";
import { fetchText, normaliseRecord, writeOutputs, loadExisting, randomDelay, mapPool } from "./lib/scrape-core.js";
import { stripTags, firstMatch, digits } from "./lib/html-utils.js";

// planet-trucks advertises an IPv6 address that isn't routable from some hosts;
// Node's fetch (undici) prefers it and times out where curl (IPv4) succeeds.
// Force IPv4 connections process-wide so the crawl connects reliably.
setGlobalDispatcher(new Agent({ connect: { family: 4, timeout: 15000 } }));

const BASE = "https://www.planet-trucks.com";

// Trucks: priority makes → make code, categories 31 (tractor) + 32 (rigid truck).
const TRUCK_MAKE_CODES = { DAF: 180, Volvo: 774, MAN: 496 };
const TRUCK_CATEGORIES = [
  { cat: 31, kind: "tractor-unit" },
  { cat: 32, kind: "truck" },
];
// Trailers: priority trailer brands → code, category 35 (semi-trailer). Fliegl &
// Wielton aren't carried by planet-trucks (Eastern-European brands) — covered by
// otomoto/sauto instead.
const TRAILER_MAKE_CODES = { Kögel: 412, Krone: 428, "Schmitz-Cargobull": 680 };
const TRAILER_CATEGORIES = [{ cat: 35, kind: "semi-trailer" }];

// planet-trucks scopes results by country via a URL slug + an "n<CC>" code (both
// verified 2026-08). Poland is deliberately excluded (already covered by otomoto).
const COUNTRIES = {
  FR: { slug: "france", name: "France" },
  DE: { slug: "germany", name: "Germany" },
  CZ: { slug: "czech-republic", name: "Czechia" },
  BE: { slug: "belgium", name: "Belgium" },
  NL: { slug: "netherlands", name: "Netherlands" },
  LT: { slug: "lithuania", name: "Lithuania" },
};
const DEFAULT_COUNTRIES = ["DE", "CZ", "BE", "NL", "LT"]; // FR handled by its own run

const KIND_BY_CAT = { 31: "tractor-unit", 32: "truck", 35: "semi-trailer" };

function parseArgs(argv) {
  const args = { concurrency: 2, maxPages: 25, countries: DEFAULT_COUNTRIES, trailers: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--concurrency") args.concurrency = Math.max(1, Number(argv[++i]) || 1);
    else if (argv[i] === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (argv[i] === "--trailers") args.trailers = true;
    else if (argv[i] === "--country")
      args.countries = argv[++i]
        .toUpperCase()
        .split(",")
        .map((c) => c.trim())
        .filter((c) => COUNTRIES[c]);
  }
  return args;
}

function countryUrl(makeSlug, code, cat, cc) {
  const { slug } = COUNTRIES[cc];
  return `${BASE}/${makeSlug}-${KIND_BY_CAT[cat]}/${slug}/~a1b${cat}e${code}n${cc}/${makeSlug}-${slug}.html`;
}

// Pull result cards from a list page. Each card gives id, name (make+model),
// price and the detail href (whose 2nd segment is the location slug).
function parseCards(html) {
  const cards = [];
  const re =
    /data-id="(\d+)"[^>]*>[\s\S]*?data-name="([^"]*)"[\s\S]*?data-price="([^"]*)"[\s\S]*?href="(\/[a-z0-9-]+\/([a-z0-9-]+)\/ts-vi\d+\/used\.html)"/gi;
  let m;
  while ((m = re.exec(html))) {
    cards.push({ id: m[1], name: m[2], price: m[3], href: m[4], locSlug: m[5] });
  }
  // Fallback: simpler anchor-based scan if the compound regex misses (markup drift).
  if (cards.length === 0) {
    for (const a of html.matchAll(/href="(\/[a-z0-9-]+\/([a-z0-9-]+)\/ts-vi(\d+)\/used\.html)"[^>]*data-price="([^"]*)"[^>]*data-name="([^"]*)"/gi)) {
      cards.push({ id: a[3], name: a[5], price: a[4], href: a[1], locSlug: a[2] });
    }
  }
  return cards;
}

// "DAF XF FT 480 tractor unit" → { make:"DAF", model:"XF FT 480" }.
function splitName(name) {
  const t = stripTags(name).replace(/\b(tractor unit|truck|chassis truck|rigid)\b/i, "").trim();
  const parts = t.split(/\s+/);
  return { make: parts[0] || "", model: parts.slice(1).join(" ").trim() };
}

async function enrichDetail(record) {
  const html = await fetchText(`${BASE}${record._href}`);
  if (!html) return;
  const pair = (label) =>
    firstMatch(
      html,
      new RegExp(`${label}[^<]*</[^>]+>\\s*<[^>]+>([^<]{1,40})`, "i"),
    ) || "";
  record.year =
    firstMatch(pair("Date of first registration"), /(\d{4})/) ||
    firstMatch(record.title, /\b(20\d{2}|19\d{2})\b/) ||
    "";
  record.mileage_km = digits(pair("Mileage"));
  record.engine_power_hp = digits(firstMatch(pair("Power"), /(\d+)/));
  record.gearbox = pair("Gearbox");
}

async function crawl(makeSlug, code, cat, cc, ctx, args) {
  const { byId, counts, scrapedAt } = ctx;
  const { name: countryName } = COUNTRIES[cc];
  const base = countryUrl(makeSlug, code, cat, cc);
  const seen = new Set();
  let page = 1;
  let pageCards = [];
  // Pagination is `?p=N` (from the page's <link rel="next">); pages return
  // distinct card sets. Stop when a page has no new cards or we hit the cap.
  while (page <= args.maxPages) {
    const url = page === 1 ? base : `${base}?p=${page}`;
    const html = await fetchText(url);
    if (!html) break;
    const fresh = parseCards(html).filter((c) => !seen.has(c.id));
    if (fresh.length === 0) break;
    fresh.forEach((c) => seen.add(c.id));
    pageCards.push(...fresh);
    page++;
    await randomDelay([800, 1600]);
  }
  const cards = pageCards;
  console.log(`  [${cc}] ${makeSlug} cat${cat}: ${cards.length} cards over ${page - 1} page(s)`);

  const records = cards.map((c) => {
    const { make, model } = splitName(c.name);
    const rec = normaliseRecord(
      {
        id: `pt-${c.id}`,
        url: `${BASE}${c.href}`,
        title: stripTags(c.name),
        make: make || makeSlug,
        model,
        // Some cards show no price ("0"/blank) — store empty, not a misleading 0.
        price_amount: /[1-9]/.test(digits(c.price)) ? digits(c.price) : "",
        price_currency: /[1-9]/.test(digits(c.price)) && /EUR|€/.test(c.price) ? "EUR" : "",
        // URL is country-scoped, so the country is authoritative.
        country_origin: countryName,
        region: c.locSlug.replace(/-/g, " "),
        city: c.locSlug.replace(/-/g, " "),
      },
      scrapedAt,
    );
    rec._href = c.href;
    return rec;
  });

  await mapPool(records, args.concurrency, async (rec) => {
    try {
      await enrichDetail(rec);
    } catch (err) {
      console.warn(`  detail ${rec.id} failed: ${err.message}`);
    }
    delete rec._href;
    await randomDelay([500, 1200]);
  });

  for (const rec of records) {
    if (byId.has(rec.id)) counts.updated++;
    else counts.added++;
    byId.set(rec.id, rec);
  }
  await randomDelay([1000, 2200]);
}

// Make display name → the ASCII URL slug planet-trucks uses (Kögel → kogel).
function toSlug(name) {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const slug = args.trailers ? "planet-trucks-trailers" : "planet-trucks-trucks";
  const source = args.trailers ? "planet_trucks_trailers" : "planet_trucks";
  const makeCodes = args.trailers ? TRAILER_MAKE_CODES : TRUCK_MAKE_CODES;
  const categories = args.trailers ? TRAILER_CATEGORIES : TRUCK_CATEGORIES;

  const scrapedAt = new Date().toISOString();
  const byId = await loadExisting(slug);
  const startCount = byId.size;
  const ctx = { byId, counts: { added: 0, updated: 0 }, scrapedAt, slug };

  console.log(
    `--- planet-trucks.com ${args.trailers ? "TRAILER" : "truck"} scrape (countries: ${args.countries.join(",")}) ---`,
  );
  for (const cc of args.countries) {
    for (const [makeName, code] of Object.entries(makeCodes)) {
      for (const { cat } of categories) {
        await crawl(toSlug(makeName), code, cat, cc, ctx, args);
        await writeOutputs(slug, byId); // checkpoint per make/category
      }
    }
  }

  console.log(
    `--- planet-trucks ${args.trailers ? "trailers" : "trucks"}: ${ctx.counts.added} new, ${ctx.counts.updated} refreshed, ${byId.size} total (was ${startCount}) ---`,
  );
  console.log(`Next: node load-listings.js ${slug} ${source}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
