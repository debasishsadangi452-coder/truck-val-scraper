#!/usr/bin/env node
// terre-net-occasions.fr — Poids lourds (heavy trucks) scraper, plain HTTP.
//
// BACKEND-ONLY per the project rule: reachable from the server, so it is scraped
// here and gets NO extension adapter.
//
// Agri-oriented classifieds (Régie Agricole / agrionline group; the same
// inventory is skinned in ~20 languages at *.agrionline.com — this scrapes the
// French origin). The heavy-truck section is /poids-lourds/s78.
//
// ONE PAGE, 55 LISTINGS, NO PAGINATION. Verified live 2026-09: the category
// renders all 55 ads server-side in one response and its
// <nav aria-label="Pagination"> is EMPTY. Query-string paging does not exist —
// ?page=2 / ?p=2 / ?PageIndex=2 all return byte-identical page 1 (checked), so
// anything that "pages" here would silently re-scrape the same 55 rows. The
// scraper therefore fetches once and asserts the pager is empty; if the site
// ever grows past one page, the warning below fires instead of quietly
// truncating.
//
// ROBOTS: User-agent: * allows /poids-lourds/ and the /poids-lourds/<slug>/aNNN
// detail pages. It DISALLOWS /Search* and every filter query string
// (*?idCategorie=, *modele=, *idMarque=, *idOffreur=, *idRegion=, *?triliste=),
// so this scraper never builds a filtered/sorted URL — it takes the plain
// category path and filters locally. A Crawl-Delay: 20 is declared for bingbot
// only, but the delays here stay generous anyway.
//
// Card shape (inspected 2026-09):
//   div.ad-list
//     div.ad-list__prix      "15 000 € HT"  or  "--NC--" when not quoted
//     a.ad-list__link[href]  /poids-lourds/<slug>/a<id>   <- id is the digits
//     <titre>                "Renault PREMIUM LANDER 460 dxi"
//     span.ad-list__mat      "2010 / 666000 / 346" — POSITIONALLY UNRELIABLE,
//                            see below
//     span.ad-list__loc      "France - Ile de France"
//     span.ad-list__pro      "Professionnel" / private
//
// THE THIRD SPEC FIELD IS NOT FIXED. ad-list__mat reads "year / km / X" where X
// is the ENGINE POWER on some cards ("346") and the BODY TYPE on others
// ("Benne"). Splitting on "/" by position therefore puts "Benne" in a numeric
// horsepower column. The nested spans carry their own semantic classes —
// .detail-kilometrage, .detail-puissance, .detail-type — so every value is read
// from its class, never from its position.
//
// PRICES ARE HT (hors taxes / ex-VAT), printed with a non-breaking space as the
// thousands separator ("15&#160;000 €"). Cards reading "--NC--" (non communiqué)
// have no price and are stored NULL, not 0.
//
// Usage:
//   node terrenet-scraper.js
//   node terrenet-scraper.js --make renault --year-min 2015
//   node terrenet-scraper.js --no-detail

import {
  normaliseRecord,
  writeOutputs,
  fetchText,
  loadExisting,
  mapPool,
  randomDelay,
} from "./lib/scrape-core.js";
import { digits, firstMatch } from "./lib/html-utils.js";

const SLUG = "terrenet-trucks";
const ORIGIN = "https://www.terre-net-occasions.fr";
const CATEGORY = "/poids-lourds/s78";

function parseArgs(argv) {
  const args = {
    concurrency: 3,
    detail: true,
    limit: Infinity,
    make: null,
    model: null,
    yearMin: null,
    yearMax: null,
    kmMax: null,
    priceMax: null,
    bodyType: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--concurrency") args.concurrency = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--no-detail") args.detail = false;
    else if (a === "--limit") args.limit = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--make") args.make = String(argv[++i] || "").toLowerCase();
    else if (a === "--model") args.model = String(argv[++i] || "").toLowerCase();
    else if (a === "--year-min") args.yearMin = parseInt(argv[++i], 10);
    else if (a === "--year-max") args.yearMax = parseInt(argv[++i], 10);
    else if (a === "--km-max") args.kmMax = parseInt(argv[++i], 10);
    else if (a === "--price-max") args.priceMax = parseInt(argv[++i], 10);
    else if (a === "--body-type") args.bodyType = String(argv[++i] || "").toLowerCase();
  }
  return args;
}

