import { parseLots } from "./euroauctions-scraper.js";
import { readFileSync } from "node:fs";
const a = JSON.parse(readFileSync(process.argv[2], "utf8"));
const page = a.find((x) => (x.html || "").length > 100000);
const lots = parseLots(page.html, "1049");
console.log("parsed lots:", lots.length);
for (const l of lots.slice(0, 8)) {
  console.log(` ${l.itemId} | ${String(l.title).slice(0,30).padEnd(30)} | bid=${l.bid}${l.currency} | bids=${l.bidsCount} | ${l.city},${l.country} | ${l.status}`);
}
const withBid = lots.filter(l=>l.bid).length, withLoc = lots.filter(l=>l.city).length, withExt = lots.filter(l=>l.externalId).length;
console.log(`\nbid=${withBid}/${lots.length} loc=${withLoc}/${lots.length} extId=${withExt}/${lots.length}`);
