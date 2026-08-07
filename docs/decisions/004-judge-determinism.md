# ADR 004 — Judge determinism without `temperature: 0`

Status: accepted (Phase 4B) · Date: 2026-08-07

> **`[PENDING JUDGE BUDGET]` marks numbers that are not yet measured.** The
> org spend cap was exhausted mid-phase; the v2 calibration and repeat-stability
> runs are queued, not estimated. A fabricated calibration number would be the
> worst artifact this harness could ship — the whole point of the judge is that
> its error rates are *measured*.

## Context

The eval design doc pins the judge to `temperature: 0` for a correct reason: if
the grader's own sampling wobbles, run-to-run variance in the headline is a
mixture of agent and grader variance, and k=3 / pass^3 stop meaning what they
claim. The grader must be the fixed instrument.

**That instruction cannot be followed on this model.** `claude-opus-5` rejects
`temperature`, `top_p` and `top_k` — HTTP 400 if any is present. There is no
sampler knob to pin. The two bad answers: pass it anyway (every judge call
breaks), or downgrade to an older model that accepts it, trading real capability
for a nominal reproducibility claim.

## Decision

Meet the design doc's **goal** by other means, and measure the result rather
than assert it:

1. **Constrained decode.** `generateObject` against a strict Zod schema:
   `explanation`, then `label` (`PASS` | `FAIL`), then `confidence`. No
   free-form text to drift in; the label is a two-element enum. **Field order is
   load-bearing** — JSON generates left to right, so `explanation` first forces
   reasoning before commitment. `judge.test.ts` asserts that order so a refactor
   cannot silently reverse it.
2. **Extended thinking disabled**, valid at the default `high` effort. Thinking
   is on by default here and is a long, unconstrained, high-variance decode
   path; the judge does not need it (explicit criteria, short inputs). Output is
   additionally capped at 4096 tokens rather than the model's 128000 default.
3. **Measured repeat-stability instead of assumed determinism.** `stability.ts`
   runs the judge 3× over 6 calibration items and reports the flip rate — the
   fraction of (item × check) cells whose labels are not unanimous.

Positive class is **PASS** everywhere: TPR is pass-recognition, **TNR is the
failure-catching rate**. Raw agreement is never the headline — an always-PASS
judge scores ~65–80% agreement on this set while catching zero failures, and
`judge.test.ts` encodes that scenario as a regression test.

## Consequences

- **Part 3 is the substantive claim.** `temperature: 0` was only ever a proxy for
  "same input, same verdict", and an imperfect one — batching and kernel
  nondeterminism mean temp 0 is not bit-reproducible on a serving stack either;
  it just stops you measuring. A measured flip rate puts a number on how much
  observed agent variance could actually be judge variance.
  **Flip rate: `[PENDING JUDGE BUDGET]`.**
- **v1 is measured and is therefore the default.** `no_invented_commitments`
  TPR 76.9% / TNR 100.0% / κ 0.700; `professional_tone` 100% / 100% / κ 1.000
  (n=20). The commitments TPR misses the >80% target and is reported as missing
  it; all three errors are false alarms, zero missed failures.
- **v2 exists, is diagnosed, and is NOT the default.** It addresses all three v1
  false alarms, but its calibration run aborted on the spend cap, so
  `JUDGE_VERSION` stays `"v1"`: the default must be the best *measured* prompt,
  not the best *believed* one. v2 metrics: `[PENDING JUDGE BUDGET]`.
- **A stated resolution limit.** `professional_tone` has 4 negative labels, so
  its TNR is quantized to 25-point steps — one miss reads as 75%. That is a
  property of the label counts, not the prompt; report 75% with the caveat
  rather than bolting an item-specific clause on to recover the cell. An
  overfit judge is a worse deliverable than an honest 75%.
- **Disabled thinking has a known failure mode** on this model (a tool call
  written as plain text instead of a structured block). It surfaces as a
  `generateObject` failure — loud, not silent — which is the right failure for
  a grader.

Evidence: `evals/judge/versions.md` (per-version history and the resume protocol
for when budget returns), `evals/judge/judge.ts`,
`evals/judge/calibration-v1.json`.
