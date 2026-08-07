# Failure taxonomy — open + axial coding over 40 live traces

Date: 2026-08-06 · Method: `.claude/research/goodlane-eval-design-2026-08-06.md` §Ordering steps 2–4
Agent under test: `claude-opus-5`, frozen system prompt, 4 tools, `stopWhen: stepCountIs(6)`
Raw traces: `evals/error-analysis/traces.jsonl` (40 lines, one per probe, with tool args, retrieved source ids, full answer, verdict and free-text note)

40 probes over two rounds. Round 1 (P01–P30) sampled the dimension grid; round 2 (R01–R10) probed
the ambiguity/absent cells harder after round 1 saturated on the easy ones. Verdicts:
**30 pass · 4 near-miss · 6 fail.**

Round 2 produced no new failure *types* — only new instances of modes 1, 2 and one counter-example
(R09) to mode 4. That is the design doc's stopping rule (theoretical saturation), so coding stopped
at 40.

## The modes

| # | Name | Definition (one line) | Count | Example traces |
|---|---|---|---|---|
| 1 | **Equipment blind** | `search_inquiries.equipment` filters the *inquiry's* `extracted_equipment` (NULL on 169/329 records), not the referenced *load's* equipment type — and the truncated result set is then reported as complete. | 5 | **P02**, **P25**, P29, P17, P23 |
| 2 | **Lane-join blind** | `origin_state`/`dest_state` reach only inquiries carrying an `extracted_load_reference`; every call has NULL, so lanes named in prose are invisible — and the empty result is reported as "none exist". | 2 | **R05**, P29 |
| 3 | **ASR-name echo** | Reports the transcript's mangled company name instead of the resolved carrier's name of record, though `resolved_carrier_mc` is in the same tool result. | 1 (2 names) | **P10** |
| 4 | **Phantom total** | States an aggregate count as if exhaustive when the 20-row cap and a missing filter mean the enumeration was partial. | 2 | **P20**, P25 |
| 5 | **Verdict flip** | The answer-first headline is emitted before the arithmetic finishes, then reversed mid-answer — the contradicting lead sentence stays in the output. | 1 | **P13** |
| 6 | **Unreachable carrier** | Carriers with `mc_number IS NULL` (BLUE EAGLE LOGISTICS, HKR LOGISTICS LLC — both `authority_status` NULL) cannot be reached by the MC-keyed `carrier_history`, so a real compliance record is structurally invisible. | 2 | P28, R10 |

Secondary, co-occurring with 1/2/4: **tool thrash** (2 — P20 fires 21 `search_inquiries` calls, P23
fires 9, both brute-forcing filter combinations to page around a missing filter and the 20-row cap).
Not listed as its own mode because it never produced a wrong answer on its own — it is the cost
signature of modes 1/2/4, not an independent failure.

Modes 1 and 2 are the same root cause seen from two sides: **`search_inquiries` structured filters
are evaluated against extraction output, but the broker's question is about the load.** They account
for 7 of the 12 mode-instances and for both of the outright wrong answers below. One fix — resolve
`equipment` through the same `extracted_load_reference -> loads` subquery the lane filters already
use, and OR it with `extracted_equipment` — retires both.

## The three worth reading in full

