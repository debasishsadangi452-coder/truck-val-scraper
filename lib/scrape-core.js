// Shared scraper core for the multi-source truck crawlers.
//
// Every source scraper (autoline, truck7, ...) is the same shape as the
// original otomoto-trucks-scraper.js:
//   fetch list pages → build base records → (optionally) enrich from detail
//   pages → upsert by id into a deduped Map → rewrite listings.{json,csv}.
// The DB loader (scripts/db/load-listings.js) then upserts that JSON into
// truck_listings on (source, source_id), so re-running never duplicates.
//
// This module factors out everything that isn't source-specific: fetching
// with retries, jittered polite delays, bounded-parallel detail fetches,
// the dedup Map, and JSON/CSV writing. A source scraper just supplies its
// own list-page URLs and its own record parser(s) and calls runScrape().
//
// FIELDNAMES here is the canonical superset every record is normalised to —
// it matches load-listings.js's COLUMNS (minus the source/source_id it adds)
// so a record from any source loads through the same path. A source that
// doesn't populate a field leaves it "" (empty), which the loader maps to
// NULL. No dependencies beyond Node's built-in fetch (Node 18+).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Standalone package layout: lib/ sits under the package root, output/ beside it.
export const OUTPUT_ROOT = path.join(__dirname, "..", "output");

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Canonical record shape — the union of columns across all sources, kept in
// the same order as scripts-output CSVs. Mirrors load-listings.js COLUMNS
// (which prepends source/source_id). A blank field ("") becomes NULL on load.
export const FIELDNAMES = [
  "id",
  "url",
  "title",
  "make",
  "model",
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
  "created_at",
  "scraped_at",
];

// Detail-page photo URLs join with this when flattened into the CSV/JSON
// record; the DB loader splits back into a Postgres TEXT[] on load. Must match
// IMAGE_URL_SEPARATOR in load-listings.js.
export const IMAGE_URL_SEPARATOR = "|";

// Fill any missing canonical fields with "" so every emitted record has the
// same shape regardless of which source produced it (keeps the CSV columns
// aligned and the loader's `record.field || null` mapping predictable).
export function normaliseRecord(partial, scrapedAt) {
  const rec = {};
  for (const f of FIELDNAMES) rec[f] = partial[f] ?? "";
  rec.scraped_at = scrapedAt;
  return rec;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomDelay([min, max]) {
  return sleep(min + Math.random() * (max - min));
}

// Runs `worker(item)` over `items` with at most `limit` in flight at once —
// bounded parallelism. A fixed pool of workers each pull the next index from a
// shared cursor, so slow requests don't stall the others. Results are collected
// in input order. Used to fetch several detail pages concurrently per list page.
export async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

// Fetch text with retries + exponential backoff. `headers` are merged over the
// defaults so a source can add e.g. Accept-Language. Returns null after all
// retries fail so the caller can stop that query cleanly rather than crash.
export async function fetchText(url, { retries = 3, headers = {} } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "en-US,en;q=0.9",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...headers,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      console.warn(`  attempt ${attempt}/${retries} failed for ${url}: ${err.message}`);
      if (attempt < retries) await sleep(2000 * attempt);
    }
  }
  return null;
}

// Fetch that also captures Set-Cookie into `jar` (a Map name->value) and sends
// the jar back on the request — a minimal cookie session, enough for sites that
// gate stateful endpoints (e.g. Livewire) on a session + CSRF cookie. Returns
// { text, status } so callers can branch on non-OK without a throw.
export async function fetchWithCookies(url, jar, { method = "GET", headers = {}, body } = {}) {
  const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(url, {
    method,
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...headers,
    },
    body,
  });
  // Node's fetch exposes multiple Set-Cookie via getSetCookie().
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const sc of setCookies) {
    const [pair] = sc.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  const text = await res.text();
  return { text, status: res.status };
}

