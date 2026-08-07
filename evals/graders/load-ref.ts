import type { EvalCase, GraderResult, RunRecord } from "../lib/types";

/**
 * `load-ref-present` — a draft that names no load number is unusable to the
 * carrier reading it. Applies to any case whose gold sets `load_ref_required`
 * (all five email_draft cases).
 *
 * The check is a digits-only substring, so "#29372343", "load 29372343" and
 * "29372343" all pass; a wrong load number fails because its digits differ.
 */
export const loadRefPresent = {
  name: "load-ref-present",
  grade(c: EvalCase, r: RunRecord): GraderResult {
    const ref = c.gold.load_ref_required;
    if (typeof ref !== "string" || ref.length === 0) {
      return {
        passed: true,
        reason: "n/a: gold has no load_ref_required",
      };
    }
    const text = r.text ?? "";
    if (!text.includes(ref)) {
      return {
        passed: false,
        reason: `load-ref-present: load ${ref} never appears in the answer`,
      };
    }
    return {
      passed: true,
      reason: `load-ref-present: load ${ref} appears in the answer`,
    };
  },
};
