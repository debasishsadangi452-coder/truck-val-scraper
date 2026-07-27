#!/usr/bin/env node
// Scrapes used-vehicle listings from truck7.eu.
//
// truck7.eu is a Laravel/Livewire app. The paginated /listings index links to
// /listings/{id} detail pages; each detail page embeds its full spec table as
// JSON inside a Livewire `wire:snapshot` attribute (HTML-entity-escaped) — an
// `attributeGroups` tree of { label, value } pairs covering Type, First
// Registration, VIN Code, Cabin, Color, Location, Fuel Type, dimensions, axles
// and max load. That structured blob is what we parse (not brittle HTML), plus
// the page <h1> for the human title.
//
// PAGINATION is Livewire-stateful, NOT a URL query param — /listings?page=N is
// ignored and always returns page 1. We reproduce the browser flow instead:
//   1. GET /listings  → captures the session + XSRF-TOKEN cookies and the
//      pages.listings component snapshot (which holds the paginators state).
//   2. POST /livewire/update with a gotoPage(N,'page') call + the current
//      snapshot + the decrypted XSRF token as the X-XSRF-TOKEN header. The
//      response's effects.html carries that page's /listings/{id} links and a
//      fresh snapshot for the next page.
// This walks the full ~5600-listing result set politely, page by page.
//
// truck7 does NOT publish prices (detail pages show a contact/inquiry prompt),
// so price_amount is left blank — honestly empty rather than fabricated. VIN,
// which otomoto never exposed, IS present here and captured.
//
// Note the catalog mixes trucks, trailers and semi-trailers; the ad's "Type"
// field is stored as-is in the title/model, and can be filtered downstream.
//
// The stable source id is the numeric /listings/{id}, used for dedup and the
// DB (source, source_id) upsert.
//
// Usage:
//   node scripts/truck7-trucks-scraper.js
//   node scripts/truck7-trucks-scraper.js --max-pages 40 --concurrency 4
//
// No dependencies beyond Node's built-in fetch (Node 18+).

import { fetchText, fetchWithCookies, normaliseRecord, runScrape } from "./lib/scrape-core.js";
import { stripTags } from "./lib/html-utils.js";

const SLUG = "truck7-trucks";
const BASE = "https://truck7.eu";
const LIVEWIRE_URL = `${BASE}/livewire/update`;

// truck7's catalog mixes trucks, trailers and semi-trailers. Filtering to
// `?type=truck` cuts ~5,600 mixed listings down to ~2,500 trucks. The filter is
// baked into the initial Livewire snapshot ("selectedType":"truck"), so starting
// the crawl from this URL carries the filter through every paginated page — no
// extra Livewire filter call needed. Pass --type "" to scrape everything, or
// --type trailer / --type semi-trailer for other categories.
function listingsUrl(type) {
  return type ? `${BASE}/listings?type=${encodeURIComponent(type)}` : `${BASE}/listings`;
}

function parseArgs(argv) {
  const args = { maxPages: 50, concurrency: 4, details: true, type: "truck" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (a === "--concurrency") args.concurrency = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--no-details") args.details = false;
    else if (a === "--type") args.type = argv[++i];
  }
  return args;
}

// Pull the largest Livewire snapshot that contains the spec tree, unescape the
// HTML entities, JSON-parse it, and flatten attributeGroups into { label: value }.
function extractAttributes(html) {
  const snaps = html.match(/wire:snapshot="([\s\S]*?)"/g) ?? [];
  for (const raw of snaps) {
    const escaped = raw.slice('wire:snapshot="'.length, -1);
    const json = escaped
      .replace(/&quot;/g, '"')
      .replace(/&#039;|&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
    if (!json.includes("attributeGroups")) continue;
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      continue;
    }
    const root = Array.isArray(data.data) ? data.data[0] : data.data;
    return flattenGroups(root?.attributeGroups);
  }
  return {};
}

// attributeGroups shape (Livewire arrays are wrapped in [value, {"s":"arr"}]):
//   [ [ { name, values: [ [ [ [{label,value},{s}], ... ], {s} ] ] }, {s} ], ... ]
// Walk it recursively collecting every {label, value} object into a flat map.
function flattenGroups(node, out = {}) {
  if (node == null || typeof node !== "object") return out;
  if (typeof node.label === "string" && "value" in node) {
    out[node.label.toLowerCase()] = node.value;
    return out;
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === "object") flattenGroups(v, out);
  }
  return out;
}

// "May 2022" / "2022" -> "2022".
function yearFrom(value) {
  const m = String(value ?? "").match(/(\d{4})/);
  return m ? m[1] : "";
}

// "Rawa Mazowiecka, Poland" -> { city: "Rawa Mazowiecka", country: "Poland" }.
function splitLocation(value) {
  const parts = String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return { city: "", country: "" };
  return { city: parts.slice(0, -1).join(", "), country: parts[parts.length - 1] };
}

