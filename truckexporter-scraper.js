#!/usr/bin/env node
// truckexporter.co.uk (Comvex Trucks) scraper — plain HTTP, no browser.
//
// BACKEND-FIRST, and this site earns it despite the category page being
// JS-rendered. The /product-category/ listing grid IS client-side (JetEngine
// injects the cards; the server HTML has zero /vehicle/ links), which is easy to
// mistake for "needs a browser". It does not:
//
//   * /product-sitemap.xml lists all 89 vehicle URLs, server-side.
//   * /wp-json/wp/v2/product returns the same 89 (X-WP-Total: 89), open, no auth.
//   * Every /vehicle/<slug>/ DETAIL page is fully server-rendered — price,
//     odometer, registration, chassis number and the full spec list are in the
//     raw HTML.
//
// So the whole catalogue is reachable over plain HTTP by enumerating the sitemap
// and reading detail pages. robots.txt is "User-agent: * / Disallow:" — i.e.
// nothing disallowed — and it advertises the sitemap.
//
// DETAIL SPECS ARE LABEL/VALUE ICON-BOXES:
//   div.elementor-icon-box-title   > span   "Registration"
//   p.elementor-icon-box-description        "SK65BLJ"
// Read by LABEL, never by position — the set present varies per vehicle.
//
// ODOMETER UNIT VARIES PER LISTING. Live examples: "200,825 Kms" and
// "1,063,994 Miles" — a UK exporter carries both home-market (miles) and
// imported (km) stock. Taking the number without its unit would record that
// 1.06M-mile truck as 1.06M km, understating it by 61%. Miles are converted.
//
// NOT EVERYTHING IS A TRUCK. The same product type holds generators ("ASHITA
// 50KVA SUPER-SILENT DIESEL GENERATOR"), plant and machinery. Those have no
// odometer/registration and would pollute a truck comparison, so they are
// dropped unless --include-plant.
//
// Writes output/truckexporter/listings.json, then
//   node load-listings.js truckexporter truckexporter
//
// Usage:
//   node truckexporter-scraper.js
//   node truckexporter-scraper.js --make daf --year-min 2015
//   node truckexporter-scraper.js --include-plant

import {
  normaliseRecord,
  writeOutputs,
  fetchText,
  loadExisting,
  mapPool,
  randomDelay,
} from "./lib/scrape-core.js";
import { digits, firstMatch } from "./lib/html-utils.js";

const SLUG = "truckexporter";
const ORIGIN = "https://www.truckexporter.co.uk";
const SITEMAP = `${ORIGIN}/product-sitemap.xml`;

// The site quotes GBP. Converted to EUR for comparability with the rest of the
// registry; the raw figure is kept in the title/description trail.
const GBP_PER_EUR = 0.85;
const KM_PER_MILE = 1.609344;

