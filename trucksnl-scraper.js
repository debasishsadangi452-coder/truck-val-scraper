#!/usr/bin/env node
// Scrapes truck listings from trucksnl.com — local Playwright (headless Chromium).
//
// THE GATE (re-verified 2026-08-29): trucksnl.com sits behind Google reCAPTCHA
// Enterprise, but NOT uniformly, and NOT on the route we need:
//   /trucks                          -> passes with a plain headless browser
//   /search?category=trucks&make=daf -> STILL GATED ("Checking your browser")
// A direct fetch of /trucks returns HTTP 200 with a ~20KB challenge page and no
// listings, which is why this needs a real browser. It does NOT need Apify: a
// local headless Chromium clears it with no proxy, so this scraper is free to
// run and is the reason we don't spend Apify credit here.
//
// Because /search is gated, the site's own make/country/euro-norm filters are
// unreachable. We therefore crawl the unfiltered /trucks list and filter AFTER
// parsing (--priority-only). That costs pages, not money.
//
// ⚠️ reCAPTCHA Enterprise scores by IP reputation. This clears the gate from a
// normal residential connection; from a datacenter IP (Railway, most CI) it may
// not. Treat this as a LOCAL/manual scraper — it is deliberately not in run.js's
// weekly cron. If it returns 0 listings, that's the gate, not a parser bug:
// re-run with --headful to see what the page is actually showing.
//
// Cards are read from the DOM, not an embedded state blob: window.__NUXT__ is
// empty on this page and the ad links are rendered client-side, so there is no
// JSON payload to lift. Each card is a `div[class*="bg-card"]` (36 per page)
// containing an `a[href$="-vd"]` whose slug ends in the numeric ad id, plus a
// single flattened text run holding the spec:
//   "MAN TGX 33.580 6X4 30 T AJK Haak | container truck | Used | Euro 6 | 6x4 |
//    340,000 km | 2023 | De Koning | 4.822 reviews | Oss, Netherlands | €97,500"
//
// Writes output/trucksnl-trucks/listings.json; load with:
//   node load-listings.js trucksnl-trucks trucksnl
//
// Usage:
//   node trucksnl-scraper.js --pages 5
//   node trucksnl-scraper.js --pages 20 --priority-only
//   node trucksnl-scraper.js --pages 1 --headful     # watch the gate resolve

import { pathToFileURL } from "node:url";
import { withBrowser } from "./lib/browser.js";
import { normaliseRecord, writeOutputs, loadExisting, randomDelay } from "./lib/scrape-core.js";
import { isPriorityModel } from "./lib/auction-core.js";

const SLUG = "trucksnl-trucks";
const BASE = "https://www.trucksnl.com";
const DEFAULT_START = "https://www.trucksnl.com/trucks";
// reCAPTCHA Enterprise + Nuxt hydration both need a moment; 11s clears both in
// testing. Too short and the page is still the challenge or an empty shell.
const SETTLE_MS = 11000;
const CARD_SELECTOR = 'div[class*="bg-card"]';

function parseArgs(argv) {
  const args = {
    pages: 3,
    startUrl: DEFAULT_START,
    routes: null,
    headless: true,
    priorityOnly: false,
    slug: SLUG,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pages") args.pages = parseInt(argv[++i], 10);
    else if (a === "--start-url") args.startUrl = argv[++i];
    else if (a === "--routes") args.routes = argv[++i].split(",").map((x) => x.trim());
    else if (a === "--slug") args.slug = argv[++i];
    else if (a === "--headful") args.headless = false;
    else if (a === "--priority-only") args.priorityOnly = true;
  }
  return args;
}

// /trucks is CAPPED at 20 pages (720 ads) even though the site advertises
// 15,000+ — page 21 onward returns an empty (not gated) list. The per-make
// routes are separate pools with their OWN 20-page allowance and are also
// ungated, so crawling them is the only way past that ceiling. These are the
// priority makes; --routes overrides.
const PRIORITY_ROUTES = [
  "/trucks",
  "/trucks/daf",
  "/trucks/volvo",
  "/trucks/man",
  "/trucks/mercedes-benz",
  "/trucks/scania",
];

