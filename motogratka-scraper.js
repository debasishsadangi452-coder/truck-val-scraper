#!/usr/bin/env node
// motogratka.pl — Samochody ciężarowe (trucks) scraper, plain HTTP.
//
// BACKEND-ONLY per the project rule: reachable from the server, so it is scraped
// here and gets NO extension adapter.
//
// Polish general-motoring classifieds (Grupa Morizon-Gratka, part of the
// Ringier Axel Springer group; the same stack serves gratka.pl). The truck
// category is /motoryzacja/ciezarowe.
//
// SERVER-RENDERED despite the Vue shell. Verified live 2026-09: a plain fetch
// returns HTTP 200 with all 32 teaser cards already in the HTML — the Vue app
// hydrates markup that is already there, so no browser is needed.
//
// ~747 LISTINGS OVER 23 PAGES (?page=N). The category counter in the sidebar
// says 747; the page's own JSON-LD AggregateOffer reports offerCount:32, which
// is the PER-PAGE count, not the category total — do not trust it as a total.
// Paging is a real query string and robots.txt permits it.
//
// ROBOTS: User-agent: * disallows /mapa/*, /*sort=*, /*oferta-archiwalna* and
// every lokalizacja_* filter parameter. This scraper touches none of those — it
// walks the plain category path with ?page=N only, and filters locally.
//
// Card shape (inspected 2026-09):
//   div.listing__teaserWrapper
//     article.teaserUnified id="item-<id>"   <- id="item-N" is the RELIABLE key
//     a.teaserLink[href]                     .../<slug>/oi/<id>
//     h2.teaserUnified__title                "Renault MASCOTT z zabudową..."
//     span.teaserUnified__location           "Świebodzin, świebodziński, lubuskie"
//     ul.teaserUnified__paramsWithKey > li   "Przebieg: 280560", "Stan techniczny: sprawny"
//     p.teaserUnified__price                 "55 000<span> zł</span>"
//
// USE id="item-N" to identify a card, and read the URL from the article's
// data-href (present on all 32/32 cards). TWO DETAIL-URL FORMS exist and both
// are real: /oi/<id> for private-seller ads and /ob/<id> for business/dealer
// ads. Page 1 is 7 private + 25 dealer, so anything matching only /oi/ silently
// drops ~80% of the category.
//
// NO YEAR ON THE LIST CARD. The teaser params carry mileage/condition/seller but
// NOT the production year, so year comes from the detail page (or, failing that,
// a 4-digit year in the title). With --no-detail expect year to be sparse.
//
// PRICES ARE PLN, gross, written with a space as the thousands separator
// ("55 000 zł"). They are stored in PLN — the server converts elsewhere
// (server/routes/listings.js holds the fixed PLN_PER_EUR rate); this scraper
// does NOT pre-convert, so the row keeps the currency the seller quoted.
//
// Usage:
//   node motogratka-scraper.js                       whole category (23 pages)
//   node motogratka-scraper.js --pages 3 --no-detail quick smoke test
//   node motogratka-scraper.js --make daf --year-min 2015

import {
  normaliseRecord,
  writeOutputs,
  fetchText,
  loadExisting,
  mapPool,
  randomDelay,
} from "./lib/scrape-core.js";
import { digits, firstMatch } from "./lib/html-utils.js";

const SLUG = "motogratka-trucks";
const ORIGIN = "https://motogratka.pl";
const CATEGORY = "/motoryzacja/ciezarowe";

