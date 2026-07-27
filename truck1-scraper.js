#!/usr/bin/env node
// truck1.eu scraper — Playwright (headless Chromium) required.
//
// truck1.eu serves an anti-bot interstitial to plain fetch/axios (HTTP 202 JS
// cookie-challenge), so the real listing HTML only appears after the page's JS
// runs. This scraper therefore drives a headless browser (scripts/lib/browser.js
// → Playwright) rather than an HTTP client.
//
// The DOM/JSON-LD extraction below is grounded in truck1.eu's real markup
// (inspected 2026-07): each detail page embeds a JSON-LD Product/Vehicle block
// plus a `.specs-item` label/value list and a dealer block. Pagination on the
// search results is zero-indexed `?page=N`, and detail URLs match
// /trucks/<cat>/<slug>-a<id>.html.
//
// It writes output/truck1-trucks/listings.json in a normalized shape, then
// `node load-listings.js truck1-trucks truck1` upserts it into truck_listings
// on (source, source_id) — no duplicates on re-run. `node run.js` does both.
//
// ⚠️ Needs Playwright + a real browser with network egress. Install once with:
//     npm install && npx playwright install chromium
// then run locally:
//     node truck1-scraper.js --pages 5
//     node truck1-scraper.js --start-url "https://www.truck1.eu/trucks/tippers" --pages 3
//
// Honest field caveats from the inspected markup: VIN is usually gated behind a
// "Show" reveal (needs login) → often null; engine_capacity_cc, co2_g_km and
// coordinates aren't exposed on detail pages → null. Be polite: keep --pages and
// --concurrency modest and check truck1.eu's robots.txt / ToS before bulk runs.

import { withBrowser } from "./lib/browser.js";
import { normaliseRecord, writeOutputs, loadExisting, randomDelay } from "./lib/scrape-core.js";

const SLUG = "truck1-trucks";
const DEFAULT_START = "https://www.truck1.eu/trucks/all";

function parseArgs(argv) {
  const args = {
    pages: 3,
    concurrency: 3,
    startUrl: DEFAULT_START,
    headless: true,
    limit: Infinity, // cap number of detail pages scraped (smoke-testing)
    url: null, // scrape ONE detail url and print the parsed record, then exit
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pages") args.pages = parseInt(argv[++i], 10);
    else if (a === "--concurrency") args.concurrency = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--start-url") args.startUrl = argv[++i];
    else if (a === "--limit") args.limit = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--url") args.url = argv[++i];
    else if (a === "--headful") args.headless = false;
  }
  return args;
}

const digitsOnly = (s) => {
  if (s == null) return "";
  const m = String(s).replace(/[^\d]/g, "");
  return m || "";
};

// "27 t" / "27000 kg" → kilograms as a digit string.
function weightToKg(str) {
  if (!str) return "";
  const s = String(str).trim().toLowerCase();
  const num = parseFloat(s.replace(",", ".").replace(/[^\d.]/g, ""));
  if (Number.isNaN(num)) return "";
  return String(Math.round(s.includes("t") && !s.includes("kg") ? num * 1000 : num));
}

function idFromUrl(url) {
  const m = String(url).match(/-a(\d+)\.html/);
  return m ? m[1] : url;
}

// Zero-indexed ?page=N (page 0 == no param), matching the site.
function listingsPageUrl(baseUrl, pageIndex) {
  const url = new URL(baseUrl);
  if (pageIndex > 0) url.searchParams.set("page", String(pageIndex));
  return url.toString();
}