// This page is served with numeric HTML entities for accents (&#233; = é) and
// &#160; for the non-breaking space inside prices — decode both or prices parse
// wrong and French place names come out mangled.
const clean = (h) =>
  String(h ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCharCode(parseInt(x, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/ /g, " ")
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
  ["Ford", /\bford\b/i],
  ["Nissan", /\bnissan\b/i],
  ["Isuzu", /\bisuzu\b/i],
  ["Mitsubishi", /\bmitsubishi\b/i],
  ["Citroën", /\bcitro(?:ë|e)n\b/i],
  ["Peugeot", /\bpeugeot\b/i],
  ["Fiat", /\bfiat\b/i],
  ["Schmitz", /\bschmitz(?:\s?cargobull)?\b/i],
  ["Krone", /\bkrone\b/i],
  ["Fruehauf", /\bfruehauf\b/i],
  ["Samro", /\bsamro\b/i],
  ["Kögel", /\bk(?:ö|oe|o)gel\b/i],
  // The site uses a literal "Inconnu" (unknown) make for unbranded lots.
  ["Inconnu", /\binconnu\b/i],
];

function canonicalMake(raw) {
  const s = clean(raw);
  if (!s) return "";
  for (const [canonical, re] of MAKES) if (re.test(s)) return canonical;
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

function parseListPage(html) {
  const out = [];
  const parts = html.split(/<div class="ad-list\s*"/);
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];

    const href = firstMatch(chunk, /class="ad-list__link"\s+href=['"]([^'"]+)['"]/);
    if (!href) continue;
    const id = firstMatch(href, /\/a(\d+)/);
    if (!id) continue;

    // <titre> is a non-standard tag this site emits for the display title; the
    // anchor text carries the same string and is the fallback.
    const title =
      clean(firstMatch(chunk, /<titre>([\s\S]*?)<\/titre>/)) ||
      clean(firstMatch(chunk, /class="ad-list__link"[^>]*>([\s\S]*?)<\/a>/));
    if (!title) continue;

    // Price: "15 000 € HT" or "--NC--" (non communiqué). Never zero-fill.
    const priceBlock = clean(firstMatch(chunk, /class="ad-list__prix">([\s\S]*?)<\/div>/));
    const price = /NC/i.test(priceBlock) ? "" : digits(priceBlock.replace(/\bHT\b/i, ""));

    // Read each spec from its OWN class, never by splitting ad-list__mat on "/"
    // — the third slot is power on some cards and body type on others.
    let km = digits(clean(firstMatch(chunk, /class="detail detail-kilometrage"[^>]*>([\s\S]*?)<\/span>/)));
    let hp = digits(clean(firstMatch(chunk, /class="detail detail-puissance"[^>]*>([\s\S]*?)<\/span>/)));
    const bodyType = clean(firstMatch(chunk, /class="detail detail-type"[^>]*>([\s\S]*?)<\/span>/));

    // THE SITE'S OWN LABELS ARE SOMETIMES WRONG, so sanity-check the magnitude
    // rather than trusting the class. Live example (ad a2764145, "Iveco VASP
    // NACELLE 18M"): the card carries NO detail-kilometrage span and tags its
    // odometer reading 126635 as detail-puissance — which would store 126,635 hp.
    // No road truck exceeds ~1,000 hp, so an implausible "power" that looks like
    // an odometer is reassigned to mileage when mileage is otherwise missing,
    // and dropped otherwise. Better a blank field than a fictional spec.
    if (hp && Number(hp) > 1200) {
      if (!km) km = hp;
      hp = "";
    }

    // The year is the leading token of ad-list__mat ("2010 / 666000 / 346").
    const mat = clean(firstMatch(chunk, /class="ad-list__mat">([\s\S]*?)<span/));
    const year = firstMatch(mat, /\b(19[5-9]\d|20[0-4]\d)\b/);

    // "France - Ile de France" -> country + region. Not every card has both:
    // some print the country alone (and some print nothing), so the region half
    // must default rather than be destructured blind.
    const loc = clean(firstMatch(chunk, /class="ad-list__loc">([\s\S]*?)<\/span>/));
    const locParts = loc ? loc.split(/\s*-\s*/) : [];
    const locCountry = locParts[0] || "";
    const locRegion = locParts.slice(1).join(" - ");

    const seller = clean(firstMatch(chunk, /class="ad-list__pro">([\s\S]*?)<\/span>/));
    const img = firstMatch(chunk, /<img[^>]+src="([^"]+)"/);

    const { make, model } = splitTitle(title);

    out.push({
      id,
      url: href.startsWith("http") ? href : ORIGIN + href,
      title,
      make,
      model,
      year,
      mileage_km: km,
      engine_power_hp: hp,
      body_type: bodyType,
      price_amount: price,
      country_origin: (locCountry || "").trim() || "FR",
      region: (locRegion || "").trim(),
      seller_type: seller,
      thumbnail_url: img || "",
    });
  }
  return out;
}

