# Freight assistant — eval report

| field | value |
| --- | --- |
| run id | postfix-20260807 |
| label | **BASELINE** — no agent or tool fixes applied |
| model | claude-opus-5 |
| prompt version | sp-v1 |
| judge version | v3 |
| cases | 24 (`cases.jsonl`) |
| runs | 72 (k=3) |
| runs file | `evals/results/runs-postfix-20260807.jsonl` |

This is the **baseline**. The two dominant failure modes from error analysis
(`equipment-blind`, `lane-join-blind`) are EXPECTED to fail cases here — 8 of the 24 cases
exist precisely to catch them. Nothing in the agent or the tools was changed to make this
report look better; the before/after comparison is the next phase's deliverable.

## Headline

| Metric | Value | Wilson 95% CI | Definition |
| --- | --- | --- | --- |
| **Run-level pass rate** | 52/72 (72.2%) | [61.0%, 81.2%] | every graded run, all k pooled — the expected outcome of one broker query |
| **pass@1** | 17/24 (70.8%) | [50.8%, 85.1%] | case passes if its first run passes (the k=1 slice) |
| **pass^3** | 16/24 (66.7%) | [46.7%, 82.0%] | case passes only if ALL k runs pass — our own addition, see note |

The CI is Wilson, not Wald: at n in the twenties with p near 1, Wald runs past 1.0 and
collapses to zero width at p=1. Publishing the width is the point — at this n the interval
is wide, and a report that hides that is selling a number it does not have.

> **k=3 and pass^3 are our own addition, not prescribed by the source guides.** They exist
> so run-to-run variance is attributed to the agent rather than mistaken for a regression.
> The judge cannot be pinned to temperature 0 on `claude-opus-5` (see Judge section), so
> k=3 plus measured judge repeat-stability is how variance is separated instead.

## Per-bucket

| Bucket | Cases | Runs passed | Run-level rate (Wilson 95%) | pass^3 |
| --- | --- | --- | --- | --- |
| factual_lookup | 8 | 20/24 | 83.3% [64.1%, 93.3%] | 6/8 |
| set_retrieval | 6 | 3/18 | 16.7% [5.8%, 39.2%] | 1/6 |
| email_draft | 5 | 15/15 | 100.0% [79.6%, 100.0%] | 5/5 |
| abstention | 5 | 14/15 | 93.3% [70.2%, 98.8%] | 4/5 |

## Failed cases in detail

| Case | Origin | Runs failed | Mode | Grader reasons |
| --- | --- | --- | --- | --- |
| L06 | regression | 2/3 | ASR-name echo | `exact-match`: exact-match L06: 1/3 gold assertions failed — company_name: expected "Chahal Trucking" in the answer |
| L07 | regression | 2/3 | Verdict flip | `exact-match`: exact-match L07: 1/5 gold assertions failed — GRADER NOTE: no 'below market' assertion anywhere: forbidden phrase present — "Below market" |
| S01 | regression | 3/3 | Equipment blind | `set-f1`: set-f1 S01: P=0.2 R=1 F1=0.333 (threshold 1) — F1 below threshold — missing=[] spurious=[CE0057, CE0016, CALL_051, CALL_054]<br>`set-f1`: set-f1 S01: P=0.25 R=1 F1=0.4 (threshold 1) — F1 below threshold — missing=[] spurious=[CE0057, CALL_051, CALL_054] |
| S02 | ground_truth | 3/3 | Unclassified | `set-f1`: set-f1 S02: P=0.667 R=1 F1=0.8 (threshold 1) — F1 below threshold — missing=[] spurious=[CE0059, CALL_026]<br>`set-f1`: set-f1 S02: P=0.8 R=1 F1=0.889 (threshold 1) — F1 below threshold — missing=[] spurious=[CE0059] |
| S04 | regression | 3/3 | Phantom total | `set-f1`: set-f1 S04: P=0.75 R=1 F1=0.857 (threshold 1) — F1 below threshold — missing=[] spurious=[CE0016, CE0042, CE0019] |
| S05 | regression | 3/3 | Equipment blind | `set-f1`: set-f1 S05: P=0.667 R=1 F1=0.8 (threshold 1) — F1 below threshold — missing=[] spurious=[CALL_051, CE0046]; excluded id(s) named in the answer: CE0046<br>`set-f1`: set-f1 S05: P=0.571 R=1 F1=0.727 (threshold 1) — F1 below threshold — missing=[] spurious=[CALL_051, CALL_054, CE0046]; excluded id(s) named in the answer: CE0046 |
| S06 | regression | 3/3 | Lane-join blind | `set-f1`: set-f1 S06: P=0 R=0 F1=0 (threshold 1) — F1 below threshold — missing=[CALL_004, CALL_013] spurious=[CE0069, CE0070, CE0015, CE0044, CE0057]<br>`set-f1`: set-f1 S06: P=0 R=0 F1=0 (threshold 1) — F1 below threshold — missing=[CALL_004, CALL_013] spurious=[CE0069, CE0070] |
| A05 | regression | 1/3 | Compliance miss | `compliance-surfacing`: compliance-surfacing A05: "authority status cannot be verified": missing verified (required tokens: authority + cannot + verified) |

