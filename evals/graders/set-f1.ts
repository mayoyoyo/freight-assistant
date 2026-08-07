import type { EvalCase, GraderResult, RunRecord } from "../lib/types";
import { containsAny, extractInquiryIds, normalizeId } from "./text";

/**
 * `set-f1` — set_retrieval bucket. Precision / recall / F1 of the inquiry ids
 * the answer names against the case's gold id set.
 *
 * Default threshold is 1.0 (exact set match). A case may lower it by putting
 * `f1_threshold` in its gold; none of the current six do, and that is the point
 * — every set case in this suite is scored as an exact set match.
 */

/**
 * Ids that are neither gold nor spurious: naming them neither helps recall nor
 * hurts precision. Hard-coded here (the cases file is read-only) with the notes
 * clause that authorizes each entry.
 */
const PRECISION_NEUTRAL_IDS: Record<string, string[]> = {
  // S02 notes: "CE0060 (Mohammed Al-Rashid, MC 678234) is availability='unknown'
  // and CE0061 is 'conditional', so both are OUTSIDE the gold set and must not
  // count against precision — but MC 678234 has insurance_expiry NULL, so IF
  // the answer mentions CE0060 it must carry the unknown-insurance caveat."
  // (That caveat is `compliance-surfacing`'s job, not this grader's.)
  S02: ["CE0060", "CE0061"],
};

/** Accepted renderings of "phone calls carry no date, so I could not filter them". */
const UNDATED_PHRASES = [
  "undated",
  "no date",
  "not dated",
  "without a date",
  "occurred_at is null",
  "occurred at is null",
  "no timestamp",
  "calls have no",
  "calls are not dated",
  "date-filtered",
  "cannot be date",
  "can't be date",
  "outside the date",
  "unfiltered",
  "no dates on",
];

function asStringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

export const setF1 = {
  name: "set-f1",
  grade(c: EvalCase, r: RunRecord): GraderResult {
    if (c.bucket !== "set_retrieval") {
      return {
        passed: true,
        reason: `n/a: bucket is ${c.bucket}, set-f1 grades set_retrieval only`,
      };
    }

    // S01/S02 score F1 over the DATED set only (their notes split the answer
    // into a dated set plus a separately-required undated-calls statement).
    const goldRaw =
      asStringArray(c.gold.dated_inquiry_ids).length > 0
        ? asStringArray(c.gold.dated_inquiry_ids)
        : asStringArray(c.gold.inquiry_ids);
    if (goldRaw.length === 0) {
      return {
        passed: false,
        reason: `set-f1: ${c.id} is a set_retrieval case with no gold id set (dated_inquiry_ids / inquiry_ids)`,
      };
    }

    const threshold =
      typeof c.gold.f1_threshold === "number" ? c.gold.f1_threshold : 1.0;

    const gold = new Set(goldRaw.map(normalizeId));
    const undated = asStringArray(c.gold.undated_call_ids).map(normalizeId);
    const excluded = asStringArray(c.gold.excluded_ids).map(normalizeId);
    const neutral = new Set([
      ...(PRECISION_NEUTRAL_IDS[c.id] ?? []).map(normalizeId),
      // Undated calls are required by name (checked below) and are
      // precision-neutral: they are correct to mention, wrong to score.
      ...undated,
    ]);

    const text = r.text ?? "";
    const found = extractInquiryIds(text);
    const scored = found.filter((id) => !neutral.has(id));

    const hits = scored.filter((id) => gold.has(id));
    const spurious = scored.filter((id) => !gold.has(id));
    const missing = [...gold].filter((id) => !found.includes(id));

    const precision = scored.length === 0 ? 0 : hits.length / scored.length;
    const recall = gold.size === 0 ? 0 : hits.length / gold.size;
    const f1 =
      precision + recall === 0
        ? 0
        : (2 * precision * recall) / (precision + recall);

    const round = (n: number) => Math.round(n * 1000) / 1000;
    const stats = `P=${round(precision)} R=${round(recall)} F1=${round(f1)} (threshold ${threshold})`;
    const detail = `missing=[${missing.join(", ")}] spurious=[${spurious.join(", ")}]`;

    const problems: string[] = [];
    if (f1 < threshold) problems.push(`F1 below threshold — ${detail}`);

    // S05: `excluded_ids` is a positive must-not-appear check, not merely a
    // precision penalty ("CE0046 ... is not an offer to cover").
    const wronglyIncluded = excluded.filter((id) => found.includes(id));
    if (wronglyIncluded.length > 0) {
      problems.push(
        `excluded id(s) named in the answer: ${wronglyIncluded.join(", ")}`,
      );
    }

    // S01/S02: the undated calls must be surfaced AND labelled undated.
    if (c.gold.must_state_calls_are_undated === true) {
      const missingCalls = undated.filter((id) => !found.includes(id));
      if (missingCalls.length > 0) {
        problems.push(
          `undated call(s) omitted silently: ${missingCalls.join(", ")}`,
        );
      }
      if (!containsAny(text, UNDATED_PHRASES)) {
        problems.push(
          "must_state_calls_are_undated: answer never says calls are undated / unfiltered",
        );
      }
    }

    if (problems.length > 0) {
      return {
        passed: false,
        reason: `set-f1 ${c.id}: ${stats} — ${problems.join("; ")}`,
      };
    }
    return {
      passed: true,
      reason: `set-f1 ${c.id}: ${stats} — ${detail}`,
    };
  },
};
