/**
 * Shared, pure text primitives for the code graders.
 *
 * Nothing in this file does I/O, reads a clock, or touches the network — every
 * export is a deterministic function of its arguments. That is what makes the
 * whole grading pass re-runnable for free (`pnpm eval --grade-only <file>`).
 */

/**
 * Fold typographic punctuation to ASCII before any matching.
 *
 * OpenAI models emit curly apostrophes ("can’t", U+2019), which silently miss
 * every ASCII-quoted pattern in this suite — `can'?t`, `\bdon't\b`, phrase
 * lists. Discovered when gpt-5.6-luna false-failed the whole abstention bucket
 * on refusals that were correct on their face. Claude emits ASCII apostrophes,
 * so the miscalibration was invisible until a second provider ran.
 */
export function foldPunctuation(text: string): string {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-");
}

/** Lowercase + collapse whitespace. The normal form for substring checks. */
export function normalize(text: string): string {
  return foldPunctuation(text).toLowerCase().replace(/\s+/g, " ");
}

/** Case-insensitive, whitespace-insensitive substring check. */
export function containsString(text: string, needle: string): boolean {
  return normalize(text).includes(normalize(needle));
}

/** True if ANY of `needles` is present (the `one-of` assertion primitive). */
export function containsAny(text: string, needles: readonly string[]): boolean {
  const hay = normalize(text);
  return needles.some((n) => hay.includes(normalize(n)));
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every surface form a grader accepts for a gold number.
 *
 *   890    -> "890", "890.0", "890.00", "890"        (+ thousands separators)
 *   1480355-> "1480355", "1,480,355", …
 *   5.09   -> "5.09", "5.090"
 *   3.925  -> "3.925", "3.93" (round), "3.92" (truncate)
 *
 * The 2-decimal roundings of a 3-decimal gold are deliberate: `market_rate`
 * returns 3.925 and a broker-facing answer legitimately renders that as
 * "$3.93/mi" or "$3.92/mi". Accepting both is a tolerance, not a hole — the
 * failure this grader exists to catch is a *different* number, not a rounding.
 */
export function numberForms(n: number): string[] {
  const forms = new Set<string>();
  forms.add(String(n));
  if (Number.isInteger(n)) {
    forms.add(`${n}.0`);
    forms.add(`${n}.00`);
    forms.add(n.toLocaleString("en-US"));
  } else {
    forms.add((Math.round(n * 100) / 100).toFixed(2));
    forms.add((Math.floor(n * 100) / 100).toFixed(2));
    forms.add(n.toFixed(3));
  }
  return [...forms];
}

/**
 * Is `n` present in `text` as a standalone number?
 *
 * Tolerant of a leading `$` and of trailing-zero / thousands renderings; strict
 * about boundaries, so 890 does NOT match inside 1890, 8900 or 890.50.
 */
export function numberPresent(text: string, n: number): boolean {
  return numberForms(n).some((form) => {
    const re = new RegExp(
      `(?<![\\d.,])\\$?\\s?${escapeRegExp(form)}(?!\\d)(?!\\.\\d)`,
    );
    return re.test(text);
  });
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * Is the ISO date `iso` (YYYY-MM-DD) present, in ISO form or in the two US
 * renderings a broker-facing answer actually uses ("May 15, 2026", "5/15/2026")?
 */
export function datePresent(text: string, iso: string): boolean {
  const hay = normalize(text);
  if (hay.includes(iso)) return true;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const year = m[1] as string;
  const mm = m[2] as string;
  const dd = m[3] as string;
  const month = MONTHS[Number(mm) - 1];
  const day = String(Number(dd));
  if (month) {
    const long = new RegExp(
      `\\b${month}\\.?\\s+${day}(st|nd|rd|th)?,?\\s+${year}\\b`,
      "i",
    );
    const short = new RegExp(
      `\\b${month.slice(0, 3)}\\.?\\s+${day}(st|nd|rd|th)?,?\\s+${year}\\b`,
      "i",
    );
    if (long.test(hay) || short.test(hay)) return true;
  }
  const numeric = new RegExp(
    `\\b0?${Number(mm)}/0?${Number(dd)}/(${year}|${year.slice(2)})\\b`,
  );
  return numeric.test(hay);
}

/** Split into sentence-ish spans. Newlines and bullets end a span too. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+|(?:^|\s)[-•*]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const NEGATION =
  /\b(no|nobody|no one|none|nor|neither|not|never|nothing|cannot|can't|won't|wouldn't|don't|doesn't|didn't|isn't|aren't|wasn't|hasn't|haven't|unable|without|unknown|unverified|lacks?|missing)\b/i;

/** Does this span carry a negation / absence marker? */
export function hasNegation(span: string): boolean {
  return NEGATION.test(span);
}

// ---------------------------------------------------------------------------
// Dollar figures
// ---------------------------------------------------------------------------

/**
 * Every `$`-denominated figure in `text`.
 *
 * Rate-per-mile renderings (`$5.09/mi`, `$3.93 per mile`) are deliberately
 * SKIPPED: they are arithmetic derived from two sourced numbers, not a quoted
 * figure, so they are not expected to appear verbatim in any tool result.
 */
export function dollarFigures(text: string): number[] {
  const out: number[] = [];
  const re = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(\/\s*mi\w*|per\s+mile)?/gi;
  let m = re.exec(text);
  while (m !== null) {
    if (!m[2]) {
      const n = Number((m[1] as string).replace(/,/g, ""));
      if (!Number.isNaN(n)) out.push(n);
    }
    m = re.exec(text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Citations and ids
// ---------------------------------------------------------------------------

/**
 * Normalize one citable id into the comparison space used by `groundedness`
 * and `set-f1`.
 *
 *   CE0044                        -> "CE0044"
 *   call_017_availability_check   -> "CALL_017"   (calls are cited by prefix)
 *   load 29372515 / 29372515      -> "29372515"
 *   MC 876543 / 876543            -> "876543"
 */
export function normalizeId(raw: string): string {
  const id = raw.trim();
  const call = /^call[_\s]?(\d+)/i.exec(id);
  if (call) return `CALL_${call[1]}`;
  const load = /^load\s*#?\s*(\d{4,})$/i.exec(id);
  if (load) return load[1] as string;
  const mc = /^mc\s*#?\s*(\d{3,})$/i.exec(id);
  if (mc) return mc[1] as string;
  return id.toUpperCase();
}

/**
 * Every id a tool result made available, in normalized form. Call ids are
 * added BOTH in full and as their `call_NNN` prefix, because the system prompt
 * tells the agent to cite the prefix.
 */
export function toolIdSet(ids: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const raw of ids) {
    const id = raw.trim();
    if (!id) continue;
    set.add(id.toUpperCase());
    set.add(normalizeId(id));
  }
  return set;
}

export type Citation = { raw: string; token: string };

/**
 * Classify one comma-part of a bracket span as a citation, or reject it.
 *
 * The four forms the system prompt defines are `[CE0074]`, `[call_006]`,
 * `[load 29372515]` and `[MC 876543]`. A bare digit run of 5+ digits is also
 * accepted (a load id or MC written without its keyword); 1–4 digit spans are
 * NOT, so markdown footnotes `[1]`, `[12]` never become phantom citations.
 */
export function classifyCitationPart(part: string): Citation | null {
  const p = part.trim().replace(/^#/, "");
  if (!p) return null;
  if (/^CE\d{3,5}$/i.test(p)) return { raw: p, token: p.toUpperCase() };
  if (/^call[_\s]?\d+(_[a-z_]+)?$/i.test(p))
    return { raw: p, token: normalizeId(p) };
  if (/^load\s*#?\s*\d{4,}$/i.test(p)) return { raw: p, token: normalizeId(p) };
  if (/^mc\s*#?\s*\d{3,}$/i.test(p)) return { raw: p, token: normalizeId(p) };
  if (/^\d{5,}$/.test(p)) return { raw: p, token: p };
  return null;
}

/**
 * Every id-citation in `text`.
 *
 * Rule for what is NOT a citation (documented so it can't drift):
 *  1. A span immediately followed by `(` is a markdown link — skipped whole.
 *  2. A span is split on `,` `;` and ` and `; each part is classified
 *     independently. Parts that match none of the id forms are IGNORED, not
 *     failed — so `[see below]`, `[1]`, `[Reed Barlus]` produce nothing.
 *  3. Consequently a span like `[CE0044, see below]` still yields CE0044.
 */
export function parseCitations(text: string): Citation[] {
  const out: Citation[] = [];
  const re = /\[([^\][\n]{1,160})\]/g;
  let m = re.exec(text);
  while (m !== null) {
    const after = text[m.index + m[0].length];
    if (after !== "(") {
      const parts = (m[1] as string).split(/\s*(?:,|;|\band\b)\s*/i);
      for (const part of parts) {
        const c = classifyCitationPart(part);
        if (c) out.push(c);
      }
    }
    m = re.exec(text);
  }
  return out;
}

/**
 * Every inquiry id mentioned anywhere in `text` (not just inside brackets) —
 * the candidate set for `set-f1`. Returned normalized and de-duplicated, in
 * order of first appearance.
 */
export function extractInquiryIds(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /\b(CE\d{4}|call_\d+(?:_[a-z_]+)?)\b/gi;
  let m = re.exec(text);
  while (m !== null) {
    const token = normalizeId(m[1] as string);
    if (!seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
    m = re.exec(text);
  }
  return out;
}
