#!/usr/bin/env node
// Scrapes truck listings from autovit.ro (Romania) — plain HTTP, no browser.
//
// autovit.ro is an OLX Group site built on the SAME stack as otomoto.pl: each
// list page embeds the full result set as a GraphQL/urql cache inside the
// __NEXT_DATA__ script (props.pageProps.urqlState → advertSearch.edges). Every
// edge.node carries the core fields as parameters (make, model, year, mileage,
// engine_capacity, engine_power, fuel_type) plus price + location — so the
// list-page payload alone covers everything; no detail fetch needed.
//
// Pagination is ?page=N. source id = node.id. Category path: /camioane (trucks).
// Writes output/autovit-trucks/listings.json; load with:
//   node load-listings.js autovit-trucks autovit
//
// Usage:
//   node autovit-scraper.js
//   node autovit-scraper.js --max-pages 40
//   node autovit-scraper.js --category autoutilitare   # vans instead of trucks

import { fetchText, normaliseRecord, runScrape } from "./lib/scrape-core.js";

const SLUG = "autovit-trucks";
const BASE = "https://www.autovit.ro";

function parseArgs(argv) {
  const args = { maxPages: 50, category: "camioane" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (a === "--category") args.category = argv[++i];
  }
  return args;
}

// Pull advertSearch out of the __NEXT_DATA__ urql cache (same shape as otomoto).
function extractAdvertSearch(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const urqlState = data?.props?.pageProps?.urqlState;
  if (!urqlState) return null;
  for (const key of Object.keys(urqlState)) {
    const raw = urqlState[key]?.data;
    if (typeof raw !== "string") continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.advertSearch) return parsed.advertSearch;
    } catch {
      /* skip a partial/throttled entry */
    }
  }
  return null;
}

function paramValue(parameters, key) {
  return parameters?.find((p) => p.key === key)?.value ?? "";
}

function toRecord(edge, scrapedAt) {
  const node = edge.node;
  const params = node.parameters;
  const make = paramValue(params, "make");
  return normaliseRecord(
    {
      id: node.id,
      url: node.url,
      title: node.title,
      // parameters carry a URL-slug make ("mercedes-benz"); Title-case it lightly
      // for display, leaving hyphens (mercedes-benz stays recognizable).
      make: make ? make.charAt(0).toUpperCase() + make.slice(1) : "Unknown",
      model: paramValue(params, "model"),
      year: paramValue(params, "year"),
      mileage_km: paramValue(params, "mileage"),
      fuel_type: paramValue(params, "fuel_type"),
      engine_capacity_cc: paramValue(params, "engine_capacity"),
      engine_power_hp: paramValue(params, "engine_power"),
      price_amount: node.price?.amount?.value ?? "",
      price_currency: node.price?.amount?.currencyCode ?? "",
      city: node.location?.city?.name ?? "",
      // autovit exposes a Romanian județ, but the map only has country centroids,
      // so use "Romania" for region (plots on the Romania centroid) and keep the
      // finer județ nowhere-needed. City is preserved above.
      region: "Romania",
      country_origin: "Romania",
      seller_name: node.sellerLink?.name ?? "",
      thumbnail_url: node.thumbnail?.x1 ?? "",
      created_at: node.createdAt ?? "",
    },
    scrapedAt,
  );
}

async function* listPages(args) {
  const scrapedAt = new Date().toISOString();
  for (let page = 1; page <= args.maxPages; page++) {
    const url = `${BASE}/${args.category}${page > 1 ? `?page=${page}` : ""}`;
    console.log(`fetching page ${page}: ${url}`);
    const html = await fetchText(url, {
      headers: { "Accept-Language": "ro-RO,ro;q=0.9,en;q=0.8" },
    });
    if (!html) {
      yield { records: [], done: true };
      return;
    }
    const search = extractAdvertSearch(html);
    const edges = search?.edges ?? [];
    if (edges.length === 0) {
      yield { records: [], done: true };
      return;
    }
    yield { records: edges.map((e) => toRecord(e, scrapedAt)) };
  }
}

const source = { slug: SLUG, listPages, pageDelay: [1500, 3000], stopOnEmptyPage: true };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`--- autovit.ro scrape: category=${args.category}, max ${args.maxPages} pages ---`);
  await runScrape(source, args);
  console.log(`Next: node load-listings.js ${SLUG} autovit`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
