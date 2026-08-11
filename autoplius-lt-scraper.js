#!/usr/bin/env node
// autoplius.lt (Lithuania) scraper — Playwright (headless Chromium) required.
//
// autoplius.lt sits behind Cloudflare Bot Management: plain HTTP and even a
// headless browser on a DATACENTER IP get the "Just a moment..." interstitial
// and never see listings. It therefore needs a real browser AND a residential
// egress IP. Point PROXY_URL at a residential proxy to run it:
//     PROXY_URL="http://user:pass@host:port" node autoplius-lt-scraper.js
// Without a residential proxy the crawl still runs but Cloudflare will block it
// (the scraper detects the interstitial and exits with a clear message).
//
// autoplius.lt has an English host (en.autoplius.lt). Truck search:
//     https://en.autoplius.lt/ads/used-trucks
// Each result card links to a detail page /ads/<slug>-<id>. Detail pages embed a
// JSON-LD Product/Vehicle block plus a label/value spec table (Make, Model, Year,
// Mileage, Fuel, Power, Gearbox...). Prices are in EUR (Lithuania is eurozone).
//
// Writes output/autoplius-lt-trucks/listings.json; load with:
//     node load-listings.js autoplius-lt-trucks autoplius_lt

import { withBrowser } from "./lib/browser.js";
import { normaliseRecord, writeOutputs, loadExisting, randomDelay, mapPool } from "./lib/scrape-core.js";
import { stripTags, firstMatch, digits, extractJsonLd } from "./lib/html-utils.js";

const SLUG = "autoplius-lt-trucks";
const BASE = "https://en.autoplius.lt";
const SEARCH = `${BASE}/ads/used-trucks`;
const PROXY_URL = process.env.PROXY_URL || undefined;

function parseArgs(argv) {
  const args = { pages: 10, concurrency: 3, headless: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pages") args.pages = parseInt(argv[++i], 10);
    else if (a === "--concurrency") args.concurrency = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--headful") args.headless = false;
  }
  return args;
}

const isBlocked = (html) =>
  !html || html.length < 25000 || /Just a moment|not a robot|challenge-error|cf-browser-verification/i.test(html);

const searchPageUrl = (page) => (page <= 1 ? SEARCH : `${SEARCH}?page_nr=${page}`);

// Result cards link to /ads/<slug>-<digits>. Capture the numeric ad id.
function listingIds(html) {
  return [...new Set([...html.matchAll(/\/ads\/[a-z0-9-]*?-(\d{6,})(?:[/?#]|\.html|")/gi)].map((m) => m[1]))];
}

// Parse a detail page: prefer JSON-LD, fall back to the spec table + title.
function parseDetail(html, url, id, scrapedAt) {
  const lds = extractJsonLd(html);
  const product =
    lds.find((l) => /Product|Vehicle|Car/i.test(l["@type"] || "")) || lds[0] || {};
  const brand = product.brand?.name || product.brand || "";
  const name = product.name || stripTags((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ?? [])[1] ?? "");

  // Spec table: label/value pairs. autoplius uses dl/dt/dd or div rows; grab both.
  const spec = {};
  const re = /<(?:dt|div class="[^"]*param[^"]*label[^"]*")[^>]*>([\s\S]*?)<\/(?:dt|div)>\s*<(?:dd|div class="[^"]*param[^"]*value[^"]*")[^>]*>([\s\S]*?)<\/(?:dd|div)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const k = stripTags(m[1]).replace(/:\s*$/, "").toLowerCase();
    if (k) spec[k] = stripTags(m[2]);
  }

  const make = brand || spec["make"] || spec["manufacturer"] || (name ? name.split(/\s+/)[0] : "") || "Unknown";
  const model = spec["model"] || (name && make ? name.replace(make, "").trim() : "");
  const price =
    digits(String(product.offers?.price ?? "")) ||
    digits(firstMatch(html, /€\s?([\d.,]{3,})/) || "");

  return normaliseRecord(
    {
      id,
      url,
      title: name,
      make,
      model,
      year: firstMatch(spec["year"] || spec["date of manufacture"] || "", /(\d{4})/) || firstMatch(name, /\b(19|20)\d{2}\b/),
      mileage_km: digits(spec["mileage"] || spec["kilometrage"] || ""),
      fuel_type: spec["fuel type"] || spec["fuel"] || "",
      engine_power_hp: digits(firstMatch(spec["power"] || spec["engine power"] || "", /([\d]+)\s*(?:hp|kw|ag)/i)),
      gearbox: spec["gearbox"] || spec["transmission"] || "",
      country_origin: "Lithuania",
      region: spec["city"] || spec["location"] || "Lithuania",
      city: spec["city"] || "",
      price_amount: price,
      price_currency: price ? "EUR" : "",
    },
    scrapedAt,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scrapedAt = new Date().toISOString();
  const byId = await loadExisting(SLUG);
  const startCount = byId.size;
  const counts = { added: 0, updated: 0 };

  console.log(`--- autoplius.lt scrape (Playwright${PROXY_URL ? " + residential proxy" : ", NO proxy"}) ---`);
  if (!PROXY_URL) {
    console.warn("  ⚠ No PROXY_URL set — autoplius.lt's Cloudflare gate will likely block a datacenter IP.");
  }

  await withBrowser(
    async ({ render }) => {
      const seen = new Set();
      for (let page = 1; page <= args.pages; page++) {
        const listHtml = await render(searchPageUrl(page), { settleMs: 2500 });
        if (isBlocked(listHtml)) {
          console.error(
            `  BLOCKED on page ${page} (Cloudflare interstitial). ` +
              `Set PROXY_URL to a residential proxy and retry.`,
          );
          break;
        }
        const ids = listingIds(listHtml).filter((x) => !seen.has(x));
        ids.forEach((x) => seen.add(x));
        if (ids.length === 0) {
          console.log(`  page ${page}: no new listings — end of results.`);
          break;
        }
        console.log(`  page ${page}: ${ids.length} listings`);

        await mapPool(ids, args.concurrency, async (id) => {
          const url = `${BASE}/ads/-${id}`;
          try {
            const dHtml = await render(url, { settleMs: 1500 });
            if (isBlocked(dHtml)) return;
            const rec = parseDetail(dHtml, url, id, scrapedAt);
            if (rec.make && rec.make !== "Unknown") {
              if (byId.has(id)) counts.updated++;
              else counts.added++;
              byId.set(id, rec);
            }
          } catch (err) {
            console.warn(`  detail ${id} failed: ${err.message}`);
          }
          await randomDelay([600, 1400]);
        });
        await writeOutputs(SLUG, byId);
        await randomDelay([1500, 3000]);
      }
    },
    { headless: args.headless, proxy: PROXY_URL },
  );

  await writeOutputs(SLUG, byId);
  console.log(
    `--- autoplius.lt: ${counts.added} new, ${counts.updated} refreshed, ${byId.size} total (was ${startCount}) ---`,
  );
  console.log(`Next: node load-listings.js ${SLUG} autoplius_lt`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
