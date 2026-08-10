// Canonical truck-model normalizer.
//
// Scraped model strings are wildly inconsistent — the same real model appears as
// "XF 480", "XF480", "FT XF 480", "XF 480 SSC*ACC*2Tanks*", "XFN 480". This maps
// any of those to one uniform canonical name like "XF 480" for grouping,
// counting and CRM matching. The original `model` is preserved verbatim; the
// canonical value is stored alongside as `model_normalized`.
//
// Strategy per make family:
//   DAF   : <XF|XG|XD|CF|LF|XB> + engine power (3-digit 180-799); chassis codes
//           (105/106/95/85…) only used when there's no power number.
//   VOLVO : <FH16|FMX|FH|FM|FL|FE|VM> + power. FH16 is its own family.
//   MAN   : <TGX|TGS|TGM|TGL|TGA|TGE> + the NN.NNN chassis.power code.
//   FORD  : keyword map (F-MAX / Transit / Cargo NNNN / Ranger / F-Line).
//   other : first alpha token + first number group (best-effort).
// When no series can be identified, falls back to the cleaned raw string so we
// never invent a wrong model — a messy-but-true value beats a confident guess.

const AXLE = /\b[2468]\s*[xX×]\s*[2468]\b/g;

// Uppercase, unglue letters/digits, strip axle configs and punctuation noise.
function clean(s) {
  return (" " + String(s).toUpperCase() + " ")
    .replace(/\bF[\s-]*MAX\b/g, "F-MAX") // "F MAX", "FMAX", "F-MAX" -> F-MAX
    .replace(AXLE, " ")
    .replace(/([A-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Z])/g, "$1 $2")
    .replace(/[*/,()]/g, " ")
    .replace(/[–]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// Match a series token as a whole word OR as the prefix of a token (so "XFN",
// "XFC" fold into "XF"; "TGXL" into "TGX"). Anchored at a word start to avoid
// matching mid-token junk.
const hasWord = (s, t) => new RegExp(`(^| )${t}`).test(" " + s + " ");
function pickSeries(s, order) {
  for (const t of order) if (hasWord(s, t)) return t;
  return null;
}

/**
 * Normalize a (make, model) pair to a canonical model string, e.g.
 *   ("daf", "FT XF 480 Super Space Cab") -> "XF 480"
 *   ("man", "Tgx 18.470 BL SA")          -> "TGX 18.470"
 * Returns null only when model is empty.
 */
export function normalizeModel(make, model) {
  if (!model || !String(model).trim()) return null;
  const mk = String(make || "").toLowerCase().trim();
  const s = clean(model);
  const power = () => (s.match(/\b(1[89]\d|[2-7]\d\d)\b/) || [])[0] || ""; // 180..799
  const manCode = () => (s.match(/\b\d{2}\.\d{3}\b/) || [])[0] || "";
  const fallback = () => s || null;

  if (mk === "daf") {
    const ser = pickSeries(s, ["XF", "XG", "XD", "CF", "LF", "XB"]);
    if (!ser) return fallback();
    const p = power();
    if (p) return `${ser} ${p}`;
    const chassis = (s.match(/\b(105|106|95|85|75|65|55|45)\b/) || [])[0];
    return chassis ? `${ser} ${chassis}` : ser;
  }
  if (mk === "volvo") {
    const ser = pickSeries(s, ["FH16", "FMX", "FH", "FM", "FL", "FE", "VM"]);
    if (!ser) return fallback();
    if (ser === "FH16") return "FH16";
    const p = power();
    return p ? `${ser} ${p}` : ser;
  }
  if (mk === "man") {
    const ser = pickSeries(s, ["TGX", "TGS", "TGM", "TGL", "TGA", "TGE"]);
    const code = manCode(); // preferred: NN.NNN chassis.power
    if (ser) return code ? `${ser} ${code}` : power() ? `${ser} ${power()}` : ser;
    return code || fallback();
  }
  if (mk === "ford") {
    if (/F-MAX/.test(s)) return "F-MAX";
    if (/TRANSIT/.test(s)) return "TRANSIT";
    if (/RANGER/.test(s)) return "RANGER";
    if (/F-LINE/.test(s)) return "F-LINE";
    if (/CARGO/.test(s)) {
      const n = (s.match(/\b\d{4}\b/) || [])[0];
      return n ? `CARGO ${n}` : "CARGO";
    }
    return fallback();
  }

  // Generic best-effort for every other make.
  const first = (s.match(/[A-Z][A-Z-]{1,}/) || [])[0] || "";
  const num = (s.match(/\b\d{2,3}(?:\.\d{3})?\b/) || [])[0] || "";
  return (first + (num ? ` ${num}` : "")).trim() || fallback();
}
