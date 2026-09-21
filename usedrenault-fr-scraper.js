#!/usr/bin/env node
// used-renault-trucks.fr — Renault Trucks' French used-vehicle network.
//
// BACKEND, plain HTTP. Verified 2026-09: /sitemap.xml lists 643 URLs of which
// 562 are vehicles, the TYPE IS IN THE PATH (/tractor-…, /rigid-…, /van-…), and
// every detail page is fully server-rendered. There is no robots.txt (404), so
// nothing is disallowed.
//
// NOTE THIS IS NOT ONLY RENAULT STOCK. The network sells trade-ins too — live
// sitemap includes /tractor-man-tgs-64598, /van-opel-vivaro-…, /van-iveco-daily-…
// So the make comes from the page, never from the domain name.
//
// TRUCKS ARE tractor + rigid (306 of 562). The rest are vans (245), semi (9) and
// trailers (2); vans are light commercials, not trucks, so they are excluded by
// default — `--include-vans` keeps them.
//
// THE <h1> CARRIES ALMOST EVERYTHING, in a fixed shape:
//   "Tracteur MAN TGS 500 / 4X2 Euro 6 / 372 500 kms - 2019"
//   "Porteur Renault Trucks Midlum 220 4X2 Euro 5 - Benne 104 982 kms - 2014"
// i.e. <type> <make> <model> <axles> <euro> [- body] <mileage> kms - <year>.
// It is split from the RIGHT (mileage+year first, then axles/euro), because the
// model portion is free text of unpredictable length.
//
// JSON-LD IS PRESENT BUT THIN: a Product block gives name/brand/mpn (the
// reference number) and a description, which is useful as a cross-check on the
// make — but its `offers.price` is a hardcoded "0.00" placeholder. Storing that
// would put a €0 truck into the comparison set, so the price is NOT read from
// JSON-LD.
//
// NO PRICE IS PUBLISHED AT ALL. Vehicle pages carry no price element; the only
// "€" on the page is the site-wide "dès 790€/mois" finance banner in the header,
// which belongs to a marketing offer and NOT to the vehicle. An early version of
// this parser scraped exactly that and reported every truck as "790€" — a
// site-wide constant. price_amount is therefore left blank (NULL), as on
// camion-occasion.
//
// Usage:
//   node usedrenault-fr-scraper.js
//   node usedrenault-fr-scraper.js --make man --year-min 2018
//   node usedrenault-fr-scraper.js --include-vans

import {
  normaliseRecord,
  writeOutputs,
  fetchText,
  loadExisting,
  mapPool,
  randomDelay,
} from "./lib/scrape-core.js";
import { digits, firstMatch } from "./lib/html-utils.js";

const SLUG = "usedrenault-fr";
const ORIGIN = "https://www.used-renault-trucks.fr";
const SITEMAP = `${ORIGIN}/sitemap.xml`;

// Path prefixes that are trucks. Vans are light commercials — excluded unless
// --include-vans.
const TRUCK_TYPES = ["tractor", "rigid"];
const VAN_TYPES = ["van"];

function parseArgs(argv) {
  const args = {
    concurrency: 3,
    limit: Infinity,
    includeVans: false,
    make: null,
    model: null,
    yearMin: null,
    yearMax: null,
    kmMax: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--concurrency") args.concurrency = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--limit") args.limit = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--include-vans") args.includeVans = true;
    else if (a === "--make") args.make = String(argv[++i] || "").toLowerCase();
    else if (a === "--model") args.model = String(argv[++i] || "").toLowerCase();
    else if (a === "--year-min") args.yearMin = parseInt(argv[++i], 10);
    else if (a === "--year-max") args.yearMax = parseInt(argv[++i], 10);
    else if (a === "--km-max") args.kmMax = parseInt(argv[++i], 10);
  }
  return args;
}

const clean = (h) =>
  String(h ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&eacute;/g, "é")
    .replace(/\s+/g, " ")
    .trim();

const MAKES = [
  ["Renault", /\brenault(?:\s+trucks)?\b/i],
  ["Mercedes-Benz", /\bmercedes(?:[-\s]?benz)?\b/i],
  ["DAF", /\bdaf\b/i],
  ["Volvo", /\bvolvo\b/i],
  ["MAN", /\bman\b/i],
  ["Scania", /\bscania\b/i],
  ["Iveco", /\biveco\b/i],
  ["Ford", /\bford\b/i],
  ["Opel", /\bopel\b/i],
  ["Peugeot", /\bpeugeot\b/i],
  ["Citroën", /\bcitro(?:ë|e)n\b/i],
  ["Fiat", /\bfiat\b/i],
  ["Nissan", /\bnissan\b/i],
  ["Toyota", /\btoyota\b/i],
  ["Isuzu", /\bisuzu\b/i],
  ["Mitsubishi", /\bmitsubishi\b/i],
  ["Volkswagen", /\b(?:volkswagen|vw)\b/i],
];

function canonicalMake(raw) {
  const s = clean(raw);
  if (!s) return "";
  for (const [canonical, re] of MAKES) if (re.test(s)) return canonical;
  return s;
}

// French body/type words that lead the h1 and are NOT part of the model.
const LEAD_TYPE = /^(Tracteur|Porteur|Semi[- ]?remorque|Remorque|Utilitaire|Fourgon)\s+/i;

