# Eval Design v2 — Goodlane Freight Carrier Agent
Date: 2026-08-06 · Supersedes D5 in `goodlane-agent-scoping-2026-08-04.md`
Sources: Anthropic "Demystifying evals for AI agents" (Jan 2026), Hamel Husain/Shreya Shankar evals FAQ, and the ai-system-design-guide comprehensive evals study guide (distilled in 4 segments by subagents, 2026-08-06). Design principle: **tight and methodologically credible, not big** — the skip list is as load-bearing as the adopt list.

## Ordering change (highest-leverage upgrade)
Error analysis comes BEFORE final case authoring, not after:
1. Build agent to working state.
2. **Dimensional sampling**: define 3–4 dimensions (question type × entity ambiguity × data availability × time scope), sample ~25–30 combinations, expand into natural queries.
3. **Open coding**: run the agent, ~30s free-text note per trace.
4. **Axial coding**: cluster into 4–6 named failure modes (specific, ≤2 words + one-line definition; "Temporal issues" too vague, "Stale-quote — cites older of two rates for same load" usable).
5. Finalize the ~24-case eval set FROM observed failure modes + dataset ground truth. Stopping rule: theoretical saturation (new traces yield no new failure types). Defense for n=24: "50 high-quality labels beat 500 noisy labels."

