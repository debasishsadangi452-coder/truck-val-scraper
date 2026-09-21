// Run the REAL extension adapters (extension/adapters/*.js, loaded unmodified
// alongside base.js) against the live sites in a browser, page through with the
// adapter's own hasNextPage()/advancePage(), and POST every record to the same
// /api/search-jobs/:id/listings endpoint the orchestrator uses.
//
// This is the extension's own scraping code and the extension's own ingest
// contract; only the tab-driving shell differs, because Chrome 152 refuses
// --load-extension on this machine (developer_mode is reset on each launch).
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve("..");
const base = readFileSync(path.join(ROOT, "extension/adapters/base.js"), "utf8");

const API = process.env.EXT_API_BASE || "http://localhost:8080";
const TOKEN = process.env.INGEST_TOKEN || "";
const JOB = process.env.JOB_ID;
const SOURCE = process.argv[2];
const START = process.argv[3];
const ADAPTER = process.argv[4];
const MAX_PAGES = Number(process.env.MAX_PAGES || 30);

const adapterSrc = readFileSync(path.join(ROOT, "extension/adapters", ADAPTER), "utf8");

const b = await chromium.launch({ headless: true });
const p = await b.newPage({
  locale: SOURCE === "auto24" ? "et-EE" : "cs-CZ",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
});

async function install() {
  await p.evaluate(
    ([baseSrc, adapterSrc]) => {
      window.chrome = { runtime: { onMessage: { addListener() {} } } };
      eval(baseSrc);
      window.__REG = null;
      window.__TV.defineAdapter = (a) => { window.__REG = a; };
      eval(adapterSrc);
    },
    [base, adapterSrc],
  );
}

async function post(records) {
  if (!records.length) return { matched: 0 };
  const r = await fetch(`${API}/api/search-jobs/${JOB}/listings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Ingest-Token": TOKEN },
    body: JSON.stringify({ sourceId: SOURCE, records }),
  });
  if (!r.ok) throw new Error(`POST ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

await p.goto(START, { waitUntil: "domcontentloaded", timeout: 90000 });
await p.waitForTimeout(6000);
await install();

const seen = new Set();
let total = 0, matched = 0;
for (let page = 1; page <= MAX_PAGES; page++) {
  const out = await p.evaluate(() => {
    const reg = window.__REG;
    const recs = [];
    for (const c of reg.cards()) {
      try { const r = reg.parseCard(c); if (r) recs.push(r); } catch {}
    }
    return {
      records: recs,
      captcha: reg.detectCaptcha ? !!reg.detectCaptcha() : false,
      next: reg.hasNextPage ? reg.hasNextPage() : null,
      hasAdvance: typeof reg.advancePage === "function",
    };
  });
  if (out.captcha) { console.log(`  page ${page}: CAPTCHA/challenge detected — stopping`); break; }

  const fresh = out.records.filter((r) => {
    const k = String(r.sourceListingId);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  if (!fresh.length) { console.log(`  page ${page}: no new records — done`); break; }

  const res = await post(fresh.map(r => ({ ...r, scrapedAt: new Date().toISOString() })));
  total += fresh.length; matched += res.matched || 0;
  console.log(`  page ${page}: ${fresh.length} scraped, ${res.matched} matched (total ${total})`);

  if (out.hasAdvance) {
    const adv = await p.evaluate(() => window.__REG.advancePage());
    if (!adv) break;
    await p.waitForTimeout(2500);
  } else if (out.next) {
    await p.goto(out.next, { waitUntil: "domcontentloaded", timeout: 90000 });
    await p.waitForTimeout(5000);
    await install();
  } else break;
}
console.log(`${SOURCE}: TOTAL ${total} scraped, ${matched} matched`);
await b.close();