async function enrichDetail(record) {
  const html = await fetchText(record.url);
  if (!html) return;
  const attrs = extractAttributes(html);
  const title = stripTags((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ?? [])[1] ?? "");

  const loc = splitLocation(attrs.location);
  // Title is the human name (make + model); first token approximates the make.
  // make is NOT NULL in the DB, so fall back to the ad's "Type" or "Unknown".
  const make = title.split(/\s+/)[0] || attrs.type || "Unknown";

  record.title = title;
  record.make = make;
  record.model = make && title.startsWith(make) ? title.slice(make.length).trim() : title;
  record.year = yearFrom(attrs["first registration"]);
  record.vin = attrs["vin code"] ?? "";
  record.fuel_type = attrs["fuel type"] ?? "";
  record.gearbox = attrs.gearbox ?? attrs.transmission ?? "";
  record.payload_kg = String(attrs["maximum load (kg)"] ?? "").replace(/[^\d]/g, "");
  record.axle_configuration = attrs["total axles"] ? `${attrs["total axles"]} axles` : "";
  record.city = loc.city;
  record.region = loc.country;
  record.country_origin = loc.country;
  // "Type" (Semi-Trailers / Trucks / ...) is useful context — keep it if the
  // title didn't already carry a model.
  if (!record.model && attrs.type) record.model = attrs.type;
}

// The pages.listings Livewire component snapshot is the wire:snapshot blob that
// carries the `paginators` state. Return it decoded (HTML entities → chars).
function extractListingsSnapshot(html) {
  const snaps = html.match(/wire:snapshot="([\s\S]*?)"/g) ?? [];
  for (const raw of snaps) {
    const escaped = raw.slice('wire:snapshot="'.length, -1);
    const decoded = escaped
      .replace(/&quot;/g, '"')
      .replace(/&#039;|&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
    if (decoded.includes("paginators")) return decoded;
  }
  return null;
}

function listingIds(html) {
  return [...new Set([...html.matchAll(/\/listings\/(\d+)/g)].map((m) => m[1]))];
}

// Walk the result set through Livewire's stateful pager. Yields one page of
// base records at a time; the shared runScrape enriches each from its detail
// page. `args.maxPages` caps the crawl (5600 listings / 10 = ~560 pages max).
async function* listPages(args) {
  const scrapedAt = new Date().toISOString();
  const jar = new Map();
  const startUrl = listingsUrl(args.type);

  // Page 1: a normal GET of the (optionally type-filtered) listings URL seeds
  // cookies + the initial snapshot (which encodes the type filter), and its own
  // HTML already lists the first 10 ids.
  const first = await fetchWithCookies(startUrl, jar);
  if (first.status !== 200) {
    console.error(`  GET ${startUrl} failed (HTTP ${first.status})`);
    yield { records: [], done: true };
    return;
  }
  let snapshot = extractListingsSnapshot(first.text);
  const xsrf = jar.has("XSRF-TOKEN") ? decodeURIComponent(jar.get("XSRF-TOKEN")) : "";
  const toRecords = (ids) =>
    ids.map((id) => normaliseRecord({ id, url: `${BASE}/listings/${id}` }, scrapedAt));

  const firstIds = listingIds(first.text);
  yield { records: toRecords(firstIds), done: firstIds.length < 10 || args.maxPages <= 1 };
  if (!snapshot || firstIds.length < 10 || args.maxPages <= 1) return;

  // Pages 2..N: POST gotoPage(page) to the Livewire endpoint, reading ids and
  // the next snapshot out of each response.
  for (let page = 2; page <= args.maxPages; page++) {
    const payload = JSON.stringify({
      components: [
        {
          snapshot,
          updates: {},
          calls: [{ path: "", method: "gotoPage", params: [page, "page"] }],
        },
      ],
    });
    const resp = await fetchWithCookies(LIVEWIRE_URL, jar, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Livewire": "1",
        ...(xsrf ? { "X-XSRF-TOKEN": xsrf } : {}),
        Referer: startUrl,
      },
      body: payload,
    });
    if (resp.status !== 200) {
      console.warn(`  livewire page ${page} failed (HTTP ${resp.status}), stopping.`);
      return;
    }
    let comp;
    try {
      comp = JSON.parse(resp.text).components[0];
    } catch {
      console.warn(`  livewire page ${page}: unparseable response, stopping.`);
      return;
    }
    const fragment = comp.effects?.html ?? "";
    snapshot = comp.snapshot ?? snapshot; // carry the fresh state forward
    const ids = listingIds(fragment);
    console.log(`  livewire page ${page}: ${ids.length} ids`);
    yield { records: toRecords(ids), done: ids.length < 10 };
    if (ids.length < 10) return;
  }
}

const source = {
  slug: SLUG,
  listPages,
  details: enrichDetail,
  detailDelay: [800, 1600],
  pageDelay: [1500, 3000],
  concurrency: 4,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  source.concurrency = args.concurrency;
  console.log(
    `--- truck7.eu scrape: type=${args.type || "all"}, max ${args.maxPages} pages, details=${args.details} ---`,
  );
  await runScrape(source, args);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
