#!/usr/bin/env node
// proresale.cz (Pro Resale Trucks) — Czech dealer, plain HTTP.
//
// BACKEND. Verified 2026-09: /sitemap.xml lists 1,330 URLs and every vehicle
// detail page is fully server-rendered. robots.txt disallows only /*plugins*,
// /*redirect* and /*?currency*, none of which this touches.
//
// THE SITEMAP IS MOSTLY NOT VEHICLES. Of 1,330 URLs, 441 are /ro/ and 417 are
// /ua/ — Romanian and Ukrainian TRANSLATIONS of the same stock, which would
// triple-count every truck if followed. Only the Czech /vozidla/ tree is taken.
//
// AND PATH DEPTH DOES NOT IDENTIFY A VEHICLE. Within /vozidla/ there are 18
// depth-1, 401 depth-2 and 44 depth-3 URLs, but most depth-2 entries are
// per-make FILTER pages (/vozidla/tahace/daf) while some are real vehicles
// (/vozidla/nakladni-auta/nakladni-automobil-avia-d120-e-a0007c). What actually
// separates them is the dealer's STOCK CODE suffix — "-d0846w", "-a0007c":
// a letter, four digits, a letter. That yields 79 vehicles; depth-based
// filtering would have silently dropped 28 of them and pulled in ~370 category
// pages.
//
// SPECS ARE "Label : value" TEXT, read by label:
//   Výkon (power, kW) · Objem (cc) · Palivo (fuel) · Emisní třída (Euro) ·
//   Najeto (odometer) · Rok výroby (year) · Provozní hmotnost (kerb weight) ·
//   Země původu (country of origin)
//
// POWER IS IN KILOWATTS — converted to hp (1 kW = 1.35962 hp) so the column
// matches every other source here.
//
// Usage:
//   node proresale-scraper.js
//   node proresale-scraper.js --make daf --year-min 2015

import {
  normaliseRecord,
  writeOutputs,
  fetchText,
  loadExisting,
  mapPool,
  randomDelay,
} from "./lib/scrape-core.js";
import { digits, firstMatch } from "./lib/html-utils.js";

const SLUG = "proresale";
const ORIGIN = "https://www.proresale.cz";
const SITEMAP = "https://proresale.cz/sitemap.xml";

const CZK_PER_EUR = 25;
const HP_PER_KW = 1.35962;

// A dealer stock code: letter + 4 digits + letter, at the very end of the slug.
const STOCK_CODE = /-([a-z]\d{4}[a-z])$/i;

function parseArgs(argv) {
  const args = {
    concurrency: 3,
    limit: Infinity,
    make: null,
    model: null,
    yearMin: null,
    yearMax: null,
    kmMax: null,
    priceMax: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--concurrency") args.concurrency = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--limit") args.limit = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--make") args.make = String(argv[++i] || "").toLowerCase();
    else if (a === "--model") args.model = String(argv[++i] || "").toLowerCase();
    else if (a === "--year-min") args.yearMin = parseInt(argv[++i], 10);
    else if (a === "--year-max") args.yearMax = parseInt(argv[++i], 10);
    else if (a === "--km-max") args.kmMax = parseInt(argv[++i], 10);
    else if (a === "--price-max") args.priceMax = parseInt(argv[++i], 10);
  }
  return args;
}

