// Headless-browser rendering for the source scrapers that plain HTTP can't
// reach — JS-gated sites (cookie challenges, reCAPTCHA browser-checks) and
// client-rendered listing pages. Wraps Playwright/Chromium behind the same
// tiny surface the fetch-based scrapers use, so a source scraper only needs a
// `render(url) -> post-JS HTML string` and its existing parser takes over.
//
// Playwright is an OPTIONAL dependency: it's only imported when a browser
// scraper actually runs, so the fetch-based scrapers (otomoto, autoline,
// truck7) keep working with zero new install. If it's missing, withBrowser
// throws a clear "npm install playwright" message rather than a cryptic error.
//
// One browser + one context is shared across a whole crawl (cheap; a fresh
// page per fetch keeps state clean). A realistic UA + viewport + locale reduce
// trivial bot flags; this is NOT an anti-detection framework — sites that block
// datacenter IPs outright still need a residential proxy (pass `proxy`).

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error(
      "Playwright is not installed. Run `npm install --save-dev playwright` and " +
        "`npx playwright install chromium` to enable browser-based scrapers.",
    );
  }
}

// Open a browser session, hand a `render`-capable client to `fn`, and always
// tear the browser down afterwards. Usage:
//   await withBrowser(async ({ render }) => { const html = await render(url); ... });
// Options:
//   headless  (default true) — set false to watch it while debugging.
//   proxy     e.g. "http://user:pass@host:port" for the IP-blocked sites.
//   blockAssets (default true) — skip images/fonts/media for speed; keeps CSS/JS.
export async function withBrowser(fn, { headless = true, proxy, blockAssets = true } = {}) {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    headless,
    proxy: proxy ? { server: proxy } : undefined,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: "en-US",
    viewport: { width: 1366, height: 900 },
  });
  if (blockAssets) {
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "font" || type === "media") return route.abort();
      return route.continue();
    });
  }

  // Render a URL to its post-JS HTML. `waitFor` (a CSS selector) lets a source
  // block until its listings have hydrated; otherwise we wait for the network
  // to go idle. `settleMs` adds a small grace period for late JS. Returns the
  // full page HTML (what document.documentElement.outerHTML yields).
  async function render(url, { waitFor, settleMs = 800, timeout = 45000 } = {}) {
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      if (waitFor) {
        await page.waitForSelector(waitFor, { timeout }).catch(() => {});
      } else {
        await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
      }
      if (settleMs) await page.waitForTimeout(settleMs);
      return await page.content();
    } finally {
      await page.close();
    }
  }

  try {
    return await fn({ render, context, browser });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
