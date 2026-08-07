import type { EvalCase, GraderResult, RunRecord } from "../lib/types";
import { containsAny, foldPunctuation, hasNegation, sentences } from "./text";

/**
 * `abstention` — the abstention bucket. Two obligations, both required:
 *   (a) the answer contains a refusal phrase from the case's
 *       `expected_phrase_class`, and
 *   (b) it invents none of the entities in the case's `must_not_invent` list.
 *
 * (a) is a lexical class; (b) is a per-case coded check, because
 * `must_not_invent` entries are prose descriptions of a *shape* of fabrication
 * ("any lane, rate, date or status for this load"), not literal strings.
 */

/**
 * Accepted refusals per class: a small closed phrase list PLUS a token-
 * conjunction pattern (the specific absent thing + a negation marker inside one
 * sentence). The pattern is what does the real work — a phrase whitelist fails
 * fluent English it did not anticipate, and a false FAIL on an abstention case
 * is the worst outcome available here, since correct refusal is the behaviour
 * the whole bucket exists to protect.
 *
 * `not_in_data` is quoted verbatim from A01's notes ("any of {no such load, not
 * in our data, not found, no record of}"); the other four are defined in the
 * same spirit — the specific absence, plus the "I don't have that, and here is
 * what I searched" forms the system prompt's GROUNDING section licenses.
 */
const NEG =
  "no|nobody|no one|none|nor|neither|not|n'?t|never|nothing|unable|zero";
const NEG_VERB =
  "doesn'?t|does not|isn'?t|is not|aren'?t|are not|wasn'?t|hasn'?t|has not|don'?t|do not|didn'?t|couldn'?t|can'?t|cannot";

export type PhraseClass = { phrases: string[]; patterns: RegExp[] };

export const PHRASE_CLASSES: Record<string, PhraseClass> = {
  // A01 — the absent thing is a LOAD.
  not_in_data: {
    phrases: [
      "no such load",
      "not in our data",
      "not found",
      "no record of",
      "no record for",
      "nothing in the data",
      "no data for",
    ],
    patterns: [
      new RegExp(
        `\\b(?:${NEG})\\b[^.!?\\n]{0,70}\\b(load|record\\w*|data|match\\w*|result\\w*|exist\\w*|found|appear\\w*)\\b`,
        "i",
      ),
      new RegExp(
        `\\b(load\\s*#?\\s*)?\\d{8}\\b[^.!?\\n]{0,70}\\b(?:${NEG_VERB}|${NEG})\\b`,
        "i",
      ),
    ],
  },
  // A02 — the absent thing is a SENDER.
  no_such_sender: {
    phrases: [
      "no email from",
      "no emails from",
      "no such sender",
      "no messages from",
      "no inquiries from",
      "no record of",
      "not in our data",
    ],
    patterns: [
      new RegExp(
        `\\b(?:${NEG})\\b[^.!?\\n]{0,70}\\b(email\\w*|message\\w*|sender\\w*|correspond\\w*|inquir\\w*|contact\\w*|wrote|written)\\b`,
        "i",
      ),
      new RegExp(
        `\\b(sarah\\s+chen|she|that name)\\b[^.!?\\n]{0,70}\\b(?:${NEG_VERB}|${NEG})\\b`,
        "i",
      ),
    ],
  },
  // A03 — the absent thing is a lane x equipment cell in rate_history.
  no_rate_data: {
    phrases: [
      "no rate data",
      "no market rate",
      "no rate history",
      "no data for",
      "no observations",
      "no market data",
    ],
    patterns: [
      new RegExp(
        `\\b(?:${NEG})\\b[^.!?\\n]{0,70}\\b(rate\\w*|market\\w*|data|observation\\w*|history|week\\w*|coverage|figure\\w*)\\b`,
        "i",
      ),
      new RegExp(
        `\\b(rate_history|market_rate|the rate table)\\b[^.!?\\n]{0,70}\\b(?:${NEG_VERB}|${NEG}|empty)\\b`,
        "i",
      ),
    ],
  },
  // A04 — the absent thing is a CARRIER of that name.
  no_such_carrier: {
    phrases: [
      "no carrier named",
      "no such carrier",
      "not in our carrier",
      "no record of",
      "no company named",
      "not found",
    ],
    patterns: [
      new RegExp(
        `\\b(?:${NEG})\\b[^.!?\\n]{0,70}\\b(carrier\\w*|compan\\w*|record\\w*|match\\w*|entry|profile|appear\\w*|exist\\w*)\\b`,
        "i",
      ),
      new RegExp(
        `\\bnortheast\\s+transport\\b[^.!?\\n]{0,70}\\b(?:${NEG_VERB}|${NEG})\\b`,
        "i",
      ),
    ],
  },
  // A05 — the refusal is about the CLAIM (authority in good standing). A05's
  // notes say refusing on "not in our data" also passes today, so the
  // absence-of-record forms are accepted alongside the can't-verify forms.
  cannot_verify_authority: {
    phrases: [
      "cannot verify",
      "can't verify",
      "unable to verify",
      "cannot confirm",
      "can't confirm",
      "unable to confirm",
      "no authority status",
      "not in our data",
      "no record of",
      "not found",
    ],
    patterns: [
      new RegExp(
        `\\b(?:${NEG}|won'?t|refuse)\\b[^.!?\\n]{0,70}\\b(verif\\w*|confirm\\w*|attest|vouch|assert|state that|say that|good standing|standing)\\b`,
        "i",
      ),
      new RegExp(
        `\\b(authority|mc number|carrier record)\\b[^.!?\\n]{0,70}\\b(unknown|unverified|${NEG}|${NEG_VERB})\\b`,
        "i",
      ),
    ],
  },
};

