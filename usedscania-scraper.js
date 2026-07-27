#!/usr/bin/env node
// used.scania.com — DOCUMENTED STUB (blocked from plain HTTP).
//
// Probe (2026-07): GET returns a small JavaScript SPA shell (~1.3 KB, title
// "Scania Used Vehicles - Product Details") with no listing data in the initial
// HTML — the inventory is fetched client-side from a backend API after load.
//
// To enable: EITHER capture the JSON API the SPA calls (open the site in a
// browser, watch the network tab for the search/inventory XHR, and replay that
// endpoint directly — usually the cleanest, fastest path and often needs no
// browser at runtime), OR render the SPA in a headless browser and scrape the
// hydrated DOM. Prefer the API route if one is reachable.
import { reportBlocked } from "./lib/blocked-source.js";

reportBlocked({
  name: "usedscania",
  domain: "used.scania.com",
  reason: "JavaScript SPA — inventory loads client-side from a backend API, not in initial HTML.",
  needs: "Capture the SPA's inventory JSON API (preferred), or render with a headless browser.",
});
