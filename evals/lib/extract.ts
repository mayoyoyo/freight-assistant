/**
 * Pure extractors that turn a raw tool result into the two things the graders
 * need: the set of citable ids it returned, and the set of dollar figures it
 * exposed. Kept out of the graders so the expensive generation pass records
 * them once and every later re-grade is free and deterministic.
 */

/**
 * Keys whose values are citable ids in this corpus. Mirrors the citation
 * vocabulary in `src/lib/agent/system-prompt.ts`: inquiry ids, load ids and MC
 * numbers are the only things the agent is allowed to cite.
 */
const ID_KEYS = new Set([
  "id",
  "load_id",
  "mc_number",
  "dot_number",
  "resolved_carrier_mc",
  "extracted_mc_number",
  "extracted_load_reference",
]);

/** Keys carrying a USD amount. `*_per_mile` is a rate, and also quotable. */
function isFigureKey(key: string): boolean {
  return (
    key.endsWith("_usd") || key.includes("rate_per_mile") || key === "rate_usd"
  );
}

/** `$1,234`, `$1,234.56`, `$ 890` — the forms a model writes money in. */
export const DOLLAR_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g;

/** Every dollar figure written as text inside a blob (snippets, raw bodies). */
export function dollarFiguresInText(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(DOLLAR_RE)) {
    const whole = (m[1] ?? "").replace(/,/g, "");
    const frac = m[2] ?? "";
    const n = Number(frac ? `${whole}.${frac}` : whole);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function walk(
  value: unknown,
  onEntry: (key: string, value: unknown) => void,
): void {
  if (Array.isArray(value)) {
    for (const v of value) walk(v, onEntry);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    onEntry(k, v);
    walk(v, onEntry);
  }
}

/** Every citable id anywhere in a tool result, deduped, insertion-ordered. */
export function idsInToolResult(output: unknown): string[] {
  const seen = new Set<string>();
  walk(output, (key, value) => {
    if (!ID_KEYS.has(key)) return;
    if (typeof value === "string" && value.length > 0) seen.add(value);
    else if (typeof value === "number") seen.add(String(value));
  });
  return [...seen];
}

/**
 * Every dollar figure a tool result exposed — both structured (`*_usd` keys)
 * and textual (a `$280` inside a raw-text snippet). The textual half matters:
 * case L08 turns on the body figure $280 while the extracted column says 2800.
 */
export function figuresInToolResult(output: unknown): number[] {
  const seen = new Set<number>();
  walk(output, (key, value) => {
    if (isFigureKey(key) && typeof value === "number") seen.add(value);
    if (typeof value === "string") {
      for (const n of dollarFiguresInText(value)) seen.add(n);
    }
  });
  return [...seen].sort((a, b) => a - b);
}
