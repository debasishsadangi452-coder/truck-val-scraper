#!/usr/bin/env node
// francepoidslourds.fr (Groupe France Poids Lourds) scraper — plain HTTP.
//
// BACKEND-ONLY, per the project rule: a site the server can reach is scraped
// here and NOT given an extension adapter. WordPress theme, fully server-
// rendered; verified live 2026-09 (HTTP 200 to a plain fetch). The page does
// load reCAPTCHA v3, but only as an invisible badge for the CONTACT FORM — the
// listings render without it, so there is nothing for a human to clear.
//
// SMALL MULTI-BRAND DEALER GROUP: 10 vehicles total, not 6. The landing page
// shows 6 and its pager hides 4 more on /occasions/page/2 — scraping only page
// one silently drops 40% of stock, so this always walks the pager to the end.
//
// FILTERS ARE REAL URL PARAMS, unusually for a dealer site: ?type=typeTracteur
// | typePorteur | typeUtilitaire | typeSemi | typeRemorque is applied
// SERVER-side (verified: tracteur 4, porteur 3, utilitaire 3, semi 0, remorque
// 0). The on-page radios are decorative — a jQuery handler just sets
// location.href to that same query string. So --type filters at the source;
// every other filter is applied locally after the scrape.
//
// Card shape (inspected 2026-09):
//   div.occasion-list-item
//     a[href="/occasion/<slug>/"]     detail link, slug is the only stable id
//     p.prix                          "NOUS CONSULTER" — see the price note
//     p.carrosserie                   body type ("Benne", "Citerne Alim")
//     h2.titre                        "DAF CF 530 FAT CONSTRUCTION"
//     p.annee                         "Année : 2018"
//     p.kilometrage                   "Kilométrage : 155 200"
//     p.numero-affaire                "Numero d'affaire : VONUT24047"
//
// MIXED PRICING. Some cards quote a real figure in French format
// ("39 990,00 € H.T." — space thousands separator, COMMA decimal, ex-VAT) and
// some read "NOUS CONSULTER" (ask us). Priced cards are parsed; unpriced ones
// are left blank rather than zeroed, since a fabricated 0 would pass a
// price-ceiling filter and poison the comparison set.
//
// NO NUMERIC ID. Unlike most sources there is no integer listing id anywhere in
// the markup; the URL slug is the only stable per-vehicle key, so it is used as
// source_id. "Numero d'affaire" looks like an id but is the group's internal
// deal reference and is NOT guaranteed unique across centres.
//
// Usage:
//   node francepoidslourds-scraper.js
//   node francepoidslourds-scraper.js --type typeTracteur
//   node francepoidslourds-scraper.js --make daf --year-min 2015

import {
  normaliseRecord,
  writeOutputs,
  fetchText,
  loadExisting,
  mapPool,
  randomDelay,
} from "./lib/scrape-core.js";
import { digits, firstMatch } from "./lib/html-utils.js";

const SLUG = "francepoidslourds";
const ORIGIN = "https://www.francepoidslourds.fr";

// The ?type= values the site itself accepts, read off the radio ids.
const TYPES = ["typeTracteur", "typePorteur", "typeUtilitaire", "typeSemi", "typeRemorque"];

function parseArgs(argv) {
  const args = {
    type: "",
    pages: 25, // runaway guard; the catalogue is 2 pages
    concurrency: 3,
    detail: true,
    limit: Infinity,
    make: null,
    model: null,
    yearMin: null,
    yearMax: null,
    kmMax: null,
    bodyType: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--type") args.type = String(argv[++i] || "");
    else if (a === "--pages") args.pages = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--concurrency") args.concurrency = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--no-detail") args.detail = false;
    else if (a === "--limit") args.limit = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--make") args.make = String(argv[++i] || "").toLowerCase();
    else if (a === "--model") args.model = String(argv[++i] || "").toLowerCase();
    else if (a === "--year-min") args.yearMin = parseInt(argv[++i], 10);
    else if (a === "--year-max") args.yearMax = parseInt(argv[++i], 10);
    else if (a === "--km-max") args.kmMax = parseInt(argv[++i], 10);
    else if (a === "--body-type") args.bodyType = String(argv[++i] || "").toLowerCase();
  }
  if (args.type && !TYPES.includes(args.type)) {
    throw new Error(`unknown --type "${args.type}" (expected one of: ${TYPES.join(", ")})`);
  }
  return args;
}

