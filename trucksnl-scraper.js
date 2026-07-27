#!/usr/bin/env node
// Scrapes truck listings from trucksnl.com — Playwright (headless Chromium).
//
// ⚠️ HARD GATE: trucksnl.com sits behind Google reCAPTCHA Enterprise on EVERY
// URL (verified 2026-07 — even /api/trucks returns the challenge page, not JSON).
// A plain HTTP request only ever gets the "Checking your browser" interstitial,
// so this MUST use a real browser. Even then, reCAPTCHA Enterprise frequently
// detects and blocks headless automation from datacenter IPs — this scraper may
// clear the gate on a residential connection but be blocked from a cloud host.
// If it returns 0 listings, that's the gate, not a parser bug; the Chrome
// extension (real browser + your IP) is the reliable fallback for this site.
//
// trucksnl.com is a Nuxt app. Its listing data lives in the hydrated page —
// preferentially in window.__NUXT__, else JSON-LD, else the rendered DOM. The
// extraction below tries those in that order and is written DEFENSIVELY because
// the live DOM couldn't be inspected past the gate. ⚠️ VERIFY the selectors /
// state paths on a real (gate-cleared) page and adjust extractListings() before
// trusting a bulk run — run with --headful --pages 1 and read the debug output.
//
// Writes output/trucksnl-trucks/listings.json; load with:
//   node load-listings.js trucksnl-trucks trucksnl
//
// Usage:
//   node trucksnl-scraper.js --pages 5
//   node trucksnl-scraper.js --start-url "https://www.trucksnl.com/trucks" --pages 3 --headful

import { withBrowser } from "./lib/browser.js";
import { normaliseRecord, writeOutputs, loadExisting, randomDelay } from "./lib/scrape-core.js";

const SLUG = "trucksnl-trucks";
const BASE = "https://www.trucksnl.com";
const DEFAULT_START = "https://www.trucksnl.com/trucks";
// reCAPTCHA Enterprise can take a few seconds to resolve (or never, if blocked).
const GATE_WAIT_MS = 12000;

function parseArgs(argv) {
  const args = { pages: 3, startUrl: DEFAULT_START, headless: true, debug: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pages") args.pages = parseInt(argv[++i], 10);
    else if (a === "--start-url") args.startUrl = argv[++i];
    else if (a === "--headful") args.headless = false;
    else if (a === "--debug") args.debug = true;
  }
  return args;
}

const digitsOnly = (s) => {
  if (s == null) return "";
  const m = String(s).replace(/[^\d]/g, "");
  return m || "";
};

// ?page=N pagination (Nuxt list route). Verify N is 1-indexed on the live site.
function listPageUrl(baseUrl, page) {
  const url = new URL(baseUrl);
  if (page > 1) url.searchParams.set("page", String(page));
  return url.toString();
}

// True while the reCAPTCHA interstitial is still showing. We poll until it's
// gone (the real page hydrated) or the wait budget runs out.
async function gatePresent(page) {
  const title = await page.title().catch(() => "");
  if (/checking your browser|recaptcha/i.test(title)) return true;
  // The real trucks page should have listing anchors or the Nuxt state.
  const hasContent = await page
    .evaluate(() => !!window.__NUXT__ || !!document.querySelector('a[href*="/truck/"]'))
    .catch(() => false);
  return !hasContent;
}

async function waitPastGate(page) {
  const deadline = Date.now() + GATE_WAIT_MS;
  while (Date.now() < deadline) {
    if (!(await gatePresent(page))) return true;
    await page.waitForTimeout(1000);
  }
  return !(await gatePresent(page));
}

