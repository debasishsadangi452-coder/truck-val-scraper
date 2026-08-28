#!/usr/bin/env node
// Scrapes European truck/trailer AUCTION lots from the TBAuctions platform —
// plain HTTP, no browser.
//
// surplex.com and troostwijkauctions.com are the SAME Next.js application (same
// category UUIDs, same `lotsData.results` shape, 48 lots/page), so one scraper
// serves both; --platform picks which host to crawl.
//
// We do NOT parse the HTML. The page's data comes from Next.js's own JSON
// endpoint, which returns the lot list already structured:
//   /_next/data/<buildId>/en/c/<categoryPath>/<uuid>.json?page=N
// `buildId` changes on every deploy, so each run re-reads it from the category
// page's __NEXT_DATA__ before paging (a stale id 404s).
//
// Locale note: the `en` route is used deliberately. The `de` route 307-redirects
// to it, and English titles ("2015 DAF CF 440FT Truck") parse into make/model far
// more reliably than the German ones ("... Lkw"), which is what the priority-model
// filter matches on.
//
// Lot specs (Brand / Type / Year of build) come from the per-lot detail endpoint
// /_next/data/<buildId>/en/l/<urlSlug>.json -> pageProps.lot.attributes. Detail
// fetching is on by default because the list title alone often misses the year;
// pass --no-details to skip it for a fast sweep.
//
// Prices arrive in CENTS (currentBidAmount.cents) — divided by 100 on the way out.
//
// Usage:
//   node tbauctions-scraper.js --platform surplex --category trucks
//   node tbauctions-scraper.js --platform troostwijk --category trailers --priority-only
//   node tbauctions-scraper.js --platform surplex --category trucks --max-pages 3 --no-details
//
// Then load with:  node load-auctions.js <slug> <source>

import { fetchText, mapPool, randomDelay } from "./lib/scrape-core.js";
import {
  normaliseAuctionRecord,
  loadExistingAuctions,
  writeAuctionOutputs,
  isPriorityModel,
  epochToIso,
  IMAGE_URL_SEPARATOR,
} from "./lib/auction-core.js";

const PLATFORMS = {
  surplex: { host: "https://www.surplex.com", source: "surplex" },
  troostwijk: { host: "https://www.troostwijkauctions.com", source: "troostwijk" },
};

// Category UUIDs are shared across both platforms (same backing catalogue).
// `path` is the English URL segment the `en` locale serves them under.
const CATEGORIES = {
  trucks: {
    uuid: "fd5500c7-5590-42fb-8f0b-24fa8e6d95da",
    path: "transport-logistics/trucks-trailers",
  },
  trailers: {
    uuid: "f4e64a74-b4ba-4498-9e2d-e8ae1af496c0",
    path: "transport-logistics/trailers",
  },
};

const PAGE_SIZE = 48; // fixed by the platform's tba-fe-titan-page-sizes flag

