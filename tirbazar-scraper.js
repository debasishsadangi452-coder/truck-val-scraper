#!/usr/bin/env node
// tirbazar.cz — Czech truck bazaar, plain HTTP.
//
// BACKEND. Verified 2026-09: /sitemap.xml lists 339 URLs, of which 297 are
// vehicle detail pages under /nabidka-vozidel/produkt/<id>-<slug>, and every
// detail page is fully server-rendered. robots.txt disallows only /admin/*.
//
// THE SITEMAP MIXES CATEGORY AND DETAIL PAGES under the same prefix: 18 of the
// /nabidka-vozidel/ URLs are category listings (tahace, navesy, motor, …) and
// the rest are products. They are separated by path depth — a product always has
// the /produkt/ segment.
//
// NOT EVERYTHING IS A VEHICLE. The same catalogue carries spare parts
// (nahradni-dily, motor, prevodovka, naprava, kabina, brzdy, …). Products
// declare their own "Typ vozidla" (vehicle type) — "Nákladní" (truck),
// "Tahač" (tractor), "Návěs" (semi-trailer) etc. Parts have no such row, and are
// dropped unless --include-parts.
//
// SPECS ARE A PLAIN <table> of label/value <td> pairs, read by LABEL:
//   Značka (make) · Rok výroby (year) · Najeto (odometer) · Objem (cc) ·
//   Výkon (power, in kW) · Palivo (fuel) · Emisní norma (Euro) · VIN ·
//   Karosérie (body) · Typ vozidla (vehicle type)
//
// POWER IS IN KILOWATTS ("300 kW"), not hp — converted here (1 kW = 1.35962 hp)
// so the column means the same thing as every other source in this registry.
//
// THE PRICE CSS CLASSES ARE MISLEADING — read the TEXT, not the class name:
//   <span class="with-dph">1 250 000 Kč</span>          <- actually EX-VAT
//   <span class="without-dph">1 512 500 Kč včetně DPH</span>  <- INCLUDING VAT
// "včetně DPH" literally means "including VAT", so the class names are the wrong
// way round on this site. This scraper takes the ex-VAT figure (the one WITHOUT
// the "včetně DPH" wording), matching how the other EU sources here quote.
//
// Usage:
//   node tirbazar-scraper.js
//   node tirbazar-scraper.js --make scania --year-min 2015
//   node tirbazar-scraper.js --include-parts

import {
  normaliseRecord,
  writeOutputs,
  fetchText,
  loadExisting,
  mapPool,
  randomDelay,
} from "./lib/scrape-core.js";
import { digits, firstMatch } from "./lib/html-utils.js";

const SLUG = "tirbazar";
const ORIGIN = "https://www.tirbazar.cz";
const SITEMAP = `${ORIGIN}/sitemap.xml`;

const CZK_PER_EUR = 25; // same fixed rate as the other Czech sources here
const HP_PER_KW = 1.35962;