// Extract listing records from a hydrated list page. Tries, in order:
//   1. window.__NUXT__ state (Nuxt SSR payload) — most robust if present
//   2. JSON-LD ItemList/Product
//   3. rendered DOM cards (last resort)
// Returns an array of raw {..} objects; normalize() maps them to the schema.
// ⚠️ The exact __NUXT__ path and DOM selectors need live verification.
async function extractListings(page) {
  return page.evaluate(() => {
    const out = [];
    const digits = (s) => String(s ?? "").replace(/[^\d]/g, "");

    // --- 1) Nuxt state ---------------------------------------------------
    try {
      const nuxt = window.__NUXT__;
      if (nuxt) {
        // Nuxt buries the list under state/data/fetch — search for an array of
        // objects that look like listings (have an id + a title/price).
        const seen = new Set();
        const visit = (o) => {
          if (!o || typeof o !== "object" || seen.has(o)) return;
          seen.add(o);
          if (Array.isArray(o)) {
            if (
              o.length > 3 &&
              o.every((x) => x && typeof x === "object") &&
              o[0] &&
              ("id" in o[0] || "slug" in o[0]) &&
              ("title" in o[0] || "name" in o[0] || "price" in o[0])
            ) {
              for (const it of o) {
                const id = it.id ?? it.slug ?? it.reference;
                if (id == null) continue;
                out.push({
                  id: String(id),
                  url: it.url || it.slug ? `https://www.trucksnl.com/truck/${it.slug || id}` : "",
                  title: it.title || it.name || "",
                  make: it.brand || it.make || (it.title || "").split(" ")[0] || "",
                  model: it.model || it.type || "",
                  year: String(it.year || it.constructionYear || it.buildYear || ""),
                  mileage: digits(it.mileage || it.km || it.kilometers),
                  price: digits(it.price?.amount ?? it.price ?? it.priceExVat),
                  currency: it.price?.currency || it.currency || "EUR",
                  fuel: it.fuel || it.fuelType || "",
                  country: it.country || it.location?.country || "",
                  city: it.city || it.location?.city || "",
                  thumb: it.image || it.thumbnail || (it.images && it.images[0]) || "",
                });
              }
              return; // found the list; stop descending this branch
            }
          }
          for (const v of Object.values(o)) visit(v);
        };
        visit(nuxt);
        if (out.length) return { source: "nuxt", items: out };
      }
    } catch {
      /* fall through */
    }

    // --- 2) JSON-LD ItemList/Product ------------------------------------
    try {
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        let d;
        try {
          d = JSON.parse(s.textContent);
        } catch {
          continue;
        }
        const list = d?.["@type"] === "ItemList" ? d.itemListElement : null;
        if (Array.isArray(list)) {
          for (const el of list) {
            const it = el.item || el;
            if (!it?.url) continue;
            out.push({
              id: (String(it.url).match(/(\d+)/) || [])[1] || it.url,
              url: it.url,
              title: it.name || "",
              make: it.brand?.name || (it.name || "").split(" ")[0] || "",
              model: "",
              year: "",
              mileage: "",
              price: digits(it.offers?.price),
              currency: it.offers?.priceCurrency || "EUR",
              fuel: "",
              country: "",
              city: "",
              thumb: Array.isArray(it.image) ? it.image[0] : it.image || "",
            });
          }
          if (out.length) return { source: "jsonld", items: out };
        }
      }
    } catch {
      /* fall through */
    }

    // --- 3) DOM cards (last resort) -------------------------------------
    const cards = document.querySelectorAll('a[href*="/truck/"]');
    const seen = new Set();
    for (const a of cards) {
      const url = a.href;
      const id = (url.match(/\/truck\/(?:.*?-)?(\d+)/) || url.match(/(\d{4,})/) || [])[1] || url;
      if (seen.has(id)) continue;
      seen.add(id);
      const card = a.closest("article, li, div[class*='card'], div[class*='result']") || a;
      const txt = card.textContent.replace(/\s+/g, " ").trim();
      const title = (card.querySelector("h2, h3, [class*='title']") || a).textContent
        .replace(/\s+/g, " ")
        .trim();
      out.push({
        id: String(id),
        url,
        title,
        make: title.split(" ")[0] || "",
        model: "",
        year: (txt.match(/\b(19|20)\d{2}\b/) || [""])[0],
        mileage: digits((txt.match(/([\d.,]+)\s*km/i) || [""])[0]),
        price: digits((txt.match(/[€]\s?([\d.,]+)/) || [""])[1]),
        currency: /€/.test(txt) ? "EUR" : "",
        fuel: "",
        country: "",
        city: "",
        thumb: card.querySelector("img")?.src || "",
      });
    }
    return { source: "dom", items: out };
  });
}

function normalize(raw, scrapedAt) {
  const make = raw.make || (raw.title ? raw.title.split(/\s+/)[0] : "") || "Unknown";
  return normaliseRecord(
    {
      id: raw.id,
      url: raw.url || `${BASE}/truck/${raw.id}`,
      title: raw.title || "",
      make,
      model:
        raw.model ||
        (make && raw.title?.startsWith(make) ? raw.title.slice(make.length).trim() : ""),
      year: digitsOnly(raw.year).slice(0, 4),
      mileage_km: digitsOnly(raw.mileage),
      fuel_type: raw.fuel || "",
      price_amount: digitsOnly(raw.price),
      price_currency: raw.currency || "",
      city: raw.city || "",
      region: raw.country || "",
      country_origin: raw.country || "",
      thumbnail_url: raw.thumb || "",
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

  console.log(`--- trucksnl.com scrape: ${args.pages} page(s) from ${args.startUrl} ---`);

  await withBrowser(
    async ({ context }) => {
      const page = await context.newPage();
      for (let p = 1; p <= args.pages; p++) {
        const url = listPageUrl(args.startUrl, p);
        console.log(`[list] page ${p}/${args.pages}: ${url}`);
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
          const cleared = await waitPastGate(page);
          if (!cleared) {
            console.error("  ! reCAPTCHA gate not cleared — stopping (see file header).");
            break;
          }
          const { source, items } = await extractListings(page);
          if (args.debug) console.log(`  [debug] extracted via ${source}: ${items.length} items`);
          if (items.length === 0) {
            console.log("  no listings found on this page — end (or selectors need tuning).");
            break;
          }
          for (const raw of items) {
            const rec = normalize(raw, scrapedAt);
            const key = String(rec.id);
            if (byId.has(key)) updated++;
            else added++;
            byId.set(key, rec);
          }
          console.log(`  +${items.length} (total ${byId.size})`);
        } catch (err) {
          console.error(`  ! page ${p} failed: ${err.message}`);
          break;
        }
        await randomDelay([1500, 3000]);
      }
      await page.close();
    },
    { headless: args.headless },
  );

  await writeOutputs(SLUG, byId);
  console.log(
    `--- trucksnl: ${added} new, ${updated} refreshed, ${byId.size} total (was ${startCount}) ---`,
  );
  console.log(`Next: node load-listings.js ${SLUG} trucksnl`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