function parseArgs(argv) {
  const args = {
    platform: "surplex",
    category: "trucks",
    maxPages: 20,
    details: true,
    priorityOnly: false,
    slug: null,
    concurrency: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--platform") args.platform = argv[++i];
    else if (a === "--category") args.category = argv[++i];
    else if (a === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (a === "--slug") args.slug = argv[++i];
    else if (a === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (a === "--no-details") args.details = false;
    else if (a === "--priority-only") args.priorityOnly = true;
  }
  return args;
}

// Makes we can recognise in a lot title. The canonical spelling on the left is
// what gets stored, so casing stays consistent across sources. "Mercedes-Benz"
// is listed before the bare-"Mercedes" case its own pattern already covers.
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
  ["Kässbohrer", /\bk(?:ä|ae|a)ssbohrer\b/i],
];

// Body/type words that describe the LOT, not the model. Stripped so the model
// string is just the chassis designation the normalizer expects ("XF 480"),
// which is what the priority-model prefixes match against.
const TITLE_NOISE =
  /\b(?:truck|trucks|lorry|lkw|semi[-\s]?trailer|trailers?|head\s+tractor\s+unitt?|tractor\s+unitt?|head|tow truck|breakdown truck|dump truck|tipper|container|curtainsider|refrigerated|box|flatbed|crane|truck[-\s]?mounted|hydraulic|three[-\s]axle|two[-\s]axle|axles?|with crane|with generator set)\b/gi;

// Some sellers (notably the Romanian lots) put a REGISTRATION PLATE where the
// model belongs: "DAF - Head Tractor unit TM10NUC - 2005". A plate is a solid
// letters+digits blob with no space, unlike every real designation we care about
// ("XF 480", "TGX 18.470", "CF 85.43", "F-MAX"), which carries a space, a dot or
// a hyphen. Dropping it leaves the model empty rather than wrong — the loader
// stores NULL and the lot simply doesn't match a priority model, which is
// correct, because from this title we genuinely cannot tell which model it is.
const PLATE = /^[A-Z]{2}\d{2}[A-Z]{3}$/;

/** Split a TBAuctions lot title into { year, make, model }. */
export function parseTitle(title) {
  const t = String(title || "").trim();
  const year = (t.match(/\b(?:19[5-9]\d|20[0-4]\d)\b/) || [])[0] || "";

  // First make mentioned wins — titles put the make before the model, and a
  // later token (e.g. a crane brand on a truck-mounted lot) must not override it.
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

  // Everything after the make is the model, minus the year (which can sit on
  // either side of the make: "MAN - 2008 - TGL 7.150") and minus body words.
  const model = t
    .slice(idx + len)
    .replace(year ? new RegExp(`\\b${year}\\b`, "g") : /(?!)/g, " ")
    .replace(TITLE_NOISE, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Drop registration plates token-by-token, so "CF 85.43 TM10NUC" keeps the
    // real model and "TM10NUC" alone collapses to "". Done BEFORE the separator
    // trim below, so removing a trailing plate doesn't strand its leading dash.
    .split(" ")
    .filter((tok) => !PLATE.test(tok))
    .join(" ")
    // Removing a plate can strand the separator that introduced it
    // ("CF 85.43 - TM10NUC" -> "CF 85.43 -"), so drop bare separator tokens too.
    .replace(/\s+[-–—/,:]+(?=\s|$)/g, "")
    .replace(/^[\s\-–—,:/]+/, "")
    .replace(/\s*[-–—/,:]+\s*$/, "")
    .trim();

  return { year, make, model };
}

// buildId is baked into the deployed page; re-read it every run because it
// changes on each deploy and a stale one makes every _next/data call 404.
async function fetchBuildId(host, category) {
  const url = `${host}/en/c/${category.path}/${category.uuid}`;
  const html = await fetchText(url);
  if (!html) throw new Error(`could not load ${url} to read buildId`);
  const m = html.match(/"buildId":"([^"]+)"/);
  if (!m) throw new Error("buildId not found in page — the site layout changed");
  return m[1];
}

function dataUrl(host, buildId, category, page) {
  const base = `${host}/_next/data/${buildId}/en/c/${category.path}/${category.uuid}.json`;
  return page > 1 ? `${base}?page=${page}` : base;
}

async function fetchJson(url) {
  const text = await fetchText(url, { headers: { Accept: "application/json" } });
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function lotToRecord(lot, ctx) {
  const { host, categoryName, scrapedAt } = ctx;
  const parsed = parseTitle(lot.title);
  const bid = lot.currentBidAmount || {};
  const loc = lot.location || {};
  const thumb = lot.image?.url || "";

  return normaliseAuctionRecord(
    {
      id: lot.id,
      url: lot.urlSlug ? `${host}/en/l/${lot.urlSlug}` : host,
      title: lot.title || "",
      make: parsed.make,
      model: parsed.model,
      year: parsed.year,
      category: categoryName,
      // cents -> major units; the column is NUMERIC in the same currency.
      current_bid_amount: bid.cents != null ? bid.cents / 100 : "",
      currency: bid.currency || "",
      bids_count: lot.bidsCount ?? "",
      bidding_status: lot.biddingStatus || "",
      auction_start_at: epochToIso(lot.startDate),
      auction_end_at: epochToIso(lot.endDate),
      auction_id: lot.auctionId || "",
      lot_number: lot.displayId || "",
      city: loc.city || "",
      country_code: (loc.countryCode || "").toUpperCase(),
      thumbnail_url: thumb,
    },
    scrapedAt,
  );
}

// Enrich a record from its lot detail page. The attributes list carries the
// seller's own Brand/Type/Year of build, which beat the title guess when
// present; the detail page also has the full image set and the auction name.
async function enrichDetail(record, ctx) {
  const { host, buildId } = ctx;
  const slug = record.url.split("/en/l/")[1];
  if (!slug) return;
  const data = await fetchJson(`${host}/_next/data/${buildId}/en/l/${slug}.json`);
  const lot = data?.pageProps?.lot;
  if (!lot) return;

  const attrs = {};
  for (const a of lot.attributes || []) {
    if (a?.name) attrs[String(a.name).toLowerCase()] = a.value;
  }

  // "Brand" is often "Iveco Eurocargo" — make and model glued together. Re-run
  // the title parser over it so the make is canonical and the rest becomes the
  // model, but only when the title gave us nothing better.
  if (attrs.brand) {
    const fromBrand = parseTitle(String(attrs.brand));
    if (fromBrand.make) record.make = fromBrand.make;
    if (!record.model && fromBrand.model) record.model = fromBrand.model;
  }
  if (attrs.type) record.model = String(attrs.type).trim();
  if (attrs["year of build"]) {
    const y = String(attrs["year of build"]).match(/\b(?:19[5-9]\d|20[0-4]\d)\b/);
    if (y) record.year = y[0];
  }
  // Attribute names are the seller's own labels, surveyed live off the platform
  // (2026-08) rather than guessed — the mileage key really is spelled
  // "Mileage during intake (km)", and a lot re-listed after a correction carries
  // an extra "… old" variant we must NOT prefer over the current figure.
  const km = attrs["mileage during intake (km)"] ?? attrs.mileage ?? attrs.kilometres;
  if (km) record.mileage_km = String(km).replace(/[^\d]/g, "");
  const hp = attrs.power ?? attrs.horsepower ?? attrs["engine power"];
  if (hp) record.engine_power_hp = String(hp).replace(/[^\d]/g, "");
  const cc = attrs["cylinder capacity"];
  if (cc) record.engine_capacity_cc = String(cc).replace(/[^\d]/g, "");

  // Fuel is sometimes a named field and sometimes a boolean-ish flag attribute
  // ({name:"Diesel", value:"true"}), so fall back to detecting the flag form.
  const fuel = attrs["fuel type"] ?? attrs.fuel;
  if (fuel) record.fuel_type = String(fuel).trim();
  else {
    for (const name of ["diesel", "petrol", "electric", "lpg", "cng"]) {
      if (String(attrs[name]).toLowerCase() === "true") {
        record.fuel_type = name.charAt(0).toUpperCase() + name.slice(1);
        break;
      }
    }
  }

  const gearbox = attrs["transmission type"] ?? attrs.transmission ?? attrs.gearbox;
  if (gearbox) record.gearbox = String(gearbox).trim();
  else if (String(attrs.automatic).toLowerCase() === "true") record.gearbox = "Automatic";

  const axle = attrs["axle configuration"];
  if (axle) record.axle_configuration = String(axle).trim();

  const vin = attrs.vin ?? attrs["chassis number"] ?? attrs["serial number"];
  if (vin) record.vin = String(vin).trim();

  const images = (lot.images || []).map((i) => i?.url).filter(Boolean);
  if (images.length) {
    record.image_urls = images.join(IMAGE_URL_SEPARATOR);
    record.thumbnail_url = record.thumbnail_url || images[0];
  }
  if (data.pageProps.auction?.name) record.auction_name = data.pageProps.auction.name;
  if (lot.location?.city) record.city = lot.location.city;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const platform = PLATFORMS[args.platform];
  const category = CATEGORIES[args.category];
  if (!platform) {
    console.error(
      `Unknown --platform "${args.platform}". Use: ${Object.keys(PLATFORMS).join(", ")}`,
    );
    process.exit(1);
  }
  if (!category) {
    console.error(
      `Unknown --category "${args.category}". Use: ${Object.keys(CATEGORIES).join(", ")}`,
    );
    process.exit(1);
  }

  const slug = args.slug || `${platform.source}-${args.category}`;
  const scrapedAt = new Date().toISOString();
  const byId = await loadExistingAuctions(slug);
  const startCount = byId.size;
  const counts = { added: 0, updated: 0, skipped: 0 };
  const seen = new Set();

  console.log(`--- ${platform.source} auctions: ${args.category} -> slug=${slug} ---`);
  const buildId = await fetchBuildId(platform.host, category);
  console.log(`  buildId=${buildId}`);
  const ctx = { host: platform.host, buildId, categoryName: args.category, scrapedAt };

  for (let page = 1; page <= args.maxPages; page++) {
    const data = await fetchJson(dataUrl(platform.host, buildId, category, page));
    const lots = data?.pageProps?.lotsData?.results;
    if (!lots) {
      console.warn(`  page ${page}: no lotsData, stopping.`);
      break;
    }
    if (lots.length === 0) {
      console.log(`  page ${page}: empty, end of results.`);
      break;
    }
    const total = data.pageProps.lotsData.totalSize ?? 0;

    const fresh = lots.filter((l) => l.id && !seen.has(l.id));
    fresh.forEach((l) => seen.add(l.id));

    let records = fresh.map((lot) => lotToRecord(lot, ctx));

    // Filter BEFORE fetching details so a priority-only run doesn't spend
    // requests on lots it will throw away. Titles carry the make, so the
    // decision is already reliable at this point.
    if (args.priorityOnly) {
      const kept = records.filter((r) => isPriorityModel(r.make, r.model));
      counts.skipped += records.length - kept.length;
      records = kept;
    }

    if (args.details && records.length) {
      await mapPool(records, args.concurrency, async (record) => {
        try {
          await enrichDetail(record, ctx);
        } catch (err) {
          console.warn(`  detail failed for ${record.url}: ${err.message}`);
        }
        await randomDelay([400, 900]);
      });
    }

    for (const rec of records) {
      const key = String(rec.id);
      if (byId.has(key)) counts.updated++;
      else counts.added++;
      byId.set(key, rec);
    }

    const lastPage = total ? Math.ceil(total / PAGE_SIZE) : "?";
    console.log(
      `  page ${page}/${lastPage}: ${lots.length} lots (${fresh.length} new` +
        `${args.priorityOnly ? `, ${records.length} priority` : ""})`,
    );

    await writeAuctionOutputs(slug, byId); // checkpoint each page

    if (fresh.length === 0) {
      console.log("  page repeated known lots — end of results.");
      break;
    }
    if (total && page * PAGE_SIZE >= total) {
      console.log("  reached last page.");
      break;
    }
    await randomDelay([1000, 2000]);
  }

  await writeAuctionOutputs(slug, byId);
  console.log(
    `--- ${slug}: ${counts.added} new, ${counts.updated} refreshed` +
      `${args.priorityOnly ? `, ${counts.skipped} non-priority skipped` : ""}` +
      `, ${byId.size} total (was ${startCount}) ---`,
  );
  console.log(`Next: node load-auctions.js ${slug} ${platform.source}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
