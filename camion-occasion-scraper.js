#!/usr/bin/env node
// camion-occasion.com (Le Bris) scraper — plain HTTP, no browser needed.
//
// A single French dealer's own catalogue (Noyal-sur-Vilaine, Brittany), ~144
// vehicles over 4 list pages. Verified live 2026-09: a plain fetch with a normal
// User-Agent returns the full server-rendered listing (HTTP 200, 62 KB, 36 cards
// on page 1) — no JS challenge, no consent wall, no CAPTCHA. robots.txt allows
// /vente-camion/; its Disallow rules cover /*login*, /*print.html, /*sort_value*
// and friends, none of which this scraper touches.
//
// SCRAPE EVERYTHING, THEN FILTER. The site's own filter UI cannot be driven by
// URL — the sidebar POSTs prop_37/prop_66/prop_44 to /vente-camion/getpagecontent
// and swaps the results div in place, rewriting the address bar to a bare
// "./?t=<ms>" that carries no filter state. Replaying that is brittle and, at
// 144 vehicles, pointless: pulling the whole catalogue costs 4 list requests and
// filtering locally is exact. --make, --model, --year-min etc. below apply AFTER
// the scrape, against normalized fields.
//
// TWO-PHASE. List pages carry id/title/year/km/thumbnail but NO PRICE — this
// dealer publishes none, on the list or the detail page (verified on several
// detail pages: zero euro signs, no JSON-LD). price_amount is therefore left
// blank rather than guessed; a fabricated 0 would sail through a price-ceiling
// filter and poison the comparison set. Detail pages are still worth fetching:
// they add engine power, Euro norm, gearbox, fuel, axle config, PTAC/payload and
// the exact first-registration date. Skip them with --no-detail.
//
// Detail markup (inspected 2026-09):
//   div.product_bottom_tab_lines_line > span.left / span.right   label/value rows
//   ul.tabFeature > li > span + span                             Puissance, Norme Euro, ...
//   the "carrosserie" tab holds PTAC / PTRA / PV / Charge utile as free text
//
// Writes output/camion-occasion/listings.json in the canonical shape, then
//   node load-listings.js camion-occasion camion_occasion
// upserts on (source, source_id).
//
// Usage:
//   node camion-occasion-scraper.js                       whole catalogue
//   node camion-occasion-scraper.js --make Renault --year-min 2018
//   node camion-occasion-scraper.js --category tracteur-routier --no-detail
//   node camion-occasion-scraper.js --include-sold        keep sold units too

import {
  normaliseRecord,
  writeOutputs,
  fetchText,
  loadExisting,
  mapPool,
  randomDelay,
} from "./lib/scrape-core.js";
import { digits, firstMatch } from "./lib/html-utils.js";

const SLUG = "camion-occasion";
const ORIGIN = "https://www.camion-occasion.com";

// Real category paths, confirmed against the counts the site's own filter form
// reports (2026-09): camion-porteur 93, utilitaire 31, semi-remorque 11,
// tracteur-routier 6, remorque 3. "" means the whole catalogue.
const CATEGORIES = [
  "camion-porteur",
  "tracteur-routier",
  "semi-remorque",
  "remorque",
  "utilitaire",
];

function parseArgs(argv) {
  const args = {
    category: "",
    pages: 25, // hard stop; the catalogue is 4 pages, this is just a runaway guard
    concurrency: 4,
    detail: true,
    includeSold: false,
    limit: Infinity,
    // post-scrape filters
    make: null,
    model: null,
    yearMin: null,
    yearMax: null,
    kmMax: null,
    bodyType: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--category") args.category = String(argv[++i] || "").replace(/^\/|\/$/g, "");
    else if (a === "--pages") args.pages = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--concurrency") args.concurrency = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--no-detail") args.detail = false;
    else if (a === "--include-sold") args.includeSold = true;
    else if (a === "--limit") args.limit = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--make") args.make = String(argv[++i] || "").toLowerCase();
    else if (a === "--model") args.model = String(argv[++i] || "").toLowerCase();
    else if (a === "--year-min") args.yearMin = parseInt(argv[++i], 10);
    else if (a === "--year-max") args.yearMax = parseInt(argv[++i], 10);
    else if (a === "--km-max") args.kmMax = parseInt(argv[++i], 10);
    else if (a === "--body-type") args.bodyType = String(argv[++i] || "").toLowerCase();
  }
  if (args.category && !CATEGORIES.includes(args.category)) {
    throw new Error(
      `unknown --category "${args.category}" (expected one of: ${CATEGORIES.join(", ")})`,
    );
  }
  return args;
}

