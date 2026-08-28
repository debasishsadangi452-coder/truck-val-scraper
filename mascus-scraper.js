#!/usr/bin/env node
// Scrapes European used-truck DEALER listings from mascus.com by running a
// ready-made Apify actor.
//
// Why Apify: mascus.com answers a plain request with 403 (documented in
// lib/blocked-source.js's family of blocked sources, and re-confirmed 2026-08).
// Apify's actors run behind their own proxy pool and get through. Note that
// Apify PROXY is not usable directly on this account — proxy.apify.com returns
// 403 for every group — so running an ACTOR is the only route that works.
//
// Why this writes to truck_listings and NOT auction_listings: despite Mascus
// being reachable via the same Apify path as the auction sources, it is a
// DEALER marketplace, not an auction house. Every item in a 25-item live sample
// came back with es_subasta (is_auction) = false, carrying an asking price and
// no bid/lot/close-date. Those are exactly truck_listings rows, and filing them
// as auctions would corrupt the "current bid" semantics of that table. The
// actor does expose an `enlace_subasta` (auction link) field, so if Mascus ever
// starts returning true auction rows they can be split out then.
//
// COST: the Apify plan is FREE ($5/month of credits), so this is opt-in and
// never part of weekly-refresh.js. --max-items defaults low on purpose.
//
// Usage (APIFY_TOKEN must be set in .env):
//   node mascus-scraper.js --max-items 200
//   node mascus-scraper.js --max-items 500 --priority-only
//
// Then load with:  node load-listings.js mascus-trucks mascus

import { normaliseRecord, loadExisting, writeOutputs, IMAGE_URL_SEPARATOR } from "./lib/scrape-core.js";
import { isPriorityModel } from "./lib/auction-core.js";

try {
  process.loadEnvFile();
} catch {
  // no .env file (e.g. on Railway, where env vars are injected directly)
}

const ACTOR = "rastriq~mascus-scraper";
const DEFAULT_SLUG = "mascus-trucks";