const clean = (h) =>
  String(h ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

// Titles are ALL-CAPS here ("DAF CF 530 FAT CONSTRUCTION", "RENAULT PRENIUM
// 460 DXI"). This group sells DAF/Nissan/Isuzu/Piaggio new but the used stock is
// explicitly multi-marque, so the full list is needed.
const MAKES = [
  ["Mercedes-Benz", /\bmercedes(?:[-\s]?benz)?\b/i],
  ["DAF", /\bdaf\b/i],
  ["Volvo", /\bvolvo\b/i],
  ["MAN", /\bman\b/i],
  ["Scania", /\bscania\b/i],
  ["Iveco", /\biveco\b/i],
  ["Renault", /\brenault\b/i],
  ["Nissan", /\bnissan\b/i],
  ["Isuzu", /\bisuzu\b/i],
  ["Piaggio", /\bpiaggio\b/i],
  ["Ford", /\bford\b/i],
  ["Citroën", /\bcitro(?:ë|e)n\b/i],
  ["Peugeot", /\bpeugeot\b/i],
  ["Opel", /\bopel\b/i],
  ["Fiat", /\bfiat\b/i],
  ["Schmitz", /\bschmitz(?:\s?cargobull)?\b/i],
  ["Krone", /\bkrone\b/i],
  ["Fruehauf", /\bfruehauf\b/i],
  ["Samro", /\bsamro\b/i],
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
  const parts = html.split(/<div class="col-lg-4 col-md-6 occasion-list-item">/);
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];

    const href = firstMatch(chunk, /<a href="(\/occasion\/[^"]+)"/);
    if (!href) continue;
    // No numeric id exists on this site — the slug is the stable key.
    const id = firstMatch(href, /\/occasion\/([^/]+)\/?/);
    if (!id) continue;

    const title = clean(firstMatch(chunk, /<h2 class="titre">([\s\S]*?)<\/h2>/));
    if (!title) continue;

    const body = clean(firstMatch(chunk, /<p class="carrosserie">([\s\S]*?)<\/p>/));
    const yearRaw = clean(firstMatch(chunk, /<p class="annee">([\s\S]*?)<\/p>/));
    const kmRaw = clean(firstMatch(chunk, /<p class="kilometrage">([\s\S]*?)<\/p>/));
    const ref = clean(firstMatch(chunk, /<p class="numero-affaire">([\s\S]*?)<\/p>/)).replace(
      /^Numero d'affaire\s*:?\s*/i,
      "",
    );
    const img = firstMatch(chunk, /<img src="([^"]+)"/);
    // MIXED PRICING: some cards quote a real figure, others say "NOUS CONSULTER"
    // (ask us). Live 2026-09 page 1 had 3 of 6 priced.
    //
    // FRENCH NUMBER FORMAT, and it matters: "39 990,00 € H.T." uses a space as
    // the thousands separator and a COMMA as the decimal point. Running digits()
    // over it yields 3999000 — a 100x overstatement that would sail through a
    // price filter. So the decimal tail is dropped explicitly before taking
    // digits.
    //
    // Prices are H.T. (hors taxes / ex-VAT), which is normal for French
    // commercial-vehicle trade and is what the rest of the pipeline compares on.
    const priceRaw = clean(firstMatch(chunk, /<p class="prix">([\s\S]*?)<\/p>/));
    const priceDigits = digits(priceRaw.replace(/[.,]\d{2}\b/, ""));

    const { make, model } = splitTitle(title);

    out.push({
      id,
      url: href.startsWith("http") ? href : ORIGIN + href,
      title,
      make,
      model,
      year: firstMatch(yearRaw, /\b(19[5-9]\d|20[0-4]\d)\b/),
      mileage_km: digits(kmRaw.replace(/^Kilométrage\s*:?/i, "")),
      body_type: body,
      stock_ref: ref,
      // Only ever set if the site starts quoting real numbers; blank otherwise.
      price_amount: priceDigits.length >= 3 ? priceDigits : "",
      thumbnail_url: img ? (img.startsWith("http") ? img : ORIGIN + img) : "",
    });
  }
  return out;
}