// Decode the handful of entities this site actually emits and flatten tags.
const clean = (h) =>
  String(h ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&deg;/g, "°")
    .replace(/\s+/g, " ")
    .trim();

// Makes as this site spells them ("Mercedes", not "Mercedes-Benz"; "Citroen"
// with a diaeresis). Body/trailer builders are included because the catalogue
// mixes semi-trailers in with the trucks and their cards are identical.
const MAKES = [
  ["Mercedes-Benz", /\bmercedes(?:[-\s]?benz)?\b/i],
  ["DAF", /\bdaf\b/i],
  ["Volvo", /\bvolvo\b/i],
  ["MAN", /\bman\b/i],
  ["Scania", /\bscania\b/i],
  ["Iveco", /\biveco\b/i],
  ["Renault", /\brenault\b/i],
  ["Ford", /\bford\b/i],
  ["Citroën", /\bcitro(?:ë|e)n\b/i],
  ["Opel", /\bopel\b/i],
  ["Isuzu", /\bisuzu\b/i],
  ["Nissan", /\bnissan\b/i],
  ["Fruehauf", /\bfruehauf\b/i],
  ["Samro", /\bsamro\b/i],
  ["Louault", /\blouault\b/i],
  ["STAS", /\bstas\b/i],
  ["Lecitrailer", /\blecitrailer\b/i],
  ["Robuste Kaiser", /\brobuste\s?kaiser\b/i],
  ["Castera", /\bcastera\b/i],
  ["Klubb", /\bklubb\b/i],
  ["Unic", /\bunic\b/i],
];

// Canonical spelling for a make the site wrote in its own casing. The detail
// page's "Marque" field is free text and is NOT case-consistent across records
// — the live catalogue contains both "SAMRO" and "Samro", and both
// "ROBUSTE KAISER" and "Robuste kaiser". Taking it verbatim split one
// manufacturer into two buckets and broke --make filtering and any grouping, so
// every make goes through this table first. A make the table doesn't know is
// returned unchanged rather than dropped.
function canonicalMake(raw) {
  const s = clean(raw);
  if (!s) return "";
  for (const [canonical, re] of MAKES) {
    if (re.test(s)) return canonical;
  }
  return s;
}

function splitTitle(title) {
  const t = clean(title);
  for (const [canonical, re] of MAKES) {
    const m = t.match(re);
    if (m) return { make: canonical, model: t.slice(m.index + m[0].length).trim() };
  }
  const parts = t.split(" ").filter(Boolean);
  return { make: parts[0] || "", model: parts.slice(1).join(" ") };
}

// "15/01/2018" or "10/2018" -> 2018.
function yearOf(s) {
  const m = String(s ?? "").match(/\b(?:\d{1,2}\/)?(?:\d{1,2}\/)?(19[5-9]\d|20[0-4]\d)\b/);
  return m ? Number(m[1]) : "";
}

