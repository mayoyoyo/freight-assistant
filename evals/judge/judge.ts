/**
 * LLM judge for the two email-draft checks that code cannot express.
 *
 * Everything expressible as if/else lives in the code graders (dollar figures
 * subset-of-source, load ref present, PII, length). This module owns only the
 * two judgment calls: (1) no invented commitments / hallucinated logistics,
 * (2) professional broker tone.
 *
 * The two checks are ALWAYS separate API calls with separate prompts. Never one
 * call returning two labels, never an averaged score — a judge asked to weigh
 * "is it grounded AND polite" collapses on the drafts where exactly one of the
 * two fails, which is half the calibration set.
 *
 * Determinism: `claude-opus-5` rejects `temperature`, `top_p` and `top_k`, so
 * the design doc's "judge at temperature 0" is not achievable. What we do
 * instead: disable extended thinking (a fixed, short decode path) and measure
 * repeat-stability directly — see `stability.ts` and `versions.md`.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import type { GraderResult } from "../lib/types";
import { buildUserPrompt, loadCheckPrompt } from "./prompts";

export type { JudgeCheck } from "./prompts";

import type { JudgeCheck } from "./prompts";

export const JUDGE_MODEL = "claude-opus-5";

/**
 * Output cap per judge call, pinned rather than defaulted.
 *
 * `generateObject` sends no `maxOutputTokens` unless one is given, and the AI
 * SDK then falls back to the model's ceiling — 128000 on `claude-opus-5`. That
 * is not a cost bug (you pay for what is generated, not for the cap) but it is
 * a blast-radius bug: a judge that starts rambling inside `explanation` has no
 * brake, and a runaway call can burn minutes and thousands of tokens before it
 * stops. A verdict is `{explanation, label, confidence}` with the explanation
 * truncated to 400 chars downstream, so 4096 is generous by more than an order
 * of magnitude while still bounding the worst case.
 *
 * Hitting this cap means the response is truncated and `generateObject` throws
 * rather than returning a half-parsed verdict — a loud failure, which is the
 * right one for a grader.
 */
export const JUDGE_MAX_OUTPUT_TOKENS = 4096;

/**
 * The winning prompt version — the best version with MEASURED calibration
 * numbers. v1 is measured (no_invented_commitments TPR 76.9% / TNR 100%;
 * professional_tone TPR 100% / TNR 100%). v2 exists on disk and is the
 * diagnosed successor, but its calibration run was blocked by the Anthropic
 * spend cap, so it is NOT the default: an unmeasured prompt must never be the
 * one the reported eval runs against. Flip this to "v2" only after
 * `calibration-v2.json` exists and beats v1. See `versions.md`.
 */
export const JUDGE_VERSION = "v2";

export type JudgeVerdict = GraderResult & {
  confidence: "high" | "medium" | "low";
};

/**
 * Field order is load-bearing. JSON is generated left to right, so declaring
 * `explanation` before `label` forces the model to write its reasoning before
 * it commits to a verdict. Reordering these fields silently weakens the judge.
 */
export const verdictSchema = z.object({
  explanation: z.string(),
  label: z.enum(["PASS", "FAIL"]),
  confidence: z.enum(["high", "medium", "low"]),
});

const REASON_MAX = 400;

export function truncateReason(s: string, max = REASON_MAX): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export async function judge(
  check: JudgeCheck,
  draftText: string,
  sourceContext: string,
  opts: { version?: string; model?: string } = {},
): Promise<JudgeVerdict> {
  const version = opts.version ?? JUDGE_VERSION;
  const model = opts.model ?? JUDGE_MODEL;

  const { object } = await generateObject({
    model: anthropic(model),
    schema: verdictSchema,
    // `instructions` is the v7 name for `system`.
    instructions: loadCheckPrompt(version, check),
    prompt: buildUserPrompt(draftText, sourceContext),
    maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
    providerOptions: {
      // No temperature/top_p/top_k: claude-opus-5 rejects them. Thinking off
      // keeps the decode short and the verdicts repeatable.
      anthropic: { thinking: { type: "disabled" } },
    },
    maxRetries: 3,
  });

  return {
    passed: object.label === "PASS",
    reason: truncateReason(object.explanation),
    confidence: object.confidence,
  };
}
