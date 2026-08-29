#!/usr/bin/env node
// Loads an auction scraper's output/<slug>/auctions.json into the
// auction_listings table (upsert on (source, source_id), so re-running after a
// fresh scrape refreshes the live bid instead of duplicating the lot).
//
// This is the auction twin of load-listings.js. It's separate because auction
// lots go to their own table — an auction row has a moving bid, a bid count and
// a close date, and mixing those into truck_listings would corrupt every price
// average the dashboard computes there. See scripts/db/auction-schema.sql.
//
//   node load-auctions.js                          # load every known source
//   node load-auctions.js surplex-trucks surplex   # one: <slug> [source]
//   node load-auctions.js rbauction-trucks rbauction
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./lib/db.js";
import { normalizeModel } from "./lib/normalize-model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT = path.join(__dirname, "output");

// slug (output/ folder) -> DB `source` tag. Add a line per auction scraper.
const SOURCES = [
  { slug: "surplex-trucks", source: "surplex" },
  { slug: "surplex-trailers", source: "surplex" },
  { slug: "troostwijk-trucks", source: "troostwijk" },
  { slug: "troostwijk-trailers", source: "troostwijk" },
  { slug: "rbauction-trucks", source: "rbauction" },
  { slug: "euroauctions-trucks", source: "euroauctions" },
];

const COLUMNS = [
  "source",
  "source_id",
  "url",
  "title",
  "make",
  "model",
  "model_normalized",
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

// Must match IMAGE_URL_SEPARATOR in lib/auction-core.js.
const IMAGE_URL_SEPARATOR = "|";

const BATCH_SIZE = 500;

function toInt(value) {
  if (value === "" || value == null) return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function toNumeric(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toTimestamp(value) {
  return value || null;
}

function toTextArray(value) {
  if (!value) return null;
  const parts = String(value).split(IMAGE_URL_SEPARATOR).filter(Boolean);
  return parts.length > 0 ? parts : null;
}

function toRow(record, source) {
  // make is NOT NULL in the schema — an auction lot whose title names no known
  // make (a mixed "Shipping Cell" lot) must not abort the whole batch, so fall
  // back to the title's first word and finally a placeholder, same as the
  // listings loader does.
  const make = record.make || String(record.title || "").split(/\s+/)[0] || "Unknown";
  return [
    source,
    record.id,
    record.url,
    record.title || null,
    make,
    record.model || null,
    // Canonical model for grouping/matching against truck_listings.model_normalized.
    normalizeModel(make, record.model),
    toInt(record.year),
    record.vin || null,
    toInt(record.mileage_km),
    toInt(record.engine_power_hp),
    toInt(record.engine_capacity_cc),
    record.fuel_type || null,
    record.axle_configuration || null,
    record.gearbox || null,
    record.category || null,
    toNumeric(record.current_bid_amount),
    record.currency || null,
    toInt(record.bids_count),
    toNumeric(record.sold_price_amount),
    record.bidding_status || null,
    toTimestamp(record.auction_start_at),
    toTimestamp(record.auction_end_at),
    record.auction_id || null,
    record.auction_name || null,
    record.lot_number != null && record.lot_number !== "" ? String(record.lot_number) : null,
    record.city || null,
    record.region || null,
    record.country_code || null,
    toNumeric(record.latitude),
    toNumeric(record.longitude),
    record.seller_name || null,
    record.thumbnail_url || null,
    toTextArray(record.image_urls),
    toTimestamp(record.scraped_at),
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
    INSERT INTO auction_listings (${cols.join(", ")})
    VALUES ${valuesSql.join(", ")}
    ON CONFLICT (source, source_id) DO UPDATE SET
      ${updateSet},
      updated_at = now()
  `;
  return { sql, params };
}

async function loadSource(slug, source) {
  const file = path.join(OUTPUT_ROOT, slug, "auctions.json");
  if (!existsSync(file)) {
    console.log(`skip ${slug}: no auctions.json (not scraped yet)`);
    return 0;
  }
  const records = JSON.parse(await readFile(file, "utf8"));
  if (records.length === 0) {
    console.log(`skip ${slug}: no records`);
    return 0;
  }

  // A lot with no id can't participate in the (source, source_id) upsert, and a
  // duplicate id inside one batch makes Postgres reject the whole statement
  // ("cannot affect row a second time") — so drop both here, keeping the last
  // occurrence of a repeated id.
  const byId = new Map();
  let skipped = 0;
  for (const rec of records) {
    if (!rec.id) {
      skipped++;
      continue;
    }
    byId.set(String(rec.id), rec);
  }
  if (skipped > 0) console.log(`  ${slug}: skipped ${skipped} record(s) with no id`);

  const rows = [...byId.values()].map((rec) => toRow(rec, source));
  let loaded = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { sql, params } = buildUpsertQuery(batch);
    await pool.query(sql, params);
    loaded += batch.length;
  }
  console.log(`loaded ${loaded} rows into auction_listings from ${slug} (source=${source})`);
  return loaded;
}

// A lot that has passed its close date can no longer be bid on, and the source
// drops it from the catalogue — so the row would otherwise sit in the table for
// ever, still tagged BIDDING_OPEN because the last scrape that saw it said so.
// Mark those closed on every load, which is what makes the weekly refresh
// self-correcting rather than just additive. The rows are KEPT (not deleted):
// a closed lot with a final bid is the most useful price evidence we have.
async function markClosedLots() {
  const { rowCount } = await pool.query(`
    UPDATE auction_listings
       SET bidding_status = 'CLOSED', updated_at = now()
     WHERE bidding_status = 'BIDDING_OPEN'
       AND auction_end_at IS NOT NULL
       AND auction_end_at < now()
  `);
  if (rowCount > 0) console.log(`marked ${rowCount} past-end lot(s) CLOSED`);
}

async function main() {
  const [slugArg, sourceArg] = process.argv.slice(2);
  const targets = slugArg ? [{ slug: slugArg, source: sourceArg || slugArg }] : SOURCES;

  let total = 0;
  for (const { slug, source } of targets) {
    total += await loadSource(slug, source);
  }
  await markClosedLots();
  console.log(`--- ${total} auction rows loaded ---`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
