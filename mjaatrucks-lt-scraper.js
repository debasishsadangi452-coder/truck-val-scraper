#!/usr/bin/env node
// mjaatrucks.lt (Lithuania) scraper — plain HTTP, no browser. A Lithuanian used
// commercial-vehicle dealer (hosted on the autoline.lt platform) whose stock is
// all located in Lithuania. Small inventory (~120 listings) but an unblocked,
// server-rendered source for a country that's otherwise gated (autoplius.lt is
// Cloudflare-protected), so every real LT priority-make listing counts.
//
// Structure: /en/stock/?page=N lists ~24 cards/page; each detail page is
// /en/<slug>--a<id>.html with the make/model in the slug and a spec block
// (title, price €, Year of manufacture, Mileage). Prices are EUR (eurozone).
//
// Writes output/mjaatrucks-lt-trucks/listings.json; load with:
//   node load-listings.js mjaatrucks-lt-trucks mjaatrucks_lt

import { fetchText, normaliseRecord, writeOutputs, loadExisting, randomDelay, mapPool } from "./lib/scrape-core.js";
import { stripTags, firstMatch, digits } from "./lib/html-utils.js";

const SLUG = "mjaatrucks-lt-trucks";
const BASE = "https://mjaatrucks.lt";
const KNOWN_MAKES = ["DAF", "Volvo", "Mercedes-Benz", "Renault", "Scania", "MAN", "Iveco", "Ford", "Kögel", "Krone", "Schmitz"];

function parseArgs(argv) {
  const args = { maxPages: 15, concurrency: 3 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (argv[i] === "--concurrency") args.concurrency = Math.max(1, Number(argv[++i]) || 1);
  }
  return args;
}

// Detail links: /en/<slug>--a<digits>.html. Capture full url + numeric id.
function listingLinks(html) {
  const out = new Map();
  for (const m of html.matchAll(/https:\/\/mjaatrucks\.lt\/(?:en\/)?[^"']*?-a(\d{10,})\.html/g)) {
    out.set(m[1], m[0]);
  }
  return [...out.entries()].map(([id, url]) => ({ id, url }));
}

// Pull make/model from the slug (e.g. "vilkikas-DAF-XF-530-6x2-Super-Space-Cab").
function makeModelFromUrl(url) {
  const slug = decodeURIComponent(url).replace(/^https:\/\/mjaatrucks\.lt\/(?:en\/)?/, "");
  // Strip the trailing "--a<id>.html" and any query so the model doesn't inherit it.
  const clean = slug.replace(/--?a\d{6,}\.html.*$/i, "").replace(/\.html.*$/i, "");
  for (const mk of KNOWN_MAKES) {
    const re = new RegExp(`${mk.replace("-", "[- ]?")}[- ]([A-Za-z0-9][A-Za-z0-9- ]*)`, "i");
    const m = clean.match(re);
    if (m) return { make: mk, model: m[1].replace(/-/g, " ").replace(/\s+/g, " ").trim() };
  }
  return { make: "", model: "" };
}

async function enrichDetail(rec) {
  const html = await fetchText(rec.url);
  if (!html) return false;
  const title = stripTags((html.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? "").replace(/\s*for sale.*$/i, "").trim();
  if (title) rec.title = title;

  // Title fallback for make/model when the slug didn't resolve.
  if (!rec.make) {
    for (const mk of KNOWN_MAKES) {
      if (new RegExp(mk.replace("-", "[- ]?"), "i").test(title)) {
        rec.make = mk;
        rec.model = title.replace(new RegExp(mk.replace("-", "[- ]?"), "i"), "").split(/\s+/).slice(0, 4).join(" ").trim();
        break;
      }
    }
  }

  rec.year =
    firstMatch(html, /(?:Year of manufacture|Manufacture year|Pagaminimo metai)[^0-9]{0,20}(\d{4})/i) ||
    firstMatch(rec.title, /\b(20\d{2}|19\d{2})\b/) ||
    "";
  rec.mileage_km = digits(
    firstMatch(html, /(?:Mileage|Rida)[^0-9]{0,20}([\d\s]{4,})\s*km/i) || "",
  );
  // Prices render as "Price: €30,800" / "€30,800" (symbol before the number).
  const price = digits(
    firstMatch(html, /Price:\s*€\s*([\d.,\s]{3,})/i) || firstMatch(html, /€\s*([\d.,\s]{3,})/) || "",
  );
  rec.price_amount = /[1-9]/.test(price) ? price : "";
  rec.price_currency = rec.price_amount ? "EUR" : "";
  rec.fuel_type = firstMatch(html, /(?:Fuel|Kuras)[^A-Za-z]{0,12}(Diesel|Petrol|Nafta|Benzinas)/i) || "";
  return Boolean(rec.make);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scrapedAt = new Date().toISOString();
  const byId = await loadExisting(SLUG);
  const startCount = byId.size;
  const counts = { added: 0, updated: 0 };
  const seen = new Set();

  console.log(`--- mjaatrucks.lt scrape (Lithuania) ---`);
  for (let page = 1; page <= args.maxPages; page++) {
    const listHtml = await fetchText(`${BASE}/en/stock/?page=${page}`);
    if (!listHtml) break;
    const links = listingLinks(listHtml).filter((l) => !seen.has(l.id));
    if (links.length === 0) {
      console.log(`  page ${page}: no new listings — end.`);
      break;
    }
    links.forEach((l) => seen.add(l.id));
    console.log(`  page ${page}: ${links.length} listings`);

    const records = links.map((l) => {
      const { make, model } = makeModelFromUrl(l.url);
      const rec = normaliseRecord(
        {
          id: `mjaa-${l.id}`,
          url: l.url,
          make,
          model,
          country_origin: "Lithuania",
          region: "Lithuania",
        },
        scrapedAt,
      );
      return rec;
    });

    await mapPool(records, args.concurrency, async (rec) => {
      try {
        const ok = await enrichDetail(rec);
        if (!ok) rec.make = rec.make || "Unknown";
      } catch (err) {
        console.warn(`  detail ${rec.id} failed: ${err.message}`);
      }
      await randomDelay([500, 1100]);
    });

    for (const rec of records) {
      if (!rec.make || rec.make === "Unknown") continue; // skip un-parseable
      if (byId.has(rec.id)) counts.updated++;
      else counts.added++;
      byId.set(rec.id, rec);
    }
    await writeOutputs(SLUG, byId);
    await randomDelay([1000, 2000]);
  }

  console.log(
    `--- mjaatrucks.lt: ${counts.added} new, ${counts.updated} refreshed, ${byId.size} total (was ${startCount}) ---`,
  );
  console.log(`Next: node load-listings.js ${SLUG} mjaatrucks_lt`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
