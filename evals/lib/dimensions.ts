/**
 * Dimensional tags for the 24 reported cases.
 *
 * The dimensions are the design doc's: question type x entity ambiguity x data
 * availability x time scope. They are NOT stored in `cases.jsonl` (that file is
 * the labeler's artifact and is read-only here), and they are NOT inferred from
 * the query string — a regex over prose would silently mis-tag and the coverage
 * table would then be decoration rather than evidence. So they are hand-assigned
 * once, here, with the assignment visible and auditable next to the id.
 *
 * `question type` is deliberately finer than `bucket`: L04 is a compliance
 * question that happens to live in the lookup bucket, L07/A03 are rate
 * questions. Collapsing them to the bucket would hide the two thinnest cells.
 */
import type { EvalCase } from "./types";

export type QuestionType = "lookup" | "set" | "rate" | "draft" | "compliance";

/** How well the entity in the question maps onto a record. */
export type Ambiguity = "clean" | "garbled_or_flagged" | "absent";

/** Whether the corpus can answer at all. `absent` cases must abstain. */
export type Availability = "present" | "absent";

/** Explicit time constraint in the question. */
export type TimeScope = "none" | "this_week" | "window";

export type Dimensions = {
  question_type: QuestionType;
  ambiguity: Ambiguity;
  availability: Availability;
  time_scope: TimeScope;
};

export const DIMENSIONS: Record<string, Dimensions> = {
  // ---- factual lookup ----
  L01: d("lookup", "clean", "present", "none"), // best offer on a load
  L02: d("lookup", "garbled_or_flagged", "present", "none"), // self-corrected MC on tape
  L03: d("lookup", "garbled_or_flagged", "present", "none"), // planted wrong MC, name-resolved
  L04: d("compliance", "clean", "present", "window"), // "right now" = as of snapshot
  L05: d("lookup", "clean", "present", "none"), // max box-truck quote
  L06: d("lookup", "garbled_or_flagged", "present", "none"), // ASR-mangled company name
  L07: d("rate", "clean", "present", "window"), // 4-week market comparison
  L08: d("lookup", "garbled_or_flagged", "present", "none"), // discrepancy-flagged record
  // ---- set retrieval ----
  S01: d("set", "clean", "present", "this_week"),
  S02: d("set", "clean", "present", "this_week"),
  S03: d("set", "garbled_or_flagged", "present", "none"), // the garbled-MC set itself
  S04: d("set", "garbled_or_flagged", "present", "this_week"), // discrepancy-flagged set
  S05: d("set", "clean", "present", "none"),
  S06: d("set", "garbled_or_flagged", "present", "none"), // "PAMD" as one ASR token
  // ---- email draft ----
  D01: d("draft", "clean", "present", "none"),
  D02: d("draft", "clean", "absent", "none"), // the "best rate" asked for does not exist
  D03: d("draft", "clean", "present", "none"),
  D04: d("draft", "clean", "present", "none"),
  D05: d("draft", "garbled_or_flagged", "present", "none"), // Rami / Rummy
  // ---- abstention ----
  A01: d("lookup", "absent", "absent", "none"),
  A02: d("lookup", "absent", "absent", "none"), // "Sarah" decoy
  A03: d("rate", "clean", "absent", "window"), // real lane, missing equipment slice
  A04: d("compliance", "absent", "absent", "none"), // similar-name trap
  A05: d("compliance", "absent", "absent", "none"), // MC-keyed lookup can't reach the row
};

function d(
  question_type: QuestionType,
  ambiguity: Ambiguity,
  availability: Availability,
  time_scope: TimeScope,
): Dimensions {
  return { question_type, ambiguity, availability, time_scope };
}

export const QUESTION_TYPES: QuestionType[] = [
  "lookup",
  "set",
  "rate",
  "draft",
  "compliance",
];
export const AMBIGUITIES: Ambiguity[] = [
  "clean",
  "garbled_or_flagged",
  "absent",
];
export const AVAILABILITIES: Availability[] = ["present", "absent"];
export const TIME_SCOPES: TimeScope[] = ["none", "this_week", "window"];

/** Throws if a case has no dimension tuple — the table can't drift silently. */
export function dimensionsFor(c: EvalCase): Dimensions {
  const dim = DIMENSIONS[c.id];
  if (!dim)
    throw new Error(
      `case ${c.id} has no entry in evals/lib/dimensions.ts — add one`,
    );
  return dim;
}