function parseArgs(argv) {
  const args = {
    pages: 30, // 23 real pages + headroom; the loop stops at the true end anyway
    concurrency: 3,
    detail: true,
    limit: Infinity,
    make: null,
    model: null,
    yearMin: null,
    yearMax: null,
    kmMax: null,
    priceMax: null,
    includeWanted: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pages") args.pages = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--concurrency") args.concurrency = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--no-detail") args.detail = false;
    else if (a === "--limit") args.limit = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--make") args.make = String(argv[++i] || "").toLowerCase();
    else if (a === "--model") args.model = String(argv[++i] || "").toLowerCase();
    else if (a === "--year-min") args.yearMin = parseInt(argv[++i], 10);
    else if (a === "--year-max") args.yearMax = parseInt(argv[++i], 10);
    else if (a === "--km-max") args.kmMax = parseInt(argv[++i], 10);
    else if (a === "--price-max") args.priceMax = parseInt(argv[++i], 10);
    else if (a === "--include-wanted") args.includeWanted = true;
  }
  return args;
}

const clean = (h) =>
  String(h ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&oacute;/g, "ó")
    .replace(/ /g, " ")
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
  ["Opel", /\bopel\b/i],
  ["Fiat", /\bfiat\b/i],
  ["Volkswagen", /\b(?:volkswagen|vw)\b/i],
  ["Star", /\bstar\b/i],
  ["Jelcz", /\bjelcz\b/i],
  ["Kamaz", /\bkamaz\b/i],
  ["Tatra", /\btatra\b/i],
  ["Schmitz", /\bschmitz(?:\s?cargobull)?\b/i],
  ["Krone", /\bkrone\b/i],
  ["Wielton", /\bwielton\b/i],
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
    if (m) {
      // Polish listing titles run on ("Renault MIDLUM Doka, 4x4, 9 osób,
      // Bezwypadkowy, niski przebieg"), so the model is the first comma-free
      // chunk after the make, not the whole tail.
      const tail = t.slice(m.index + m[0].length).trim();
      const model = tail.split(/[,;]/)[0].trim();
      return { make: canonical, model: model || tail };
    }
  }
  const parts = t.split(" ").filter(Boolean);
  return { make: parts[0] || "", model: parts.slice(1).join(" ") };
}

function yearOf(s) {
  const m = String(s ?? "").match(/\b(19[5-9]\d|20[0-4]\d)\b/);
  return m ? m[1] : "";
}

function parseListPage(html) {
  const out = [];
  // Split on the teaser article, which carries the id. Using id="item-N" as the
  // key rather than the /oi/ href — see the header note (only 14/32 cards expose
  // a parseable href, all 32 expose the id).
  const parts = html.split(/<article class="teaserUnified/);
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];

    const id = firstMatch(chunk, /id="item-(\d+)"/);
    if (!id) continue;

    // data-href on the article is present even where the anchor form varies.
    // data-href is on the article itself and is present on every card (32/32
    // verified); the anchor form varies, so prefer it.
    const href =
      firstMatch(chunk, /data-href="([^"]+)"/) ||
      firstMatch(chunk, /href="(https:\/\/motogratka\.pl\/[^"]*\/o[ib]\/\d+)"/);

    const title = clean(firstMatch(chunk, /<h2 class="teaserUnified__title">([\s\S]*?)<\/h2>/));
    if (!title) continue;

    const location = clean(
      firstMatch(chunk, /class="teaserUnified__location"[^>]*>([\s\S]*?)<\/span>/),
    );
    // "Świebodzin, świebodziński, lubuskie" — city, county, voivodeship.
    const locParts = location ? location.split(/\s*,\s*/) : [];

    // Price: "55 000<span> zł</span>". Some ads have none.
    const priceBlock = clean(firstMatch(chunk, /class="teaserUnified__price"[^>]*>([\s\S]*?)<\/p>/));
    const price = /\d/.test(priceBlock) ? digits(priceBlock.replace(/z[łl]/i, "")) : "";

    // Params are "Key: value" list items — read by LABEL, never by position,
    // because the set present varies per ad.
    const params = {};
    const liRe = /<li class="teaserUnified__listItem">([\s\S]*?)<\/li>/g;
    let m;
    while ((m = liRe.exec(chunk))) {
      const txt = clean(m[1]);
      const idx = txt.indexOf(":");
      if (idx > 0) params[txt.slice(0, idx).trim().toLowerCase()] = txt.slice(idx + 1).trim();
    }

    const { make, model } = splitTitle(title);

    out.push({
      id,
      url: href || `${ORIGIN}${CATEGORY}`,
      title,
      make,
      model,
      // No year in the teaser params — filled from the detail page below.
      year: yearOf(title),
      mileage_km: digits(params["przebieg"] || ""),
      price_amount: price,
      city: locParts[0] || "",
      region: locParts[locParts.length - 1] || "",
      seller_name: params["dodane przez"] || "",
      condition: params["stan techniczny"] || "",
      thumbnail_url: firstMatch(chunk, /<img[^>]+src="([^"]+)"/),
    });
  }
  return out;
}

