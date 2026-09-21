#!/usr/bin/env node
// lastbilbasen.com / .dk (Tachines) scraper — plain HTTP, no browser.
//
// BACKEND-FIRST, and this site earns it even though the catalogue page is
// client-rendered. /vehicle/catalog/trucks-c1 returns HTTP 200 whose
// #vehicle_list_wrapper holds only SEO copy — zero ads — which looks like a
// browser-only site. It is not:
//
//   * /sitemap.xml lists 6,991 URLs, of which 6,982 are vehicle detail pages,
//     and the CATEGORY IS IN THE PATH (/vehicle/catalog/<dealer>/trucks/...),
//     so trucks can be isolated without fetching everything. 477 truck URLs —
//     exactly the count the site's own category bar reports.
//   * Every detail page is fully server-rendered: make, model, year, VIN,
//     odometer, power, gearbox, Euro class, weights.
//
// robots.txt disallows only /admin, /content/, /pageajax/, /piranyaplatform/*,
// /task/ and /form/ — none of which this scraper touches.
//
// THE SITEMAP IS ALL .dk URLS even though the English site is .com. Both hosts
// serve the same records; .com renders labels in English, which is what this
// scraper wants, so sitemap URLs are rewritten .dk -> .com before fetching.
// (Verified: the .com host returns the same vehicle with English headings.)
//
// TWO SPEC SOURCES ON EACH DETAIL PAGE, both used:
//   1. div.vehicle_basic_info — value/label pairs, some carrying schema.org
//      itemprops (category, bodyType). Read by LABEL, never by position.
//   2. The meta description — a Danish spec dump: "Hk: 460 Km: 612000
//      Gearkasse: Automat Eurotype: 6 Totalvægt: 26000 kg". This is where the
//      odometer and power actually live; the basic-info row does not carry them.
//
// DANISH FIELD NAMES, on an English page. The meta string stays Danish
// regardless of host: Hk = horsepower, Km = odometer, Årgang = year,
// Gearkasse = gearbox, Totalvægt = gross weight, Egenvægt = kerb weight,
// Serienummer = VIN. Parsing the English labels alone would silently lose all
// of these.
//
// PRICES ARE OFTEN "Price on request". Those are stored NULL, never 0.
//
// Usage:
//   node lastbilbasen-scraper.js
//   node lastbilbasen-scraper.js --make volvo --year-min 2015
//   node lastbilbasen-scraper.js --category semitruck

import {
  normaliseRecord,
  writeOutputs,
  fetchText,
  loadExisting,
  mapPool,
  randomDelay,
} from "./lib/scrape-core.js";
import { digits, firstMatch } from "./lib/html-utils.js";

const SLUG = "lastbilbasen";
const ORIGIN = "https://lastbilbasen.com";
const SITEMAP = "https://lastbilbasen.com/sitemap.xml";

// Path segment -> the site's own category slug. "trucks" is the default.
const CATEGORIES = [
  "trucks",
  "semitruck",
  "semi-trailer",
  "trailer",
  "crane",
  "forklifts",
  "construction",
  "van",
  "bus",
  "cars",
  "agriculture",
  "forestry",
  "other",
];

// The site quotes DKK. Fixed rate, same approach as the CZK/GBP sources.
const DKK_PER_EUR = 7.46;

function parseArgs(argv) {
  const args = {
    category: "trucks",
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
    if (a === "--category") args.category = String(argv[++i] || "").trim();
    else if (a === "--concurrency") args.concurrency = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--limit") args.limit = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--make") args.make = String(argv[++i] || "").toLowerCase();
    else if (a === "--model") args.model = String(argv[++i] || "").toLowerCase();
    else if (a === "--year-min") args.yearMin = parseInt(argv[++i], 10);
    else if (a === "--year-max") args.yearMax = parseInt(argv[++i], 10);
    else if (a === "--km-max") args.kmMax = parseInt(argv[++i], 10);
    else if (a === "--price-max") args.priceMax = parseInt(argv[++i], 10);
  }
  if (!CATEGORIES.includes(args.category)) {
    throw new Error(`unknown --category "${args.category}" (expected: ${CATEGORIES.join(", ")})`);
  }
  return args;
}