// Read the JSON-LD Product + `.specs-item` pairs + dealer block off a detail
// page. Runs inside the page (Playwright page.evaluate).
async function extractDetail(page) {
  return page.evaluate(() => {
    const ldScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    let product = null;
    for (const s of ldScripts) {
      try {
        const parsed = JSON.parse(s.textContent);
        const type = parsed["@type"];
        if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) {
          product = parsed;
          break;
        }
      } catch {
        /* ignore malformed JSON-LD */
      }
    }
    const specs = {};
    document.querySelectorAll(".specs-item").forEach((el) => {
      const labelEl = el.querySelector(".specs-title span");
      const valEl = el.querySelector(".specs-value");
      if (labelEl && valEl) {
        const label = labelEl.textContent.trim().toLowerCase();
        if (label) specs[label] = valEl.textContent.trim();
      }
    });
    const q = (sel) => document.querySelector(sel);
    return {
      title: q("h1")?.textContent.trim() ?? product?.name ?? "",
      productLd: product,
      specs,
      dealerName: q(".d6_dealer-container .name_")?.textContent.trim() ?? "",
      dealerLocationText:
        q(".d6_dealer-container .ap-location-container")?.textContent.trim() ?? "",
      dealerWebsite: q('.d6_dealer-container a[href^="http"]:not([href*="truck1"])')?.href ?? "",
    };
  });
}