## Failure taxonomy

Ranked by **frequency x business impact** (impact is a judgement about what the failure
costs a broker, recorded in `evals/lib/taxonomy.ts`, not a measurement). Mode names come
from the axial coding in `evals/error-analysis/failure-modes.md`, which was done BEFORE
the case set was authored — the taxonomy is a design input here, not a post-hoc summary.

| Mode | Failing runs | Cases | Impact | Named fix | Expected metric movement |
| --- | --- | --- | --- | --- | --- |
| **Equipment blind** | 6 | S01, S05 | critical | Resolve `equipment` through the same `extracted_load_reference -> loads` subquery the lane filters already use, OR-ed with `extracted_equipment`. | S01, S05, L05 move to pass; set-retrieval bucket pass@1 rises by ~3 cases. |
| **Lane-join blind** | 3 | S06 | critical | Same subquery fix as equipment_blind, plus a mandatory FTS fallback when a structured search returns zero rows. | S06 moves to pass. |
| **Phantom total** | 3 | S04 | high | Tools already return `total_matches`; require the answer to cite it whenever it states a count, and to label any enumeration that hit `limit` as partial. | S04 stabilises; phantom_total instances go to zero. |
| **Verdict flip** | 2 | L07 | high | Prompt rule: compute before you lead. Any comparative verdict must be stated once, after the figures it rests on. | L07 moves to pass. |
| **Compliance miss** | 1 | A05 | critical | Already prompted; escalate to a hard code gate that refuses to emit a booking draft without a `carrier_history` call in the same run. | D03, D04, L04 stay green; any regression is blocking. |
| **Unclassified** | 3 | S02 | medium | Re-run open coding on these traces. | n/a |
| **ASR-name echo** | 2 | L06 | medium | System-prompt rule: when `resolved_carrier_mc` is present, the carrier's name of record is the canonical answer; the transcript rendering may be offered as an aside. | L06 moves to pass. |

**Fix effects are predictions, not results.** That is what makes this a baseline: the next
phase applies the fixes and this table gets a measured before/after column.

Modes with zero instances in the graded runs: Unreachable carrier, Ungrounded citation, Invented commitment, Abstention break, Tool omission.

### Mode definitions