// Detail page — a WordPress single-occasion template. Specs appear as a simple
// label/value list; pulled opportunistically since the list card already has
// the essentials.
function parseDetail(html) {
  const text = clean(html.replace(/<script[\s\S]*?<\/script>/gi, " "));
  const after = (label) =>
    firstMatch(text, new RegExp(label + "\\s*:?\\s*([A-Za-z0-9À-ÿ.,/ -]{1,40})", "i")).trim();

  const power = digits(firstMatch(text, /(\d{2,4})\s*(?:CV|ch\b)/i));
  const euro = firstMatch(text, /Euro\s*([0-9VI]+)/i);
  return {
    engine_power_hp: power,
    euro_norm: euro,
    gearbox: after("Bo[iî]te"),
    fuel_type: after("Energie|Carburant"),
    axle_configuration: firstMatch(text, /\b(\d\s?x\s?\d)\b/).replace(/\s/g, ""),
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
  const query = args.type ? `?type=${encodeURIComponent(args.type)}` : "";

  // ---- phase 1: every list page ----
  const rows = [];
  const seen = new Set();
  for (let page = 1; page <= args.pages; page++) {
    const url = page === 1 ? `${ORIGIN}/occasions/${query}` : `${ORIGIN}/occasions/page/${page}${query}`;
    const html = await fetchText(url);
    if (!html) {
      console.warn(`[francepoidslourds] list page ${page} failed; stopping paging here`);
      break;
    }
    const found = parseListPage(html);
    const fresh = found.filter((c) => !seen.has(c.id));
    for (const c of fresh) seen.add(c.id);
    rows.push(...fresh);
    console.log(
      `[francepoidslourds] page ${page}: ${found.length} cards (${fresh.length} new, ${rows.length} total)`,
    );

    // The pager's "next" link is the only reliable end marker — the landing page
    // shows 6 of 10 and would otherwise look complete.
    if (!/class="next page-numbers"/.test(html) || fresh.length === 0) break;
    await randomDelay([700, 1400]);
  }

  let out = rows.length > args.limit ? rows.slice(0, args.limit) : rows;

  // ---- phase 2: detail pages ----
  if (args.detail && out.length) {
    let done = 0;
    await mapPool(out, args.concurrency, async (row) => {
      const html = await fetchText(row.url);
      if (html) {
        const d = parseDetail(html);
        if (d.engine_power_hp) row.engine_power_hp = d.engine_power_hp;
        if (d.gearbox) row.gearbox = d.gearbox;
        if (d.fuel_type) row.fuel_type = d.fuel_type;
        if (d.axle_configuration) row.axle_configuration = d.axle_configuration;
        row.euro_norm = d.euro_norm;
      }
      done++;
      await randomDelay([400, 900]);
    });
    console.log(`[francepoidslourds] detail pages fetched: ${done}`);
  }

  // ---- filter ----
  const before = out.length;
  out = applyFilters(out, args);
  console.log(`[francepoidslourds] filtered ${before} -> ${out.length} matching`);

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
          engine_power_hp: r.engine_power_hp,
          axle_configuration: r.axle_configuration,
          gearbox: r.gearbox,
          // Blank where the card said "NOUS CONSULTER", so it loads as NULL.
          price_amount: r.price_amount,
          price_currency: "EUR",
          country_origin: "FR",
          seller_name: "Groupe France Poids Lourds",
          dealer_website: ORIGIN,
          thumbnail_url: r.thumbnail_url,
        },
        scrapedAt,
      ),
    );
  }

  await writeOutputs(SLUG, byId);
  console.log(`[francepoidslourds] wrote ${byId.size} records to output/${SLUG}/`);
}

main().catch((err) => {
  console.error("[francepoidslourds] fatal:", err.message);
  process.exit(1);
});
