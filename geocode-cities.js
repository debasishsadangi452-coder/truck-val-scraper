// One-time (idempotent, resumable) batch: give trucks REAL coordinates.
//
// Only ~256 of ~18k truck_listings have scraped latitude/longitude; the rest
// are NULL and get plotted on the map via region centroids. Radius / route
// search is meaningless on centroids, so this script geocodes each distinct
// `city` (with its `region` for disambiguation) via Nominatim (OpenStreetMap)
// and writes the resulting lat/lng onto every row for that city that is still
// missing coordinates.
//
// Nominatim usage policy is respected:
//   - at most 1 request/second (we sleep 1100ms between calls)
//   - a descriptive User-Agent identifying the app + a contact
// Results are cached in-memory per "city|region" so each is geocoded once.
//
// Idempotent: it only UPDATEs rows WHERE latitude IS NULL, so real scraped
// coordinates are never overwritten, and re-running only fills whatever is
// still missing (e.g. after a fresh scrape adds new cities). Safe to Ctrl-C
// and resume — completed cities already have coords and are skipped next run.
//
// Run from the scraper package:  node geocode-cities.js
// Requires DATABASE_URL in truckval-scraper/.env (cp ../.env .env if missing).
import { pool } from "./lib/db.js";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "TruckVal/1.0 (route-search geocoder; contact: pyl.ceo@gmail.com)";
const RATE_LIMIT_MS = 1100; // > 1s, honouring Nominatim's 1 req/sec policy

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cache by "city|region" so each distinct place is only hit once, even if it
// appears under several rows. Value: [lat, lng] or null (geocoding failed).
const geoCache = new Map();

async function geocode(city, region) {
  const key = `${city}|${region ?? ""}`;
  if (geoCache.has(key)) return geoCache.get(key);

  const q = region ? `${city}, ${region}` : city;
  const url = `${NOMINATIM}?format=json&limit=1&q=${encodeURIComponent(q)}`;
  let result = null;
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (res.ok) {
      const json = await res.json();
      if (Array.isArray(json) && json.length > 0) {
        const lat = Number(json[0].lat);
        const lng = Number(json[0].lon);
        if (Number.isFinite(lat) && Number.isFinite(lng)) result = [lat, lng];
      }
    } else {
      console.warn(`  ! Nominatim HTTP ${res.status} for "${q}"`);
    }
  } catch (err) {
    console.warn(`  ! geocode failed for "${q}": ${err.message}`);
  }
  geoCache.set(key, result);
  return result;
}

async function main() {
  console.log("[geocode] finding distinct cities with NULL coordinates…");
  // Distinct (city, region) pairs among rows that currently lack coordinates.
  // Ordered by how many rows they'd fill, so the biggest wins land first.
  const { rows: cities } = await pool.query(
    `SELECT city, region, count(*)::int AS n
       FROM truck_listings
      WHERE latitude IS NULL
        AND city IS NOT NULL
        AND btrim(city) <> ''
      GROUP BY city, region
      ORDER BY n DESC`,
  );

  console.log(
    `[geocode] ${cities.length} distinct city/region pairs to resolve ` +
      `(${cities.reduce((s, c) => s + c.n, 0)} rows still missing coords).`,
  );

  let done = 0;
  let updatedRows = 0;
  let failed = 0;

  for (const { city, region, n } of cities) {
    done += 1;
    const coords = await geocode(city, region);
    if (!coords) {
      failed += 1;
      console.log(`  [${done}/${cities.length}] ✗ "${city}${region ? ", " + region : ""}" — no match (${n} rows)`);
      await sleep(RATE_LIMIT_MS);
      continue;
    }
    const [lat, lng] = coords;
    // Only fill rows that are still NULL — preserves real scraped coords and
    // makes the whole script idempotent / safe to resume.
    const params = region
      ? [lat, lng, city, region]
      : [lat, lng, city];
    const whereRegion = region ? "AND region = $4" : "AND region IS NULL";
    const { rowCount } = await pool.query(
      `UPDATE truck_listings
          SET latitude = $1, longitude = $2
        WHERE city = $3 ${whereRegion}
          AND latitude IS NULL`,
      params,
    );
    updatedRows += rowCount;
    console.log(
      `  [${done}/${cities.length}] ✓ "${city}${region ? ", " + region : ""}" → ` +
        `${lat.toFixed(4)}, ${lng.toFixed(4)} (${rowCount} rows)`,
    );
    await sleep(RATE_LIMIT_MS);
  }

  console.log(
    `\n[geocode] complete. ${updatedRows} rows updated across ` +
      `${cities.length - failed} geocoded cities (${failed} unresolved).`,
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error("[geocode] fatal:", err);
  try {
    await pool.end();
  } catch {
    // ignore
  }
  process.exit(1);
});
