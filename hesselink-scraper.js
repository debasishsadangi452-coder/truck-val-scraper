#!/usr/bin/env node
// Scrapes used-truck listings from hesselinktrucks.com — plain HTTP, no
// browser.
//
// Verified live 2026-09: one of 31 sites the Chrome extension had registered
// as "needs a human check" purely as a conservative default (no prior
// evidence). A plain request returns HTTP 200, no CAPTCHA/Cloudflare markers.
// The catalog page (a Nuxt app) embeds its full stock as a schema.org
// `ItemList` JSON-LD block — no HTML card scraping needed, and it survives a
// markup redesign far better than selectors would.
//
// KNOWN GAP: price is NOT in the JSON-LD or anywhere in the server-rendered
// HTML — it's filled in client-side after hydration. Every row here has make/
// model/year/mileage but an EMPTY price. That is the honest result of what
// this site actually serves without a browser, not a parsing bug — a missing
// price is better than inventing one. If price ever matters more than
// inventory breadth for this source, it needs Playwright instead.
//
// The whole stock (12 vehicles, verified live) fits on one page — no
// pagination was found (`/c/all` and every `/c/all/brand:<x>` filter return
// the same JSON-LD shape with no next-page link), so this fetches once.
//
// ItemList shape, verified live:
//   itemListElement[].item.name         "DAF XF 480 6X2 FTP Space Cab Midlift
//                                        Stand-alone A/C 450,646 km PTO-Prep
//                                        NL Truck APK/TÜV 10/02/2026"
//   itemListElement[].item.description  HTML string: "Condition: Accident-free
//                                        <br/><br/>DAF XF 480 6X2 FTP<br/>Model
//                                        Year 01-2022<br/>EURO 6<br/>450,646
//                                        KM<br/>Space Cab<br/>..."
//   itemListElement[].item.url          "/v/daf-xf-480-...-10022026" (relative,
//                                        and the slug itself is the stable id —
//                                        the site mints no separate numeric id)
//   itemListElement[].item.image        full CDN URL
//
// Writes output/hesselink-trucks/listings.json; load with:
//   node load-listings.js hesselink-trucks hesselink
//
// Usage:
//   node hesselink-scraper.js
//   node hesselink-scraper.js --brand daf
import { fetchText, normaliseRecord, writeOutputs, loadExisting } from "./lib/scrape-core.js";
import { extractJsonLd, isType, digits } from "./lib/html-utils.js";

const BASE = "https://hesselinktrucks.com";

const MAKES = [
  ["Mercedes-Benz", /\bmercedes(?:[-\s]?benz)?\b/i],
  ["DAF", /\bdaf\b/i],
  ["Volvo", /\bvolvo\b/i],
  ["MAN", /\bman\b/i],
  ["Scania", /\bscania\b/i],
  ["Iveco", /\biveco\b/i],
  ["Renault", /\brenault\b/i],
];

function makeOf(t) {
  for (const [canonical, re] of MAKES) if (re.test(t)) return canonical;
  return "";
}

// The description is an HTML string (not stripped by the site itself), one
// spec per line separated by <br/>. Strip tags to plain text before matching
// so "Model Year 01-2022<br/>EURO 6" doesn't glue into one unmatchable token.
function descText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&");
}

function parseArgs(argv) {
  const args = { brand: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--brand") args.brand = argv[++i].toLowerCase();
  }
  return args;
}

async function run(args) {
  const path = args.brand ? `/c/all/brand:${args.brand}` : "/c/all";
  const slug = args.brand ? `hesselink-${args.brand}-trucks` : "hesselink-trucks";

  const html = await fetchText(`${BASE}${path}`);
  if (!html) {
    console.error("fetch failed");
    process.exitCode = 1;
    return;
  }

  const nodes = extractJsonLd(html);
  const itemList = nodes.find((n) => isType(n, "ItemList"));
  const items = itemList?.itemListElement || [];
  console.log(`found ${items.length} item(s) in the ItemList`);

  const scrapedAt = new Date().toISOString();
  const byId = await loadExisting(slug);

  for (const entry of items) {
    const item = entry?.item;
    if (!item?.url) continue;

    // The URL slug is the id — the site never exposes a separate numeric one,
    // and the slug is stable (it encodes the vehicle's own spec, not a
    // position in the list).
    const id = item.url.replace(/^\/+|\/+$/g, "").split("/").pop();
    if (!id) continue;

    const title = String(item.name || "");
    const desc = descText(item.description);
    const make = makeOf(title) || makeOf(desc);

    // Description's second line is usually the bare model designation, e.g.
    // "DAF XF 480 6X2 FTP" — cleaner than parsing it out of the sales-copy
    // title. Falls back to the title's leading words after the make.
    const modelLine = desc
      .split("\n")
      .map((l) => l.trim())
      .find((l) => make && l.toUpperCase().startsWith(make.toUpperCase()));
    const model = modelLine
      ? modelLine.slice(make.length).trim()
      : make
        ? title.slice(title.toUpperCase().indexOf(make.toUpperCase()) + make.length).trim()
        : "";

    // "Model Year 01-2022" -> 2022. Falls back to any bare year in the title
    // (some titles carry it directly, e.g. a registration date).
    const year =
      (desc.match(/Model Year\s*\d{1,2}-((?:19|20)\d{2})/i) || [])[1] ||
      (title.match(/\b(19[5-9]\d|20[0-4]\d)\b/) || [])[0] ||
      "";

    // "450,646 KM" / "588.396KM" — comma or dot as the thousands separator,
    // with or without a space before the unit.
    const mileageMatch = desc.match(/([\d][\d.,]{2,})\s*KM\b/i) || title.match(/([\d][\d.,]{2,})\s*km\b/i);
    const mileage = mileageMatch ? digits(mileageMatch[1]) : "";

    const rec = normaliseRecord(
      {
        id,
        url: item.url.startsWith("http") ? item.url : `${BASE}${item.url}`,
        title,
        make,
        model,
        year,
        mileage_km: mileage,
        // NO PRICE — see the file header. Left blank rather than guessed.
        country_origin: "Netherlands",
        thumbnail_url: item.image || "",
      },
      scrapedAt,
    );
    byId.set(id, rec);
  }

  await writeOutputs(slug, byId);
  console.log(`--- ${slug}: ${byId.size} total ---`);
}

const args = parseArgs(process.argv.slice(2));
run(args).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