function parseArgs(argv) {
  const args = {
    maxItems: 100,
    maxPages: 3,
    priorityOnly: false,
    slug: DEFAULT_SLUG,
    timeout: 900,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-items") args.maxItems = Number(argv[++i]);
    else if (a === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (a === "--slug") args.slug = argv[++i];
    else if (a === "--timeout") args.timeout = Number(argv[++i]);
    else if (a === "--priority-only") args.priorityOnly = true;
  }
  return args;
}

// Start the run, then poll. We deliberately do NOT use run-sync-get-dataset-items
// here: a Mascus sweep runs for many minutes and the sync endpoint would hold a
// single HTTP connection open for the whole time (and time out). Polling also
// lets us read a partial dataset if the run is aborted or hits the credit limit.
async function startRun(token, input, timeoutSecs) {
  const res = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR}/runs?token=${encodeURIComponent(token)}&timeout=${timeoutSecs}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`Apify start failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  const data = JSON.parse(text).data;
  return { runId: data.id, datasetId: data.defaultDatasetId };
}

async function pollRun(runId, token, { intervalMs = 15000, maxWaitMs = 20 * 60 * 1000 } = {}) {
  const started = Date.now();
  for (;;) {
    const res = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
    const data = JSON.parse(await res.text()).data;
    if (data.status !== "RUNNING" && data.status !== "READY") return data.status;
    if (Date.now() - started > maxWaitMs) {
      // Don't leave a run burning credit after we've stopped waiting for it.
      await fetch(`https://api.apify.com/v2/actor-runs/${runId}/abort?token=${encodeURIComponent(token)}`, {
        method: "POST",
      });
      return "ABORTED_BY_SCRAPER";
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function fetchDataset(datasetId, token, limit) {
  const res = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&limit=${limit}`,
  );
  if (!res.ok) throw new Error(`dataset fetch failed: HTTP ${res.status}`);
  const data = JSON.parse(await res.text());
  return Array.isArray(data) ? data : [];
}

// The actor's `images` field is a JSON-encoded STRING, not an array (verified
// live) — parse it, but tolerate either shape in case the actor changes.
function parseImages(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

// "390000 km" -> "390000". Mascus reuses one `hours` column for both machine
// hours and road kilometres, so only take it when the unit says km — otherwise
// an excavator's hour count would be stored as a truck's mileage.
function kmFromUsage(value) {
  const s = String(value ?? "");
  if (!/km/i.test(s)) return "";
  return s.replace(/[^\d]/g, "");
}

function itemToRecord(item, scrapedAt) {
  const make = String(item.make ?? item.marca ?? "").trim();
  const model = String(item.model ?? item.modelo ?? "").trim();
  const images = parseImages(item.images);

  // Prefer the actor's normalised EUR figure so prices are comparable across
  // the GBP/EUR mix; fall back to the native price + its own currency.
  const eur = item.precio_eur;
  const price = eur ? String(eur).replace(/[^\d]/g, "") : String(item.price ?? "").replace(/[^\d]/g, "");
  const currency = eur ? "EUR" : item.currency || "";

  return normaliseRecord(
    {
      id: item.listing_id || item.item_id || "",
      url: item.url || "",
      title: [item.year, make, model].filter(Boolean).join(" "),
      make,
      model,
      year: String(item.year ?? "").replace(/[^\d]/g, "").slice(0, 4),
      mileage_km: kmFromUsage(item.hours),
      fuel_type: item.engine_type || "",
      engine_power_hp: String(item.engine_power ?? "").replace(/[^\d]/g, ""),
      gross_weight_kg: String(item.weight ?? "").replace(/[^\d]/g, ""),
      payload_kg: String(item.payload ?? "").replace(/[^\d]/g, ""),
      price_amount: price,
      price_currency: price ? currency : "",
      // `location` is often just "-" on this source; keep the country, which is
      // reliable, and don't invent a city from a placeholder.
      city: item.location && item.location !== "-" ? item.location : "",
      country_origin: item.country || "",
      region: item.country || "",
      seller_name: item.seller || "",
      vin: item.serial_number || "",
      thumbnail_url: images[0] || "",
      image_urls: images.join(IMAGE_URL_SEPARATOR),
      created_at: item.date_published || "",
    },
    scrapedAt,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    console.error("APIFY_TOKEN is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  const scrapedAt = new Date().toISOString();
  const byId = await loadExisting(args.slug);
  const startCount = byId.size;
  const counts = { added: 0, updated: 0, skipped: 0, notAuction: 0 };

  // Only the transport catalogue — the actor defaults every OTHER category
  // (construction/agriculture/forestry/...) to true, which would burn credit on
  // excavators and tractors we have no use for.
  const input = {
    cat_transport: true,
    cat_construction: false,
    cat_agriculture: false,
    cat_forestry: false,
    cat_material_handling: false,
    cat_groundcare: false,
    maxItems: args.maxItems,
    maxPages: args.maxPages,
    outputSchema: "english",
  };

  console.log(`--- mascus via Apify (${ACTOR}) -> slug=${args.slug} ---`);
  const { runId, datasetId } = await startRun(token, input, args.timeout);
  console.log(`  run ${runId} started (dataset ${datasetId}); polling...`);
  const status = await pollRun(runId, token);
  console.log(`  run finished: ${status}`);

  // Read the dataset even on a non-SUCCEEDED status — an aborted or
  // credit-limited run still leaves everything it managed to collect.
  const items = await fetchDataset(datasetId, token, args.maxItems);
  console.log(`  dataset returned ${items.length} items`);

  for (const item of items) {
    const rec = itemToRecord(item, scrapedAt);
    if (!rec.id || !rec.url) continue;
    if (args.priorityOnly && !isPriorityModel(rec.make, rec.model)) {
      counts.skipped++;
      continue;
    }
    const key = String(rec.id);
    if (byId.has(key)) counts.updated++;
    else counts.added++;
    byId.set(key, rec);
  }

  await writeOutputs(args.slug, byId);
  console.log(
    `--- ${args.slug}: ${counts.added} new, ${counts.updated} refreshed` +
      `${args.priorityOnly ? `, ${counts.skipped} non-priority skipped` : ""}` +
      `, ${byId.size} total (was ${startCount}) ---`,
  );
  console.log(`Next: node load-listings.js ${args.slug} mascus`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