// Detail page — the full spec table. Labels are Polish.
function parseDetail(html) {
  const text = clean(html.replace(/<script[\s\S]*?<\/script>/gi, " "));
  const val = (label) =>
    clean(
      firstMatch(text, new RegExp("(?:" + label + ")\\s*:?\\s*([A-Za-zÀ-ÿ0-9.,/ -]{1,40})", "i")) ??
        "",
    );
  return {
    // "Rok produkcji: 2015"
    year: yearOf(val("Rok produkcji")),
    fuel_type: val("Rodzaj paliwa"),
    gearbox: val("Skrzynia biegów"),
    axle_configuration: firstMatch(text, /\b(\d{1,2}\s?x\s?\d{1,2})\b/).replace(/\s/g, ""),
    engine_power_hp: digits(firstMatch(text, /Moc silnika\s*:?\s*(\d{2,4})/i) ?? ""),
    // The label carries its unit in brackets — "Pojemność silnika [cm3] 6000 cm3"
    // — so the bracketed part must be consumed or the capture starts at "[".
    engine_capacity_cc: digits(
      firstMatch(text, /Pojemność silnika(?:\s*\[[^\]]*\])?\s*:?\s*([\d\s]{3,8})/i) ?? "",
    ),
    gross_weight_kg: digits(
      firstMatch(text, /Dopuszczalna masa całkowita[^\d]{0,12}([\d\s]{3,9})/i) ?? "",
    ),
    vin: firstMatch(text, /\b([A-HJ-NPR-Z0-9]{17})\b/),
  };
}

// NOT-FOR-SALE ADS. A Polish classifieds truck category carries three things
// that are not a truck for sale, and all three poison a price comparison:
//
//   "Skup ..." / "KUPIE NA EXPORT"  a dealer advertising that they BUY trucks
//   "... CZĘŚCI"                    a parts ad, not a vehicle
//   "cena do uzgodnienia"           price-on-application placeholders
//
// Their prices are invented (live 2026-09: 1 PLN, 123, 321, and 883 600 101 PLN
// — the largest is 6700x the p95 of 492 000), so leaving them in skews any
// average or ceiling filter built on this source. 18 of 715 on the live
// category. Dropped by default; --include-wanted keeps them for auditing.
const WANTED_RE = /(?:skup|skupuj[eę]?|kupi[eę]|kupuj[eę]?)/i;
const PARTS_RE = /(?:cz[eę][sś]ci|na cz[eę][sś]ci)/i;

function isNotForSale(row) {
  const t = String(row.title || "");
  return WANTED_RE.test(t) || PARTS_RE.test(t);
}