const clean = (h) =>
  String(h ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

const MAKES = [
  ["Mercedes-Benz", /\bmercedes(?:[-\s]?benz)?\b/i],
  ["DAF", /\bdaf\b/i],
  ["Volvo", /\bvolvo\b/i],
  ["MAN", /\bman\b/i],
  ["Scania", /\bscania\b/i],
  ["Iveco", /\biveco\b/i],
  ["Renault", /\brenault\b/i],
  ["Avia", /\bavia\b/i],
  ["Tatra", /\btatra\b/i],
  ["Schmitz", /\bschmitz(?:\s?cargobull)?\b/i],
  ["Krone", /\bkrone\b/i],
  ["Kögel", /\bk(?:ö|oe|o)gel\b/i],
  ["Ford", /\bford\b/i],
  ["Volkswagen", /\b(?:volkswagen|vw)\b/i],
];

function canonicalMake(raw) {
  const s = clean(raw);
  if (!s) return "";
  for (const [canonical, re] of MAKES) if (re.test(s)) return canonical;
  return s;
}

// "Label : value" pairs out of the page's visible text, read by LABEL.
function specs(text) {
  const pick = (label) =>
    clean(
      firstMatch(
        text,
        new RegExp("(?:" + label + ")\\s*:\\s*([^:]{1,40}?)(?=\\s+[A-ZÀ-ÿÁ-Žá-ž][^:]{0,24}\\s*:|$)", "i"),
      ) ?? "",
    );
  return {
    powerKw: digits(firstMatch(text, /Výkon\s*:\s*([\d\s]+)\s*kW/i) ?? ""),
    cc: digits(firstMatch(text, /Objem\s*:\s*([\d\s]+)\s*ccm/i) ?? ""),
    fuel: pick("Palivo"),
    euro: firstMatch(text, /Emisní\s+třída\s*:\s*Euro\s*(\d)/i),
    km: digits(firstMatch(text, /Najeto\s*:\s*([\d\s]+)\s*km/i) ?? ""),
    year: firstMatch(text, /Rok\s+výroby\s*:\s*((?:19|20)\d{2})/i),
    kerbKg: digits(firstMatch(text, /Provozní\s+hmotnost\s*:\s*([\d\s]+)\s*kg/i) ?? ""),
    country: pick("Země původu"),
  };
}

function parseDetail(html, url) {
  const title = clean(firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/));
  if (!title) return null;

  const text = clean(html.replace(/<script[\s\S]*?<\/script>/gi, " "));
  const s = specs(text);

  const make = canonicalMake(title);
  let model = title;
  for (const [, re] of MAKES) {
    const m = title.match(re);
    if (m) {
      model = title.slice(m.index + m[0].length).trim();
      break;
    }
  }

  // Price, where quoted: "1 250 000 Kč". Many are on request.
  const czk = digits(firstMatch(text, /Cena\s*:?\s*([\d\s]{4,})\s*Kč/i) ?? "");
  const priceEur = czk ? Math.round((Number(czk) / CZK_PER_EUR) * 100) / 100 : "";

  const kmNum = Number(s.km);

  return {
    // The stock code is the dealer's own id and is stable across slug edits.
    id: firstMatch(url, STOCK_CODE) || firstMatch(url, /\/([^/]+)$/),
    url,
    title,
    make,
    model: clean(model),
    year: s.year,
    // Sanity cap: no road truck exceeds ~3M km.
    mileage_km: kmNum && kmNum <= 3000000 ? String(kmNum) : "",
    engine_capacity_cc: s.cc,
    // kW -> hp so the column means the same as everywhere else.
    engine_power_hp: s.powerKw ? String(Math.round(Number(s.powerKw) * HP_PER_KW)) : "",
    fuel_type: s.fuel,
    euro_norm: s.euro,
    axle_configuration: firstMatch(title, /(\d\s?[xX]\s?\d)/).replace(/\s/g, ""),
    country_origin: /^[A-Z]{2}$/.test(s.country) ? s.country : "CZ",
    price_amount: priceEur,
  };
}

function applyFilters(rows, args) {
  return rows.filter((r) => {
    if (args.make && !String(r.make).toLowerCase().includes(args.make)) return false;
    if (args.model && !String(r.model).toLowerCase().includes(args.model)) return false;
    const y = Number(r.year) || 0;
    if (args.yearMin && (!y || y < args.yearMin)) return false;
    if (args.yearMax && (!y || y > args.yearMax)) return false;
    if (args.kmMax) {
      const km = Number(r.mileage_km) || 0;
      if (!km || km > args.kmMax) return false;
    }
    if (args.priceMax) {
      const p = Number(r.price_amount) || 0;
      if (!p || p > args.priceMax) return false;
    }
    return true;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scrapedAt = new Date().toISOString();

  const xml = await fetchText(SITEMAP);
  if (!xml) throw new Error("sitemap fetch failed");
  const all = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  // Czech tree only (skip the /ro/ and /ua/ translations), and only URLs ending
  // in a dealer stock code — see the header note on why depth does not work.
  const urls = all.filter((u) => /\/vozidla\//.test(u) && STOCK_CODE.test(u) && !/\/(ro|ua)\//.test(u));
  console.log(`[proresale] sitemap: ${all.length} urls, ${urls.length} vehicles`);

  const targets = urls.length > args.limit ? urls.slice(0, args.limit) : urls;

  let done = 0;
  const parsed = await mapPool(targets, args.concurrency, async (u) => {
    const html = await fetchText(u);
    let rec = null;
    if (html) {
      try {
        rec = parseDetail(html, u);
      } catch {
        rec = null;
      }
    }
    if (++done % 25 === 0) console.log(`[proresale] detail ${done}/${targets.length}`);
    await randomDelay([400, 900]);
    return rec;
  });

  let rows = parsed.filter(Boolean);
  console.log(`[proresale] parsed ${rows.length}/${targets.length}`);

  const before = rows.length;
  rows = applyFilters(rows, args);
  console.log(`[proresale] filtered ${before} -> ${rows.length}`);

  const byId = await loadExisting(SLUG);
  for (const r of rows) {
    byId.set(
      r.id,
      normaliseRecord(
        {
          id: r.id,
          url: r.url,
          title: r.title,
          make: r.make,
          model: r.model,
          year: r.year,
          mileage_km: r.mileage_km,
          fuel_type: r.fuel_type,
          engine_capacity_cc: r.engine_capacity_cc,
          engine_power_hp: r.engine_power_hp,
          axle_configuration: r.axle_configuration,
          price_amount: r.price_amount,
          price_currency: "EUR",
          country_origin: r.country_origin,
          seller_name: "Pro Resale Trucks",
          dealer_website: ORIGIN,
        },
        scrapedAt,
      ),
    );
  }

  await writeOutputs(SLUG, byId);
  console.log(`[proresale] wrote ${byId.size} records to output/${SLUG}/`);
}

main().catch((err) => {
  console.error("[proresale] fatal:", err.stack || err.message);
  process.exit(1);
});
