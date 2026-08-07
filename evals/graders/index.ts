import type { EvalCase, GraderResult, RunRecord } from "../lib/types";
import { abstention } from "./abstention";
import { complianceSurfacing } from "./compliance-surfacing";
import { dollarFiguresSubset } from "./dollar-figures";
import { exactMatch } from "./exact-match";
import { groundedness } from "./groundedness";
import { loadRefPresent } from "./load-ref";
import { requiredTools } from "./required-tools";
import { setF1 } from "./set-f1";

/**
 * A code grader: pure, synchronous, `(case, run) => {passed, reason}`.
 *
 * No I/O, no API calls, no DB — a grader reads only `run.text`, `run.tools[]`
 * and the case. That is what makes a re-grade free and byte-reproducible:
 * `pnpm eval --grade-only <runs file>` replays the same verdicts forever.
 *
 * N/A CONTRACT (relied on downstream): when a grader does not apply to a case
 * it returns `{passed: true, reason: "n/a: <why>"}`. The `n/a:` prefix is
 * literal — `report.ts` counts it to separate "applied and passed" from "never
 * applied", and `RunRecord.passed` is the AND over the non-N/A verdicts only.
 */
export type Grader = {
  name: string;
  grade(c: EvalCase, r: RunRecord): GraderResult;
};

/**
 * The code graders, in a stable order. The order is part of the contract: it is
 * the column order in `report.ts` and the tie-break order when a run fails more
 * than one check, so appending is safe and reordering is not.
 *
 *   1–2  cross-cutting  — apply to every bucket (trajectory, then citations)
 *   3–6  bucket-specific — one bucket each, in the case-file's bucket order
 *   7–8  cross-cutting safety — compliance surfacing, then abstention
 *
 * Reading a failure top-down therefore goes: did it call the right tools? did
 * it cite real records? did it get the facts right? did it stay safe?
 */
export const CODE_GRADERS: Grader[] = [
  requiredTools, // 1. every case  — membership + args subset, not order
  groundedness, // 2. every case  — [CE0074] / [call_006] / [load N] / [MC N]
  exactMatch, // 3. factual_lookup
  setF1, // 4. set_retrieval
  dollarFiguresSubset, // 5. email_draft (+ any case with allowed_dollar_figures)
  loadRefPresent, // 6. email_draft (any case with gold.load_ref_required)
  complianceSurfacing, // 7. any case with compliance_must_surface
  abstention, // 8. abstention
];

export {
  abstention,
  complianceSurfacing,
  dollarFiguresSubset,
  exactMatch,
  groundedness,
  loadRefPresent,
  requiredTools,
  setF1,
};

/** True when a verdict means "this grader did not apply to this case". */
export function isNotApplicable(v: GraderResult): boolean {
  return v.reason.startsWith("n/a:");
}