// Map raw page data → the canonical record shape (scrape-core FIELDNAMES).
function normalize(url, data, scrapedAt) {
  const { productLd: ld, specs, title, dealerName, dealerLocationText, dealerWebsite } = data;
  const specVal = (...labels) => {
    for (const l of labels) {
      const v = specs[l.toLowerCase()];
      if (v && v.trim() && v.trim() !== "Show") return v.trim();
    }
    return "";
  };

  const make =
    ld?.brand?.name || specVal("brand") || (title ? title.split(/\s+/)[0] : "") || "Unknown";
  const model = ld?.model || specVal("model") || "";

  const yearRaw = ld?.vehicleModelDate || specVal("year of manufacture");
  const year = (String(yearRaw).match(/\d{4}/) || [""])[0];

  const mileage = digitsOnly(ld?.mileageFromOdometer?.value || specVal("mileage"));
  const grossWeight =
    (ld?.weightTotal?.value ? String(ld.weightTotal.value) : "") ||
    weightToKg(specVal("gross weight"));

  const axle = specVal("axle configuration");
  const rawLocation = specVal("location") || dealerLocationText;
  let city = "";
  let region = "";
  if (rawLocation) {
    const parts = rawLocation
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      region = parts[0];
      city = parts[1];
    } else if (parts.length === 1) {
      region = parts[0];
    }
  }
  const country = ld?.countryOfOrigin?.name || "";
  if (!region && country) region = country;

  const images = Array.isArray(ld?.image) ? ld.image : ld?.image ? [ld.image] : [];
  const vinSpec = specs["vin"];

  return normaliseRecord(
    {
      id: ld?.sku ? String(ld.sku) : idFromUrl(url),
      url,
      title: title || ld?.name || "",
      make,
      model,
      year,
      mileage_km: mileage,
      fuel_type: ld?.fuelType || specVal("fuel") || "",
      engine_power_hp: digitsOnly(specVal("power output")),
      engine_capacity_cc: digitsOnly(specVal("engine capacity", "displacement")),
      co2_g_km: digitsOnly(specVal("co2", "co2 emission", "co2 emissions")),
      gross_weight_kg: grossWeight,
      payload_kg: digitsOnly(specVal("payload")),
      axle_configuration: axle,
      wheel_axis:
        axle || (ld?.numberOfAxles ? `${ld.numberOfAxles}-axle` : specVal("number of axles")),
      gearbox: ld?.vehicleTransmission || specVal("gearbox") || "",
      country_origin: country,
      condition_service_record: specVal("service record", "service book", "full service history")
        ? "Yes"
        : "",
      price_amount:
        ld?.offers?.price != null ? digitsOnly(ld.offers.price) : digitsOnly(specVal("price")),
      price_currency: ld?.offers?.priceCurrency || "",
      city,
      region,
      dealer_address: ld?.offers?.seller?.address?.addressLocality || rawLocation || "",
      seller_name: ld?.offers?.seller?.name || dealerName || "",
      dealer_website: dealerWebsite || "",
      vin: vinSpec && vinSpec !== "Show" ? vinSpec : "",
      thumbnail_url: images[0] || "",
      image_urls: images.join("|"),
    },
    scrapedAt,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scrapedAt = new Date().toISOString();
  const byId = await loadExisting(SLUG);
  const startCount = byId.size;
  let added = 0;
  let updated = 0;

  // Smoke test: scrape ONE detail page, print the parsed record, and exit
  // without writing files. The fastest way to verify the selectors work on a
  // live page: `node scripts/truck1-trucks-scraper.js --url "<detail-url>"`.
  if (args.url) {
    await withBrowser(
      async ({ context }) => {
        const page = await context.newPage();
        await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForSelector(".specs-item", { timeout: 15000 }).catch(() => {});
        const data = await extractDetail(page);
        const rec = normalize(args.url, data, scrapedAt);
        const filled = Object.entries(rec).filter(([, v]) => v !== "" && v != null).length;
        console.log(`\n=== parsed record (${filled}/${Object.keys(rec).length} fields filled) ===`);
        console.log(JSON.stringify(rec, null, 2));
        await page.close();
      },
      { headless: args.headless },
    );
    return;
  }

  console.log(`--- truck1.eu scrape: ${args.pages} page(s) from ${args.startUrl} ---`);

  await withBrowser(
    async ({ context }) => {
      // Step 1: collect detail URLs across the search-result pages.
      const listingUrls = new Set();
      const listPage = await context.newPage();
      for (let p = 0; p < args.pages; p++) {
        const pageUrl = listingsPageUrl(args.startUrl, p);
        console.log(`[list] page ${p + 1}/${args.pages}: ${pageUrl}`);
        try {
          await listPage.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
          await listPage.waitForSelector('a[href*="-a"]', { timeout: 15000 }).catch(() => {});
          const hrefs = await listPage.$$eval("a[href]", (as) =>
            as
              .map((a) => a.href)
              .filter((h) => /\/trucks\/[^/]+\/[^/]+-a\d+\.html(\?.*)?$/.test(h)),
          );
          hrefs.forEach((u) => listingUrls.add(u));
          console.log(`  -> ${hrefs.length} links (unique so far: ${listingUrls.size})`);
        } catch (err) {
          console.error(`  ! list page failed: ${err.message}`);
        }
        await randomDelay([800, 1600]);
      }
      await listPage.close();

      const urls = [...listingUrls].slice(0, args.limit);
      console.log(
        `Collected ${listingUrls.size} detail URLs${
          Number.isFinite(args.limit) ? ` (scraping first ${urls.length})` : ""
        }. Scraping...`,
      );

      // Step 2: scrape detail pages with a small concurrency pool.
      let cursor = 0;
      async function worker() {
        while (cursor < urls.length) {
          const i = cursor++;
          const url = urls[i];
          const page = await context.newPage();
          try {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
            await page.waitForSelector(".specs-item", { timeout: 15000 }).catch(() => {});
            const data = await extractDetail(page);
            const rec = normalize(url, data, scrapedAt);
            const key = String(rec.id);
            if (byId.has(key)) updated++;
            else added++;
            byId.set(key, rec);
            console.log(`[${i + 1}/${urls.length}] OK ${rec.id} — ${rec.title.slice(0, 50)}`);
          } catch (err) {
            console.error(`[${i + 1}/${urls.length}] FAIL ${url}: ${err.message}`);
          } finally {
            await page.close();
            await randomDelay([300, 700]);
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(args.concurrency, urls.length) }, worker));
    },
    { headless: args.headless },
  );

  await writeOutputs(SLUG, byId);
  console.log(
    `--- truck1: ${added} new, ${updated} refreshed, ${byId.size} total (was ${startCount}) ---`,
  );
  console.log(`Next: node load-listings.js ${SLUG} truck1`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
