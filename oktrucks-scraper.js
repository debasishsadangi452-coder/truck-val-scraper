#!/usr/bin/env node
// oktrucks.com (IVECO OK Trucks) — DOCUMENTED STUB (blocked from plain HTTP).
//
// Probe (2026-07): same signature as usedvolvotrucks.com — the connection is
// refused/reset before any response (curl "connection 000"), across HTTP
// versions and with browser headers. The edge blocks non-browser clients
// and/or datacenter IPs, so there is no HTML to parse.
//
// To enable: headless browser with a real TLS fingerprint + a residential
// IP/proxy, then parse the used-trucks listing + detail pages via scrape-core.js.
import { reportBlocked } from "./lib/blocked-source.js";

reportBlocked({
  name: "oktrucks",
  domain: "oktrucks.com",
  reason: "Connection refused at the edge (blocks non-browser TLS and/or datacenter IPs).",
  needs: "Headless browser with a real TLS fingerprint + a residential IP/proxy.",
});
