# Standalone Playwright scraper image. Self-contained: the whole build context
# is THIS folder, so it works as its own GitHub repo + Railway service.
#
# Microsoft's official Playwright image = Debian + Chromium + every system lib
# the browser needs, pinned to a Playwright version. Keep this tag in sync with
# the `playwright` version in package.json.
FROM mcr.microsoft.com/playwright:v1.62.0-jammy

WORKDIR /app

# Install prod deps (pg + playwright). The base image already ships the browser
# binaries, so no `npx playwright install` step is needed.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# App code (flat layout — everything lives in this package).
COPY . .

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# One-shot: crawl Truck1 → load Postgres → exit. Railway's cron re-runs it.
CMD ["node", "run.js"]