function csvEscape(value) {
  const str = String(value ?? "");
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// listings.json / listings.csv live under scripts-output/<slug>/, one folder
// per source — parallel to the otomoto-trucks folder.
export function outputDir(slug) {
  return path.join(OUTPUT_ROOT, slug);
}

export async function loadExisting(slug) {
  const jsonFile = path.join(outputDir(slug), "listings.json");
  if (!existsSync(jsonFile)) return new Map();
  try {
    const records = JSON.parse(await readFile(jsonFile, "utf8"));
    return new Map(records.map((r) => [String(r.id), r]));
  } catch {
    return new Map();
  }
}

export async function writeOutputs(slug, byId) {
  const dir = outputDir(slug);
  await mkdir(dir, { recursive: true });
  const records = [...byId.values()];
  await writeFile(path.join(dir, "listings.json"), JSON.stringify(records, null, 2));

  const lines = [FIELDNAMES.join(",")];
  for (const rec of records) {
    lines.push(FIELDNAMES.map((f) => csvEscape(rec[f])).join(","));
  }
  await writeFile(path.join(dir, "listings.csv"), lines.join("\n") + "\n");
}

// The generic crawl driver shared by every source scraper.
//
// A source supplies a `source` config object:
//   slug         folder name under scripts-output/ (also the DB `source`)
//   listPages    async function*(args) yielding one job per list page. Each
//                job is { records: [baseRecord,...], done?: boolean }. `done`
//                lets a source signal "last page" without knowing totals.
//   details      (optional) async (record) => void — enrich a base record from
//                its detail page in place. Only called when args.details.
//   detailDelay  [min,max] ms jitter between detail fetches (default below).
//   pageDelay    [min,max] ms jitter between list pages (default below).
//
// Records must already be normalised (use normaliseRecord). Dedup + output +
// counts are handled here identically to otomoto's runScrape.
export async function runScrape(source, args) {
  const {
    slug,
    listPages,
    details,
    detailDelay = [1000, 2000],
    pageDelay = [1500, 3000],
    concurrency = 4,
    // Stop when a page contributes zero not-yet-seen ids this run. Safe for
    // sources that clamp beyond-last-page requests back to the last real page
    // (e.g. autoline) — those repeat pages dedup to empty and end the crawl.
    // Leave false for sources whose pages can legitimately be all-repeats
    // mid-crawl (none currently).
    stopOnEmptyPage = false,
  } = source;

  const byId = await loadExisting(slug);
  const startCount = byId.size;
  const processedInRun = new Set();
  const counts = { added: 0, updated: 0 };

  for await (const job of listPages(args)) {
    // Skip anything already handled earlier in THIS run (pagination can drift
    // as new ads land on page 1), without blacklisting ids across runs.
    const fresh = job.records.filter((r) => {
      const key = String(r.id);
      if (processedInRun.has(key)) return false;
      processedInRun.add(key);
      return true;
    });
    console.log(`  ${job.records.length} on page (${fresh.length} new this run)`);

    if (stopOnEmptyPage && job.records.length > 0 && fresh.length === 0) {
      console.log("  page repeated known listings — end of results.");
      break;
    }

    if (details && args.details !== false) {
      await mapPool(fresh, concurrency, async (record) => {
        try {
          await details(record);
        } catch (err) {
          console.warn(`  detail failed for ${record.url}: ${err.message}`);
        }
        await randomDelay(detailDelay);
      });
    }

    for (const record of fresh) {
      const key = String(record.id);
      if (byId.has(key)) counts.updated++;
      else counts.added++;
      byId.set(key, record);
    }

    if (job.done) {
      console.log("  reached last page.");
      break;
    }
    await randomDelay(pageDelay);
  }

  await writeOutputs(slug, byId);
  console.log(
    `--- ${slug}: ${counts.added} new, ${counts.updated} refreshed, ${byId.size} total (was ${startCount}) ---`,
  );
  return counts;
}
