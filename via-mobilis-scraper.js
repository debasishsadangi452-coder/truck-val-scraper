#!/usr/bin/env node
// Scrapes used-truck listings from via-mobilis.com — plain HTTP, no browser.
//
// via-mobilis.com serves server-rendered search pages (a reCAPTCHA widget sits
// in the page but does NOT gate the HTML — the full result list is returned to a
// plain request). Each result card is rich enough that we DON'T need detail
// pages: the card carries a labelled spec run in its text, e.g.
//   "… Make : Daf | Range : Xf | 531 HP | 220300 km | Gearbox : … | 12902 cc |
//    Energy : Diesel | Axles : 6x4 | Normes euro : 6 | 26 Tonnes …"
// plus a title, a "65,900 EUR" price, a "Date of first registration 05/01/2020",
// a "Country GERMANY", a "GERMANY - Region - City" location line, a photo, and a
// detail href ending in /ts-vi<id>. The numeric <id> (also on the card as
// data-id) is the stable dedup / DB (source, source_id) key.
//
// Pagination is ?p=N (1-based). The card count per page is ~21; we page until a
// page yields no NEW ids (past the last page repeats or empties).
//
// The URL is passed in with --url so any via-mobilis search (make / model /
// country filtered) can be crawled; --slug names its output folder. Writes
// output/<slug>/listings.json; load with:
//   node load-listings.js <slug> via_mobilis
//
// Usage:
//   node via-mobilis-scraper.js \
//     --url "https://www.via-mobilis.com/used/daf-xf/truck-germany/~a1b32e180f6029nDE" \
//     --slug via-mobilis-daf --max-pages 20

import { fetchText, normaliseRecord, writeOutputs, loadExisting, randomDelay } from "./lib/scrape-core.js";
import { stripTags, digits } from "./lib/html-utils.js";

const DEFAULT_SLUG = "via-mobilis-trucks";
const BASE = "https://www.via-mobilis.com";

function parseArgs(argv) {
  const args = { maxPages: 30, url: null, slug: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (a === "--url") args.url = argv[++i];
    else if (a === "--slug") args.slug = argv[++i];
  }
  return args;
}

function pageUrl(url, page) {
  if (page <= 1) return url;
  return `${url}${url.includes("?") ? "&" : "?"}p=${page}`;
}

// Split the page into per-card HTML chunks, one per result. Cards open with
// class="… card … vehicle card-<id>" and data-id="<id>"; we slice from each
// card marker to the next (or end of document).
function splitCards(html) {
  const markers = [...html.matchAll(/class="[^"]*\bvehicle\b[^"]*\bcard-(\d{5,})"/g)];
  const cards = [];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].index;
    const end = i + 1 < markers.length ? markers[i + 1].index : html.length;
    cards.push({ id: markers[i][1], html: html.slice(start, end) });
  }
  return cards;
}

