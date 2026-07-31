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

// Geocode a free-text place query via Nominatim. Cached so each distinct query
// string is only hit once (respecting the rate limit even across passes).
async function geocodeQuery(q) {
  if (geoCache.has(q)) return geoCache.get(q);
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
  geoCache.set(q, result);
  return result;
}

function geocode(city, region) {
  return geocodeQuery(region ? `${city}, ${region}` : city);
}

// Pass 1: rows that HAVE a city → geocode "city, region" (precise).
async function passCity() {
  const { rows } = await pool.query(
    `SELECT city, region, count(*)::int AS n
       FROM truck_listings
      WHERE latitude IS NULL
        AND city IS NOT NULL
        AND btrim(city) <> ''
      GROUP BY city, region
      ORDER BY n DESC`,
  );
  console.log(
    `\n[pass 1 · city] ${rows.length} distinct city/region pairs ` +
      `(${rows.reduce((s, c) => s + c.n, 0)} rows).`,
  );

  let done = 0,
    updated = 0,
    failed = 0;
  for (const { city, region, n } of rows) {
    done += 1;
    const coords = await geocode(city, region);
    const label = `${city}${region ? ", " + region : ""}`;
    if (!coords) {
      failed += 1;
      console.log(`  [${done}/${rows.length}] ✗ "${label}" — no match (${n} rows)`);
      await sleep(RATE_LIMIT_MS);
      continue;
    }
    const [lat, lng] = coords;
    const whereRegion = region ? "AND region = $4" : "AND region IS NULL";
    const params = region ? [lat, lng, city, region] : [lat, lng, city];
    const { rowCount } = await pool.query(
      `UPDATE truck_listings SET latitude = $1, longitude = $2
        WHERE city = $3 ${whereRegion} AND latitude IS NULL`,
      params,
    );
    updated += rowCount;
    console.log(`  [${done}/${rows.length}] ✓ "${label}" → ${lat.toFixed(3)}, ${lng.toFixed(3)} (${rowCount} rows)`);
    await sleep(RATE_LIMIT_MS);
  }
  return { updated, failed, pairs: rows.length };
}

// Pass 2: rows with NO city but a region → geocode the region (approximate; the
// truck lands at the region's centre). Disambiguated by country_origin when
// present. This is what lifts the region-only sources off 0% on the map.
async function passRegion() {
  const { rows } = await pool.query(
    `SELECT region, country_origin, count(*)::int AS n
       FROM truck_listings
      WHERE latitude IS NULL
        AND (city IS NULL OR btrim(city) = '')
        AND region IS NOT NULL
        AND btrim(region) <> ''
      GROUP BY region, country_origin
      ORDER BY n DESC`,
  );
  console.log(
    `\n[pass 2 · region] ${rows.length} distinct region/country pairs ` +
      `(${rows.reduce((s, c) => s + c.n, 0)} rows).`,
  );

  let done = 0,
    updated = 0,
    failed = 0;
  for (const { region, country_origin, n } of rows) {
    done += 1;
    const country = country_origin && country_origin.trim();
    const q = country ? `${region}, ${country}` : region;
    const coords = await geocodeQuery(q);
    if (!coords) {
      failed += 1;
      console.log(`  [${done}/${rows.length}] ✗ "${q}" — no match (${n} rows)`);
      await sleep(RATE_LIMIT_MS);
      continue;
    }
    const [lat, lng] = coords;
    const whereCountry = country ? "AND country_origin = $4" : "AND country_origin IS NULL";
    const params = country ? [lat, lng, region, country_origin] : [lat, lng, region];
    const { rowCount } = await pool.query(
      `UPDATE truck_listings SET latitude = $1, longitude = $2
        WHERE region = $3 ${whereCountry}
          AND (city IS NULL OR btrim(city) = '')
          AND latitude IS NULL`,
      params,
    );
    updated += rowCount;
    console.log(`  [${done}/${rows.length}] ✓ "${q}" → ${lat.toFixed(3)}, ${lng.toFixed(3)} (${rowCount} rows)`);
    await sleep(RATE_LIMIT_MS);
  }
  return { updated, failed, pairs: rows.length };
}

async function main() {
  const before = await pool.query("SELECT count(latitude)::int c, count(*)::int t FROM truck_listings");
  console.log(`[geocode] starting — ${before.rows[0].c}/${before.rows[0].t} rows already have coords.`);

  const p1 = await passCity();
  const p2 = await passRegion();

  const after = await pool.query("SELECT count(latitude)::int c, count(*)::int t FROM truck_listings");
  console.log(
    `\n[geocode] complete.` +
      `\n  pass 1 (city):   +${p1.updated} rows (${p1.pairs} places, ${p1.failed} unresolved)` +
      `\n  pass 2 (region): +${p2.updated} rows (${p2.pairs} places, ${p2.failed} unresolved)` +
      `\n  coords now: ${after.rows[0].c}/${after.rows[0].t} ` +
      `(${(after.rows[0].t - after.rows[0].c)} still missing — rows with no city/region text).`,
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
