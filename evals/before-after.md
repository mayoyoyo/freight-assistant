# Fix round: measured before/after + model comparison

Both sides: same 24 cases, k=3, graded with the same graders and judge v3 (see evals/judge/versions.md for the v2 retraction).
Baseline = pre-fix code (`e4ff03f`) against pre-fix data. Post-fix = branch
head against re-extracted data (CE0027 280, verified against the raw body).
Runs files: `results/runs-baseline-20260806.jsonl`,
`results/runs-postfix-20260807.jsonl`. Full per-run detail: `report.md`
(baseline) and `report-postfix.md`.

## Headline

| metric | baseline | post-fix |
| --- | --- | --- |
| run-level | 51/72 (70.8%) | 52/72 (72.2%) |
| pass@1 | 17/24 | 17/24 |
| pass^3 | 15/24 | 16/24 |

| bucket | baseline | post-fix |
| --- | --- | --- |
| factual_lookup | 18/24 | 20/24 |
| set_retrieval | 4/18 | 3/18 |
| abstention | 14/15 | 14/15 |
| email_draft | 15/15 | 15/15 |

Per-case movement: **L05 0/3 → 3/3** (equipment OR-join — the targeted fix,
verified end-to-end); L07 2/3 → 1/3 (known flip-flopper, generation-mode);
S04 1/3 → 0/3 (see below).

## The honest story: the fix worked and the aggregate didn't move

The equipment/lane OR-join fixed exactly what it targeted. It also
**transformed the set-retrieval failure mode rather than eliminating it**:
baseline S-cases failed on recall (missing items — sets silently truncated);
post-fix S-cases fail on precision (R=1.0, spurious items — e.g. S01 P=0.2
with CE0057, CE0016, CALL_051, CALL_054 listed beyond gold). The wider join
now over-returns and the agent reports borderline items instead of filtering
to the question's intersection (availability intent x equipment x lane).

Two things follow. First, over-inclusion is the better failure mode to hold:
a broker can see and discard extras; silent omission was invisible. Second,
the next fix is prompt-side intersection guidance, not another tool change —
and it should be verified by this same table, because "did the fix work" is a
measurement. Without a set-F1 grader this recall→precision trade would have
read as "fixed".

## Model comparison (post-fix code + data, judge v3)

Full table: `results/compare-cmp-final-20260807.md`. Summary:

| model | pass@1 | run-level buckets (abst / draft / factual / set) | $/query |
| --- | --- | --- | --- |
| claude-opus-5 | 70.8% (17/24) | 14/15 · 15/15 · 20/24 · 3/18 | $0.1209 |
| claude-sonnet-5 | 62.5% (15/24) | 15/15 · 15/15 · 16/24 · 3/18 | $0.0610 |
| claude-haiku-4-5 | 29.2% (7/24) | 4/15 · 5/15 · 6/24 · 3/18 | $0.0080 |
| gpt-5.6-luna | 25.0% (6/24) | 9/15 · 2/15 · 2/24 · 0/18 | $0.0026 |

Readings, in the order they matter:

1. **set_retrieval fails at ~3/18 for every model** — the precision problem is
   a property of the task+tool+prompt system, not of model choice. No amount
   of model shopping fixes it; the intersection-guidance fix round would.
2. **sonnet-5 is the real production question.** Half the cost of opus,
   pass@1 within overlapping Wilson intervals ([42.7, 78.8] vs [50.8, 85.1])
   — n=24 cannot separate them. Notably it beats opus on abstention (15/15).
   Its gap is factual completeness (16/24 vs 20/24). Decision: opus stays the
   demo default; promoting sonnet would need a larger case set to resolve the
   overlap — which is exactly the kind of question this harness exists to
   answer cheaply later.
3. **The cheap tier fails on thoroughness, not fluency.** haiku calls ~1.4
   tools/run and often zero on abstention cases (answers without looking);
   luna under-retrieves and skips required tool calls before drafting. Their
   failures are invisible without an eval — the prose reads fine.
4. Cost ratio across the table is 46x (opus $0.1209 vs luna $0.0026) for a
   2.8x pass@1 ratio. If per-query cost ever matters at Goodlane's scale, the
   play is a router (cheap model for lookups that pass, escalate on
   abstention/set queries), not a wholesale swap.