function parseArgs(argv) {
  const args = {
    concurrency: 3,
    limit: Infinity,
    includePlant: false,
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
    else if (a === "--include-plant") args.includePlant = true;
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
    .replace(/&pound;/g, "£")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
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
  ["Hino", /\bhino\b/i],
  ["Isuzu", /\bisuzu\b/i],
  ["Toyota", /\btoyota\b/i],
  ["Ford", /\bford\b/i],
  ["Nissan", /\bnissan\b/i],
  ["Mitsubishi", /\bmitsubishi\b/i],
  ["Fuso", /\bfuso\b/i],
  ["Leyland", /\bleyland\b/i],
  ["ERF", /\berf\b/i],
  ["Foden", /\bfoden\b/i],
];

function splitTitle(title) {
  // "SCANIA R450 HIGHLINE 6X2 MIDLIFT TRACTOR (2015)" — drop the bracketed year.
  const t = clean(title).replace(/\(\s*(?:19|20)\d{2}\s*\)\s*$/, "").trim();
  for (const [canonical, re] of MAKES) {
    const m = t.match(re);
    if (m) return { make: canonical, model: t.slice(m.index + m[0].length).trim() };
  }
  const parts = t.split(" ").filter(Boolean);
  return { make: parts[0] || "", model: parts.slice(1).join(" ") };
}

// Pull every icon-box label/value pair on the detail page into a flat lookup.
function specMap(html) {
  const out = {};
  const re =
    /<div class="elementor-icon-box-title">\s*<span[^>]*>([\s\S]*?)<\/span>\s*<\/div>\s*<p class="elementor-icon-box-description">([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(html))) {
    const k = clean(m[1]).toLowerCase();
    const v = clean(m[2]);
    if (k && v) out[k] = v;
  }
  return out;
}

// "200,825 Kms" or "1,063,994 Miles" -> kilometres. See header note.
function odometerKm(raw) {
  const m = String(raw || "").match(/([\d,.\s]{3,})\s*(miles?|kms?|km)\b/i);
  if (!m) return "";
  const n = Number(digits(m[1]));
  if (!n) return "";
  return String(/mile/i.test(m[2]) ? Math.round(n * KM_PER_MILE) : n);
}

function parseDetail(html, url) {
  const title = clean(firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/));
  if (!title) return null;

  const specs = specMap(html);
  const { make, model } = splitTitle(title);

  // Price sits inside a <bdi> under .woocommerce-Price-amount. Strip the pence
  // so 24,750.00 does not become 2475000.
  // The amount is nested TWO levels deep — <span class="...amount"><bdi><span
  // class="...currencySymbol">&pound;</span>24,750.00</bdi></span> — so a lazy
  // match to the first </span> stops at the CURRENCY SYMBOL and captures no
  // digits at all (this returned 0/85 prices before being fixed). Match to
  // </bdi> instead, which is the real end of the figure.
  const priceBlock =
    firstMatch(html, /class="woocommerce-Price-amount amount">\s*<bdi>([\s\S]*?)<\/bdi>/) ||
    firstMatch(html, /class="woocommerce-Price-amount amount">([\s\S]*?)<\/span>\s*<\/p>/);
  const gbp = Number(digits(clean(priceBlock).replace(/[.,]\d{2}\s*$/, ""))) || "";
  const priceEur = gbp ? Math.round((gbp / GBP_PER_EUR) * 100) / 100 : "";

  // Odometer: prefer a labelled spec, else the "Miles / Kms Reading:" sentence
  // in the description, else any "N Kms/Miles" on the page.
  const odoRaw =
    specs["miles / kms"] ||
    specs["mileage"] ||
    specs["odometer"] ||
    firstMatch(html, /Miles\s*\/\s*Kms Reading:\s*([\d,.\s]+(?:Miles|Kms?))/i) ||
    firstMatch(html, /([\d,]{3,}\s*(?:Miles|Kms?))\b/i);
  const mileageKm = odometerKm(odoRaw);

  const year =
    firstMatch(title, /\((19|20)(\d{2})\)/) && title.match(/\((\d{4})\)/)
      ? title.match(/\((\d{4})\)/)[1]
      : firstMatch(specs["year"] || "", /((?:19|20)\d{2})/) ||
        firstMatch(html, /\b((?:19|20)\d{2})\b/);

  const tonnes = firstMatch(
    specs["gross weight"] || specs["gvw"] || specs["weight"] || "",
    /([\d.]+)/,
  ) || firstMatch(html, /([\d.]+)\s*Tonne\b/i);

  return {
    id: firstMatch(url, /\/vehicle\/([^/]+)/),
    url,
    title,
    make,
    model,
    year: year || "",
    mileage_km: mileageKm,
    gross_weight_kg: tonnes ? String(Math.round(Number(tonnes) * 1000)) : "",
    registration: specs["registration"] || "",
    vin: specs["chassis number"] || specs["vin"] || "",
    gearbox: specs["gearbox"] || specs["transmission"] || "",
    axle_configuration: firstMatch(title, /\b(\d\s?[xX]\s?\d)\b/).replace(/\s/g, ""),
    price_gbp: gbp,
    price_amount: priceEur,
    // Kept so a reader can see the quoted figure, not just the conversion.
    original_price_gbp: gbp,
  };
}

// Generators / plant have no registration AND no odometer, and their titles say
// so. Dropping them keeps a truck price comparison honest.
const PLANT_RE = /\b(generator|kva|excavator|forklift|telehandler|dumper|roller|compressor)\b/i;
function isPlant(row) {
  if (PLANT_RE.test(row.title)) return true;
  return !row.mileage_km && !row.registration;
}

function applyFilters(rows, args) {
  return rows.filter((r) => {
    if (!args.includePlant && isPlant(r)) return false;
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

  // ---- phase 1: enumerate the sitemap ----
  const xml = await fetchText(SITEMAP);
  if (!xml) throw new Error("product sitemap fetch failed");
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1])
    .filter((u) => /\/vehicle\//.test(u));
  console.log(`[truckexporter] sitemap: ${urls.length} vehicle URLs`);

  const targets = urls.length > args.limit ? urls.slice(0, args.limit) : urls;

  // ---- phase 2: detail pages (all fields live here) ----
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
    if (++done % 20 === 0) console.log(`[truckexporter] detail ${done}/${targets.length}`);
    await randomDelay([400, 900]);
    return rec;
  });

  let rows = parsed.filter(Boolean);
  console.log(`[truckexporter] parsed ${rows.length}/${targets.length} detail pages`);

  const plant = rows.filter(isPlant).length;
  const before = rows.length;
  rows = applyFilters(rows, args);
  console.log(
    `[truckexporter] filtered ${before} -> ${rows.length} (${plant} plant/generator${args.includePlant ? " kept" : " excluded"})`,
  );

  // ---- emit ----
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
          axle_configuration: r.axle_configuration,
          gearbox: r.gearbox,
          gross_weight_kg: r.gross_weight_kg,
          // EUR, converted from the quoted GBP at the fixed rate above.
          price_amount: r.price_amount,
          price_currency: "EUR",
          country_origin: "GB",
          seller_name: "Comvex Trucks (TruckExporter)",
          dealer_website: ORIGIN,
          vin: r.vin,
        },
        scrapedAt,
      ),
    );
  }

  await writeOutputs(SLUG, byId);
  console.log(`[truckexporter] wrote ${byId.size} records to output/${SLUG}/`);
}

main().catch((err) => {
  console.error("[truckexporter] fatal:", err.stack || err.message);
  process.exit(1);
});