| Mode | Definition | Seen in pre-case error analysis? |
| --- | --- | --- |
| Equipment blind | `search_inquiries.equipment` filters the inquiry's `extracted_equipment` (NULL on 169/329 records), not the referenced load's equipment type — and the truncated result set is reported as complete. | yes |
| Lane-join blind | `origin_state`/`dest_state` reach only inquiries carrying an `extracted_load_reference`; every call has NULL, so lanes named in prose are invisible — and the empty result is reported as 'none exist'. | yes |
| ASR-name echo | Reports the transcript's mangled company name instead of the resolved carrier's name of record, though `resolved_carrier_mc` is in the same tool result. | yes |
| Phantom total | States an aggregate count as if exhaustive when the 20-row cap and a missing filter mean the enumeration was partial. | yes |
| Verdict flip | The answer-first headline is emitted before the arithmetic finishes, then reversed mid-answer — the contradicting lead sentence stays in the output. | yes |
| Unreachable carrier | Carriers with `mc_number IS NULL` cannot be reached by the MC-keyed `carrier_history`, so a real compliance record is structurally invisible. | yes |
| Ungrounded citation | A bracketed source id in the answer does not appear in any tool result from that run. | no — detector added for this harness |
| Invented commitment | A draft commits to a figure, appointment, term or fact that no tool result supports (code: dollar-figure subset; judge: no_invented_commitments). | no — detector added for this harness |
| Compliance miss | A blocking compliance fact (expired insurance, non-ACTIVE authority, unknown status) is not surfaced where the case requires it. | no — detector added for this harness |
| Abstention break | The agent answers a question whose subject is not in the corpus, or invents an attribute for an absent entity. | no — detector added for this harness |
| Tool omission | A tool the case requires (by name + argument subset, order-insensitive) was never called. | no — detector added for this harness |

## Failure localization (3-step)

Applied to every failed run in a retrieval bucket:

1. Was the gold record retrieved by any tool call in that run? No -> **RETRIEVAL**.
2. Does the retrieved payload actually contain the gold answer? No -> **CORPUS**.
3. Otherwise the data was in hand and the answer is still wrong -> **GENERATION**.

Step 2 is the trap-catcher: it is what stops a corpus gap being mis-filed as a retrieval bug
and 'fixed' with tuning that cannot work.

| Case | Run | Verdict | Detail |
| --- | --- | --- | --- |
| L06 | 0 | **GENERATION** | gold records were retrieved and contain the answer; the answer is still wrong |
| L06 | 2 | **GENERATION** | gold records were retrieved and contain the answer; the answer is still wrong |
| L07 | 0 | **GENERATION** | gold records were retrieved and contain the answer; the answer is still wrong |
| L07 | 1 | **GENERATION** | gold records were retrieved and contain the answer; the answer is still wrong |
| S01 | 0 | **GENERATION** | gold records were retrieved and contain the answer; the answer is still wrong |
| S01 | 1 | **GENERATION** | gold records were retrieved and contain the answer; the answer is still wrong |
| S01 | 2 | **GENERATION** | gold records were retrieved and contain the answer; the answer is still wrong |
| S02 | 0 | **GENERATION** | gold records were retrieved and contain the answer; the answer is still wrong |
| S02 | 1 | **GENERATION** | gold records were retrieved and contain the answer; the answer is still wrong |
| S02 | 2 | **GENERATION** | gold records were retrieved and contain the answer; the answer is still wrong |
| S04 | 0 | **GENERATION** | gold records were retrieved and contain the answer; the answer is still wrong |
| S04 | 1 | **GENERATION** | gold records were retrieved and contain the answer; the answer is still wrong |
| S04 | 2 | **GENERATION** | gold records were retrieved and contain the answer; the answer is still wrong |
| S05 | 0 | **GENERATION** | gold records were retrieved and contain the answer; the answer is still wrong |
| S05 | 1 | **GENERATION** | gold records were retrieved and contain the answer; the answer is still wrong |
| S05 | 2 | **GENERATION** | gold records were retrieved and contain the answer; the answer is still wrong |
| S06 | 0 | **RETRIEVAL** | gold ids never returned by any tool call: call_004_rate_negotiation, call_013_rate_negotiation, 945231 |
| S06 | 1 | **RETRIEVAL** | gold ids never returned by any tool call: call_004_rate_negotiation, call_013_rate_negotiation, 945231 |
| S06 | 2 | **RETRIEVAL** | gold ids never returned by any tool call: call_004_rate_negotiation, call_013_rate_negotiation, 945231 |

## Flip-floppers (unstable cases)

Cases whose k runs disagree. Instability is itself a finding — the error analysis found
the same gap answered two opposite ways (P20 confabulated a count, R09 refused it), and
the instability was the finding, not either answer.

