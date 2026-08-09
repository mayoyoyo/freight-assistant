import type {
  EvalCase,
  GraderResult,
  RunRecord,
  ToolCallRecord,
} from "../lib/types";

/**
 * `required-tools` — membership + args-subset, NOT order.
 *
 * Each `required_tools[i]` is satisfied if SOME call in the run has that name
 * AND its args are a superset of `args_subset`. Sequence is deliberately not
 * graded: trajectory grading is brittle (Anthropic, "Demystifying evals for AI
 * agents"), and there is no single correct order for "look up the load and the
 * carrier".
 *
 * An empty `args_subset` means "the tool was called at all".
 */

/** Value equality, tolerant of string-vs-number and of letter case. */
function looseEqual(actual: unknown, required: unknown): boolean {
  if (actual === required) return true;
  if (typeof actual === "string" && typeof required === "string") {
    return actual.toLowerCase() === required.toLowerCase();
  }
  const bothScalar = (v: unknown) =>
    typeof v === "string" || typeof v === "number";
  if (bothScalar(actual) && bothScalar(required)) {
    const a = Number(actual);
    const b = Number(required);
    if (!Number.isNaN(a) && !Number.isNaN(b)) return a === b;
  }
  return false;
}

/**
 * `ids: ["call_017"]` in a case must be satisfied by an actual
 * `ids: ["call_017_availability_check"]`: the tool itself documents that call
 * ids may be given as a prefix, so both spellings are the same request.
 */
function idPrefixEqual(actual: unknown, required: unknown): boolean {
  return (
    typeof actual === "string" &&
    typeof required === "string" &&
    actual.toLowerCase().startsWith(`${required.toLowerCase()}_`)
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function valueSatisfies(actual: unknown, required: unknown): boolean {
  if (Array.isArray(required)) {
    if (!Array.isArray(actual)) return false;
    // Array subset, order-insensitive.
    return required.every((req) =>
      actual.some((act) => looseEqual(act, req) || idPrefixEqual(act, req)),
    );
  }
  if (isPlainObject(required)) {
    if (!isPlainObject(actual)) return false;
    return argsSuperset(actual, required);
  }
  return looseEqual(actual, required) || idPrefixEqual(actual, required);
}

function argsSuperset(
  actual: Record<string, unknown>,
  required: Record<string, unknown>,
): boolean {
  return Object.entries(required).every(
    ([k, v]) => k in actual && valueSatisfies(actual[k], v),
  );
}

function describe(call: ToolCallRecord): string {
  return JSON.stringify(call.args);
}

export const requiredTools = {
  name: "required-tools",
  grade(c: EvalCase, r: RunRecord): GraderResult {
    if (c.required_tools.length === 0) {
      return { passed: true, reason: "n/a: case declares no required_tools" };
    }

    const failures: string[] = [];
    for (const req of c.required_tools) {
      const sameName = r.tools.filter((t) => t.name === req.name);
      if (sameName.length === 0) {
        const called = r.tools.map((t) => t.name);
        failures.push(
          `${req.name} was never called (calls seen: ${called.length > 0 ? called.join(", ") : "none"})`,
        );
        continue;
      }
      const ok = sameName.some((t) => argsSuperset(t.args, req.args_subset));
      if (!ok) {
        failures.push(
          `${req.name} called but never with args ⊇ ${JSON.stringify(req.args_subset)} (args seen: ${sameName.map(describe).join(" | ")})`,
        );
      }
    }

    if (failures.length > 0) {
      return {
        passed: false,
        reason: `required-tools: ${failures.length}/${c.required_tools.length} requirement(s) unmet — ${failures.join("; ")}`,
      };
    }
    return {
      passed: true,
      reason: `required-tools: all ${c.required_tools.length} requirement(s) met across ${r.tools.length} call(s)`,
    };
  },
};