function parseArgs(argv) {
  const args = {
    concurrency: 3,
    limit: Infinity,
    includeParts: false,
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
    else if (a === "--include-parts") args.includeParts = true;
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
    .replace(/&#0?39;|&apos;/g, "'")
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
  ["Tatra", /\btatra\b/i],
  ["Avia", /\bavia\b/i],
  ["Liaz", /\bliaz\b/i],
  ["Schmitz", /\bschmitz(?:\s?cargobull)?\b/i],
  ["Krone", /\bkrone\b/i],
  ["Kögel", /\bk(?:ö|oe|o)gel\b/i],
  ["Wielton", /\bwielton\b/i],
  ["Ford", /\bford\b/i],
  ["Volkswagen", /\b(?:volkswagen|vw)\b/i],
  ["Fiat", /\bfiat\b/i],
  ["Palfinger", /\bpalfinger\b/i],
];

function canonicalMake(raw) {
  const s = clean(raw);
  if (!s) return "";
  for (const [canonical, re] of MAKES) if (re.test(s)) return canonical;
  return s;
}

// The product's <table> of label/value pairs, keyed by lowercased label.
function specTable(html) {
  const out = {};
  const re = /<tr>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/g;
  let m;
  while ((m = re.exec(html))) {
    const k = clean(m[1]).toLowerCase();
    const v = clean(m[2]);
    if (k && v) out[k] = v;
  }
  return out;
}

function parseDetail(html, url) {
  const title =
    clean(firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/)) ||
    clean(firstMatch(html, /<h2[^>]*>([\s\S]*?)<\/h2>/));
  if (!title) return null;

  const spec = specTable(html);

  // PRICE: read by TEXT, not by class — see the header note. The figure that
  // does NOT say "včetně DPH" is the ex-VAT price.
  const priceBlock = firstMatch(html, /<div class="price">([\s\S]*?)<\/div>/);
  const spans = [...String(priceBlock).matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((m) =>
    clean(m[1]),
  );
  const exVat = spans.find((s) => /Kč/i.test(s) && !/včetně\s+DPH/i.test(s)) || "";
  const czk = digits(exVat);
  const priceEur = czk ? Math.round((Number(czk) / CZK_PER_EUR) * 100) / 100 : "";

  const makeRaw = spec["značka"] || "";
  const make = canonicalMake(makeRaw || title);
  // The h1 is "<make> <model> …"; strip the make to leave the model.
  let model = title;
  const mm = title.match(new RegExp(makeRaw ? makeRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "$^", "i"));
  if (mm) model = title.slice(mm.index + mm[0].length).trim();

  // Power is quoted in kW — convert so the column is hp everywhere.
  const kw = Number(digits(firstMatch(spec["výkon"] || "", /([\d\s]+)\s*kW/i)));
  const hp = kw ? String(Math.round(kw * HP_PER_KW)) : "";

  const kmNum = Number(digits(spec["najeto"] || ""));

  return {
    id: firstMatch(url, /\/produkt\/(\d+)-/) || firstMatch(url, /\/([^/]+)$/),
    url,
    title,
    make,
    model: clean(model),
    year: firstMatch(spec["rok výroby"] || "", /((?:19|20)\d{2})/),
    // Sanity cap: no road truck exceeds ~3M km.
    mileage_km: kmNum && kmNum <= 3000000 ? String(kmNum) : "",
    engine_capacity_cc: digits(firstMatch(spec["objem"] || "", /([\d\s]+)\s*ccm/i)),
    engine_power_hp: hp,
    fuel_type: spec["palivo"] || "",
    gearbox: spec["převodovka"] || "",
    vin: firstMatch(spec["vin"] || "", /([A-HJ-NPR-Z0-9]{11,17})/i),
    body_type: spec["karosérie"] || "",
    vehicle_type: spec["typ vozidla"] || "",
    euro_norm: firstMatch(spec["emisní norma"] || "", /(\d)/),
    axle_configuration: firstMatch(title, /(\d\s?[xX]\s?\d)/).replace(/\s/g, ""),
    price_amount: priceEur,
    price_czk: czk,
  };
}

// Parts listings carry no "Typ vozidla" row. Vehicles always do.
const PART_RE =
  /\b(motor|převodovka|náprava|kabina|brzd|diferenciál|podvozek|řízení|karosářsk|náhradní díl)\b/i;
function isPart(row) {
  if (row.vehicle_type) return false;
  return PART_RE.test(row.title) || (!row.year && !row.mileage_km);
}

// THE CATALOGUE IS NOT ONLY TRUCKS. Products declare their own "Typ vozidla",
// and a 20-product sample of the live sitemap returned: Nákladní (truck) 8,
// Přívěsy (trailer) 7, Osobní (PASSENGER CAR) 4, Pracovní stroje (machinery) 1.
// A Škoda Kodiaq turned up in the first 14 parsed. Passenger cars and machinery
// would skew a truck price comparison, so only trucks and trailers are kept —
// trailers because the rest of this registry already carries them as stock.
const VEHICLE_TYPES_KEPT = /^(nákladní|tahač|přívěs|návěs)/i;
function isWantedType(row) {
  if (!row.vehicle_type) return true; // unclassified: let the parts filter judge
  return VEHICLE_TYPES_KEPT.test(row.vehicle_type);
}

function applyFilters(rows, args) {
  return rows.filter((r) => {
    if (!args.includeParts && isPart(r)) return false;
    if (!args.includeParts && !isWantedType(r)) return false;
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
  // /produkt/ is what separates a product from the 18 category pages.
  const urls = all.filter((u) => /\/nabidka-vozidel\/produkt\//.test(u));
  console.log(`[tirbazar] sitemap: ${all.length} urls, ${urls.length} products`);

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
    if (++done % 50 === 0) console.log(`[tirbazar] detail ${done}/${targets.length}`);
    await randomDelay([400, 900]);
    return rec;
  });

  let rows = parsed.filter(Boolean);
  const parts = rows.filter(isPart).length;
  const offType = rows.filter((r) => !isPart(r) && !isWantedType(r)).length;
  console.log(
    `[tirbazar] parsed ${rows.length}/${targets.length} (${parts} parts, ${offType} cars/machinery)`,
  );

  const before = rows.length;
  rows = applyFilters(rows, args);
  console.log(`[tirbazar] filtered ${before} -> ${rows.length}`);

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
          gearbox: r.gearbox,
          // EUR, converted from the quoted ex-VAT CZK figure.
          price_amount: r.price_amount,
          price_currency: "EUR",
          country_origin: "CZ",
          seller_name: "TIR Bazar",
          dealer_website: ORIGIN,
          vin: r.vin,
        },
        scrapedAt,
      ),
    );
  }

  await writeOutputs(SLUG, byId);
  console.log(`[tirbazar] wrote ${byId.size} records to output/${SLUG}/`);
}

main().catch((err) => {
  console.error("[tirbazar] fatal:", err.stack || err.message);
  process.exit(1);
});