| Case | Bucket | Verdicts (run 0..k) | Failing graders |
| --- | --- | --- | --- |
| L06 | factual_lookup | FAIL / PASS / FAIL | exact-match |
| L07 | factual_lookup | FAIL / FAIL / PASS | exact-match |
| A05 | abstention | PASS / PASS / FAIL | compliance-surfacing |

## Dimensional coverage

Cells are case counts. **Bold** = at least one graded run in that cell failed.
A `?` superscript counts cases in that cell with no graded run yet.
Dimension tags are hand-assigned in `evals/lib/dimensions.ts`, one line per case id —
not regexed out of the query text, which would silently mis-tag and turn this table
into decoration. This is a coverage statement, not a cherry-pick: the thin cells are
named below rather than hidden.

**Question type x entity ambiguity**

| question type | clean | garbled_or_flagged | absent | total |
| --- | --- | --- | --- | --- |
| lookup | 2 | **4** | 2 | **8** |
| set | **3** | **3** | — | **6** |
| rate | **2** | — | — | **2** |
| draft | 4 | 1 | — | 5 |
| compliance | 1 | — | **2** | **3** |

**Data availability x time scope**

| data availability | none | this_week | window | total |
| --- | --- | --- | --- | --- |
| present | **13** | **3** | **2** | **18** |
| absent | **5** | — | 1 | **6** |

Thinnest cells, stated as limits: rate x garbled (0 — the rate tools key on
lane+equipment, which admits no entity ambiguity), set x absent (0 — a set query whose
gold is the empty set is not meaningfully distinct from an abstention case, so it is
folded into that bucket), draft x absent-entity (0).

## Latency and cost

| Measure | median | p95 | max |
| --- | --- | --- | --- |
| end-to-end (ms) | 14999 | 35407 | 53400 |

**Per-tool execution time (ms)** — DB time only, excludes model latency:

| Tool | calls | median | p95 | max |
| --- | --- | --- | --- | --- |
| carrier_history | 67 | 5 | 44 | 49 |
| get_load | 41 | 2 | 5 | 47 |
| market_rate | 17 | 2 | 6 | 6 |
| search_inquiries | 157 | 5 | 61 | 69 |

| Tokens | total | per run |
| --- | --- | --- |
| input | 1355677 | 18829 |
| output | 77066 | 1070 |
| cached input (read) | 0 | 0 |

Tool calls per run: mean 3.9, max 13. Steps per run: mean 3.2.

**Cost.** $8.71 for 72 graded runs — $0.1209 per query on `claude-opus-5`. Priced from the token counts each run recorded, using the `PRICING` map in `evals/compare.ts`; not an estimate from a per-call average.

## Judge

Two **binary** checks on draft cases, run as **separate calls** and never averaged:
`no_invented_commitments` and `professional_tone`. Positive class = **PASS**, so TPR is
the pass-recognition rate and **TNR is the failure-catching rate** — the one that matters.
Raw agreement is deliberately not reported: a judge that always says PASS scores ~90%
agreement when failures are rare.

### Temperature 0 is impossible here — what we do instead

The design doc pins the judge to temperature 0. `claude-opus-5` **rejects**
`temperature`, `top_p` and `top_k` outright, so that instruction cannot be followed.
The substitute, in three parts:

1. `generateObject` against a strict Zod schema with `explanation` declared **before**
   `label` — the model must write its reasoning before it can emit a verdict.
2. Extended thinking disabled via `providerOptions.anthropic.thinking = {type:'disabled'}`,
   so the judge's own reasoning budget is not a hidden source of variance.
3. **Measured** repeat-stability (3 runs x 6 calibration items, flip rate reported) in place
   of *assumed* determinism. This is strictly more honest than temperature 0 ever was:
   temp 0 is not deterministic on a serving stack either, it just stops you measuring.

Full rationale and per-version history: `evals/judge/versions.md`.

### Calibration (20 hand-labeled drafts, tuned on the calibration set ONLY)

