#!/usr/bin/env node
// Refrigerated (reefer) trucks — a SEPARATE CATEGORY built on top of the
// existing dealer-listing scrapers, not a new source.
//
// WHY THIS SHAPE. No scraper captures a structured body-type field (see the
// comment on isRefrigerated() in lib/auction-core.js) and truck_listings has
// no body_type column — adding one would be a schema migration across every
// existing scraper for a single derived attribute. Instead this script reads
// the listings.json each scraper ALREADY wrote to output/<slug>/, keeps only
// the rows whose title (or description, where present) reads as a
// refrigerated body, and loads them into truck_listings tagged with a
// "_refrigerated" suffix on the source column (e.g. "otomoto_refrigerated").
// That keeps the category queryable on its own (`WHERE source LIKE
// '%_refrigerated'`) without touching a single existing scraper, its output
// format, or the schema.
//
// This is a FILTER over prior scrapes, not a scrape itself — run the normal
// scrapers first (or rely on their existing output/) so there is something to
// filter. It never hits the network.
//
//   node refrigerated-scraper.js                 # filter every known source
//   node refrigerated-scraper.js --dry-run        # counts only, no DB write
//   node refrigerated-scraper.js --sources otomoto,autoline,truck7
//
// Then (or automatically, unless --no-load):
//   node load-listings.js   # NOT used here — see loadRefrigerated() below,
//                            # which writes with the _refrigerated source tag
//                            # directly rather than reusing load-listings.js's
//                            # fixed slug->source map.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pool } from "./lib/db.js";
import { normalizeModel } from "./lib/normalize-model.js";
import { isRefrigerated } from "./lib/auction-core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT = path.join(__dirname, "output");

// Every dealer-listing (non-auction) source this package can produce, mapped
// slug -> source tag. Mirrors load-listings.js's SOURCES — kept as a separate
// list because this script's output source tag is derived from `source`
// (`${source}_refrigerated`), not the slug.
const SOURCES = [
  { slug: "otomoto-trucks", source: "otomoto" },
  { slug: "otomoto-trailers", source: "otomoto" },
  { slug: "sauto-cz-trucks", source: "sauto_cz" },
  { slug: "autoplius-lt-trucks", source: "autoplius_lt" },
  { slug: "planet-trucks-trucks", source: "planet_trucks" },
  { slug: "mjaatrucks-lt-trucks", source: "mjaatrucks_lt" },
  { slug: "planet-trucks-trailers", source: "planet_trucks" },
  { slug: "autoline-trucks", source: "autoline" },
  { slug: "truck7-trucks", source: "truck7" },
  { slug: "autoline-bg-trucks", source: "autoline_bg" },
  { slug: "autovit-trucks", source: "autovit" },
  { slug: "truckscout24-trucks", source: "truckscout24" },
  { slug: "truckstore-trucks", source: "truckstore" },
  { slug: "mobilebg-trucks", source: "mobilebg" },
  { slug: "truck1-trucks", source: "truck1" },
  { slug: "trucksnl-trucks", source: "trucksnl" },
  { slug: "dafusedtrucks-trucks", source: "dafusedtrucks" },
  { slug: "autoline-daf-trucks", source: "autoline" },
  { slug: "via-mobilis-daf", source: "via_mobilis" },
  { slug: "via-mobilis-daf-xf", source: "via_mobilis" },
  { slug: "via-mobilis-daf-cf", source: "via_mobilis" },
  { slug: "via-mobilis-volvo-fh", source: "via_mobilis" },
  { slug: "via-mobilis-man-tgx", source: "via_mobilis" },
  { slug: "mascus-trucks", source: "mascus" },
];

// Same column set as load-listings.js's COLUMNS — kept identical so a
// refrigerated row has exactly the same shape as a normal one, just filed
// under a different `source`.
const COLUMNS = [
  "source",
  "source_id",
  "url",
  "title",
  "make",
  "model",
  "model_normalized",
  "year",
  "mileage_km",
  "fuel_type",
  "engine_capacity_cc",
  "engine_power_hp",
  "axle_configuration",
  "wheel_axis",
  "gearbox",
  "gross_weight_kg",
  "payload_kg",
  "co2_g_km",
  "country_origin",
  "condition_registered",
  "condition_no_accident",
  "condition_service_record",
  "price_amount",
  "price_currency",
  "city",
  "region",
  "dealer_address",
  "dealer_postal_code",
  "seller_name",
  "dealer_website",
  "latitude",
  "longitude",
  "vin",
  "thumbnail_url",
  "image_urls",
  "listed_at",
  "scraped_at",
];