const clean = (h) =>
  String(h ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCharCode(parseInt(x, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&hellip;/g, "…")
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
  ["Renault", /\brenault(?:\s+trucks)?\b/i],
  ["Ford", /\bford\b/i],
  ["Nissan", /\bnissan\b/i],
  ["Mitsubishi", /\bmitsubishi\b/i],
  ["Toyota", /\btoyota\b/i],
  ["Volkswagen", /\b(?:volkswagen|vw)\b/i],
  ["Unimog", /\bunimog\b/i],
  ["Kenworth", /\bkenworth\b/i],
  ["Hyundai", /\bhyundai\b/i],
  ["Isuzu", /\bisuzu\b/i],
  ["Scheuerle", /\bscheuerle\b/i],
  ["Schmitz", /\bschmitz(?:\s?cargobull)?\b/i],
  ["Krone", /\bkrone\b/i],
  ["Kel-Berg", /\bkel-?berg\b/i],
];

function canonicalMake(raw) {
  const s = clean(raw);
  if (!s) return "";
  for (const [canonical, re] of MAKES) if (re.test(s)) return canonical;
  return s;
}

// The value/label pairs in #vehicle_basic_infos, keyed by their LABEL (the
// second <p> in each cell), since the set and order vary per vehicle.
function basicInfos(html) {
  const out = {};
  // NOTE the capture group. firstMatch() returns m[1], so a regex with NO group
  // makes it call .trim() on undefined and throw — which is exactly what
  // silently produced "parsed 0/477" before this was fixed. Any regex handed to
  // firstMatch must capture.
  const block =
    firstMatch(html, /(<div id="vehicle_basic_infos"[\s\S]*?)(?=<div id="vehicle_)/) || html;
  const re = /<div class="vehicle_basic_info[^"]*">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(block))) {
    const ps = [...m[1].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((x) => clean(x[1]));
    if (ps.length >= 2) {
      const label = ps[ps.length - 1].toLowerCase();
      const value = ps.slice(0, -1).filter(Boolean).join(" ");
      if (label && value) out[label] = value;
    }
  }
  return out;
}

// The Danish spec dump in <meta name="description">. Values are "Key: value"
// separated by spaces, so each key is read individually up to the next key.
function metaSpecs(html) {
  const desc = clean(firstMatch(html, /<meta name="description" content="([\s\S]*?)"\s*\/?>/));
  // TWO META FORMATS EXIST, and only one carries specs:
  //   structured  "... Serienummer WDB963… Hk: 460 Km: 612000 Gearkasse: Automat …"
  //   free prose  "Mærke MAN. Model TGS 35.320. Årgang 2018. VELHOLDT MAN MED …"
  // The prose form is a dealer sales blurb with no odometer/power in it — and
  // the page body has none either (checked: the dealer simply never supplied
  // them), so these fields are legitimately blank on most ads. Do not invent
  // them from elsewhere on the page.
  //
  // MATCH THE UNIT STRICTLY. An earlier loose lookahead ran past the value and
  // swallowed the rest of the blurb, yielding a 19-digit "odometer" and a
  // 50-digit "horsepower" on live ads. Each key now takes only the digit run
  // immediately after its "Key:" label, and is sanity-capped.
  const pick = (key, max) => {
    const v = firstMatch(desc, new RegExp("\\b" + key + "\\s*:\\s*([\\d.\\s]{1,12})(?![\\d.])", "i"));
    const n = Number(digits(v));
    if (!n) return "";
    return max && n > max ? "" : String(n);
  };
  return {
    raw: desc,
    // Plausibility caps: no road truck exceeds ~1,200 hp or ~3M km.
    hk: pick("Hk", 1200),
    km: pick("Km", 3000000),
    year: firstMatch(desc, /Årgang\s+((?:19|20)\d{2})/i),
    gearbox: firstMatch(desc, /\bGearkasse\s*:\s*([A-Za-zÆØÅæøå]+)/i),
    euro: firstMatch(desc, /Eurotype:?\s*(\d)/i),
    vin: firstMatch(desc, /Serienummer\s+([A-HJ-NPR-Z0-9]{11,17})/i),
    grossKg: digits(firstMatch(desc, /Totalvægt:?\s*([\d.\s]+)\s*kg/i)),
    kerbKg: digits(firstMatch(desc, /Egenvægt:?\s*([\d.\s]+)\s*kg/i)),
    payloadKg: digits(firstMatch(desc, /Lastevne\s*([\d.\s]+)\s*kg/i)),
  };
}

function parseDetail(html, url) {
  const title =
    clean(firstMatch(html, /<meta name="title" content="([\s\S]*?)"\s*\/?>/)) ||
    clean(firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/));
  if (!title) return null;

  const info = basicInfos(html);
  const meta = metaSpecs(html);

  // Brand/Model come from their own labelled cells where present; the title is
  // the fallback.
  const makeRaw = info["brand"] || firstMatch(meta.raw, /Producent\s+([A-Za-zÆØÅæøå-]+)/) || "";
  const make = canonicalMake(makeRaw || title);
  let model = info["model"] || "";
  if (!model) {
    const m = title.match(new RegExp(makeRaw ? makeRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "$^", "i"));
    model = m ? title.slice(m.index + m[0].length).trim() : title;
  }

  const year = info["manufacturing date"] || meta.year || "";
  // PRICE: the listing's OWN price is the first `class="price ..."` element,
  // which appears BEFORE #vehicle_basic_infos. Everything after that point
  // includes "related vehicles" cards that carry OTHER listings' prices
  // (h3.price > span.sale, e.g. "DKK 225,000") — scanning the whole page for a
  // DKK figure therefore attributes a neighbour's price to this vehicle, which
  // is worse than no price at all. There is no itemprop="price" on this site.
  //
  // In practice almost every ad reads "Price on request": on the live truck
  // category this yields 0 priced of 477, which is the site's reality, not a
  // parse failure — dealers here quote on contact.
  const head = html.slice(0, html.indexOf('id="vehicle_basic_infos"') + 1 || html.length);
  const priceRaw = clean(firstMatch(head, /class="price[^"]*"[^>]*>([\s\S]*?)<\/h3>/));
  const dkk = /request|foresp|no-price/i.test(priceRaw) ? "" : digits(priceRaw);
  const priceEur = dkk ? Math.round((Number(dkk) / DKK_PER_EUR) * 100) / 100 : "";

  return {
    // The ad id is the -v<digits> suffix — stable across dealer/slug changes.
    id: firstMatch(url, /-v(\d+)\/?$/) || firstMatch(url, /\/([^/]+)\/?$/),
    url,
    title,
    make,
    model: clean(model),
    year: firstMatch(String(year), /((?:19|20)\d{2})/),
    mileage_km: meta.km,
    engine_power_hp: meta.hk,
    gearbox: meta.gearbox,
    gross_weight_kg: meta.grossKg,
    payload_kg: meta.payloadKg,
    vin: meta.vin,
    axle_configuration: firstMatch(info["axel"] || title, /(\d\s?[xX]\s?\d)/).replace(/\s/g, ""),
    body_type: info["structure"] || "",
    price_amount: priceEur,
    price_dkk: dkk,
    seller_name: clean(firstMatch(html, /id="vehicle_seller__name"[^>]*>([\s\S]*?)<\//)),
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

  // ---- phase 1: sitemap, filtered to the wanted category by PATH ----
  const xml = await fetchText(SITEMAP);
  if (!xml) throw new Error("sitemap fetch failed");
  const all = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const urls = all
    .filter((u) => new RegExp(`/vehicle/catalog/[^/]+/${args.category}/`).test(u))
    // The sitemap is published on the .dk host; the .com host serves the same
    // records with English labels, which is what this parser expects.
    .map((u) => u.replace(/^https?:\/\/lastbilbasen\.dk/, ORIGIN));
  console.log(`[lastbilbasen] sitemap: ${all.length} urls, ${urls.length} in category "${args.category}"`);

  const targets = urls.length > args.limit ? urls.slice(0, args.limit) : urls;

  // ---- phase 2: detail pages ----
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
    if (++done % 50 === 0) console.log(`[lastbilbasen] detail ${done}/${targets.length}`);
    await randomDelay([400, 900]);
    return rec;
  });

  let rows = parsed.filter(Boolean);
  console.log(`[lastbilbasen] parsed ${rows.length}/${targets.length}`);

  const before = rows.length;
  rows = applyFilters(rows, args);
  console.log(`[lastbilbasen] filtered ${before} -> ${rows.length}`);

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
          engine_power_hp: r.engine_power_hp,
          axle_configuration: r.axle_configuration,
          gearbox: r.gearbox,
          gross_weight_kg: r.gross_weight_kg,
          payload_kg: r.payload_kg,
          // EUR, converted from the quoted DKK; blank where "Price on request".
          price_amount: r.price_amount,
          price_currency: "EUR",
          country_origin: "DK",
          seller_name: r.seller_name,
          dealer_website: ORIGIN,
          vin: r.vin,
        },
        scrapedAt,
      ),
    );
  }

  await writeOutputs(SLUG, byId);
  console.log(`[lastbilbasen] wrote ${byId.size} records to output/${SLUG}/`);
}

main().catch((err) => {
  console.error("[lastbilbasen] fatal:", err.stack || err.message);
  process.exit(1);
});
