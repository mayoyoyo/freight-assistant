# ADR 004 — Judge determinism without `temperature: 0`

Status: accepted (Phase 4B) · Date: 2026-08-07

> **Update 2026-08-09: v2 RETRACTED — v3 is the default.** Codex adversarial
> review of PR #4 (finding 5) caught calibration contamination: v2's rules 6/7
> quoted sentences verbatim from the calibration drafts behind the v1 false
> alarms (CAL05/06/07/17), so its calibration partly measured lookup, not
> judgment; its numbers stand as a record but are disclaimed. v3 rewrites
> those examples held-out (rule semantics unchanged); a 5-word-shingle leakage
> ratchet in `judge.test.ts` now screens every prompt version against every
> calibration draft, with v2's five bespoke shingles pinned as an inverted
> assertion. v3 on the untouched 20 items: commitments TPR 100% (13/13) / TNR
> 100% (7/7) / κ 1.000; tone 100/100/κ 1.000; stability 12/12 unanimous.
> `JUDGE_VERSION` = "v3". Full story: `evals/judge/versions.md`.
>
> **Update 2026-08-07: pending numbers measured** (spend cap raised); v2
> measured better than v1 and became the default per the decision logic below
> — later retracted, see above. The original draft marked unmeasured numbers
> `[PENDING JUDGE BUDGET]` rather than estimating them: a fabricated
> calibration number would be the worst artifact this harness could ship.

## Context

The eval design doc pins the judge to `temperature: 0` for a correct reason:
if the grader's own sampling wobbles, headline variance mixes agent and
grader variance, and k=3 / pass^3 stop meaning what they claim. **That
instruction cannot be followed here**: `claude-opus-5` rejects `temperature`,
`top_p` and `top_k` (HTTP 400). There is no sampler knob to pin, and
downgrading models to get one trades real capability for a nominal claim.

## Decision

Meet the design doc's **goal** by other means, and measure the result:

1. **Constrained decode.** `generateObject` against a strict Zod schema:
   `explanation`, then `label` (`PASS` | `FAIL`), then `confidence`. **Field
   order is load-bearing** — JSON generates left to right, so
   explanation-first forces reasoning before commitment; `judge.test.ts`
   asserts the order.
2. **Extended thinking disabled** (valid at the default `high` effort) — a
   long, unconstrained, high-variance decode path the judge does not need.
   Output capped at 4096 tokens vs the model's 128000 default.
3. **Measured repeat-stability instead of assumed determinism.**
   `stability.ts` runs the judge 3× over 6 calibration items and reports the
   flip rate.

Positive class is **PASS** everywhere: TPR is pass-recognition, **TNR is the
failure-catching rate**. Raw agreement is never the headline — an always-PASS
judge scores ~65–80% agreement here while catching zero failures;
`judge.test.ts` pins that scenario as a regression test.

## Consequences

- **Part 3 is the substantive claim.** `temperature: 0` was only a proxy for
  "same input, same verdict" — and imperfect: batching and kernel
  nondeterminism mean temp 0 is not bit-reproducible on a serving stack
  either. The measured flip rate bounds how much observed agent variance
  could be judge variance: **0 flips in 12 cells (6 items × 2 checks × 3
  repeats), for v2 and again for v3 (`stability-v3.json`).**
- **v1 measured**: `no_invented_commitments` TPR 76.9% / TNR 100.0% / κ
  0.700; `professional_tone` 100/100/κ 1.000 (n=20). The commitments TPR
  missed the >80% target and was reported as missing it; all three errors
  were false alarms, zero missed failures.
- **The default is the best *measured* prompt, never the best believed one.**
  That rule promoted v2 only after calibration — and retracted it the same
  way when the calibration proved contaminated (update above). Perfect cells
  read "no observed misses", not "perfect judge": 13/13 has a Wilson 95%
  interval of [77.2%, 100%].
- **A stated resolution limit**: `professional_tone` has 4 negative labels,
  so TNR is quantized to 25-point steps — one miss reads as 75%. Report that
  with the caveat; an overfit judge is a worse deliverable than an honest 75%.
- **Disabled thinking's known failure mode** (a tool call written as plain
  text) surfaces as a `generateObject` failure — loud, not silent, the right
  failure for a grader.

Evidence: `evals/judge/versions.md` (per-version history and the retraction),
`evals/judge/judge.ts`, `evals/judge/calibration-v3.json`.
