#!/usr/bin/env node
// Scrapes commercial-vehicle AUCTION lots from Euro Auctions.
//
// Two-stage, because the two halves of this site block differently:
//
//  1. DISCOVERY is free. www.euroauctions.com serves its auction list as plain
//     HTML containing every live sale's backend link
//     (`Search.do?auctionId=NNNN`). A normal fetch gets these — no Apify needed,
//     so the auction list costs nothing.
//
//  2. THE CATALOGUE needs Apify. Those links point at euroauctionslive.com,
//     which answers a direct request with Cloudflare 403 (re-verified 2026-08).
//     Running `apify/website-content-crawler` with a real browser + Apify proxy
//     returns the page with HTTP 200, so the lot pages are fetched through it.
//     Apify Proxy is NOT usable directly on this plan (proxy.apify.com 403s on
//     every group) — running the actor is the only route that works.
//
// Lot parsing keys off the hidden `<form name="BidForm">` every lot card
// carries: it holds itemId / lotTitle / lotDescription (which includes the VIN
// and registration) as clean attribute values, which is far more stable than
// scraping the surrounding presentation markup. Location, status, bid count and
// start bid are read from the card immediately preceding each form.
//
// CATEGORY FILTERING IS WHAT MAKES THIS SOURCE WORTH RUNNING. Euro Auctions is
// primarily a CONSTRUCTION PLANT auctioneer, and its "Commercial Vehicles"
// bucket is mostly panel vans and passenger cars — an unfiltered crawl returned
// 98 lots of which ONE matched the priority list. The backend accepts a
// server-side `categoryName=` filter (verified live: "Tractor Units" cut a
// 100-lot page to the 6 real tractor units on it, 3 of them priority DAF CFs),
// so we filter BEFORE paying to fetch. Use the site's own menu labels; the
// numeric codes in its JS map (`categoryId=0548`) are silently ignored.
//
// COST: the Apify plan is FREE ($5/month). Each catalogue page is ~0.4c, and one
// page is fetched per (auction x category x page), so --max-auctions/--max-pages
// are hard caps and default low.
//
// Usage (APIFY_TOKEN must be set in .env):
//   node euroauctions-scraper.js --max-auctions 3 --max-pages 2
//   node euroauctions-scraper.js --categories "Tractor Units"
//   node euroauctions-scraper.js --priority-only
//   node euroauctions-scraper.js --all-categories     # unfiltered (expensive, noisy)
//   node euroauctions-scraper.js --list-auctions      # free: just show the sales
//
// Then load with:  node load-auctions.js euroauctions-trucks euroauctions

import { pathToFileURL } from "node:url";
import { fetchText } from "./lib/scrape-core.js";
import {
  normaliseAuctionRecord,
  loadExistingAuctions,
  writeAuctionOutputs,
  isPriorityModel,
} from "./lib/auction-core.js";

try {
  process.loadEnvFile();
} catch {
  // no .env file (e.g. on Railway, where env vars are injected directly)
}

const SEARCH_PAGE = "https://www.euroauctions.com/en/equipment-search/commercial-vehicles";
const LIVE_BASE = "https://www.euroauctionslive.com";
const CRAWLER_ACTOR = "apify~website-content-crawler";
const PAGE_SIZE = 100; // lots per catalogue page

// Categories crawled by default, as the site's own menu labels (passed to the
// backend's `categoryName` filter). These are the heavy-vehicle classes the
// business sources; everything else Euro Auctions sells — excavators, buckets,
// hammers, ATVs, and the panel vans and passenger cars that dominate its
// "Commercial Vehicles" bucket — is never fetched, so we don't pay for it.
const DEFAULT_CATEGORIES = ["Tractor Units", "Tipper Trucks", "Curtainsider Trucks", "Box Trucks"];

