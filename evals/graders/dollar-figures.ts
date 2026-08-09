import type { EvalCase, GraderResult, RunRecord } from "../lib/types";
import { dollarFigures, foldPunctuation } from "./text";

/**
 * `dollar-figures-subset` — every `$` figure in the answer must be a figure the
 * run actually saw.
 *
 * allowed = (every figure in this run's tool results) ∪ (gold.allowed_dollar_figures)
 *
 * APPLICABILITY RULE (stated, because a wider rule would be unsound):
 * applies to `email_draft` cases and to any case whose gold carries
 * `allowed_dollar_figures`. It deliberately does NOT apply to lookup/set/
 * abstention answers, because those legitimately contain *derived* money
 * arithmetic — L07's "$5.09/mi" is 275/54, a number no tool ever returned — and
 * a subset check would fail it for being right. Drafts quote figures, they do
 * not compute them, which is exactly where the subset property holds.
 *
 * Rate-per-mile renderings are stripped by `dollarFigures` for the same reason.
 */
export const dollarFiguresSubset = {
  name: "dollar-figures-subset",
  grade(c: EvalCase, r: RunRecord): GraderResult {
    const goldAllowed = Array.isArray(c.gold.allowed_dollar_figures)
      ? c.gold.allowed_dollar_figures.filter(
          (n): n is number => typeof n === "number",
        )
      : null;

    if (c.bucket !== "email_draft" && goldAllowed === null) {
      return {
        passed: true,
        reason: `n/a: bucket is ${c.bucket} and gold has no allowed_dollar_figures — the subset property only holds for quoted (non-derived) figures`,
      };
    }

    const fromTools = r.tools.flatMap((t) => t.figures);
    const allowed = new Set<number>([...fromTools, ...(goldAllowed ?? [])]);

    const used = dollarFigures(foldPunctuation(r.text ?? ""));
    const offending = [...new Set(used.filter((n) => !allowed.has(n)))];

    const allowedList = [...allowed].sort((a, b) => a - b).join(", ");
    if (offending.length > 0) {
      return {
        passed: false,
        reason: `dollar-figures-subset: unsourced figure(s) ${offending.map((n) => `$${n}`).join(", ")} — allowed = tool figures ∪ gold = [${allowedList}]`,
      };
    }
    return {
      passed: true,
      reason: `dollar-figures-subset: ${used.length} figure(s) in the answer, all within [${allowedList}]`,
    };
  },
};
