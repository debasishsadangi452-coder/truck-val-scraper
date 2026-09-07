#!/usr/bin/env node
// Scrapes used-vehicle listings from equipped4u.eu — plain HTTP, no browser.
//
// Verified live 2026-09: probed as one of 31 sites the Chrome extension had
// registered as "needs a human check" purely as a conservative default (no
// prior evidence). A plain request returns HTTP 200 with no CAPTCHA/Cloudflare
// markers, and /gebruikte-trucks/ (WordPress, "used trucks" in Dutch) renders
// 12 real cards server-side — no client-side rendering to fight.
//
// Card shape, verified live:
//   container   div.single-product-showcase
//   ad link     a[href] wrapping the whole card (the site's own domain IS the
//               slug — no numeric id in the URL, so the slug itself is the id)
//   title       h5.product-title: "Mercedes-Benz MP3 ACTROS 2646 V6 6×2 / 3
//               PEDALS / RETARDER / MEILLER HOOK (20ton) / 467.835km / E5"
//   meta        div.cat: "Auto-onderdelen - Haakarm - Trucks - Mercedes-Benz
//                <br> 1UJT786.hook - 2008"  (category breadcrumb + reg + year)
//   price       div.price: "€ 26.985,-"
//
// No pagination on /gebruikte-trucks/ (12 items, single page) or
// /gebruikte-opleggers/ (trailers) — both fetched once per run.
//
// Writes output/equipped4u-trucks/listings.json; load with:
//   node load-listings.js equipped4u-trucks equipped4u
//
// Usage:
//   node equipped4u-scraper.js
//   node equipped4u-scraper.js --trailers
import { fetchText, normaliseRecord, writeOutputs, loadExisting } from "./lib/scrape-core.js";
import { stripTags, digits } from "./lib/html-utils.js";

const BASE = "https://equipped4u.eu";

const MAKES = [
  ["Mercedes-Benz", /\bmercedes(?:[-\s]?benz)?\b/i],
  ["DAF", /\bdaf\b/i],
  ["Volvo", /\bvolvo\b/i],
  ["MAN", /\bman\b/i],
  ["Scania", /\bscania\b/i],
  ["Iveco", /\biveco\b/i],
  ["Renault", /\brenault\b/i],
  ["Ford", /\bford\b/i],
];

function makeOf(t) {
  for (const [canonical, re] of MAKES) if (re.test(t)) return canonical;
  return "";
}

function parseArgs(argv) {
  const args = { trailers: false };
  for (const a of argv) if (a === "--trailers") args.trailers = true;
  return args;
}

// Each card is a self-contained <a href="...">...<div class="cat">...</div>
// <div class="price">...</div></a> block. Split on the card container class
// rather than the generic structural parser (lib/generic-scrape.js) — this
// site's markup is clean enough that a dedicated parser gets every field, not
// just the ones the structural fallback can find blind.
function parseCards(html) {
  const cards = [];
  const re =
    /<div class="single-product-showcase[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[\s\S]*?<h5 class="product-title">([\s\S]*?)<\/h5>[\s\S]*?<div class="cat">([\s\S]*?)<\/div>[\s\S]*?<div class="price">([\s\S]*?)<\/div>/gi;
  let m;
  while ((m = re.exec(html))) {
    cards.push({ url: m[1], title: stripTags(m[2]), meta: stripTags(m[3]), priceText: stripTags(m[4]) });
  }
  return cards;
}

async function run(args) {
  const path = args.trailers ? "/gebruikte-opleggers/" : "/gebruikte-trucks/";
  const slug = args.trailers ? "equipped4u-trailers" : "equipped4u-trucks";

  const html = await fetchText(`${BASE}${path}`);
  if (!html) {
    console.error("fetch failed");
    process.exitCode = 1;
    return;
  }

  const cards = parseCards(html);
  console.log(`found ${cards.length} card(s)`);

  const scrapedAt = new Date().toISOString();
  const byId = await loadExisting(slug);

  for (const card of cards) {
    // The slug is the id — the site mints no separate numeric ad id, and the
    // slug is stable across visits (it's the WordPress post slug).
    const id = card.url.replace(/\/+$/, "").split("/").pop();
    if (!id) continue;

    const make = makeOf(card.title) || makeOf(card.meta);
    // Title reads "<make> <model...> / <spec notes> / <mileage>km / <emission>".
    // Keep the words between the make and the first "/" as the model — the
    // rest is sales copy (pedal count, retarder, hook capacity...).
    const afterMake = make
      ? card.title.slice(card.title.toLowerCase().indexOf(make.toLowerCase()) + make.length)
      : card.title;
    const model = afterMake.split("/")[0].replace(/\s+/g, " ").trim();

    // "467.835km" or "467,835 km" — Dutch sites use "." as the thousands sep.
    const mileageMatch = card.title.match(/([\d][\d.,]{2,})\s*km/i);
    const mileage = mileageMatch ? digits(mileageMatch[1]) : "";

    // The meta line ends "<registration> - <year>", e.g. "1UJT786.hook - 2008".
    const year = (card.meta.match(/\b(19[5-9]\d|20[0-4]\d)\b/) || [])[0] || "";

    // "€ 26.985,-" -> 26985. Dutch price formatting uses "." for thousands and
    // "," for the decimal/none, so strip everything but leading digit groups.
    const priceDigits = digits(card.priceText.replace(/,-?$/, ""));
    const price = priceDigits && Number(priceDigits) >= 500 ? priceDigits : "";

    const rec = normaliseRecord(
      {
        id,
        url: card.url,
        title: card.title,
        make,
        model,
        year,
        mileage_km: mileage,
        price_amount: price,
        price_currency: price ? "EUR" : "",
        country_origin: "Netherlands",
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
