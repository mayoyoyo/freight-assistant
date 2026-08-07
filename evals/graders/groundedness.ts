import type { EvalCase, GraderResult, RunRecord } from "../lib/types";
import { parseCitations, toolIdSet } from "./text";

/**
 * `groundedness` — every `[...]` citation in the answer must resolve to an id
 * that a tool in THIS run actually returned.
 *
 * The four citation forms come from the system prompt: `[CE0074]` (email),
 * `[call_006]` (call — cited by PREFIX, while the record id is
 * `call_006_rate_negotiation`), `[load 29372515]`, `[MC 876543]`. Multi-id
 * spans like `[CE0044, CE0045]` are split and each part checked.
 *
 * WHAT IS NOT A CITATION (so prose can't false-fail):
 *  - a span immediately followed by `(` is a markdown link,
 *  - a part matching none of the four forms is ignored (`[see below]`,
 *    `[Reed Barlus]`),
 *  - a bare digit run is only treated as an id at 5+ digits, so footnote
 *    markers `[1]`, `[12]` are ignored.
 * See `parseCitations` in text.ts — the rule lives in one place and is tested.
 *
 * N/A when the answer contains no recognized citation at all: there is nothing
 * to ground, and abstention answers legitimately cite nothing. "Did the answer
 * cite enough?" is a different question, and it belongs to the judge.
 */
export const groundedness = {
  name: "groundedness",
  grade(_c: EvalCase, r: RunRecord): GraderResult {
    const citations = parseCitations(r.text ?? "");
    if (citations.length === 0) {
      return {
        passed: true,
        reason: "n/a: answer contains no id citations to ground",
      };
    }

    const available = toolIdSet(r.tools.flatMap((t) => t.ids));
    const unresolved = citations.filter((c) => !available.has(c.token));

    if (unresolved.length > 0) {
      const names = [...new Set(unresolved.map((u) => u.raw))];
      return {
        passed: false,
        reason: `groundedness: ${names.length} citation(s) resolve to no tool result — [${names.join("], [")}]; ${available.size} id(s) were returned by ${r.tools.length} tool call(s)`,
      };
    }
    return {
      passed: true,
      reason: `groundedness: all ${citations.length} citation(s) resolve to ids returned by this run's tool calls`,
    };
  },
};
