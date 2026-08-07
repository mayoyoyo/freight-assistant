import type { EvalCase, GraderResult, RunRecord } from "../lib/types";
import { GOLD_SPECS } from "./gold-specs";
import {
  containsAny,
  containsString,
  numberForms,
  numberPresent,
} from "./text";

/**
 * `exact-match` — factual_lookup bucket.
 *
 * Runs the per-case assertion table in `gold-specs.ts` against `run.text`.
 * Every assertion must hold; the reason names every one that did not, with the
 * gold field it came from, so a failure line in the report is actionable
 * without opening the trace.
 */
export const exactMatch = {
  name: "exact-match",
  grade(c: EvalCase, r: RunRecord): GraderResult {
    if (c.bucket !== "factual_lookup") {
      return {
        passed: true,
        reason: `n/a: bucket is ${c.bucket}, exact-match grades factual_lookup only`,
      };
    }
    const spec = GOLD_SPECS[c.id];
    if (!spec) {
      // Deliberately a FAIL, not an n/a: a factual case with no spec is an
      // ungraded case masquerading as a passing one.
      return {
        passed: false,
        reason: `exact-match: no gold spec for ${c.id} — add one to evals/graders/gold-specs.ts`,
      };
    }

    const text = r.text ?? "";
    const failures: string[] = [];

    for (const a of spec.assertions) {
      switch (a.kind) {
        case "number": {
          if (!numberPresent(text, a.value)) {
            failures.push(
              `${a.label}: expected ${a.value} (any of ${numberForms(a.value).join(" | ")}) in the answer`,
            );
          }
          break;
        }
        case "string": {
          if (!containsString(text, a.value)) {
            failures.push(`${a.label}: expected "${a.value}" in the answer`);
          }
          break;
        }
        case "one-of": {
          if (!containsAny(text, a.values)) {
            failures.push(
              `${a.label}: answer contains none of [${a.values.slice(0, 6).join(" | ")}${a.values.length > 6 ? " | …" : ""}]`,
            );
          }
          break;
        }
        case "pattern": {
          if (!a.pattern.test(text)) {
            failures.push(
              `${a.label}: answer never makes this claim (no match for ${a.pattern.source.slice(0, 90)}…)`,
            );
          }
          break;
        }
        case "absent": {
          const m = a.pattern.exec(text);
          if (m) {
            failures.push(
              `${a.label}: forbidden phrase present — "${m[0].trim()}"`,
            );
          }
          break;
        }
        case "conditional": {
          if (
            containsString(text, a.ifPresent) &&
            !containsAny(text, a.thenOneOf)
          ) {
            failures.push(
              `${a.label}: "${a.ifPresent}" appears without any of [${a.thenOneOf.slice(0, 6).join(" | ")} | …]`,
            );
          }
          break;
        }
      }
    }

    const total = spec.assertions.length;
    if (failures.length > 0) {
      return {
        passed: false,
        reason: `exact-match ${c.id}: ${failures.length}/${total} gold assertions failed — ${failures.join("; ")}`,
      };
    }
    return {
      passed: true,
      reason: `exact-match ${c.id}: all ${total} gold assertions hold (${spec.about})`,
    };
  },
};
