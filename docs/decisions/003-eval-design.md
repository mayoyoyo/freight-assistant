# ADR 003 — Eval design: error analysis first, code/judge split, calibration not splits

Status: accepted (Phase 4) · Date: 2026-08-07

> **Update 2026-08-07: baseline complete; all pending numbers measured.** The
> remaining 48 runs were generated from the pre-fix commit (`e4ff03f`) in a
> worktree against pre-fix data, merged with the 24 on-disk runs, all 72
> graded in one pass (corrected case labels).
>
> **Update 2026-08-09:** headline runs re-graded under judge v3 after the v2
> retraction (ADR 004); headline numbers unchanged.

## Context

Writing cases first, from imagination, yields a suite measuring what the
author feared, at an n where the interval is wider than the effect, graded by
an instrument nobody validated.

## Decision

1. **Error analysis before case authoring.** 40 live probes open/axial-coded
   into six named failure modes before any case was written; round 2 produced
   no new mode types (saturation — the stopping rule). 8 of 24 cases are
   `origin: regression` and name their trace; 16 are `origin: ground_truth`
   from facts the probes never touched, so the suite is not a replay.
2. **Code graders for anything expressible as if/else; a judge only for the
   rest.** Eight pure `(case, run) => {passed, reason}` graders — no I/O, no
   model; re-grades free and byte-reproducible from disk. The LLM judge owns
   exactly two draft-email checks (`no_invented_commitments`,
   `professional_tone`), separate calls, never averaged.
3. **A calibration set, not train/dev/test splits.** 20 hand-labeled drafts
   (10 clean / 10 corrupted) are the *only* judge-tuning signal; the 24
   reported cases were never opened while building it. Splits at n=24 are
   statistically meaningless; the no-leakage principle they enforce is not.
4. **Wilson intervals, published, not Wald** — Wald runs past 1.0 near p=1
   and collapses to zero width at p=1. Also reported: pass@1 and **pass^3**
   (all k=3 runs must pass), so run-to-run variance is attributed to the
   agent, not mistaken for a regression.
5. **Conscious skips are a deliverable.** Judgy corrected rate (circular at
   n=24), 150–200 labels with 15/40/45 splits, 100-trace open coding,
   Phoenix/Langfuse/OTel, multi-turn eval, guardrail pipelines and tiered
   sampling (all assume production traffic) — each listed with why it would
   not pay. The skip list is as load-bearing as the adopt list.

## Consequences

- **Failures land where the analysis predicted**: L05 (equipment blind, 3/3),
  L06 (ASR-name echo, 2/3), L07 (verdict flip, 1/3). Per-bucket, 72 runs:
  factual_lookup 18/24, set_retrieval 4/18, abstention 14/15, email_draft
  15/15 — set retrieval dominant, exactly where the analysis located the
  equipment/lane blindness.
- **Every failed retrieval run gets a 3-step localization** (gold record
  retrieved? payload contains the answer?) so a corpus gap is never mis-filed
  as a retrieval bug. L05 localized to RETRIEVAL on all three runs — which
  made the equipment OR-join the right fix, not a prompt tweak.
- **Stated limits**: n=24, single-turn only, no adversarial-injection case,
  frozen snapshot so no rate drift.
- **Headline (measured).** Baseline: run-level 51/72 (70.8%), pass@1 17/24,
  pass^3 15/24. Post-fix: 52/72, 17/24, 16/24 — L05 0/3→3/3 as predicted,
  while set retrieval flipped recall→precision failures (spurious items from
  the wider join), leaving the aggregate flat. Predictions right about
  L05/L06/L07, wrong about the S-bucket — which is the finding. Per-case
  movement: `evals/before-after.md`.

Evidence: `evals/error-analysis/failure-modes.md`, `evals/report.md`,
`evals/graders/`.