## Case set (~24, hand-labeled, JSONL)
| Bucket | n | Grader |
|---|---|---|
| Factual lookup (best rate for load #X) | 8 | Code: exact match vs gold |
| Set retrieval (carriers confirmed for PA-NJ Box Truck this week) | 6 | Code: set P/R/F1 vs gold IDs (note: multi-relevant-doc metric is an upgrade over the guide's single-gold recall@k/MRR — own it) |
| Email draft | 5 | Split: code checks + LLM judge (below) |
| Abstention / not-in-corpus | 5 | Code: must say unknown/refuse |
- Include a dimensional-coverage table in the report (coverage, not cherry-picking).
- Tag any case created from a fixed failure `origin: regression` + `original_failure` one-liner. Run suite before every prompt/model change. README gets one before/after row ("Stale-quote: 3/24 → 0/24") — strongest single artifact.
- Cross-cutting code checks on every case: required-tool-called + arg correctness (membership + args, NOT sequence order — Anthropic: trajectory-grading is brittle); groundedness via required source IDs traced to retrieved records.

## Code vs judge split (guide: "if expressible as if/else, use code"; suite = 2–3 code + 1–2 judge)
Email-draft checks move mostly to CODE:
- Code: every $ figure in draft ⊆ source figures; load ref present and correct; no PII beyond intended recipient; length bound.
- Judge (binary, separate — never averaged): (1) no invented commitments/hallucinated logistics, (2) professional broker tone.
- Evaluator pattern: each returns `{passed, reason}`, runs over ALL cases with N/A short-circuit (`{passed: true, reason: "not a draft case"}`).
- **Meta-test the evaluators**: fixtures per check — clean-pass, corrupted-fail, out-of-scope-pass (the one people skip).

## Judge construction
- Prompt skeleton (appendix conventions): role + domain defs → PASS/FAIL criteria (exact conditions) → named failure types → **"what does NOT count as a failure"** (2–3 acceptable variations) → 3 few-shot with reasoning (clear pass, clear fail, borderline) → output JSON with `explanation` BEFORE `label`, plus `confidence`. Temperature 0.
- **Calibration set, not splits**: ~20 separate draft outputs, half deliberately corrupted per failure type; hand-label; tune judge prompt ONLY on these. Never tune on the 24 reported cases (preserves the no-leakage principle behind 15/40/45 splits without pretending n=24 supports splits).
- Validation: report **TPR and TNR per judge check** (+ confusion counts), never raw agreement ("judge that always says PASS gets 90% agreement when failures are rare"). Target both >80%. State positive-class convention explicitly (PASS = positive ⇒ TNR = failure-catching rate). Iteration diagnostics: TPR low → add fail examples; TNR low → expand does-NOT-count section.
- Also report Cohen's kappa (me vs judge) with the guide's bands: >0.8 excellent / 0.6–0.8 good / <0.6 rewrite criteria.
- Self-consistency (n=1 annotator substitute): blind re-label ~6 cases a day later, report self-agreement.
- Prompt versioning file: judge prompt + few-shot set + model + temp + calibration TPR/TNR + date/reason per version (~15 min, big maturity signal).

## Pipeline component evals (small)
- Extraction: accuracy vs hand-labeled gold on a sample of emails/transcripts (rate, MC, equipment, load ref).
- Entity resolution: MC-number match accuracy vs gold, incl. garbled-audio cases.
- Transcription: WER spot-check on a handful of clips (NOT an LLM judge per stage).
- Failure localization: per-stage failure-count table + the 3-step localizer per failed retrieval case: (1) gold doc retrieved? → RETRIEVAL; (2) does gold doc actually contain the answer? → CORPUS; (3) else → GENERATION. Step 2 is the trap-catcher.
- FTS note for report: freight text is number-dense (MC numbers, load IDs, rates) — document how the Postgres FTS config tokenizes numerics.

## Runs & reporting
- k=3 per case, judge at temp 0 so variance attributes to the agent. Report pass@1 + pass^3; flag flip-flopping cases as unstable. **Label as own addition** — not prescribed by the guide.
- Headline: raw pass rate + **Wilson 95% CI** (at 20/24 that's ~[65%, 96%] — publishing the width IS the rigor signal). [Wilson numbers re-derived, not from guide.]
- Per-bucket breakdown; failure taxonomy with counts ranked frequency × business impact; named fix + expected metric movement per category; stated coverage limits (multi-turn negotiation, adversarial emails, rate drift).
- Structured JSONL log per run: case_id, run_index, prompt_version, model, tool calls + args + rows returned, latency, tokens, verdict + reason. Observability seam — "monitoring is a query away, not a rewrite."
- Guardrails worth keeping (real threat model, <1ms): PII regex + prompt-injection substring screen on inbound email bodies — the agent reads untrusted carrier email.
- CI: eval suite runs via `pnpm eval` in GitHub Actions (non-blocking job or report artifact).

## Conscious skips (with interview defense)
| Skipped | Defense |
|---|---|
| judgy corrected rate + CI | Correction assumes a large unlabeled population scored by a validated judge; at n=24 all-labeled it's circular and the CI would swallow [0,1]. Wire in at ~500+ production traces. (Formula is Rogan–Gladen: (p_obs+TNR−1)/(TPR+TNR−1) — re-derived, validated vs guide's 84.4→88.2 example.) |
| 150–200 labels, 15/40/45 splits | Statistically meaningless at 24 cases; calibration-set substitute preserves the no-leakage principle. |
| 100-trace open coding | Narrow 4-tool surface saturates at ~25–30; saturation is the guide's own stopping rule. |
| Phoenix/Langfuse/OTel | JSONL traces capture the required fields; platforms are UI for teams. Guide itself: start with "CSV + Python script." |
| Multi-turn eval | All five failure modes are cross-turn by construction; UI is single-turn. First add if conversational: context-retention scenarios. |
| Guardrail pipeline, daily reports, 1% alerts, sampling, 3-tier cascade, judge-model downgrade | All assume traffic; tiering pays at ~10K traces. Named as production next-steps. |
| Per-stage LLM judges on transcription | WER on sample clips is the right tool. |

## Corrections to eval design v1
- "Judge-vs-human agreement" → TPR/TNR + kappa (agreement is the metric the guide explicitly calls misleading).
- Failure taxonomy moved from end-of-report artifact to design input (error analysis first).
- "Quoted rate matches source" and "load ref present" moved from judge to code.
- k=3/pass^3 kept but attributed as own addition, judge pinned to temp 0.
