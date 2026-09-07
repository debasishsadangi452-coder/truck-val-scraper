// Tiny HTML/JSON-LD parsing helpers shared by the source scrapers, so no
// cheerio/jsdom dependency is needed. These are deliberately regex-based and
// forgiving — a source parser stays readable and a malformed page degrades to
// missing fields rather than throwing.

// All <script type="application/ld+json"> payloads on a page, JSON-parsed.
// Bad blocks are skipped. Some sites wrap several JSON-LD objects in one array;
// this flattens those so callers always get a flat list of objects.
export function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let parsed;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) out.push(...parsed);
    else out.push(parsed);
  }
  return out;
}

// True if a JSON-LD node's @type matches `type`, handling both the scalar
// ("Product") and array (["Product","Vehicle"]) forms schema.org allows.
export function isType(node, type) {
  const t = node?.["@type"];
  if (!t) return false;
  return Array.isArray(t) ? t.includes(type) : t === type;
}

export function findJsonLd(nodes, type) {
  return nodes.find((n) => isType(n, type)) ?? null;
}

// Turn additionalProperty [{name,value}] into a flat lookup { name: value }.
export function propMap(additionalProperty) {
  const map = {};
  for (const p of additionalProperty ?? []) {
    if (p?.name != null) map[String(p.name).toLowerCase()] = p.value;
  }
  return map;
}

// First capture group of `re` against `str`, trimmed, or "".
export function firstMatch(str, re) {
  const m = String(str ?? "").match(re);
  return m ? m[1].trim() : "";
}

// Digits only (drops units/spaces/thousands separators): "462 000 km" -> "462000".
export function digits(value) {
  return String(value ?? "").replace(/[^\d]/g, "");
}

// Strip all tags and collapse whitespace to get an element's visible text.
export function stripTags(html) {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    // "6×2" axle configs are commonly entity-encoded (&#215; / &times;) rather
    // than typed as a literal multiplication sign — decode it so axle regexes
    // ([2468]x[2468]) matching against the stripped text still fire.
    .replace(/&#215;|&times;/gi, "×")
    .replace(/\s+/g, " ")
    .trim();
}

// Extract every href matching `pattern` (a RegExp with the URL in group 1 or
// the whole match), returning a de-duplicated, order-preserving list. Used to
// harvest detail-page links from a list page.
export function extractLinks(html, pattern) {
  const seen = new Set();
  const out = [];
  const re = new RegExp(`href=["'](${pattern})["']`, "gi");
  let m;
  while ((m = re.exec(html))) {
    const url = m[1];
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}