// Split the h1 from the RIGHT: "… 372 500 kms - 2019" is a fixed tail, so take
// it off first and treat what remains as type + make + model + trim.
function parseHeadline(h1) {
  const t = clean(h1);
  // THE EURO CLASS MUST BE REMOVED BEFORE READING THE ODOMETER. The h1 reads
  // "… 4X2 Euro 6 372 500 kms - 2019" and French groups thousands with spaces,
  // so "6 372 500" is a perfectly well-formed number to any regex — the "6"
  // belongs to "Euro 6". Seen live: 372,500 km parsed as 6,372,500 (17x), and
  // "Euro 6 330 000" as 6,330,000. No amount of anchoring fixes this because
  // both readings are structurally valid; the only reliable cure is to consume
  // "Euro N" first, then read what remains.
  const euroClass = firstMatch(t, /\bEuro\s*(\d)\b/i);
  const noEuro = t.replace(/\bEuro\s*\d\b/i, " ");
  const tail = noEuro.match(/(\d{1,3}(?:[ .]\d{3})*|\d+)\s*kms?\s*-\s*((?:19|20)\d{2})\s*$/i);
  const mileageKm = tail ? digits(tail[1]) : "";
  const year = tail ? tail[2] : firstMatch(t, /\b((?:19|20)\d{2})\b/);
  // tail[0] may include one leading boundary character (see the regex above), so
  // cut at where the NUMBER starts, not at tail.index.
  let head = tail ? t.slice(0, t.lastIndexOf(tail[1])).trim() : t;

  const vehicleType = (head.match(LEAD_TYPE) || [])[1] || "";
  head = head.replace(LEAD_TYPE, "").trim();

  // Axle config and Euro class sit after the model.
  const axles = firstMatch(head, /\b(\d\s?[xX]\s?\d)\b/).replace(/\s/g, "");
  // Read from the ORIGINAL h1, captured above — `head` has had "Euro N" removed.
  const euro = euroClass;
  // Everything before the axle config is make + model; a trailing "- Benne"
  // style body descriptor is kept out of the model.
  let makeModel = head;
  if (axles) makeModel = head.slice(0, head.search(/\b\d\s?[xX]\s?\d\b/)).trim();
  const bodyType = clean((head.match(/-\s*([A-Za-zÀ-ÿ ]+?)\s*$/) || [])[1] || "");

  const make = canonicalMake(makeModel);
  let model = makeModel;
  for (const [, re] of MAKES) {
    const m = makeModel.match(re);
    if (m) {
      model = makeModel.slice(m.index + m[0].length).trim();
      break;
    }
  }

  return { vehicleType, make, model, mileageKm, year, axles, euro, bodyType };
}

function parseDetail(html, url) {
  const h1 = firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/);
  if (!h1) return null;
  const head = parseHeadline(h1);
  if (!head.make && !head.model) return null;

  // JSON-LD Product: a cross-check for make and the dealer reference. Its
  // offers.price is a hardcoded "0.00" placeholder and is deliberately ignored.
  let ldBrand = "";
  let ref = "";
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1].trim());
      if (j && j["@type"] === "Product") {
        ldBrand = (j.brand && j.brand.name) || "";
        ref = j.mpn || "";
      }
    } catch {
      /* a malformed block must not lose the page */
    }
  }

  return {
    // The trailing number of the slug is the site's own vehicle id.
    id: firstMatch(url, /-(\d{4,})$/) || firstMatch(url, /\/([^/]+)$/),
    url,
    title: clean(h1),
    make: head.make || canonicalMake(ldBrand),
    model: head.model,
    year: head.year,
    mileage_km: head.mileageKm,
    axle_configuration: head.axles,
    body_type: head.bodyType,
    euro_norm: head.euro,
    vehicle_type: head.vehicleType,
    reference: ref,
    // NO PRICE IS PUBLISHED — see the header note about the "790€/mois" banner.
    price_amount: "",
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
    return true;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scrapedAt = new Date().toISOString();

  const xml = await fetchText(SITEMAP);
  if (!xml) throw new Error("sitemap fetch failed");
  const all = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const wanted = args.includeVans ? [...TRUCK_TYPES, ...VAN_TYPES] : TRUCK_TYPES;
  const urls = all.filter((u) =>
    new RegExp(`/(?:${wanted.join("|")})-[a-z0-9-]*-\\d{4,}$`, "i").test(u),
  );
  console.log(
    `[usedrenault-fr] sitemap: ${all.length} urls, ${urls.length} vehicles (${wanted.join("+")})`,
  );

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
    if (++done % 50 === 0) console.log(`[usedrenault-fr] detail ${done}/${targets.length}`);
    await randomDelay([400, 900]);
    return rec;
  });

  let rows = parsed.filter(Boolean);
  console.log(`[usedrenault-fr] parsed ${rows.length}/${targets.length}`);

  const before = rows.length;
  rows = applyFilters(rows, args);
  console.log(`[usedrenault-fr] filtered ${before} -> ${rows.length}`);

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
          // Blank: this network quotes on request only.
          price_amount: "",
          price_currency: "EUR",
          country_origin: "FR",
          seller_name: "Used Renault Trucks France",
          dealer_website: ORIGIN,
        },
        scrapedAt,
      ),
    );
  }

  await writeOutputs(SLUG, byId);
  console.log(`[usedrenault-fr] wrote ${byId.size} records to output/${SLUG}/`);
}

main().catch((err) => {
  console.error("[usedrenault-fr] fatal:", err.stack || err.message);
  process.exit(1);
});
