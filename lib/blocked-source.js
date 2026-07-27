// Helper for the source scrapers that CANNOT run with plain HTTP requests.
//
// Seven of the nine target sites were probed live (2026-07) and found to need
// a real browser and/or a residential IP — a plain fetch/Scrapy crawl is
// blocked before any listing HTML is returned. Rather than ship parsers that
// can't be reached (and would silently produce nothing), each such site gets a
// named entry-point script that documents exactly what blocks it and what has
// to change to enable it, and exits non-zero so a scheduler doesn't treat a
// no-op as success.
//
// When browser support is added (Playwright/Puppeteer), fill in `render(url)`
// to return the post-JS HTML and delete the guard — the parsing half of each
// scraper can then be written against the shared core exactly like autoline.
export function reportBlocked({ name, domain, reason, needs }) {
  console.error(`\n[${name}] cannot scrape ${domain} with plain HTTP requests.`);
  console.error(`  Reason:  ${reason}`);
  console.error(`  Needs:   ${needs}`);
  console.error(
    `  This scraper is a documented stub — wire up a headless browser (and, where\n` +
      `  noted, a residential IP/proxy) to enable it, then implement the parser\n` +
      `  against scripts/lib/scrape-core.js the same way autoline-trucks-scraper.js does.\n`,
  );
  process.exit(2);
}