// Detail page — fills gaps the card leaves (fuel, gearbox, axles, weights).
// Labels are French and rendered as a spec list.
function parseDetail(html) {
  const text = clean(html.replace(/<script[\s\S]*?<\/script>/gi, " "));
  // The label is an alternation ("Carburant|Energie"), so it MUST be wrapped in
  // a non-capturing group — otherwise the trailing "\s*:?\s*(...)" binds only to
  // the LAST alternative and group 1 lands in the wrong place (or nowhere). The
  // ?? "" guards the no-match case, which is normal here: not every ad lists
  // every spec.
  const val = (label) =>
    clean(
      firstMatch(text, new RegExp("(?:" + label + ")\\s*:?\\s*([A-Za-z0-9À-ÿ.,/ -]{1,40})", "i")) ??
        "",
    );
  const wt = (label) =>
    digits(
      firstMatch(text, new RegExp("(?:" + label + ")\\s*:?\\s*([\\d\\s.,]+)\\s*kg", "i")) ?? "",
    );
  return {
    fuel_type: val("Carburant|Energie|Énergie"),
    gearbox: val("Bo[iî]te(?: de vitesses?)?|Transmission"),
    axle_configuration: firstMatch(text, /\b(\d\s?x\s?\d)\b/).replace(/\s/g, ""),
    gross_weight_kg: wt("PTAC|PTC"),
    payload_kg: wt("Charge utile"),
    vin: firstMatch(text, /\b([A-HJ-NPR-Z0-9]{17})\b/),
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
      // An unpriced ("--NC--") listing cannot satisfy a price ceiling; excluding
      // it is honest, whereas treating blank as 0 would always match.
      if (!p || p > args.priceMax) return false;
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

  // ---- phase 1: the single category page ----
  const html = await fetchText(ORIGIN + CATEGORY);
  if (!html) throw new Error("category page fetch failed");

  let rows = parseListPage(html);
  console.log(`[terrenet] category page: ${rows.length} listings`);

  // Guard the "one page" assumption rather than trusting it forever: if the
  // pager ever gains links, say so loudly instead of silently under-collecting.
  const pager = firstMatch(html, /<nav aria-label="Pagination">([\s\S]*?)<\/nav>/);
  if (/href=/i.test(pager)) {
    console.warn(
      "[terrenet] WARNING: the pagination nav now contains links — this site has grown past one page and the scraper needs updating.",
    );
  }

  if (rows.length > args.limit) rows = rows.slice(0, args.limit);

  // ---- phase 2: detail pages ----
  if (args.detail && rows.length) {
    let done = 0;
    await mapPool(rows, args.concurrency, async (row) => {
      const page = await fetchText(row.url);
      if (page) {
        const d = parseDetail(page);
        if (d.fuel_type) row.fuel_type = d.fuel_type;
        if (d.gearbox) row.gearbox = d.gearbox;
        if (d.axle_configuration) row.axle_configuration = d.axle_configuration;
        if (d.gross_weight_kg) row.gross_weight_kg = d.gross_weight_kg;
        if (d.payload_kg) row.payload_kg = d.payload_kg;
        if (d.vin) row.vin = d.vin;
      }
      if (++done % 20 === 0) console.log(`[terrenet] detail ${done}/${rows.length}`);
      await randomDelay([600, 1200]);
    });
    console.log(`[terrenet] detail pages fetched: ${done}`);
  }

  // ---- filter ----
  const before = rows.length;
  rows = applyFilters(rows, args);
  console.log(`[terrenet] filtered ${before} -> ${rows.length} matching`);

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
          make: canonicalMake(r.make),
          model: r.model,
          year: r.year,
          mileage_km: r.mileage_km,
          fuel_type: r.fuel_type,
          engine_power_hp: r.engine_power_hp,
          axle_configuration: r.axle_configuration,
          gearbox: r.gearbox,
          gross_weight_kg: r.gross_weight_kg,
          payload_kg: r.payload_kg,
          // HT / ex-VAT; blank where the card said "--NC--".
          price_amount: r.price_amount,
          price_currency: "EUR",
          region: r.region,
          country_origin: r.country_origin === "France" ? "FR" : r.country_origin,
          seller_name: r.seller_type,
          dealer_website: ORIGIN,
          vin: r.vin,
          thumbnail_url: r.thumbnail_url,
        },
        scrapedAt,
      ),
    );
  }

  await writeOutputs(SLUG, byId);
  console.log(`[terrenet] wrote ${byId.size} records to output/${SLUG}/`);
}

main().catch((err) => {
  console.error("[terrenet] fatal:", err.stack || err.message);
  process.exit(1);
});
