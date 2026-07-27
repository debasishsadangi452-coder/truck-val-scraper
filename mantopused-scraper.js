// man-topused.com (MAN TopUsed) — DOCUMENTED STUB (endpoint unresolved).
//
// Probe (2026-07): every man-topused.com path (and mantopused.com) 301-redirects
// to the MAN corporate site www.man.eu/...homepage.html — there is no standalone
// used-truck marketplace at this domain anymore. The old TopUsed marketplace
// appears to have been retired, moved, or folded into MAN's "Trucker's World" /
// used-vehicles section, which was not resolvable to a scrapable listing feed
// during probing.
//
// To enable: find MAN's current used-truck inventory source. Candidates to
// investigate: the used-vehicles area under man.eu, MAN "Trucker's World"
// (truckers-world.eu), or a regional MAN used-truck portal — then check whether
// it exposes listing HTML or a JSON API and implement against scrape-core.js.
import { reportBlocked } from "./lib/blocked-source.js";

reportBlocked({
  name: "mantopused",
  domain: "man-topused.com",
  reason:
    "Domain redirects to man.eu corporate; no standalone TopUsed marketplace/listing feed found.",
  needs:
    "Locate MAN's current used-truck inventory (man.eu used-vehicles / Trucker's World), then implement.",
});
