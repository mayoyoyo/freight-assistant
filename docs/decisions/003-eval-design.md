# ADR 003 — Eval design: error analysis first, code/judge split, calibration not splits

Status: accepted (Phase 4) · Date: 2026-08-07

> **Update 2026-08-07: the baseline is complete and all pending numbers are
> measured.** The remaining 48 runs were generated from the pre-fix commit
> (`e4ff03f`) in a worktree against pre-fix data, merged with the 24 on-disk
> runs, and all 72 were graded in one pass (corrected case labels, judge v2).
> Measured values are inserted below; the before/after is in
> `evals/before-after.md`.

## Context

The temptation is to write cases first, from imagination, then report the pass
rate as if it meant something. That yields a suite measuring what the author
feared, at an n where the interval is wider than the effect, graded by an
instrument nobody validated.

## Decision

**1. Error analysis before case authoring.** 40 live probes were open/axial-coded
into six named failure modes *before* any case was written. Round 2 produced no
new mode types, only new instances — theoretical saturation, the stopping rule.
The taxonomy is a design input, not a post-hoc summary. 8 of 24 cases are
`origin: regression` and name their trace; the other 16 are `origin:
ground_truth` from facts the probes never touched, so the suite is not a replay.

**2. Code graders for anything expressible as if/else; a judge only for the rest.**
Eight code graders are pure `(case, run) => {passed, reason}` — no I/O, no model
— so a re-grade is free and byte-reproducible from disk. The LLM judge owns
exactly two draft-email checks code cannot express, `no_invented_commitments`
and `professional_tone`, run as separate calls and never averaged.

**3. A calibration set, not train/dev/test splits.** 20 hand-labeled drafts
(10 clean / 10 corrupted) are the *only* judge-tuning signal; the 24 reported
cases were never opened while building it. Splits at n=24 are statistically
meaningless, but the no-leakage principle they exist to enforce is not — so a
disjoint set enforces it instead.

**4. Wilson intervals, published, not Wald.** At n in the twenties with p near 1,
Wald runs past 1.0 and collapses to zero width at p=1. Publishing the width is
the point. Also reported: pass@1 and **pass^3** (all k=3 runs must pass), our own
addition, so run-to-run variance is attributed to the agent rather than mistaken
for a regression.

**5. Conscious skips are a deliverable.** Everything considered and not built is
listed with why it would not pay — judgy corrected rate (circular at n=24, CI
would swallow [0,1]), 150–200 labels with 15/40/45 splits, 100-trace open
coding, Phoenix/Langfuse/OTel, multi-turn eval, guardrail pipelines and tiered
sampling (all assume production traffic). The skip list is as load-bearing as
the adopt list.

## Consequences

- **Failures land where the analysis predicted.** Among graded runs the failures
  are exactly the predicted regression cases: L05 (equipment blind, 3/3), L06
  (ASR-name echo, 2/3), L07 (verdict flip, 1/3). **Per-bucket distribution
  (measured, 72 runs): factual_lookup 18/24, set_retrieval 4/18, abstention
  14/15, email_draft 15/15 — set retrieval is the dominant failure, exactly
  where the error analysis located the equipment/lane blindness.**
- **Every failed retrieval run gets a 3-step localization** — was the gold record
  retrieved? does the payload contain the answer? — so a corpus gap is never
  mis-filed as a retrieval bug and "fixed" with tuning that cannot work. L05
  localized to RETRIEVAL on all three runs, which is what made the equipment
  OR-join the right fix rather than a prompt tweak.
- **Stated coverage limits**: n=24, single-turn only, no adversarial-injection
  case, frozen snapshot so no rate drift.
- **Headline metrics (measured).** Baseline: run-level 51/72 (70.8%), pass@1
  17/24, pass^3 15/24. Post-fix: 52/72, 17/24, 16/24 — L05 0/3→3/3 as
  predicted, while set retrieval flipped recall→precision failures (spurious
  items from the wider join), leaving the aggregate flat. Full measured
  before/after with per-case movement: `evals/before-after.md`. The prediction
  vs measurement split is preserved there — predictions were right about L05
  and L06/L07, and wrong about the S-bucket, which is the finding.

Evidence: `evals/error-analysis/failure-modes.md`, `evals/report.md`,
`evals/graders/`.