**P02 — the flagship spec query, answered backwards.**
Query: *"Which carriers have confirmed availability for PA-NJ Box Truck loads this week?"* (spec
example 1, verbatim). Answer: **"No PA-NJ Box Truck availability was logged this week (5/18–5/25)."**
Ground truth: CE0044 — Reed Barlus, 2026-05-18, `availability_offer`, `available`, MC 68333, on
PA-NJ Box Truck load 29372343 — plus undated calls call_017 (MC 776491) and call_024 (MC 901234).
The agent's first search was `{equipment:"Box Truck", availability:"available", origin_state:"PA",
dest_state:"NJ", since:"2026-05-18"}` → 0 rows. It correctly suspected the date filter, retried
without `since` — but kept `equipment`, and CE0044's `extracted_equipment` is NULL, so the retry
missed it too. Everything downstream (undated-call caveat, per-carrier compliance) was excellent and
built on a false premise.

**P25 — a wrong number, stated flatly.**
Query: *"What's the highest rate any carrier has quoted us on a box truck load?"* Answer:
**"$540 — the highest box-truck quote in the data"** [CE0217]. Ground truth: **$890**, CE0099
(Nkechi Adeyemi, `rate_counter` on Box Truck load 29000138), then $865 CE0162, $860 CE0107. All three
have `extracted_equipment` NULL, so `equipment:"Box Truck"` never saw them. The proof this is
retrieval scope and not knowledge: **the same agent cited CE0099 at $890 correctly in P20.** The
answer also asserts "every rate_question, availability_offer and booking_confirm record has a null
rate", contradicted by CE0019/CE0002/CE0103 — which P20 itself had listed.

**R05 — "nobody" when two callers are on record.**
Query: *"Who has quoted us the most on PA-MD box truck freight?"* Answer: **"Nobody — we have zero
carrier inquiries on PA-MD box truck freight."** Ground truth: call_004 (Dave, Eagle Express LLC,
**$530**) and call_013 (Gene, Crossroads Transport, **$480**) both open with *"that box truck load,
the PAMD run."* Both have `extracted_load_reference` NULL, so no lane filter can reach them. The tool
description warns about exactly this and names `query` as the fallback; the agent tried three
structured variants and never fell back to FTS. Sharp detail: the ASR wrote the lane as **"PAMD"**,
one token — so a `query:"Maryland"` fallback returns 0 as well. The recovery had to be the literal
mangled token, which is a real argument for the number/lane-token FTS note in the design doc.

## Near-misses — passed, but wobbled

- **P16 vs P08 — recipient identity, inconsistently checked.** P08 volunteered that "Jean is not the
  listed contact" for Crossroads. P16 addressed a draft *"Rami,"* and sent it to
  `rummy@smrtrucking.com` (profile contact: Rummy Singh) with no flag. R07 later reconciled
  Rummy/Rami explicitly. Same check, three different outcomes.
- **P20 vs R09 — the same gap, opposite behavior.** Both ask for a discrepancy-flag count. P20
  confabulates "41 emails" (truth: **94**; sub-counts 23/12/8 vs true 67/16/15). R09 refuses:
  *"I can't give you an exact count — there's no discrepancy filter and the search caps at 20"*, and
  reports 7/20 as an explicitly non-random slice. The **instability** is the finding, not either
  answer.
- **P09 — right verdict, wrong reason.** Correctly returns MC 345678 over the broker's 345878, then
  asserts "the digits weren't unclear on the recording." call_006's transcript literally contains the
  self-correction *"…878 wait …678"* — which is *why* the broker wrote 345878.
- **P17 / P18 — compliance listed without status.** P17 lists MC 1198743 (CONDITIONAL) and MC 678234
  (insurance unknown) as capacity; P18 says both carriers on load 29372490 "matched the Flatbed
  requirement" while MC 885432 is CONDITIONAL. Both disclaim "no compliance checks run yet", which is
  defensible for a listing but drifts toward a recommendation.
- **P28 / R10 — mode 6 handled honestly but incompletely.** Both refuse correctly ("no MC, can't
  verify") without knowing a carrier row exists with `authority_status` NULL.

Worth locking as a positive: **P20 caught a genuine 10x extraction bug unprompted** — CE0027's body
reads "We could do $280" while `extracted_rate_usd` is 2800 — and P26 re-surfaced it in context.
That behavior is now case `L08`.

## Dimensional coverage

Dimensions per the design doc: question type × entity ambiguity × data availability × time scope.
Cells are probe counts; **bold** = at least one failure observed in that cell.

**Question type × entity ambiguity**

| | clean | garbled / flagged | absent | total |
|---|---|---|---|---|
| lookup | 4 | **5** | 2 | 11 |
| set retrieval | **8** | 2 | 0 | 10 |
| rate | **5** | 0 | 0 | 5 |
| draft | **8** | 1 | 1 | 10 |
| compliance | **3** | 0 | 1 | 4 |
| **total** | **28** | **8** | **4** | **40** |

**Data availability × time scope**

| | none | "this week" | window | total |
|---|---|---|---|---|
| present | **21** | **6** | **3** | **30** |
| absent (must abstain) | 7 | 0 | 3 | 10 |
| **total** | **28** | **6** | **6** | **40** |

Reading the coverage honestly:

- **Failures cluster in the `present` row, not the `absent` row.** All 10 abstention probes passed —
  including two adversarial ones (P15 "quote your best rate" with no quote in the corpus; R10
  "confirm their authority is in good standing" for a carrier absent from inquiries). The agent's
  weakness is *finding what is there*, not *inventing what isn't*.
- **Compliance is the strongest cell: 4/4 probes plus every compliance surface inside draft and set
  probes.** All three MC-keyed traps (712843 expired insurance, 1198743 and 885432 CONDITIONAL) and
  the null-authority carrier 329876 were surfaced whenever reachable — R01/R02/R03 each refused to
  write the booking confirmation the broker asked for. Mode 6 is the only compliance gap and it is a
  tool-surface limit, not a model choice.
- **Thinnest cells, stated as a limit:** compliance × garbled (1 probe, R06), set × absent (0 probes
  — a set query whose gold is the empty set is barely distinguishable from an abstention case, so it
  is folded into the abstention bucket), and rate × garbled/absent-entity (0 — the rate tools are
  keyed on lane+equipment, which admits no entity ambiguity).
- **All 6 failures are single-turn retrieval-scope errors.** No hallucinated figures, no fabricated
  citations, no wrong abstention in 40 traces. Every ID and dollar figure spot-checked against
  Postgres — including P20's 40-odd citations — was correct.

## What this hands to the case set

| Mode | Regression cases derived |
|---|---|
| 1 Equipment blind | S01 (spec query 1 verbatim), L05 (max box-truck quote), S05 |
| 2 Lane-join blind | S06 (PA-MD box truck quotes, calls only) |
| 3 ASR-name echo | L06 (canonical name for MC 538772) |
| 4 Phantom total | S04 (flagged-email count) |
| 5 Verdict flip | L07 (rate-vs-market verdict on 29372343) |
| 6 Unreachable carrier | A05 (Blue Eagle authority status) |

Six of 24 cases are `origin: regression`; the remaining 18 are `origin: ground_truth`, drawn from
dataset facts the probes never touched, so the suite is not merely a replay of this session.
