#!/usr/bin/env node
// usedvolvotrucks.com — DOCUMENTED STUB (blocked from plain HTTP).
//
// Probe (2026-07): the connection is refused/reset before any response
// (curl exit "connection 000"), across HTTP/1.1 + HTTP/2 and with full browser
// headers. The edge (Akamai/CDN) appears to drop non-browser TLS fingerprints
// and/or datacenter IPs outright — nothing is returned to parse.
//
// To enable: a headless browser with a real TLS fingerprint AND, most likely, a
// residential IP / proxy (a datacenter IP alone was refused here). Once a page
// loads, parse listings + detail pages via scrape-core.js.
import { reportBlocked } from "./lib/blocked-source.js";

reportBlocked({
  name: "usedvolvo",
  domain: "usedvolvotrucks.com",
  reason: "Connection refused at the edge (blocks non-browser TLS and/or datacenter IPs).",
  needs: "Headless browser with a real TLS fingerprint + a residential IP/proxy.",
});