function pageUrl(startUrl, page) {
  if (page <= 1) return startUrl;
  return `${startUrl}${startUrl.includes("?") ? "&" : "?"}page=${page}`;
}

// Makes recognised in a card title, canonical spelling on the left.
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

// Body/spec words that belong to the lot description, not the model name.
const TITLE_NOISE =
  /\b(?:truck|trucks|lorry|tractor unit|tipper|container|curtain(?:sider)?|sliding curtain|closed box|box|crane|refrigerated|machine transport|hydr\.?|kipper|haak(?:container)?|used|new)\b/gi;

/** Split a card title into { make, model }. Year/mileage come from the spec run. */
export function parseTitle(title) {
  const t = String(title || "").trim();
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
  if (idx === -1) return { make: "", model: "" };

  // Keep only the leading designation after the make — the rest of a trucksnl
  // title is free-text sales copy ("EX Government 151.000 KM Tipper+Kran…"),
  // which would otherwise swamp the model. Two tokens is enough for every
  // real designation we care about ("TGX 33.580", "XF 480", "CF 300").
  const rest = t
    .slice(idx + len)
    .replace(TITLE_NOISE, " ")
    .replace(/^[\s\-–—,:/.]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  const model = rest
    .split(" ")
    .slice(0, 2)
    .join(" ")
    .replace(/[-–—/,:.]+$/, "")
    .trim();

  return { make, model };
}

// The ad id is the numeric run at the end of the slug: "…-ajk-haak-9133046-vd".
function idFromHref(href) {
  const m = String(href || "").match(/-(\d{5,})-vd\/?$/);
  return m ? m[1] : "";
}

function digits(value) {
  const d = String(value ?? "").replace(/[^\d]/g, "");
  return d || "";
}

/**
 * Pull the spec fields out of a card's flattened text run. The site renders
 * these as adjacent elements with no separators, e.g.
 *   "…container truckUsedEuro 66x4340,000 km2023De Koning…Oss, Netherlands€97,500"
 * so each field is matched by its own shape rather than by position.
 */
export function parseCardText(text) {
  const t = String(text || "").replace(/\s+/g, " ");

  // The spec run is the tail of the card, and it is unpunctuated:
  //   "…tipper truckUsedEuro 44x4151,000 km2007De Koning4.822 reviewsOss,
  //    Netherlands€37,500€45,375 incl. 21% VAT…"
  // Everything before it is the free-text title, which contains decoy numbers
  // ("18.280 .280", "28000 km", "Euro 6" in a model name). So anchor on the
  // ONE token every card has exactly once in the spec run — "<n> km" followed
  // immediately by the 4-digit year — and read outwards from there. Matching
  // the LAST such occurrence skips any "28000 km" the seller typed in the title.
  // The axle config runs straight into the mileage with no separator
  // ("Euro 4" + "4x4" + "151,000 km"), so capture BOTH in one pass rather than
  // letting a greedy digit run swallow the axle digits into the mileage.
  const kmYear = [
    ...t.matchAll(
      /(?:Euro\s*(\d))?\s*([2468]\s?[xX]\s?[2468])?\s*([\d.,]+)\s*km(19[5-9]\d|20[0-4]\d)/gi,
    ),
  ].pop();
  const euro = kmYear ? kmYear[1] || "" : "";
  const axle = kmYear ? (kmYear[2] || "").replace(/\s/g, "") : "";
  const mileage = kmYear ? digits(kmYear[3]) : "";
  const year = kmYear ? kmYear[4] : "";

  // Price: the first "€" figure is ex-VAT, the second is inc-VAT; keep ex-VAT so
  // it's comparable with the other sources. "Price on request" cards have none.
  const price = digits((t.match(/€\s?([\d.,]+)/) || [])[1] || "");

  // Location is "<city>, <country>" immediately before the price (or before
  // "Price on request"). It is preceded by the dealer's "N reviews" run with no
  // separator, so cut the city at the "reviews" boundary rather than letting the
  // greedy name match swallow it.
  const loc = t.match(/([A-Za-zÀ-ÿ0-9' .-]+),\s*([A-Za-zÀ-ÿ' .-]+?)\s*(?:€|Price on request)/);
  let city = loc ? loc[1].trim() : "";
  const country = loc ? loc[2].trim() : "";
  // The dealer's "N reviews" run abuts the city with no separator, and a dealer
  // whose name has no review count leaves the mileage/year run abutting it
  // instead ("…000 km2023NGR Nutzfahrzeuge…Würselen"). Cut at whichever boundary
  // is present, then drop any leading digits the spec run left behind.
  const rev = city.lastIndexOf("reviews");
  if (rev !== -1) city = city.slice(rev + "reviews".length);
  city = city
    .replace(/^.*?\bkm(?:19[5-9]\d|20[0-4]\d)/i, "")
    .replace(/^[\d.,\s]+/, "")
    .trim();

  return { mileage, axle, euro, year, price, city, country };
}

// The title is the card's own heading; strip the leading photo count and the
// "Top advertisement" badge the site prefixes onto the text run.
function cleanTitle(raw) {
  return String(raw || "")
    .replace(/^\s*\d+\s*/, "")
    .replace(/^Top advertisement\s*/i, "")
    .trim();
}

async function extractCards(page) {
  return page.evaluate((sel) => {
    const out = [];
    const seen = new Set();
    for (const card of document.querySelectorAll(sel)) {
      const a = card.querySelector('a[href$="-vd"]');
      if (!a) continue;
      const href = a.getAttribute("href");
      if (!href || seen.has(href)) continue;
      seen.add(href);
      const img = card.querySelector("img");
      // The heading element carries the title on its own, which is far cleaner
      // than slicing it out of the concatenated card text.
      const h = card.querySelector("h2, h3, [class*='title']");
      // The "City, Country" line is its own leaf element. Reading it from the
      // DOM avoids the dealer name running into it in the flattened text — a
      // dealer with no review count leaves no separator between the two.
      const locLeaf = Array.from(card.querySelectorAll("*"))
        .filter((e) => e.children.length === 0)
        .map((e) => (e.textContent || "").trim())
        .find((x) => /^[^,]{2,40},\s*[A-Za-zÀ-ÿ ]{3,30}$/.test(x));
      out.push({
        href,
        title: h ? h.textContent.replace(/\s+/g, " ").trim() : "",
        text: (card.textContent || "").replace(/\s+/g, " ").trim(),
        loc: locLeaf || "",
        img: img ? img.getAttribute("src") : "",
      });
    }
    return out;
  }, CARD_SELECTOR);
}

function cardToRecord(card, scrapedAt) {
  const id = idFromHref(card.href);
  const spec = parseCardText(card.text);
  // "Oss, Netherlands" -> { city, country }; falls back to the text-derived
  // pair when the card has no separate location leaf.
  const locParts = String(card.loc || "").split(",");
  const loc = {
    city: locParts.length > 1 ? locParts[0].trim() : "",
    country: locParts.length > 1 ? locParts.slice(1).join(",").trim() : "",
  };
  // Prefer the heading; fall back to the leading slice of the card text.
  const title = cleanTitle(card.title || card.text.slice(0, 90));
  const parsed = parseTitle(title);

  return normaliseRecord(
    {
      id,
      url: card.href.startsWith("http") ? card.href : `${BASE}${card.href}`,
      title,
      make: parsed.make,
      model: parsed.model,
      year: spec.year,
      mileage_km: spec.mileage,
      axle_configuration: spec.axle,
      price_amount: spec.price,
      price_currency: spec.price ? "EUR" : "",
      city: loc.city || spec.city,
      region: loc.country || spec.country,
      country_origin: loc.country || spec.country,
      thumbnail_url: card.img || "",
      dealer_website: BASE,
    },
    scrapedAt,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scrapedAt = new Date().toISOString();
  const byId = await loadExisting(args.slug);
  const startCount = byId.size;
  const counts = { added: 0, updated: 0, skipped: 0 };
  const seen = new Set();

  // An explicit --start-url means "crawl exactly this"; otherwise sweep the
  // route list, since /trucks alone can only ever yield its capped 720 ads.
  // Git Bash / MSYS rewrites a leading "/" argument into a Windows path
  // ("/trucks/daf" -> "C:/Program Files/Git/trucks/daf"), which would otherwise
  // produce a nonsense URL. Recover the intended route from the tail of any
  // absolute path we're handed, so --routes works from every shell.
  const toUrl = (r) => {
    if (r.startsWith("http")) return r;
    const m = r.match(/\/(?:trucks|tractor-units|trailers|transport)(?:\/.*)?$/i);
    const path = m ? m[0] : r.startsWith("/") ? r : `/${r}`;
    return `${BASE}${path}`;
  };
  const routes =
    args.startUrl !== DEFAULT_START
      ? [args.startUrl]
      : (args.routes || PRIORITY_ROUTES).map(toUrl);

  console.log(
    `--- trucksnl.com scrape: ${routes.length} route(s) x up to ${args.pages} page(s) ---`,
  );

  await withBrowser(
    async ({ context }) => {
      const page = await context.newPage();
      try {
        for (const route of routes) {
          console.log(`  route ${route}`);
          for (let n = 1; n <= args.pages; n++) {
            const url = pageUrl(route, n);
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
            // Fixed settle rather than networkidle: the gate resolves on a timer
            // and this page keeps background requests alive, so networkidle can
            // time out even on a page that loaded fine.
            await page.waitForTimeout(SETTLE_MS);

            const html = await page.content();
            if (/challengepage|Checking your browser/i.test(html)) {
              console.error(
                `  page ${n}: BLOCKED by reCAPTCHA (challenge page returned).\n` +
                  "  This is the gate, not a parser bug — try again from a residential\n" +
                  "  connection, or re-run with --headful to watch it.",
              );
              break;
            }

            const cards = await extractCards(page);
            if (cards.length === 0) {
              console.warn(`  page ${n}: no cards found — stopping.`);
              break;
            }

            let fresh = 0;
            let kept = 0;
            for (const card of cards) {
              const rec = cardToRecord(card, scrapedAt);
              if (!rec.id) continue;
              if (seen.has(rec.id)) continue;
              seen.add(rec.id);
              fresh++;
              if (args.priorityOnly && !isPriorityModel(rec.make, rec.model)) {
                counts.skipped++;
                continue;
              }
              if (byId.has(rec.id)) counts.updated++;
              else counts.added++;
              byId.set(rec.id, rec);
              kept++;
            }
            console.log(
              `  page ${n}: ${cards.length} cards (${fresh} new this run${args.priorityOnly ? `, ${kept} priority` : ""})`,
            );

            await writeOutputs(args.slug, byId); // checkpoint each page
            if (fresh === 0) {
              console.log("  page repeated known listings — end of results.");
              break;
            }
            await randomDelay([1500, 3000]);
          }
        }
      } finally {
        await page.close().catch(() => {});
      }
    },
    { headless: args.headless, blockAssets: false },
  );

  await writeOutputs(args.slug, byId);
  console.log(
    `--- ${args.slug}: ${counts.added} new, ${counts.updated} refreshed` +
      `${args.priorityOnly ? `, ${counts.skipped} non-priority skipped` : ""}` +
      `, ${byId.size} total (was ${startCount}) ---`,
  );
  console.log(`Next: node load-listings.js ${args.slug} trucksnl`);
}

// Only run when invoked as a script — parseTitle/parseCardText are exported for
// tests, and importing this file must not launch a browser crawl.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
