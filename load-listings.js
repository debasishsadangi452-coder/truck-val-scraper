#!/usr/bin/env node
// Loads a scraper's scripts-output/<slug>/listings.json into the truck_listings
// table (upsert on (source, source_id), so re-running after a fresh scrape just
// refreshes changed rows — never duplicates).
//
// Multi-source: each scraper writes its own folder under scripts-output/ and
// tags rows with its own `source`. This loader takes the folder slug and the
// DB source name; with no args it loads every known source in turn.
//
//   node scripts/db/load-listings.js                       # load all sources
//   node scripts/db/load-listings.js otomoto-trucks otomoto # one: <slug> [source]
//   node scripts/db/load-listings.js autoline-trucks autoline
//   node scripts/db/load-listings.js truck7-trucks truck7
//
// The (source, source_id) unique key keeps sources from colliding even if two
// sites reuse the same numeric ad id.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./lib/db.js";
import { normalizeModel } from "./lib/normalize-model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT = path.join(__dirname, "output");

// slug (output/ folder) → DB `source` tag. This standalone package handles the
// browser-based sources; add a line per scraper you add here.
const SOURCES = [
  { slug: "otomoto-trucks", source: "otomoto" },
  { slug: "otomoto-trailers", source: "otomoto" },
  { slug: "sauto-cz-trucks", source: "sauto_cz" },
  { slug: "autoplius-lt-trucks", source: "autoplius_lt" },
  { slug: "planet-trucks-trucks", source: "planet_trucks" },
  { slug: "mjaatrucks-lt-trucks", source: "mjaatrucks_lt" },
  { slug: "autoline-trucks", source: "autoline" },
  { slug: "truck7-trucks", source: "truck7" },
  { slug: "autoline-bg-trucks", source: "autoline_bg" },
  { slug: "autovit-trucks", source: "autovit" },
  { slug: "truckscout24-trucks", source: "truckscout24" },
  { slug: "truckstore-trucks", source: "truckstore" },
  { slug: "mobilebg-trucks", source: "mobilebg" },
  { slug: "truck1-trucks", source: "truck1" },
  { slug: "trucksnl-trucks", source: "trucksnl" },
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

// Condition flags arrive as source-native yes/no strings — otomoto uses Polish
// Tak/Nie; other sources may use Yes/No. Anything else stays unknown (NULL).
function toBool(value) {
  if (value === "Tak" || value === "Yes" || value === true) return true;
  if (value === "Nie" || value === "No" || value === false) return false;
  return null;
}

function toTimestamp(value) {
  return value || null;
}

function toTextArray(value) {
  if (!value) return null;
  const parts = value.split(IMAGE_URL_SEPARATOR).filter(Boolean);
  return parts.length > 0 ? parts : null;
}

function toRow(record, source) {
  return [
    source,
    record.id,
    record.url,
    record.title || null,
    // make is NOT NULL in the schema — never let a source's blank make abort the
    // whole batch; fall back to the title's first word, then a placeholder.
    record.make || (record.title || "").split(/\s+/)[0] || "Unknown",
    record.model || null,
    // Canonical model for grouping/matching (raw `model` kept verbatim above).
    normalizeModel(record.make || (record.title || "").split(/\s+/)[0] || "Unknown", record.model),
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
    toTimestamp(record.created_at),
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
    INSERT INTO truck_listings (${cols.join(", ")})
    VALUES ${valuesSql.join(", ")}
    ON CONFLICT (source, source_id) DO UPDATE SET
      ${updateSet},
      updated_at = now()
  `;
  return { sql, params };
}

async function loadSource({ slug, source }) {
  const jsonFile = path.join(OUTPUT_ROOT, slug, "listings.json");
  if (!existsSync(jsonFile)) {
    console.log(`skip ${source}: no file at ${jsonFile}`);
    return null; // null = source didn't run this pass (no output file)
  }
  const records = JSON.parse(await readFile(jsonFile, "utf8"));
  console.log(`loading ${records.length} record(s) for source="${source}" from ${slug}`);

  const BATCH_SIZE = 200;
  let loaded = 0;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE).map((r) => toRow(r, source));
    const { sql, params } = buildUpsertQuery(batch);
    await pool.query(sql, params);
    loaded += batch.length;
    console.log(`  upserted ${loaded}/${records.length}`);
  }
  return records.length;
}

// Persistent run history so the web app can show scraper statistics over time.
// Created on demand so the standalone scraper needs no separate migration step.
async function ensureRunTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scrape_runs (
      id           bigserial PRIMARY KEY,
      started_at   timestamptz NOT NULL,
      finished_at  timestamptz NOT NULL DEFAULT now(),
      duration_sec integer,
      per_source   jsonb NOT NULL,      -- { source: recordsUpserted, ... }
      total_upserted integer NOT NULL,  -- sum of records upserted this run
      table_total    integer NOT NULL   -- COUNT(*) of truck_listings after load
    )
  `);
}

async function recordRun({ startedAt, perSource, totalUpserted, tableTotal }) {
  try {
    await ensureRunTable();
    const durationSec = Math.round((Date.now() - startedAt.getTime()) / 1000);
    await pool.query(
      `INSERT INTO scrape_runs (started_at, duration_sec, per_source, total_upserted, table_total)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [startedAt, durationSec, JSON.stringify(perSource), totalUpserted, tableTotal],
    );
    console.log(`recorded run in scrape_runs (duration ${durationSec}s).`);
  } catch (err) {
    // Stats are non-critical: never fail a data load because logging the run failed.
    console.error(`[warn] could not record scrape_runs row: ${err.message}`);
  }
}

// The canonical-model column is additive; ensure it exists so a fresh DB (or one
// migrated before this feature) can accept the model_normalized upsert value.
async function ensureModelNormalizedColumn() {
  await pool.query(`ALTER TABLE truck_listings ADD COLUMN IF NOT EXISTS model_normalized TEXT`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_truck_listings_model_norm ON truck_listings (lower(make), model_normalized)`,
  );
}

async function main() {
  const startedAt = new Date();
  await ensureModelNormalizedColumn();
  const [slugArg, sourceArg] = process.argv.slice(2);
  // Explicit slug wins; otherwise load every registered source that has a file.
  const fullLoad = !slugArg;
  const targets = slugArg
    ? [{ slug: slugArg, source: sourceArg || slugArg.replace(/-trucks$/, "") }]
    : SOURCES;

  let total = 0;
  const perSource = {}; // source -> records upserted (only sources that produced output)
  for (const t of targets) {
    const n = await loadSource(t);
    if (n !== null) {
      total += n;
      perSource[t.source] = n;
    }
  }

  const { rows } = await pool.query("SELECT count(*)::int AS count FROM truck_listings");
  const tableTotal = rows[0].count;
  console.log(`done. loaded ${total} this run; table now has ${tableTotal} row(s).`);

  // Only the full weekly load (no slug arg) records a run — one-off manual loads
  // of a single source shouldn't clutter the history.
  if (fullLoad) {
    await recordRun({ startedAt, perSource, totalUpserted: total, tableTotal });
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
