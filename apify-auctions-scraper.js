#!/usr/bin/env node
// Scrapes European truck auction lots from sites that CANNOT be reached with
// plain HTTP, by running a ready-made Apify actor and reshaping its dataset
// into our canonical auction record.
//
// Why Apify at all: rbauction.com, basworld, openlane.eu, plc.auction and
// euroauctions' backend all answer a plain request with 403 (Cloudflare or a JS
// challenge) — see lib/blocked-source.js for the same situation on the dealer
// sites. Apify's actors run behind their own proxy pool and get through.
//
// IMPORTANT — this account's limits (probed 2026-08):
//   * The plan is FREE: $5 of credits a month. Every run costs real credit, so
//     this scraper is NEVER part of the default weekly refresh — it is opt-in,
//     and --max-items defaults low on purpose.
//   * Apify PROXY is not usable directly from our own code: proxy.apify.com
//     returns "403 x-apify-proxy-error" for every group on this plan. Running
//     ACTORS is the only route that works, which is why this talks to the actor
//     API rather than just proxying our own tbauctions-style fetches.
//
// The actor is asked for `outputSchema: "english"`; without it the dataset comes
// back with Spanish field names (marca/modelo/anio/…), which is a deliberate
// quirk of that actor. We defensively read BOTH spellings anyway so a change in
// the actor's default doesn't silently empty every column.
//
// Usage (APIFY_TOKEN must be set in .env):
//   node apify-auctions-scraper.js --source rbauction --max-items 50
//   node apify-auctions-scraper.js --source rbauction --make DAF --year-from 2016
//   node apify-auctions-scraper.js --source rbauction --priority-only --max-items 200
//   node apify-auctions-scraper.js --source rbauction --dry-run    # cost check, no items
//
// Then load with:  node load-auctions.js <slug> <source>

import {
  normaliseAuctionRecord,
  loadExistingAuctions,
  writeAuctionOutputs,
  isPriorityModel,
  PRIORITY_MODELS,
  IMAGE_URL_SEPARATOR,
} from "./lib/auction-core.js";

try {
  process.loadEnvFile();
} catch {
  // no .env file (e.g. on Railway, where env vars are injected directly)
}

// Each entry maps one blocked auction site to the Apify actor that can reach it.
// `input` is the actor-specific base input; buildInput() layers the CLI filters
// on top. Add a site here once an actor for it is verified working.
const SOURCES = {
  rbauction: {
    actor: "rastriq~rbauction-scraper",
    source: "rbauction",
    slug: "rbauction-trucks",
    input: {
      runPreset: "custom",
      country: "EUR", // Europe-wide; the business does not buy US/CAN lots
      listingStatuses: ["Open"],
      outputSchema: "english",
      fetchDetails: false, // detail passes multiply the per-item cost
    },
  },
};