function applyFilters(rows, args) {
  return rows.filter((r) => {
    if (!args.includeWanted && isNotForSale(r)) return false;
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

  // ---- phase 1: walk the pager ----
  const rows = [];
  const seen = new Set();
  for (let page = 1; page <= args.pages; page++) {
    const url = page === 1 ? ORIGIN + CATEGORY : `${ORIGIN}${CATEGORY}?page=${page}`;
    const html = await fetchText(url, { headers: { "Accept-Language": "pl-PL,pl;q=0.9" } });
    if (!html) {
      console.warn(`[motogratka] page ${page} failed; stopping paging here`);
      break;
    }
    const found = parseListPage(html);
    const fresh = found.filter((c) => !seen.has(c.id));
    for (const c of fresh) seen.add(c.id);
    rows.push(...fresh);
    console.log(
      `[motogratka] page ${page}: ${found.length} cards (${fresh.length} new, ${rows.length} total)`,
    );

    // Stop when a page repeats what we already have (the site clamps an
    // out-of-range ?page= to the last page rather than 404ing) or runs empty.
    if (found.length === 0 || fresh.length === 0) break;
    await randomDelay([900, 1800]);
  }

  let out = rows.length > args.limit ? rows.slice(0, args.limit) : rows;

  // ---- phase 2: detail pages (year lives here) ----
  if (args.detail && out.length) {
    let done = 0;
    await mapPool(out, args.concurrency, async (row) => {
      // TWO URL FORMS, both valid: /oi/<id> for private-seller ads and /ob/<id>
      // for business/dealer ads. Matching only /oi/ skipped every dealer listing
      // — 25 of 32 on page 1 — and with it the year, which exists ONLY on the
      // detail page.
      if (!/\/o[ib]\/\d+/.test(row.url)) return; // no usable detail URL on this card
      const page = await fetchText(row.url, { headers: { "Accept-Language": "pl-PL,pl;q=0.9" } });
      if (page) {
        const d = parseDetail(page);
        if (d.year) row.year = d.year;
        if (d.fuel_type) row.fuel_type = d.fuel_type;
        if (d.gearbox) row.gearbox = d.gearbox;
        if (d.axle_configuration) row.axle_configuration = d.axle_configuration;
        if (d.engine_capacity_cc) row.engine_capacity_cc = d.engine_capacity_cc;
        // SELLER-ENTERED POWER IS SOMETIMES THE ENGINE CAPACITY. Live example
        // (ad 44760153, Scania P94): the detail page states "Pojemność silnika
        // [cm3] 6000" AND "Moc silnika 6000" — the seller repeated the
        // displacement in the power field, which would store a 6000 hp truck.
        // No road truck exceeds ~1000 hp, so an implausible figure that merely
        // echoes the capacity is dropped rather than stored.
        if (d.engine_power_hp) {
          const hp = Number(d.engine_power_hp);
          const cc = Number(d.engine_capacity_cc || row.engine_capacity_cc || 0);
          if (hp <= 1200 && !(cc && hp === cc)) row.engine_power_hp = d.engine_power_hp;
        }
        if (d.gross_weight_kg) row.gross_weight_kg = d.gross_weight_kg;
        if (d.vin) row.vin = d.vin;
      }
      if (++done % 50 === 0) console.log(`[motogratka] detail ${done}/${out.length}`);
      await randomDelay([500, 1100]);
    });
    console.log(`[motogratka] detail pages fetched: ${done}`);
  }

  // ---- filter ----
  const before = out.length;
  out = applyFilters(out, args);
  console.log(`[motogratka] filtered ${before} -> ${out.length} matching`);

  // ---- emit ----
  const byId = await loadExisting(SLUG);
  for (const r of out) {
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
          engine_capacity_cc: r.engine_capacity_cc,
          engine_power_hp: r.engine_power_hp,
          axle_configuration: r.axle_configuration,
          gearbox: r.gearbox,
          gross_weight_kg: r.gross_weight_kg,
          // PLN as quoted — deliberately not pre-converted to EUR.
          price_amount: r.price_amount,
          price_currency: "PLN",
          city: r.city,
          region: r.region,
          country_origin: "PL",
          seller_name: r.seller_name,
          dealer_website: ORIGIN,
          vin: r.vin,
          thumbnail_url: r.thumbnail_url,
        },
        scrapedAt,
      ),
    );
  }

  await writeOutputs(SLUG, byId);
  console.log(`[motogratka] wrote ${byId.size} records to output/${SLUG}/`);
}

main().catch((err) => {
  console.error("[motogratka] fatal:", err.stack || err.message);
  process.exit(1);
});