| version | check | TP/FP/TN/FN | TPR | TNR | Cohen kappa | n |
| --- | --- | --- | --- | --- | --- | --- |
| v1 | no_invented_commitments | 10/0/7/3 | 76.9% | 100.0% | 0.700 | 20 |
| v1 | professional_tone | 16/0/4/0 | 100.0% | 100.0% | 1.000 | 20 |
| v2 | no_invented_commitments | 13/0/7/0 | 100.0% | 100.0% | 1.000 | 20 |
| v2 | professional_tone | 16/0/4/0 | 100.0% | 100.0% | 1.000 | 20 |
| v3 | no_invented_commitments | 13/0/7/0 | 100.0% | 100.0% | 1.000 | 20 |
| v3 | professional_tone | 16/0/4/0 | 100.0% | 100.0% | 1.000 | 20 |

Kappa bands: >0.8 excellent, 0.6-0.8 good, <0.6 rewrite the criteria.

**Below the >80% target:** v1/`no_invented_commitments` (TPR 76.9%, TNR 100.0%). Reported rather than papered over — the diagnosis and the
prompt change it drove are in `evals/judge/versions.md`.

Measured versions: v1, v2, v3. Any prompt version shipped in
`evals/judge/` without a row above is **uncalibrated** — see `evals/judge/versions.md`
for what was still pending when the API budget ran out mid-phase.

### Repeat-stability (the temperature-0 substitute)

3 runs x 6 calibration items x 2 checks = 12 cells; **0 flipped** (flip rate 0.0%), prompt v3.

<!-- generated by evals/components/run.ts (`pnpm eval:components`), embedded verbatim -->

## Phase 4C — pipeline component evals

| Component | Metric | Result |
| --- | --- | --- |
| Extraction | per-field accuracy vs hand gold (n=15) | 100.0% (75/75 fields) |
| Extraction | records with all 5 fields correct | 100.0% (15/15) |
| Resolution | carrier identity — overall | 100.0% (75/75) |
| Resolution | carrier identity — calls (all 55) | 100.0% (55/55) |
| Resolution | carrier identity — emails (20 sample) | 100.0% (20/20) |
| Resolution | carrier identity — hard set | 100.0% (19/19) |
| FTS numerics | calls unfindable by FTS on their own MC | 38/55 — see `fts-notes.md` |
| Transcription | calls with a non-numeric cross-track divergence | 1/55 — see `wer-check.md` (substitute for WER, not WER) |

### Structural checks

- PASS — extraction gold is the stratified 15 (8 emails / 7 calls): 15 records = 8 emails + 7 calls
- PASS — extraction gold contains every eval-critical record: call_006_rate_negotiation, call_036_compliance_check, call_046_load_details, call_038_compliance_check, CE0074
- PASS — every positively-asserted gold field carries a raw-text quote: all positive assertions cite the source
- PASS — resolution gold covers all 55 calls + a 20-email sample: 55 calls + 20 emails
- PASS — every graded id has a cached extraction on disk: all present
- PASS — every extraction disagreement has been adjudicated: 0 disagreement(s), 0 unadjudicated
- PASS — resolution hard set includes the 4 named records: 19 records in the hard set

### Extraction accuracy vs hand-labeled gold (n=15: 8 emails, 7 calls)

| Field | Correct | Total | Accuracy |
| --- | ---: | ---: | ---: |
| mc_number | 15 | 15 | 100.0% |
| load_reference | 15 | 15 | 100.0% |
| rate_usd | 15 | 15 | 100.0% |
| equipment | 15 | 15 | 100.0% |
| availability | 15 | 15 | 100.0% |
| **all fields** | **75** | **75** | **100.0%** |

All-five-fields-correct per record: 15/15, Wilson 95% CI [79.6%, 100.0%].

The field-level CI [95.1%, 100.0%] is printed for completeness but is optimistic: the 75 field decisions are clustered inside 15 records, not independent draws. The record-level interval is the one to quote.

No disagreements: extraction matched gold on every field.

