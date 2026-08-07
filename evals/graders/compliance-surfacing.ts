import type { EvalCase, GraderResult, RunRecord } from "../lib/types";
import { datePresent } from "./text";

/**
 * `compliance-surfacing` — each string in `case.compliance_must_surface` must
 * actually be surfaced by the answer.
 *
 * These strings are the `concerns` sentences `carrier_history` emits:
 *   "insurance expired 2026-05-15 (before 2026-05-25)"
 *   "authority status is CONDITIONAL, not ACTIVE"
 *   "MC 678234 insurance expiry unknown"
 *   "authority status cannot be verified"
 * Exact substring matching would be worthless — no broker-facing answer repeats
 * a tool's phrasing verbatim, and one that did would pass for the wrong reason.
 *
 * THE RULE: TOKEN CONJUNCTION.
 *  1. Strip parentheticals. The `(before 2026-05-25)` half is corroborating
 *     context, not the claim; requiring the snapshot date would fail an answer
 *     that says "expired 2026-05-15 — ten days before today".
 *  2. Tokenize the rest. Keep a token only if it is
 *       - an ISO date, or
 *       - a digit run of 3+ (an MC number), or
 *       - a member of the load-bearing status vocabulary below.
 *     Drop everything else (`status`, `is`, `MC`, articles).
 *  3. Drop any token that directly follows "not": in "CONDITIONAL, not ACTIVE"
 *     the word ACTIVE is the negated foil, not the fact being asserted.
 *  4. ALL surviving tokens must be present in the answer, each matched through
 *     its own synonym pattern (expiry ≈ expiration, unknown ≈ not on file,
 *     dates also in "May 15, 2026" / "5/15/2026" form).
 *
 * Worked results for the four live strings:
 *   L04/D04 -> {insurance, expired, 2026-05-15}
 *   D03     -> {authority, conditional}
 *   S02     -> {678234, insurance, expiry, unknown}
 *   A05     -> {authority, cannot, verified}
 */