const IMAGE_URL_SEPARATOR = "|";

function toInt(value) {
  if (!value) return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function toNumeric(value) {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toBool(value) {
  if (value === "Tak" || value === "Yes" || value === true) return true;
  if (value === "Nie" || value === "No" || value === false) return false;
  return null;
}

function toTextArray(value) {
  if (!value) return null;
  const parts = value.split(IMAGE_URL_SEPARATOR).filter(Boolean);
  return parts.length > 0 ? parts : null;
}

function toRow(record, source) {
  const make = record.make || (record.title || "").split(/\s+/)[0] || "Unknown";
  return [
    source,
    record.id,
    record.url,
    record.title || null,
    make,
    record.model || null,
    normalizeModel(make, record.model),
    toInt(record.year),
    toInt(record.mileage_km),
    record.fuel_type || null,
    toInt(record.engine_capacity_cc),
    toInt(record.engine_power_hp),
    record.axle_configuration || null,
    toInt(record.wheel_axis),
    record.gearbox || null,
    toInt(record.gross_weight_kg),
    toInt(record.payload_kg),
    toInt(record.co2_g_km),
    record.country_origin || null,
    toBool(record.condition_registered),
    toBool(record.condition_no_accident),
    toBool(record.condition_service_record),
    toNumeric(record.price_amount),
    record.price_currency || null,
    record.city || null,
    record.region || null,
    record.dealer_address || null,
    record.dealer_postal_code || null,
    record.seller_name || null,
    record.dealer_website || null,
    toNumeric(record.latitude),
    toNumeric(record.longitude),
    record.vin || null,
    record.thumbnail_url || null,
    toTextArray(record.image_urls),
    record.created_at || null,
    record.scraped_at || null,
  ];
}

function buildUpsertQuery(rows) {
  const cols = COLUMNS;
  const valuesSql = [];
  const params = [];
  rows.forEach((row, rowIdx) => {
    const placeholders = row.map((_, colIdx) => `$${rowIdx * cols.length + colIdx + 1}`);
    valuesSql.push(`(${placeholders.join(", ")})`);
    params.push(...row);
  });

  const updateSet = cols
    .filter((c) => c !== "source" && c !== "source_id")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");

  const sql = `
    INSERT INTO truck_listings (${cols.join(", ")})
    VALUES ${valuesSql.join(", ")}
    ON CONFLICT (source, source_id) DO UPDATE SET
      ${updateSet},
      updated_at = now()
  `;
  return { sql, params };
}

function parseArgs(argv) {
  const args = { dryRun: false, sources: null, load: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-load") args.load = false;
    else if (a === "--sources") args.sources = argv[++i].split(",").map((s) => s.trim());
  }
  return args;
}

async function loadRefrigerated({ slug, source }) {
  const jsonFile = path.join(OUTPUT_ROOT, slug, "listings.json");
  if (!existsSync(jsonFile)) {
    console.log(`skip ${source} (${slug}): no output yet — run its scraper first`);
    return { total: 0, matched: 0 };
  }
  const records = JSON.parse(await readFile(jsonFile, "utf8"));
  const matches = records.filter((r) => isRefrigerated(r.title, r.description));
  console.log(`${source} (${slug}): ${matches.length}/${records.length} refrigerated`);
  return { total: records.length, matched: matches.length, records: matches };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sources = args.sources
    ? SOURCES.filter((s) => args.sources.includes(s.source))
    : SOURCES;

  let grandTotal = 0;
  let grandMatched = 0;
  const byTag = new Map(); // "<source>_refrigerated" -> records[]

  for (const s of sources) {
    const { total, matched, records } = await loadRefrigerated(s);
    grandTotal += total;
    grandMatched += matched;
    if (!records || records.length === 0) continue;
    const tag = `${s.source}_refrigerated`;
    const bucket = byTag.get(tag) || [];
    bucket.push(...records);
    byTag.set(tag, bucket);
  }

  console.log(`\n${grandMatched}/${grandTotal} scraped listings are refrigerated bodies`);

  if (args.dryRun || !args.load) {
    console.log(args.dryRun ? "dry run — nothing written" : "--no-load — nothing written");
    await pool.end().catch(() => {});
    return;
  }

  const BATCH_SIZE = 200;
  for (const [tag, records] of byTag) {
    let loaded = 0;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE).map((r) => toRow(r, tag));
      const { sql, params } = buildUpsertQuery(batch);
      await pool.query(sql, params);
      loaded += batch.length;
    }
    console.log(`loaded ${loaded} row(s) as source="${tag}"`);
  }

  await pool.end().catch(() => {});
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