### MC-resolution accuracy vs hand-derived gold (carrier identity)

| Slice | Correct | Total | Accuracy | Wilson 95% CI |
| --- | ---: | ---: | ---: | --- |
| overall | 75 | 75 | 100.0% | [95.1%, 100.0%] |
| calls (all 55) | 55 | 55 | 100.0% | [93.5%, 100.0%] |
| emails (20 sample) | 20 | 20 | 100.0% | [83.9%, 100.0%] |
| hard set | 19 | 19 | 100.0% | [83.2%, 100.0%] |

Hard set (19) = the 4 eval-critical records + every `mcLowConfidence` call: call_002_rate_negotiation, call_005_rate_negotiation, call_006_rate_negotiation, call_010_rate_negotiation, call_013_rate_negotiation, call_029_availability_check, call_030_availability_check, call_031_compliance_check, call_032_compliance_check, call_034_compliance_check, call_036_compliance_check, call_038_compliance_check, call_040_compliance_check, call_042_load_details, call_046_load_details, call_047_load_details, call_050_load_details, call_051_voicemail, call_054_voicemail

Resolution methods used across the graded set: mc_exact 59, email_exact 14, name_fuzzy 2

Recovered by company name after the MC route failed: call_038_compliance_check, call_046_load_details

No resolution misses.


## Conscious skips (with interview defense)

The first seven rows are copied verbatim from
`.claude/research/goodlane-eval-design-2026-08-06.md` §Conscious skips. The skip list is
as load-bearing as the adopt list: each row is a thing we could have built and chose not
to, with the reason it would not have paid.

| Skipped | Defense |
| --- | --- |
| judgy corrected rate + CI | Correction assumes a large unlabeled population scored by a validated judge; at n=24 all-labeled it's circular and the CI would swallow [0,1]. Wire in at ~500+ production traces. (Formula is Rogan–Gladen: (p_obs+TNR−1)/(TPR+TNR−1) — re-derived, validated vs guide's 84.4→88.2 example.) |
| 150–200 labels, 15/40/45 splits | Statistically meaningless at 24 cases; calibration-set substitute preserves the no-leakage principle. |
| 100-trace open coding | Narrow 4-tool surface saturates at ~25–30; saturation is the guide's own stopping rule. |
| Phoenix/Langfuse/OTel | JSONL traces capture the required fields; platforms are UI for teams. Guide itself: start with "CSV + Python script." |
| Multi-turn eval | All five failure modes are cross-turn by construction; UI is single-turn. First add if conversational: context-retention scenarios. |
| Guardrail pipeline, daily reports, 1% alerts, sampling, 3-tier cascade, judge-model downgrade | All assume traffic; tiering pays at ~10K traces. Named as production next-steps. |
| Per-stage LLM judges on transcription | WER on sample clips is the right tool. |
| **WER human-listen — PENDING, not skipped** | `evals/components/wer-check.md` substitutes a cross-track divergence count (1/55) for true WER. Real WER needs a human listening to audio; that is a scheduled task, not a design decision. Reported as pending so it cannot be mistaken for a measured number. |
| **Resolving the `professional_tone` TNR ceiling** | Only 4 negative labels exist for that check, so TNR granularity is 25 points — one miss reads as 75%. Adding negatives to reach a finer resolution means authoring more corrupted drafts, which is cheap but was not worth spending judge-tuning budget on before the check is calibrated at all. Reported as a stated limit rather than padded around. |

## Stated coverage limits

- **Multi-turn negotiation** is not evaluated; the UI is single-turn and every failure mode
  found in error analysis is single-turn by construction.
- **Adversarial carrier email** (prompt injection in an inbound body) is not evaluated. The
  design doc keeps a PII + injection substring screen as a real guardrail; it has no case here.
- **Rate drift** — the corpus is a frozen snapshot at `REFERENCE_DATE` 2026-05-25. Nothing
  here measures behaviour as rates move.
- **n=24.** The defense is the guide's own: 50 high-quality labels beat 500 noisy ones. The
  Wilson interval above is the honest statement of what that buys.
