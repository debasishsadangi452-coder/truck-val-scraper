// Shared core for the AUCTION scrapers (surplex, troostwijk, rbauction).
//
// Mirrors lib/scrape-core.js, but for auction lots. It exists separately
// because an auction record is a different shape from a dealer listing — a
// live bid, a bid count, an end date, a lot id — and those go to their own
// auction_listings table (see scripts/db/auction-schema.sql for why).
//
// AUCTION_FIELDNAMES is the canonical superset every auction record is
// normalised to, and it matches load-auctions.js COLUMNS (minus source/
// source_id, which the loader supplies). A source that can't fill a field
// leaves it "" and the loader maps that to NULL.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeModel } from "./normalize-model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const OUTPUT_ROOT = path.join(__dirname, "..", "output");

export const AUCTION_FIELDNAMES = [
  "id",
  "url",
  "title",
  "make",
  "model",
  "year",
  "vin",
  "mileage_km",
  "engine_power_hp",
  "engine_capacity_cc",
  "fuel_type",
  "axle_configuration",
  "gearbox",
  "category",
  "current_bid_amount",
  "currency",
  "bids_count",
  "sold_price_amount",
  "bidding_status",
  "auction_start_at",
  "auction_end_at",
  "auction_id",
  "auction_name",
  "lot_number",
  "city",
  "region",
  "country_code",
  "latitude",
  "longitude",
  "seller_name",
  "thumbnail_url",
  "image_urls",
  "scraped_at",
];

// Must match IMAGE_URL_SEPARATOR in load-auctions.js.
export const IMAGE_URL_SEPARATOR = "|";

export function normaliseAuctionRecord(partial, scrapedAt) {
  const rec = {};
  for (const f of AUCTION_FIELDNAMES) rec[f] = partial[f] ?? "";
  rec.scraped_at = scrapedAt;
  return rec;
}

// ---- priority-model matching ------------------------------------------------
//
// The same wishlist the web app filters truck_listings by (the PRIORITY_MODELS
// list in server/routes/listings.js) — duplicated here rather than imported
// because truckval-scraper/ is a standalone deployable package with no path
// back into the app. Keep the two in sync when the business list changes.
//
// Matching is done on the CANONICAL model (normalizeModel), so "XF480",
// "FT XF 480 SSC" and "XF 480" all match the "XF" prefix. An empty prefix list
// matches the whole make — that's how the trailer brands (which have no model
// line) are selected.
export const PRIORITY_MODELS = [
  { make: "daf", prefixes: ["XF", "CF"] },
  { make: "volvo", prefixes: ["FH 460", "FH 500", "FH 540", "FH 750"] },
  { make: "man", prefixes: ["TGX 18.470", "TGX 18.510"] },
  { make: "ford", prefixes: ["F-MAX"] },
  { make: "kogel", prefixes: [] },
  { make: "krone", prefixes: [] },
  { make: "fliegl", prefixes: [] },
  { make: "wielton", prefixes: [] },
];

// Make strings arrive as "Mercedes-Benz", "MERCEDES BENZ", "Kögel"… Fold them
// to the lowercase key PRIORITY_MODELS uses (ö→o so "Kögel" matches "kogel").
export function makeKey(make) {
  return String(make || "")
    .toLowerCase()
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/ä/g, "a")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .trim();
}

/**
 * True when (make, model) is one of the business's priority-sourcing models.
 * Used to tag and (with --priority-only) to filter what a scrape keeps.
 */
export function isPriorityModel(make, model) {
  const key = makeKey(make);
  // "mercedes-benz" style keys can carry a trailing variant ("man-truck-bus");
  // match on the leading make token so those still resolve.
  const entry = PRIORITY_MODELS.find((p) => key === p.make || key.startsWith(`${p.make}-`));
  if (!entry) return false;
  if (entry.prefixes.length === 0) return true; // make-only (trailer brands)
  const canonical = normalizeModel(entry.make, model);
  if (!canonical) return false;
  return entry.prefixes.some((prefix) => canonical.toUpperCase().startsWith(prefix.toUpperCase()));
}

// ---- refrigerated (reefer) body-type detection ------------------------------
//
// No scraper captures a structured body-type field — every source's canonical
// record is (make, model, spec columns), never "body type". A refrigerated
// truck/trailer is therefore identified the same way a human would skim a
// listing: by the words the seller used in the title (and, where a source
// supplies one, the description). This is intentionally a TEXT match over
// already-scraped output, not a new scraper or a DB migration — it lets
// "refrigerated" become its own category by re-reading what every existing
// source already collected.
//
// Covers the English/German/French/Dutch/Polish/Italian/Spanish terms seen
// across the sources this package scrapes (mirroring the language mix in
// SCRAPERS.md's site list), plus the manufacturer body-code "FP"/"TK" seen on
// Schmitz/Krone/Carrier-fitted trailers is deliberately NOT matched — those
// codes collide with unrelated model numbers too often to be reliable.
const REFRIGERATED_RE =
  /\b(?:refrigerat\w*|reefer|frigo\w*|k[uü]hl\w*|isotherm\w*|chłodni\w*|frigor[íi]fic\w*|frigorifer\w*|thermo\s?king|carrier\s?(?:supra|vector))\b/i;

/** True when a title (and optional description) reads as a refrigerated body. */
export function isRefrigerated(title, description = "") {
  return REFRIGERATED_RE.test(`${title || ""} ${description || ""}`);
}

// ---- output ----------------------------------------------------------------

function csvEscape(value) {
  const str = String(value ?? "");
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function outputDir(slug) {
  return path.join(OUTPUT_ROOT, slug);
}

export async function loadExistingAuctions(slug) {
  const jsonFile = path.join(outputDir(slug), "auctions.json");
  if (!existsSync(jsonFile)) return new Map();
  try {
    const records = JSON.parse(await readFile(jsonFile, "utf8"));
    return new Map(records.map((r) => [String(r.id), r]));
  } catch {
    return new Map();
  }
}

export async function writeAuctionOutputs(slug, byId) {
  const dir = outputDir(slug);
  await mkdir(dir, { recursive: true });
  const records = [...byId.values()];
  await writeFile(path.join(dir, "auctions.json"), JSON.stringify(records, null, 2));

  const lines = [AUCTION_FIELDNAMES.join(",")];
  for (const rec of records) {
    lines.push(AUCTION_FIELDNAMES.map((f) => csvEscape(rec[f])).join(","));
  }
  await writeFile(path.join(dir, "auctions.csv"), lines.join("\n") + "\n");
}

// Unix seconds (what the TBAuctions API returns) → ISO string for Postgres.
export function epochToIso(seconds) {
  if (!seconds && seconds !== 0) return "";
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n * 1000).toISOString();
}