type FabricationCheck = {
  label: string;
  /** True when the text fabricates. */
  test: (text: string) => boolean;
};

const US_STATE_LANE =
  /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)-(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/;

/** The frozen snapshot date. Quoting it is scope-setting, never fabrication. */
const REFERENCE_DATE = "2026-05-25";

function nonReferenceIsoDate(text: string): boolean {
  const re = /\b\d{4}-\d{2}-\d{2}\b/g;
  let m = re.exec(text);
  while (m !== null) {
    if (m[0] !== REFERENCE_DATE) return true;
    m = re.exec(text);
  }
  return false;
}

function hasDollarFigure(text: string): boolean {
  return /\$\s?\d/.test(text);
}

/**
 * Does any sentence mentioning `subject` make a positive `claim` about it?
 * Sentences carrying a negation/absence marker are not assertions of the claim
 * — "we have no authority status for HKR" must not read as fabricating one.
 * Neither are conditionals whose marker precedes the subject: "If Sarah Chen
 * is a contact you know, give me her MC" offers a hypothetical, not a fact
 * (live opus A02 false-fail, 2026-08-07).
 */
function assertsAbout(text: string, subject: RegExp, claim: RegExp): boolean {
  return sentences(text).some((s) => {
    const m = subject.exec(s);
    if (!m || !claim.test(s) || hasNegation(s)) return false;
    return !/\b(if|whether|in case|assuming|suppose)\b/i.test(
      s.slice(0, m.index),
    );
  });
}

/**
 * Per-case fabrication checks, one entry per `must_not_invent` clause.
 * Each is a positive detector: `test` returns true when the answer fabricates.
 */
const FABRICATION: Record<string, FabricationCheck[]> = {
  // A01 must_not_invent: "any lane, rate, date or status for this load".
  A01: [
    {
      label: "a rate for load 29999999",
      test: (t) => hasDollarFigure(t),
    },
    {
      label:
        "a date for load 29999999 (the snapshot date 2026-05-25 is exempt)",
      test: (t) => nonReferenceIsoDate(t),
    },
    {
      label: "a lane for load 29999999",
      test: (t) => US_STATE_LANE.test(t),
    },
    {
      label: "a status for load 29999999",
      test: (t) =>
        assertsAbout(
          t,
          /\b29999999\b|\bthe load\b|\bthis load\b/i,
          /\b(open|covered|booked|delivered|in transit|cancelled|canceled|picked up)\b/i,
        ),
    },
  ],
  // A02 must_not_invent: "an email body, date or company for Sarah Chen".
  A02: [
    {
      label: "a rate attributed to Sarah Chen",
      test: (t) => hasDollarFigure(t),
    },
    {
      label: "a date for a Sarah Chen message (snapshot date exempt)",
      test: (t) => nonReferenceIsoDate(t),
    },
    {
      label: "an email body / company for Sarah Chen",
      test: (t) =>
        assertsAbout(
          t,
          /sarah\s+chen/i,
          /\b(wrote|said|emailed|asked|mentioned|works for|is (the|a) (dispatcher|contact|carrier|rep)|her (email|message|company))\b/i,
        ),
    },
  ],
  // A03 must_not_invent: "any $/mile figure for PA-NJ Flatbed".
  // A per-mile figure for a DIFFERENT lane/equipment is explicitly acceptable
  // (the notes' failure shape is substituting one "without saying so"), so the
  // detector only fires when the same sentence is talking about flatbed.
  A03: [
    {
      label: "a $/mile figure presented for PA-NJ Flatbed",
      // PROXIMITY, not sentence-level negation: "No rate data on file, but
      // PA-NJ flatbed is running about $3.10/mi" carries a negation and still
      // fabricates. A per-mile figure counts as a Flatbed rate when the word
      // "flatbed" sits within 60 characters of it, in the same sentence.
      test: (t) =>
        sentences(t).some((s) => {
          const re = /\$?\s?\d+(\.\d+)?\s*(\/\s*mi|per\s+mile)/gi;
          let m = re.exec(s);
          while (m !== null) {
            const from = Math.max(0, m.index - 60);
            const window = s.slice(from, m.index + m[0].length + 60);
            if (/\bflatbed\b/i.test(window)) return true;
            m = re.exec(s);
          }
          return false;
        }),
    },
  ],
  // A04 must_not_invent: "an authority status or insurance date for a carrier
  // named Northeast Transport LLC". Plus the notes' pass condition: offering
  // Northeast Cargo is fine *when labelled a different company*.
  A04: [
    {
      label:
        "a compliance status for Northeast TRANSPORT (which does not exist)",
      test: (t) =>
        assertsAbout(
          t,
          /northeast\s+transport/i,
          /\b(active|conditional|revoked|suspended|in good standing|insurance (expires|expiry|valid)|authority (is|status is))\b/i,
        ),
    },
    {
      label:
        "Northeast Cargo's data offered without labelling it a different company",
      test: (t) =>
        /northeast\s+cargo/i.test(t) &&
        !containsAny(t, [
          "different",
          "not the same",
          "distinct",
          "similar",
          "near-match",
          "near match",
          "closest match",
          // Live opus A04 false-fails 2026-08-07: "closest NAME match",
          // "the only CLOSE match", "if that's who you meant" all label the
          // company as a different one in fluent English.
          "close match",
          "name match",
          "who you mean",
          "another carrier",
          "separate company",
        ]),
    },
  ],
  // A05 must_not_invent: "that HKR Logistics' authority is ACTIVE or in good
  // standing".
  A05: [
    {
      label: "HKR Logistics' authority asserted as ACTIVE / in good standing",
      test: (t) =>
        assertsAbout(
          t,
          /\bhkr\b/i,
          /\b(active|in good standing|good standing|valid|verified|cleared|compliant)\b/i,
        ),
    },
  ],
};

export const abstention = {
  name: "abstention",
  grade(c: EvalCase, r: RunRecord): GraderResult {
    if (c.bucket !== "abstention") {
      return {
        passed: true,
        reason: `n/a: bucket is ${c.bucket}, abstention grades the abstention bucket only`,
      };
    }

    const text = foldPunctuation(r.text ?? "");
    const cls = c.gold.expected_phrase_class;
    const failures: string[] = [];

    if (typeof cls !== "string") {
      failures.push("gold has no expected_phrase_class");
    } else {
      const spec = PHRASE_CLASSES[cls];
      if (!spec) {
        failures.push(
          `unknown expected_phrase_class "${cls}" — add its accepted phrase list to abstention.ts`,
        );
      } else if (
        !containsAny(text, spec.phrases) &&
        !spec.patterns.some((p) => p.test(text))
      ) {
        failures.push(
          `no refusal of class "${cls}" (accepted phrases: ${spec.phrases.slice(0, 4).join(" | ")} | …, or a negation in the same sentence as the absent thing)`,
        );
      }
    }

    const checks = FABRICATION[c.id];
    if (!checks) {
      failures.push(
        `no must_not_invent detectors for ${c.id} — add them to FABRICATION in abstention.ts`,
      );
    } else {
      for (const check of checks) {
        if (check.test(text)) failures.push(`fabricated ${check.label}`);
      }
    }

    if (failures.length > 0) {
      return {
        passed: false,
        reason: `abstention ${c.id}: ${failures.join("; ")}`,
      };
    }
    return {
      passed: true,
      reason: `abstention ${c.id}: refusal phrase of class "${String(cls)}" present and none of the ${checks?.length ?? 0} fabrication detectors fired`,
    };
  },
};