// Pull "Label : value" out of the card's flattened text (the card renders a
// "Bodywork : Tipper | Make : Daf | Range : Xf | …" run). Case-insensitive label.
function labelled(text, label) {
  const re = new RegExp(`${label}\\s*:\\s*([^|<]+?)\\s*(?:\\||$)`, "i");
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

function cardToRecord(card, scrapedAt) {
  const { id, html } = card;
  const text = stripTags(html).replace(/\s+/g, " ").trim();

  // Detail href (…/ts-vi<id>) + its title attribute (the human name).
  const href = (html.match(/href="([^"]*ts-vi\d+[^"]*)"/) || [])[1] || "";
  const url = href ? (href.startsWith("http") ? href : `${BASE}${href}`) : `${BASE}/`;
  const titleAttr = (html.match(/<a[^>]*href="[^"]*ts-vi\d+[^"]*"[^>]*title="([^"]+)"/) || [])[1] || "";
  // Strip a trailing " truck"/" used …" noise the title attr sometimes carries.
  const title = titleAttr.replace(/\s*\|\s*$/, "").trim();

  // Make: "Daf" → "DAF" (normalize-model + the priority filter lower() it either
  // way, but keep the stored value uppercase-consistent with other sources).
  const make = (labelled(text, "Make") || "DAF").toUpperCase();
  const range = labelled(text, "Range").toUpperCase(); // e.g. "XF", "TGX", "FH"
  const power = digits((text.match(/\b(\d{2,4})\s*HP\b/) || [])[1] || "");
  // Model: prefer the model token straight from the TITLE, which carries the
  // real marketing/chassis designation (e.g. "MAN TGX 26.500", "DAF XF 530",
  // "Volvo FH 500") — the card's Range+HP loses the chassis code and mis-tiers
  // Volvo (HP 539 vs marketing FH 540). We take "<range> <code>" from the title:
  // the code is either an "NN.NNN" chassis (MAN) or a 3-digit power (DAF/Volvo).
  // normalize-model.js then folds it to the canonical name. Fall back to range+HP.
  const afterRange = range
    ? (titleAttr.match(new RegExp(`\\b${range}\\s+(\\d{2}\\.\\d{3}|\\d{3})\\b`, "i")) || [])[0]
    : "";
  const model = (afterRange || [range, power].filter(Boolean).join(" ")).trim() || range;

  // Price: data-price="65,900 EUR" on the card wrapper, else "… EUR" text.
  const priceAttr = html.match(/data-price="([\d.,]+)\s*([A-Z]{3})?"/) || [];
  const price = digits(priceAttr[1] || (text.match(/([\d.,]{3,})\s*EUR/i) || [])[1] || "");
  const currency = price ? priceAttr[2] || "EUR" : "";

  // Year: "Date of first registration 05/01/2020" → 2020, else any 4-digit year.
  const year =
    (text.match(/first registration\D*(?:\d{2}\/\d{2}\/)?(\d{4})/i) || [])[1] ||
    (text.match(/\b(19|20)\d{2}\b/) || [])[0] ||
    "";

  // Mileage: the card reads "… 2020 220 300 km …" — the greedy digit run would
  // swallow the leading year, so take the labelled "… km" spec ("220300 km")
  // when present, else the digits right before "km" capped to a plausible length.
  let mileage = "";
  const kmSpec = text.match(/\|\s*([\d.,\s]+?)\s*km\b/i); // labelled spec "| 220300 km"
  if (kmSpec) mileage = digits(kmSpec[1]);
  else {
    const kmLoose = digits((text.match(/([\d.,\s]{1,10})\s*km\b/i) || [])[1] || "");
    // Drop a leading 4-digit year the loose match may have absorbed.
    mileage = kmLoose.length > 6 && /^(19|20)\d{2}/.test(kmLoose) ? kmLoose.slice(4) : kmLoose;
  }
  const cc = digits((text.match(/\b([\d.,]+)\s*cc\b/i) || [])[1] || "");
  const axle = labelled(text, "Axles");
  const gearbox = labelled(text, "Gearbox");
  const fuel = labelled(text, "Energy");

  // Location line: "GERMANY - Niedersachsen - Stuhr". Country = first segment,
  // region/city = the rest. Fall back to the labelled "Country".
  const locMatch = text.match(/\b([A-Z]{3,}(?:\s[A-Z]{3,})*)\s-\s([A-Za-zÀ-ÿ .'-]+?)\s-\s([A-Za-zÀ-ÿ .'-]+?)\b/);
  let country = labelled(text, "Country");
  let region = "";
  let city = "";
  if (locMatch) {
    country = country || titleCase(locMatch[1]);
    region = locMatch[2].trim();
    city = locMatch[3].trim();
  }
  country = country ? titleCase(country) : "";

  // Photo from the card's json-data blob or the <img> src.
  const photo =
    (html.match(/"url":"(https:[^"]+?_th\.jpg)"/) || [])[1]?.replace(/\\\//g, "/") ||
    (html.match(/<img[^>]+src="(https:\/\/photo\.static-viamobilis\.com[^"]+)"/) || [])[1] ||
    "";

  return normaliseRecord(
    {
      id: String(id),
      url,
      title: title || `${make} ${model}`.trim(),
      make,
      model,
      year: String(year).slice(0, 4),
      mileage_km: mileage,
      fuel_type: fuel,
      engine_capacity_cc: cc,
      engine_power_hp: power,
      axle_configuration: axle,
      gearbox,
      country_origin: country,
      region: region || country,
      city,
      price_amount: price,
      price_currency: currency,
      thumbnail_url: photo,
      seller_name: "",
      dealer_website: BASE,
    },
    scrapedAt,
  );
}

// "GERMANY" / "germany" → "Germany"; leaves multi-word names reasonable.
function titleCase(s) {
  return String(s)
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.error("Usage: node via-mobilis-scraper.js --url <search URL> [--slug name] [--max-pages N]");
    process.exit(1);
  }
  const slug = args.slug || DEFAULT_SLUG;
  const scrapedAt = new Date().toISOString();
  const byId = await loadExisting(slug);
  const startCount = byId.size;
  const counts = { added: 0, updated: 0 };
  const processed = new Set();

  console.log(`--- via-mobilis.com scrape: ${args.url} → slug=${slug} ---`);

  for (let page = 1; page <= args.maxPages; page++) {
    const url = pageUrl(args.url, page);
    const html = await fetchText(url);
    if (!html) {
      console.warn(`  page ${page}: fetch failed, stopping.`);
      break;
    }
    const cards = splitCards(html);
    if (cards.length === 0) {
      console.log(`  page ${page}: no cards, end of results.`);
      break;
    }
    let fresh = 0;
    for (const card of cards) {
      if (processed.has(card.id)) continue;
      processed.add(card.id);
      fresh++;
      const rec = cardToRecord(card, scrapedAt);
      const key = String(rec.id);
      if (byId.has(key)) counts.updated++;
      else counts.added++;
      byId.set(key, rec);
    }
    console.log(`  page ${page}: ${cards.length} cards (${fresh} new this run)`);
    // Past the last real page the site repeats/empties → no fresh ids → stop.
    if (fresh === 0) {
      console.log("  page repeated known listings — end of results.");
      break;
    }
    await writeOutputs(slug, byId); // checkpoint each page
    await randomDelay([1000, 2200]);
  }

  await writeOutputs(slug, byId);
  console.log(
    `--- via-mobilis: ${counts.added} new, ${counts.updated} refreshed, ${byId.size} total (was ${startCount}) ---`,
  );
  console.log(`Next: node load-listings.js ${slug} via_mobilis`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