const STATUS_VOCAB: Record<string, RegExp> = {
  insurance: /\b(insurance|coverage|certificate|coi)\b/i,
  authority: /\b(authority|operating authority)\b/i,
  expired: /\b(expired|lapsed|out of date|no longer valid)\b/i,
  expiry: /\bexpir\w*/i,
  expiration: /\bexpir\w*/i,
  expires: /\bexpir\w*/i,
  unknown:
    /\b(unknown|not known|no expiry|not on file|not recorded|unrecorded|missing|blank|null|unavailable|not listed|no date|isn't listed|no insurance expiry)\b/i,
  conditional: /\bconditional\b/i,
  revoked: /\brevoked\b/i,
  suspended: /\bsuspended\b/i,
  inactive: /\b(inactive|not active)\b/i,
  pending: /\bpending\b/i,
  active: /\bactive\b/i,
  cannot: /\b(cannot|can't|can not|unable|not able|no way to|impossible to)\b/i,
  verified: /\bverif\w*/i,
  verify: /\bverif\w*/i,
  unverified: /\b(unverified|unverifiable)\b/i,
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ComplianceToken = {
  token: string;
  kind: "date" | "digits" | "word";
};

/** Step 1–3 of the rule. Exported so the meta-tests can pin it directly. */
export function complianceTokens(requirement: string): ComplianceToken[] {
  const stripped = requirement.replace(/\([^)]*\)/g, " ");
  const words = stripped.split(/[\s,;:]+/).filter((w) => w.length > 0);
  const out: ComplianceToken[] = [];
  let previousWasNot = false;
  for (const raw of words) {
    const w = raw.replace(/^[^\w-]+|[^\w-]+$/g, "");
    const lower = w.toLowerCase();
    if (lower === "not") {
      previousWasNot = true;
      continue;
    }
    const skip = previousWasNot;
    previousWasNot = false;
    if (skip) continue;
    if (ISO_DATE.test(w)) {
      out.push({ token: w, kind: "date" });
    } else if (/^\d{3,}$/.test(w)) {
      out.push({ token: w, kind: "digits" });
    } else if (lower in STATUS_VOCAB) {
      out.push({ token: lower, kind: "word" });
    }
  }
  return out;
}

function tokenPresent(text: string, t: ComplianceToken): boolean {
  if (t.kind === "date") return datePresent(text, t.token);
  if (t.kind === "digits") return text.includes(t.token);
  return STATUS_VOCAB[t.token]?.test(text) ?? false;
}

/**
 * Per-case guards against surfacing the WRONG compliance fact.
 *
 * D03 notes: "Insurance is FINE here — only authority blocks, so an answer that
 * flags 'insurance' fails the compliance_must_surface check." (MC 885432:
 * authority CONDITIONAL, insurance good through 2027-01-31.)
 *
 * The tempered `(?!authority|not |n't )` keeps "authority is conditional,
 * insurance is fine" and "insurance is not expired" from matching.
 *
 * L04's mirror-image guard (authority is ACTIVE there, so an authority-defect
 * claim is wrong) lives in `gold-specs.ts` instead, because L04's notes tie it
 * to "the gold field check" and L04 is a factual_lookup case.
 */
const MISATTRIBUTION: Record<string, { label: string; pattern: RegExp }[]> = {
  D03: [
    {
      label:
        "insurance flagged as a problem (it is valid to 2027-01-31; only authority blocks)",
      pattern:
        /\binsurance\b(?:(?!authority|not |n't )[^.!?\n]){0,25}\b(expired|lapsed|out of date|no longer valid|invalid|is a problem)\b/i,
    },
    {
      label: "insurance flagged as a problem (reverse word order)",
      pattern:
        /\b(expired|lapsed)\b(?:(?!authority|not |n't )[^.!?\n]){0,15}\binsurance\b/i,
    },
  ],
};

/**
 * Requirements that only bite when the answer takes on the subject.
 *
 * S02's `compliance_must_surface` used to read ["MC 678234 insurance expiry
 * unknown"] — unconditional, while its notes are not: "CE0060 ... is OUTSIDE
 * the gold set and must not count against precision — but MC 678234 has
 * insurance_expiry NULL, so IF the answer mentions CE0060 it must carry the
 * unknown-insurance caveat." A correct S02 answer that simply omits CE0060 has
 * no occasion to mention MC 678234 at all, so an unconditional check would have
 * failed the best possible answer, and this gate existed to stop it.
 *
 * DORMANT since the Phase 4 fix round: S02's `compliance_must_surface` is now
 * `[]` and the obligation lives in its notes, so `grade()` short-circuits
 * before reaching this table and the gate never fires. Kept, not deleted: it is
 * the working precedent for a conditional requirement, and the alternative fix
 * — putting CE0060 in gold — would have contradicted the verified
 * availability='available' gold set. Delete it only if the case-file schema
 * grows a first-class gated-requirement shape that supersedes it.
 */
const REQUIREMENT_GATES: Record<
  string,
  { match: string; onlyIf: RegExp; why: string }[]
> = {
  S02: [
    {
      match: "MC 678234",
      onlyIf: /\bCE0060\b|\b678234\b|mohammed|al-rashid/i,
      why: "answer does not raise CE0060 / MC 678234, so the unknown-insurance caveat is not owed (S02 notes)",
    },
  ],
};

export const complianceSurfacing = {
  name: "compliance-surfacing",
  grade(c: EvalCase, r: RunRecord): GraderResult {
    if (c.compliance_must_surface.length === 0) {
      return {
        passed: true,
        reason: "n/a: case has no compliance_must_surface requirements",
      };
    }
    const text = r.text ?? "";
    const failures: string[] = [];
    const skipped: string[] = [];

    for (const requirement of c.compliance_must_surface) {
      const gate = (REQUIREMENT_GATES[c.id] ?? []).find((g) =>
        requirement.includes(g.match),
      );
      if (gate && !gate.onlyIf.test(text)) {
        skipped.push(gate.why);
        continue;
      }
      const tokens = complianceTokens(requirement);
      if (tokens.length === 0) {
        failures.push(
          `"${requirement}": no load-bearing tokens derived — extend STATUS_VOCAB in compliance-surfacing.ts`,
        );
        continue;
      }
      const missing = tokens.filter((t) => !tokenPresent(text, t));
      if (missing.length > 0) {
        failures.push(
          `"${requirement}": missing ${missing.map((m) => m.token).join(" + ")} (required tokens: ${tokens.map((t) => t.token).join(" + ")})`,
        );
      }
    }

    for (const guard of MISATTRIBUTION[c.id] ?? []) {
      const m = guard.pattern.exec(text);
      if (m) {
        failures.push(`${guard.label} — "${m[0].trim()}"`);
      }
    }

    if (failures.length > 0) {
      return {
        passed: false,
        reason: `compliance-surfacing ${c.id}: ${failures.join("; ")}`,
      };
    }
    if (skipped.length === c.compliance_must_surface.length) {
      return {
        passed: true,
        reason: `n/a: every compliance requirement is conditional and unmet-by-topic — ${skipped.join("; ")}`,
      };
    }
    return {
      passed: true,
      reason: `compliance-surfacing ${c.id}: ${c.compliance_must_surface.length - skipped.length} of ${c.compliance_must_surface.length} compliance fact(s) surfaced${skipped.length > 0 ? ` (${skipped.length} not owed: ${skipped.join("; ")})` : ""}`,
    };
  },
};