// One list page -> the cards on it. Cards are div.short_product, and a SOLD one
// carries an extra "vendu" class (sold units stay in the listing indefinitely).
function parseListPage(html) {
  const out = [];
  // Split on the card boundary rather than trying to match balanced divs with a
  // regex — the cards are siblings, so slicing between openings is exact enough
  // and cannot mis-nest.
  const parts = html.split(/<div class="short_product\b/);
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const classAttr = firstMatch(chunk, /^([^"]*)"/);
    const sold = /\bvendu\b/.test(classAttr);

    const href = firstMatch(chunk, /<a href="([^"]+)"[^>]*class="short_product_link"/);
    if (!href) continue;
    // /vente-camion/camion-porteur/3802-renault-c380.html -> "3802", the
    // dealer's own record id, stable across re-slugging of the title.
    const id = firstMatch(href, /\/(\d+)-[^/]*\.html/);
    if (!id) continue;

    const titleBlock = firstMatch(chunk, /<h2 class="short_product_title">([\s\S]*?)<\/h2>/);
    const bodyInfo = clean(firstMatch(titleBlock, /<span>([\s\S]*?)<\/span>/));
    const title = clean(titleBlock.replace(/<span>[\s\S]*?<\/span>/, ""));

    const yearRaw = clean(firstMatch(chunk, /short_product_infos_year">([\s\S]*?)</));
    const kmRaw = clean(firstMatch(chunk, /short_product_infos_km">([\s\S]*?)</));
    const ref = clean(firstMatch(chunk, /short_product_infos_num">([\s\S]*?)</)).replace(
      /^N°\s*/i,
      "",
    );
    const thumb = firstMatch(chunk, /<img[^>]+src="([^"]+)"/);

    const { make, model } = splitTitle(title);
    const axles = firstMatch(bodyInfo, /\b(\d\s?x\s?\d)\b/i).replace(/\s/g, "");

    out.push({
      sold,
      id,
      url: href.startsWith("http") ? href : ORIGIN + href,
      title: [title, bodyInfo].filter(Boolean).join(" "),
      make,
      model,
      year: yearOf(yearRaw),
      mileage_km: kmRaw ? digits(kmRaw) : "",
      axle_configuration: axles,
      body_type: bodyInfo.replace(/\b\d\s?x\s?\d\b/i, "").trim(),
      stock_ref: ref,
      thumbnail_url: thumb ? (thumb.startsWith("http") ? thumb : ORIGIN + thumb) : "",
    });
  }
  return out;
}

// Detail page -> the extra spec fields. Two different markups hold them:
//   span.left/span.right   label/value rows (make, model, first registration, km)
//   ul.tabFeature li       span+span pairs (Puissance, Norme Euro, boite, Essieu)
function parseDetail(html) {
  const kv = {};
  let m;

  const rowRe = /<span class="left">([\s\S]*?)<\/span>\s*<span class="right">([\s\S]*?)<\/span>/gi;
  while ((m = rowRe.exec(html))) kv[clean(m[1]).toLowerCase()] = clean(m[2]);

  const liRe = /<li><span>([\s\S]*?)<\/span>\s*<span>([\s\S]*?)<\/span><\/li>/gi;
  while ((m = liRe.exec(html))) kv[clean(m[1]).toLowerCase()] = clean(m[2]);

  // Weights live as free text in the "carrosserie" tab: "PTAC 19000kg PTRA
  // 44000kg PV 16468kg Charge utile 2532kg".
  const text = clean(html.replace(/<script[\s\S]*?<\/script>/gi, " "));
  const wt = (label) => digits(firstMatch(text, new RegExp(label + "\\s*([\\d\\s.,]+)\\s*kg", "i")));

  return {
    engine_power_hp: digits(firstMatch(kv["puissance"] || "", /(\d+)\s*CV/i)),
    fuel_type: kv["energie"] || "",
    gearbox: kv["type de boite"] || "",
    axle_configuration: kv["essieu"] || "",
    gross_weight_kg: wt("PTAC"),
    payload_kg: wt("Charge utile"),
    // "1ere immat." is the exact first-registration date; more precise than the
    // MM/YYYY the list card shows.
    first_registration: kv["1ère immat."] || kv["1ere immat."] || "",
    euro_norm: kv["norme euro"] || "",
    body_detail: kv["carrosserie"] || "",
    detail_make: kv["marque"] || "",
    detail_model: kv["modèle"] || kv["modele"] || "",
  };
}

// Apply the post-scrape filters. Kept separate from parsing so the same records
// can be re-filtered without re-fetching, and so "what was scraped" and "what
// matched" are both reportable.
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
    if (args.bodyType) {
      const hay = `${r.body_type || ""} ${r.title || ""}`.toLowerCase();
      if (!hay.includes(args.bodyType)) return false;
    }
    return true;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scrapedAt = new Date().toISOString();
  const base = `${ORIGIN}/vente-camion/${args.category ? args.category + "/" : ""}`;

  // ---- phase 1: every list page ----
  const cards = [];
  const seen = new Set();
  for (let page = 1; page <= args.pages; page++) {
    const url = page === 1 ? base : `${base}page-${page}.html`;
    const html = await fetchText(url);
    if (!html) {
      console.warn(`[camion-occasion] list page ${page} failed; stopping paging here`);
      break;
    }
    const found = parseListPage(html);
    const fresh = found.filter((c) => !seen.has(c.id));
    for (const c of fresh) seen.add(c.id);
    cards.push(...fresh);
    console.log(
      `[camion-occasion] page ${page}: ${found.length} cards (${fresh.length} new, ${cards.length} total)`,
    );

    // Stop at the real end of the pager rather than guessing a page count.
    if (!/class="pagerNext"/.test(html) || fresh.length === 0) break;
    await randomDelay([700, 1500]);
  }

  const soldCount = cards.filter((c) => c.sold).length;
  let rows = args.includeSold ? cards : cards.filter((c) => !c.sold);
  console.log(
    `[camion-occasion] scraped ${cards.length} cards (${soldCount} sold${args.includeSold ? ", kept" : ", excluded"})`,
  );

  if (rows.length > args.limit) rows = rows.slice(0, args.limit);

  // ---- phase 2: detail pages ----
  if (args.detail && rows.length) {
    let done = 0;
    await mapPool(rows, args.concurrency, async (row) => {
      const html = await fetchText(row.url);
      if (html) {
        const d = parseDetail(html);
        // The detail page's own make/model fields are authoritative where the
        // title parse was ambiguous, but only when non-empty.
        if (d.detail_make) row.make = canonicalMake(d.detail_make);
        if (d.detail_model) row.model = d.detail_model;
        row.engine_power_hp = d.engine_power_hp;
        row.fuel_type = d.fuel_type;
        row.gearbox = d.gearbox;
        row.gross_weight_kg = d.gross_weight_kg;
        row.payload_kg = d.payload_kg;
        if (d.axle_configuration) row.axle_configuration = d.axle_configuration;
        if (d.body_detail) row.body_type = d.body_detail;
        if (d.first_registration) row.year = yearOf(d.first_registration) || row.year;
        row.euro_norm = d.euro_norm;
      }
      if (++done % 20 === 0) console.log(`[camion-occasion] detail ${done}/${rows.length}`);
      await randomDelay([400, 900]);
    });
    console.log(`[camion-occasion] detail pages fetched: ${done}`);
  }

  // ---- filter ----
  const before = rows.length;
  rows = applyFilters(rows, args);
  console.log(`[camion-occasion] filtered ${before} -> ${rows.length} matching`);

  // ---- emit ----
  // A Map, not a plain object — writeOutputs()/loadExisting() both speak Map,
  // so this also lets a re-run merge onto the previous listings.json.
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
        engine_power_hp: r.engine_power_hp,
        axle_configuration: r.axle_configuration,
        gearbox: r.gearbox,
        gross_weight_kg: r.gross_weight_kg,
        payload_kg: r.payload_kg,
        // NO PRICE IS PUBLISHED on this site (list or detail) — left blank on
        // purpose so it loads as NULL rather than a misleading 0.
        price_amount: "",
        price_currency: "EUR",
        city: "Noyal-sur-Vilaine",
        region: "Bretagne",
        country_origin: "FR",
        seller_name: "Le Bris (Camion-Occasion)",
        dealer_website: ORIGIN,
        thumbnail_url: r.thumbnail_url,
      },
        scrapedAt,
      ),
    );
  }

  await writeOutputs(SLUG, byId);
  console.log(`[camion-occasion] wrote ${byId.size} records to output/${SLUG}/`);
}

main().catch((err) => {
  console.error("[camion-occasion] fatal:", err.message);
  process.exit(1);
});