function parseArgs(argv) {
  const args = {
    source: "rbauction",
    maxItems: 50,
    maxPages: 2,
    make: null,
    model: null,
    yearFrom: null,
    yearTo: null,
    priorityOnly: false,
    slug: null,
    dryRun: false,
    timeout: 600,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") args.source = argv[++i];
    else if (a === "--max-items") args.maxItems = Number(argv[++i]);
    else if (a === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (a === "--make") args.make = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--year-from") args.yearFrom = Number(argv[++i]);
    else if (a === "--year-to") args.yearTo = Number(argv[++i]);
    else if (a === "--slug") args.slug = argv[++i];
    else if (a === "--timeout") args.timeout = Number(argv[++i]);
    else if (a === "--priority-only") args.priorityOnly = true;
    else if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

function buildInput(config, args, make) {
  const input = { ...config.input, maxItems: args.maxItems, maxPages: args.maxPages };
  if (make) input.manufacturerName = make;
  if (args.model) input.modelName = args.model;
  if (args.yearFrom) input.manufactureYearRange_min = args.yearFrom;
  if (args.yearTo) input.manufactureYearRange_max = args.yearTo;
  if (args.dryRun) input.dryRun = true;
  return input;
}

// Run the actor and wait for its dataset. run-sync-get-dataset-items blocks
// until the run finishes and returns the items directly, so there's no polling
// loop to babysit. `timeout` caps the actor run itself, which matters on a
// metered plan — a runaway run would otherwise burn credit until the platform
// limit stops it.
async function runActor(actor, token, input, timeoutSecs) {
  const url =
    `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(token)}&timeout=${timeoutSecs}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Apify actor ${actor} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Apify returned non-JSON: ${text.slice(0, 200)}`);
  }
  return Array.isArray(data) ? data : [];
}

// The actor emits english field names with outputSchema:"english", Spanish ones
// otherwise. Read both so either shape loads.
function pick(item, english, spanish) {
  const v = item[english] ?? item[spanish];
  return v == null ? "" : v;
}

// "13268.0 h" / "220 300 km" -> digits only. Returns "" when there's no number,
// so the loader stores NULL rather than 0 (0 km would read as a brand-new truck).
function digitsOnly(value) {
  const d = String(value ?? "").replace(/[^\d]/g, "");
  return d || "";
}

function itemToRecord(item, source, scrapedAt) {
  const make = String(pick(item, "make", "marca")).trim();
  const model = String(pick(item, "model", "modelo")).trim();
  const images = Array.isArray(item.images || item.imagenes) ? item.images || item.imagenes : [];

  // The actor exposes several money fields depending on the lot's state; the
  // live/starting ask is `price`, and a closed lot also carries a sold price.
  const bid = pick(item, "price", "valor");
  const sold = item.ext_gql_sold_price ?? item.ext_detail_sold_price ?? "";

  // Location arrives as one "Zevenbergen, NRDB" string — city before the comma.
  const location = String(pick(item, "location", "ubicacion")).trim();
  const city = location.split(",")[0].trim();

  // `hours` is machine-hours for plant; on road trucks the same column carries
  // kilometres. Only treat it as mileage when the unit says so.
  const usage = String(pick(item, "hours", "tiempo_uso"));
  const mileage = /km/i.test(usage) ? digitsOnly(usage) : "";

  return normaliseAuctionRecord(
    {
      id: pick(item, "listing_id", "ref_anuncio") || item.item_id || "",
      url: item.url || "",
      title: item.ext_asset_description || `${make} ${model}`.trim(),
      make,
      model,
      year: digitsOnly(pick(item, "year", "anio")).slice(0, 4),
      vin: pick(item, "serial_number", "num_serie"),
      mileage_km: mileage,
      engine_power_hp: digitsOnly(pick(item, "engine_power", "pot_motor")),
      fuel_type: pick(item, "engine_type", "tipo_motor"),
      category: pick(item, "category", "categoria"),
      current_bid_amount: bid === "" ? "" : digitsOnly(bid),
      currency: pick(item, "currency", "moneda"),
      bids_count: item.ext_gql_bid_count ?? "",
      sold_price_amount: sold === "" ? "" : digitsOnly(sold),
      bidding_status: item.ext_listing_status || "",
      auction_end_at: item.ext_bidding_end || "",
      auction_id: item.ext_sale_event_id || "",
      auction_name: item.ext_sale_event_name || "",
      lot_number: item.ext_lot_number ?? item.ext_item_number ?? "",
      city,
      region: location,
      country_code: String(item.country || item.pais || "").toUpperCase(),
      seller_name: pick(item, "seller", "compania"),
      thumbnail_url: images[0] || "",
      image_urls: images.join(IMAGE_URL_SEPARATOR),
    },
    scrapedAt,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = SOURCES[args.source];
  if (!config) {
    console.error(`Unknown --source "${args.source}". Use: ${Object.keys(SOURCES).join(", ")}`);
    process.exit(1);
  }
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    console.error("APIFY_TOKEN is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  const slug = args.slug || config.slug;
  const scrapedAt = new Date().toISOString();
  const byId = await loadExistingAuctions(slug);
  const startCount = byId.size;
  const counts = { added: 0, updated: 0, skipped: 0 };

  // With --priority-only, ask the actor for each priority make separately rather
  // than pulling the whole European catalogue and discarding most of it — on a
  // metered plan the filtering has to happen server-side to be worth running.
  const makes = args.make
    ? [args.make]
    : args.priorityOnly
      ? PRIORITY_MODELS.map((p) => p.make.toUpperCase())
      : [null];

  console.log(`--- ${config.source} via Apify (${config.actor}) -> slug=${slug} ---`);
  if (args.dryRun) console.log("  DRY RUN — counting only, no items stored.");

  for (const make of makes) {
    const input = buildInput(config, args, make);
    console.log(`  running actor${make ? ` for make=${make}` : ""} (maxItems=${args.maxItems})...`);
    let items;
    try {
      items = await runActor(config.actor, token, input, args.timeout);
    } catch (err) {
      // One make failing (or the credit running out mid-sweep) must not throw
      // away the makes already collected — report and keep going.
      console.warn(`  actor run failed${make ? ` for ${make}` : ""}: ${err.message}`);
      continue;
    }
    console.log(`  actor returned ${items.length} items`);

    for (const item of items) {
      const rec = itemToRecord(item, config.source, scrapedAt);
      if (!rec.id || !rec.url) continue; // dry runs emit summary rows with neither
      if (args.priorityOnly && !isPriorityModel(rec.make, rec.model)) {
        counts.skipped++;
        continue;
      }
      const key = String(rec.id);
      if (byId.has(key)) counts.updated++;
      else counts.added++;
      byId.set(key, rec);
    }
  }

  if (args.dryRun) {
    console.log("--- dry run complete, nothing written ---");
    return;
  }

  await writeAuctionOutputs(slug, byId);
  console.log(
    `--- ${slug}: ${counts.added} new, ${counts.updated} refreshed` +
      `${args.priorityOnly ? `, ${counts.skipped} non-priority skipped` : ""}` +
      `, ${byId.size} total (was ${startCount}) ---`,
  );
  console.log(`Next: node load-auctions.js ${slug} ${config.source}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