function parseArgs(argv) {
  const args = {
    maxAuctions: 4,
    maxPages: 2,
    priorityOnly: false,
    allCategories: false,
    listOnly: false,
    categories: DEFAULT_CATEGORIES,
    slug: "euroauctions-trucks",
    timeout: 900,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-auctions") args.maxAuctions = Number(argv[++i]);
    else if (a === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (a === "--slug") args.slug = argv[++i];
    else if (a === "--timeout") args.timeout = Number(argv[++i]);
    else if (a === "--categories") args.categories = argv[++i].split(",").map((s) => s.trim());
    else if (a === "--priority-only") args.priorityOnly = true;
    else if (a === "--all-categories") args.allCategories = true;
    else if (a === "--list-auctions") args.listOnly = true;
  }
  // --all-categories means "don't filter server-side either": one unfiltered
  // request per auction page instead of one per category.
  if (args.allCategories) args.categories = [""];
  return args;
}

// ---- stage 1: discover live auctions (free, plain HTTP) ---------------------

async function discoverAuctions() {
  const html = await fetchText(SEARCH_PAGE);
  if (!html) throw new Error(`could not load ${SEARCH_PAGE}`);
  const ids = [...new Set([...html.matchAll(/Search\.do\?auctionId=(\d+)/g)].map((m) => m[1]))];
  return ids;
}

// ---- stage 2: fetch catalogue pages through Apify ---------------------------

async function crawlViaApify(urls, token, timeoutSecs) {
  const input = {
    startUrls: urls.map((url) => ({ url })),
    crawlerType: "playwright:firefox",
    maxCrawlPages: urls.length,
    maxCrawlDepth: 0,
    proxyConfiguration: { useApifyProxy: true },
    saveHtml: true,
    // The default transformer strips the page to readable prose, which throws
    // away the BidForm inputs we parse. "none" keeps the raw DOM.
    htmlTransformer: "none",
    dynamicContentWaitSecs: 20,
  };

  const startRes = await fetch(
    `https://api.apify.com/v2/acts/${CRAWLER_ACTOR}/runs?token=${encodeURIComponent(token)}&timeout=${timeoutSecs}&memory=4096`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const startText = await startRes.text();
  if (!startRes.ok) {
    throw new Error(`Apify start failed: HTTP ${startRes.status} ${startText.slice(0, 300)}`);
  }
  const run = JSON.parse(startText).data;
  console.log(`  apify run ${run.id} started; polling...`);

  // Poll rather than run-sync: a multi-page browser crawl runs for minutes, and
  // polling lets us read a partial dataset if the run is aborted or runs out of
  // credit mid-way.
  const started = Date.now();
  const maxWaitMs = (timeoutSecs + 120) * 1000;
  for (;;) {
    const res = await fetch(
      `https://api.apify.com/v2/actor-runs/${run.id}?token=${encodeURIComponent(token)}`,
    );
    const data = JSON.parse(await res.text()).data;
    if (data.status !== "RUNNING" && data.status !== "READY") {
      console.log(`  apify run finished: ${data.status}`);
      break;
    }
    if (Date.now() - started > maxWaitMs) {
      await fetch(
        `https://api.apify.com/v2/actor-runs/${run.id}/abort?token=${encodeURIComponent(token)}`,
        { method: "POST" },
      );
      console.warn("  apify run exceeded local wait budget — aborted.");
      break;
    }
    await new Promise((r) => setTimeout(r, 15000));
  }

  const itemsRes = await fetch(
    `https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?token=${encodeURIComponent(token)}&limit=${urls.length}`,
  );
  if (!itemsRes.ok) throw new Error(`dataset fetch failed: HTTP ${itemsRes.status}`);
  const items = JSON.parse(await itemsRes.text());
  return Array.isArray(items) ? items : [];
}

// ---- lot parsing ------------------------------------------------------------

function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function formValue(block, name) {
  const m = block.match(new RegExp(`name="${name}"\\s+value="([^"]*)"`));
  return m ? decodeEntities(m[1]) : "";
}

// Makes worth recognising in a lot title. Euro Auctions sells vans and cars
// alongside trucks, so this list stays broad — the priority filter, not this
// list, decides what the business cares about.
const MAKE_PATTERNS = [
  ["Mercedes-Benz", /\bmercedes(?:[-\s]?benz)?\b/i],
  ["Volkswagen", /\b(?:volkswagen|vw)\b/i],
  ["DAF", /\bdaf\b/i],
  ["Volvo", /\bvolvo\b/i],
  ["MAN", /\bman\b/i],
  ["Scania", /\bscania\b/i],
  ["Iveco", /\biveco\b/i],
  ["Renault", /\brenault\b/i],
  ["Ford", /\bford\b/i],
  ["Krone", /\bkrone\b/i],
  ["Wielton", /\bwielton\b/i],
  ["Kögel", /\bk(?:ö|oe|o)gel\b/i],
  ["Fliegl", /\bfliegl\b/i],
  ["Schmitz", /\bschmitz(?:\s?cargobull)?\b/i],
];

// Body/type words that describe the lot rather than the model.
const TITLE_NOISE =
  /\b(?:truck|trucks|lorry|tractor unit|van|vans|box van|beavertail|flat ?bed|tipper|curtainsider|cement mixer|plant|atv|utility vehicle|speed)\b/gi;

function parseTitle(title) {
  const t = String(title || "").trim();
  const year = (t.match(/\b(?:19[5-9]\d|20[0-4]\d)\b/) || [])[0] || "";
  let make = "";
  let idx = -1;
  let len = 0;
  for (const [canonical, re] of MAKE_PATTERNS) {
    const m = t.match(re);
    if (m && (idx === -1 || m.index < idx)) {
      make = canonical;
      idx = m.index;
      len = m[0].length;
    }
  }
  if (idx === -1) return { year, make: "", model: "" };
  const model = t
    .slice(idx + len)
    .replace(year ? new RegExp(`\\b${year}\\b`, "g") : /(?!)/g, " ")
    .replace(TITLE_NOISE, " ")
    .replace(/^[\s\-–—,:/]+/, "")
    .replace(/\s*[-–—/,:]+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return { year, make, model };
}

// A 17-character VIN at the end of the description, e.g.
// "… - BU15 YLG - VF1FW17BD51942751". Excludes I/O/Q per the VIN standard.
function extractVin(description) {
  const m = String(description || "").match(/\b([A-HJ-NPR-Z0-9]{17})\b/);
  return m ? m[1] : "";
}

// Commercial-vehicle-ish lots. Euro Auctions is mostly construction plant, so
// without this the table fills with excavator buckets and hammers. Deliberately
// generous — a lot naming a known make, or reading as a road vehicle, is kept.
const VEHICLE_HINT =
  /\b(truck|lorry|van|tractor unit|beavertail|box van|tipper|curtainsider|cement mixer|flat ?bed|sprinter|transit|crafter|luton|dropside|chassis cab|refuse|sweeper)\b/i;

function looksLikeVehicle(title, description, make) {
  if (make) return true;
  return VEHICLE_HINT.test(`${title} ${description}`);
}

/**
 * Split one catalogue page's HTML into auction lots.
 *
 * Each lot ends with a hidden <form name="BidForm"> holding its identity; the
 * card markup that precedes the form carries location, status and the bid line.
 * We therefore split ON the form and look BACK into the preceding chunk.
 */
export function parseLots(html, auctionId, category = "") {
  const chunks = html.split('<form name="BidForm"');
  const lots = [];
  for (let i = 1; i < chunks.length; i++) {
    const form = chunks[i];
    const card = chunks[i - 1];

    const itemId = formValue(form, "itemId");
    if (!itemId) continue;

    const title = formValue(form, "lotTitle");
    const description = formValue(form, "lotDescription");

    // "Start Bid: 500 GBP" / "Current Bid: 1,250 EUR" — the money line sits at
    // the end of the preceding card chunk.
    const bidMatch = card.match(
      /(?:Start Bid|Current Bid)\s*:?\s*<\/span>\s*<span[^>]*>\s*([\d.,]+)\s*([A-Z]{3})/i,
    );
    const bid = bidMatch ? bidMatch[1].replace(/[^\d]/g, "") : "";
    const currency = bidMatch ? bidMatch[2] : "";

    // The bid line reads either "No Bids" (nothing placed yet — the common case
    // before a sale opens) or "N Bid(s)". Both sit inside their own <span>, so
    // match the span's text rather than assuming a separate count element.
    const bidsMatch = card.match(/>\s*(?:(No)\s+Bids|(\d+)\s+Bids?)\s*</i);
    const bidsCount = bidsMatch ? (bidsMatch[1] ? "0" : bidsMatch[2]) : "";

    // "<strong>Location:</strong> Leeds , UK"
    const locMatch = card.match(/<strong>\s*Location:\s*<\/strong>\s*([^<]+)/i);
    const locRaw = locMatch ? decodeEntities(locMatch[1]).replace(/\s+,/g, ",").trim() : "";
    const [city, country] = locRaw.split(",").map((s) => s.trim());

    const statusMatch = card.match(/<strong>\s*Status:\s*<\/strong>\s*([^<]+)/i);
    const status = statusMatch ? decodeEntities(statusMatch[1]).trim() : "";

    const externalMatch = card.match(/externalId=(\d+)/);
    const externalId = externalMatch ? externalMatch[1] : "";

    lots.push({
      itemId,
      title,
      description,
      bid,
      currency,
      bidsCount,
      city: city || "",
      country: (country || "").toUpperCase(),
      status,
      externalId,
      auctionId,
      category,
    });
  }
  return lots;
}

function lotToRecord(lot, scrapedAt) {
  const parsed = parseTitle(lot.title || lot.description);
  const url = lot.externalId
    ? `${LIVE_BASE}/servlet/Search.do?auctionId=${lot.auctionId}&externalId=${lot.externalId}`
    : `${LIVE_BASE}/servlet/Search.do?auctionId=${lot.auctionId}&itemId=${lot.itemId}`;

  return normaliseAuctionRecord(
    {
      id: lot.itemId,
      url,
      title: lot.title || lot.description,
      make: parsed.make,
      model: parsed.model,
      year: parsed.year,
      vin: extractVin(lot.description),
      category: lot.category || "commercial-vehicles",
      current_bid_amount: lot.bid,
      currency: lot.currency,
      bids_count: lot.bidsCount,
      // Euro Auctions lots are live until the sale runs; the catalogue doesn't
      // publish a per-lot close time, so status is all we can honestly record.
      bidding_status: /on site|available/i.test(lot.status) ? "BIDDING_OPEN" : lot.status || "",
      auction_id: String(lot.auctionId),
      lot_number: lot.itemId,
      city: lot.city,
      country_code: lot.country,
      seller_name: "Euro Auctions",
    },
    scrapedAt,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("--- euroauctions ---");
  const auctionIds = await discoverAuctions();
  console.log(`  discovered ${auctionIds.length} live auction(s): ${auctionIds.join(", ")}`);
  if (args.listOnly) return;

  const token = process.env.APIFY_TOKEN;
  if (!token) {
    console.error("APIFY_TOKEN is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  // Build the page URLs up front so the whole crawl is ONE Apify run — each run
  // has a fixed start-up cost, so batching is cheaper than a run per page.
  const urls = [];
  for (const id of auctionIds.slice(0, args.maxAuctions)) {
    for (const category of args.categories) {
      for (let page = 1; page <= args.maxPages; page++) {
        const params = [`auctionId=${id}`];
        // Server-side category filter. Verified live: `categoryName=Tractor+Units`
        // cuts a 100-lot catalogue page to the 6 real tractor units on it, so
        // filtering HERE (rather than after parsing) is what makes this source
        // affordable — we stop paying to crawl pages of excavator buckets.
        // The value is the human-readable category label from the site's own
        // menu, NOT the numeric code in its JS map: `categoryId=0548` is
        // silently ignored and returns the unfiltered page.
        if (category) params.push(`categoryName=${encodeURIComponent(category)}`);
        if (page > 1) params.push(`page=${page}`);
        urls.push(`${LIVE_BASE}/servlet/Search.do?${params.join("&")}`);
      }
    }
  }
  console.log(
    `  crawling ${urls.length} catalogue page(s) via Apify (~${(urls.length * 0.4).toFixed(1)}c)`,
  );

  const pages = await crawlViaApify(urls, token, args.timeout);
  console.log(`  apify returned ${pages.length} page(s)`);

  const scrapedAt = new Date().toISOString();
  const byId = await loadExistingAuctions(args.slug);
  const startCount = byId.size;
  const counts = { added: 0, updated: 0, skippedCategory: 0, skippedPriority: 0 };

  for (const page of pages) {
    const html = page.html || "";
    const idMatch = String(page.url || "").match(/auctionId=(\d+)/);
    const auctionId = idMatch ? idMatch[1] : "";
    const catMatch = String(page.url || "").match(/categoryName=([^&]*)/);
    const category = catMatch ? decodeURIComponent(catMatch[1].replace(/\+/g, " ")) : "";
    const lots = parseLots(html, auctionId, category);
    if (lots.length === 0) continue;

    let kept = 0;
    for (const lot of lots) {
      const rec = lotToRecord(lot, scrapedAt);
      // The server-side categoryName filter already guarantees the lot class,
      // so the title heuristic only runs on an unfiltered (--all-categories)
      // crawl. Applying it to a filtered page would wrongly drop real tractor
      // units whose titles are bare model codes ("EFR E10 325").
      if (args.allCategories && !looksLikeVehicle(lot.title, lot.description, rec.make)) {
        counts.skippedCategory++;
        continue;
      }
      if (args.priorityOnly && !isPriorityModel(rec.make, rec.model)) {
        counts.skippedPriority++;
        continue;
      }
      const key = String(rec.id);
      if (byId.has(key)) counts.updated++;
      else counts.added++;
      byId.set(key, rec);
      kept++;
    }
    console.log(`  auction ${auctionId}: ${lots.length} lots on page, ${kept} kept`);
  }

  await writeAuctionOutputs(args.slug, byId);
  console.log(
    `--- ${args.slug}: ${counts.added} new, ${counts.updated} refreshed, ` +
      `${counts.skippedCategory} non-vehicle skipped` +
      `${args.priorityOnly ? `, ${counts.skippedPriority} non-priority skipped` : ""}` +
      `, ${byId.size} total (was ${startCount}) ---`,
  );
  console.log(`Next: node load-auctions.js ${args.slug} euroauctions`);
}

// Only run when invoked as a script. parseLots/parseTitle are exported for
// tests, and importing this file must not kick off a (paid) Apify crawl.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
