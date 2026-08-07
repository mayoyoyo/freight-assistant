# Judge prompt versions

Model: `claude-opus-5` (AI SDK v7, `@ai-sdk/anthropic` v4). Tuning signal:
`evals/calibration.jsonl` (20 hand-labeled draft emails) and nothing else. The
24 reported cases in `evals/cases.jsonl` were never read while building or
tuning this judge — that is the no-leakage principle the design doc substitutes
for train/dev/test splits at n=24.

---

## Why there is no `temperature: 0` (read this before citing the design doc)

The eval design doc pins the judge to temperature 0, for a specific and correct
reason: if the judge's own sampling wobbles, then run-to-run variance in the
headline pass rate is a mixture of agent variance and grader variance, and the
k=3 / pass^3 numbers stop meaning what they claim to mean. The grader has to be
the fixed instrument.

**That instruction cannot be followed on this model.** `claude-opus-5` rejects
`temperature`, `top_p` and `top_k` outright — the API returns HTTP 400 if any of
them is present in the request. There is no sampler knob to pin. Passing the
parameter anyway would break every judge call, and quietly downgrading the judge
to an older model that accepts `temperature` would trade a real capability loss
for a nominal reproducibility claim.

So the design doc's *goal* is met by other means, and the substitution is
deliberate:

1. **Constrained decode.** Every verdict is produced with `generateObject` and a
   strict Zod schema — `explanation`, then `label` (`PASS` | `FAIL`), then
   `confidence`. There is no free-form text to drift in, and the label is drawn
   from a two-element enum. Field order is load-bearing: JSON is generated left
   to right, so declaring `explanation` first forces the model to write its
   reasoning before it commits to a verdict. `judge.test.ts` asserts that order
   so a future refactor cannot silently reverse it.
2. **Extended thinking disabled**, via
   `providerOptions: { anthropic: { thinking: { type: "disabled" } } }`. Thinking
   is on by default on this model and is a long, unconstrained, high-variance
   decode path. Turning it off is the single largest available reduction in
   judge nondeterminism, and the judge does not need it: the criteria are
   explicit and the inputs are short.
3. **Measured repeat-stability instead of an assumed one.** `stability.ts` runs
   the judge three times over the same six items and reports the flip rate —
   the fraction of (item x check) cells where the three labels are not
   unanimous.

Point 3 is the important one. `temperature: 0` was only ever a *proxy* for "the
judge returns the same verdict on the same input", and on a production inference
stack it is an imperfect proxy at that — batching and kernel nondeterminism mean
temperature 0 is not bit-reproducible either. A measured flip rate is strictly
more informative than an unverified parameter: it puts a number on how much of
the observed agent variance could actually be judge variance. That number
belongs in the report next to pass@1 and pass^3, and it is the honest answer to
"how do you know your grader isn't the thing that's moving?"

## Known resolution limit — state this before quoting any TNR

`professional_tone` has only **4 negative labels** in the calibration set (16
pass / 4 fail). TNR is therefore quantized to 25-point steps: 4/4 = 100%, 3/4 =
75%, 2/4 = 50%. **One miss reads as 75% and drops the check below the 80%
target.** That wall is a property of the label counts, not of the prompt. The
correct response to landing on 75% is to report it as 75% with the n=4 caveat,
not to bolt an item-specific clause onto the prompt to recover the last cell —
an overfit prompt is a worse deliverable than an honest 75%, because it will not
generalize to the reported cases where the numbers actually count.
`no_invented_commitments` is better resourced at 13 pass / 7 fail: TPR moves in
7.7-point steps, TNR in 14.3-point steps.

## Positive-class convention

**PASS is the positive class**, everywhere, in every artifact:

- TPR = P(judge says PASS | human says pass) — recall on good drafts. Low TPR
  means the judge over-triggers and will manufacture false failures in the
  report.
- TNR = P(judge says FAIL | human says fail) — the failure-catching rate. Low
  TNR means the judge rubber-stamps and the eval is decorative.

Raw agreement is deliberately never the headline. On this calibration set a
judge that always says PASS scores 65% agreement on `no_invented_commitments`
and 80% on `professional_tone` while catching zero failures. `judge.test.ts`
encodes exactly that scenario as a regression test.

---

## v1 — 2026-08-06 — `claude-opus-5`, thinking disabled — **MEASURED**

First version. Written from the design doc's prompt skeleton, the domain rules
in `src/lib/agent/system-prompt.ts` (EMAIL DRAFTS + GROUNDING), and the
freight-brokerage vocabulary; not tuned against any calibration outcome, because
there were no outcomes yet. Two checks, two separate prompts, two separate API
calls — never one call, never averaged.

Calibration artifact: `calibration-v1.json` (40 calls, 20 items x 2 checks).

| check | n | TP | FP | TN | FN | TPR | TNR | accuracy | kappa |
|---|---|---|---|---|---|---|---|---|---|
| `no_invented_commitments` | 20 | 10 | 0 | 7 | 3 | **76.9%** | **100.0%** | 85.0% | 0.700 |
| `professional_tone` | 20 | 16 | 0 | 4 | 0 | **100.0%** | **100.0%** | 100.0% | 1.000 |

Kappa bands: >0.8 excellent, 0.6-0.8 good, <0.6 rewrite the criteria. Tone is
excellent (1.000, perfect). Groundedness is "good" (0.700) but its TPR misses
the 80% target.

**Diagnosis.** All three errors are the same shape: false alarms (FN), zero
missed failures (FP = 0). The judge catches every corruption in the set and then
over-triggers on three clean drafts. Per the design doc's iteration
diagnostics, low TPR calls for tightening the criteria rather than adding
failure examples — the criteria were correct but *over-scoped*, catching
assertions the check was never meant to own:

1. **No reference date.** The corpus is a frozen snapshot ending 2026-05-25 and
   every draft is written on that day, but v1's prompt never said so. The judge
   resolved "pickup is today" against the inquiry's `occurred_at` and called a
   correct relative date an invented schedule detail. A pure information gap.
2. **Characterizations of the carrier's own business.** The judge failed a draft
   for framing a load against the carrier's lane preferences when the profile
   note named an adjacent-but-different lane. That framing binds Goodlane to
   nothing, carries no figure or term, and is addressed to the party who is the
   authority on the subject.
3. **Goodlane's own commercial disposition.** Two drafts said the load was
   covered / gone while the load row still read `status: "open"`. The judge
   called that an unsourced factual assertion. It is a decision the broker owns
   and announces, not a claim about the freight's specifications and not a
   commitment offered to the carrier — and `status` is a lagging snapshot field.
   The check is named *no invented commitments / hallucinated logistics*; a
   withdrawal is neither.

**Repeat-stability: PENDING** — blocked on API budget (see below).

## v2 — 2026-08-06 — `claude-opus-5`, thinking disabled — **UNCALIBRATED**

Written in response to the v1 diagnosis above. Changes, and the diagnostic that
drove each:

| change | driven by |
|---|---|
| Added the frozen `REFERENCE_DATE` (2026-05-25) to the groundedness check's domain section, with an explicit instruction to resolve "today"/"tomorrow"/weekday names against it and never against a record's `occurred_at`. | v1 diagnosis (1) |
| Scoped the check's opening instruction to assertions **about the freight or about the terms Goodlane is offering this carrier**, and rewrote the borderline heuristic as a two-step test (is it a claim about the freight or our terms? only then, is it enforceable and unsourced?). | v1 diagnosis (2) + (3) |
| Added does-NOT-count item 6: characterizations of the carrier's own business that carry no number or term. | v1 diagnosis (2) |
| Added does-NOT-count item 7: Goodlane's own commercial disposition (covered / gone / passing), with the explicit note that a `status: "open"` row does not by itself make "we covered it" an invented fact. | v1 diagnosis (3) |
| `professional_tone` section left **byte-identical to v1**. | It scored 100/100 with kappa 1.000. There was nothing to diagnose, and holding it fixed means any movement in the v2 tone numbers is judge noise rather than a prompt effect — a free control. |

| check | n | TP | FP | TN | FN | TPR | TNR | accuracy | kappa |
|---|---|---|---|---|---|---|---|---|---|
| `no_invented_commitments` | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |
| `professional_tone` | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |

**Why PENDING.** The v2 calibration run aborted on its second batch: the
Anthropic organization returned
`400 invalid_request_error: "You have reached your specified API usage limits.
You will regain access on 2026-09-01 at 00:00 UTC."` The cap is org-wide and
model-independent, so it is not recoverable by retrying, by lowering
concurrency, or by switching models. **No v2 metric is estimated, simulated or
inferred anywhere in this repository.** A fabricated calibration number would be
the single worst artifact this harness could ship — the entire point of the
judge is that its error rates are measured. `PENDING` means PENDING.

`JUDGE_VERSION` in `judge.ts` therefore stays at **`v1`**: the default must be
the best *measured* prompt, not the best *believed* prompt.

---

## Protocol to execute when budget returns (2026-09-01)

Run these in order. Cost is roughly $1-2 per calibration run (40 calls) and
under $1 per stability run (36 calls). Both runners preflight a single call and
abort cleanly with exit code 2 on a usage-limit 400, so a capped budget costs
one request rather than the whole loop.

```bash
# 1. Measure v2 against the same 20 items.
pnpm exec tsx evals/judge/calibrate.ts --version v2 --concurrency 6

# 2. Fill in the v2 row above from calibration-v2.json, then compare to v1.
#    Expected movement: no_invented_commitments FN 3 -> 0..1, i.e. TPR
#    76.9% -> 92-100%, with TNR holding at 100%. Treat any TNR drop below
#    100% as a regression: the v2 changes are all does-NOT-count carve-outs,
#    and the failure mode of that lever is letting real corruptions through.

# 3. If v2 clears TPR > 80% AND TNR > 80% on both checks, set
#    JUDGE_VERSION = "v2" in judge.ts and run stability on the winner.
pnpm exec tsx evals/judge/stability.ts --version v2 --repeats 3
```

Decision rules for the next session, so it executes rather than re-derives:

- **If v2 clears both targets on both checks**, stop at v2. Do not write a v3 to
  chase the last cell; each version costs real money and the marginal item is
  where overfitting starts.
- **If v2's TNR regressed** (a real corruption now passes), the carve-outs were
  written too broadly. Narrow item 7 to withdrawal language specifically
  ("we've covered it", "we're passing") rather than commercial disposition in
  general, and re-run as v3.
- **If v2's TPR is still below 80%**, read the new misses in
  `calibration-v2.json` before touching the prompt. Three misses out of 13
  positives is a 7.7-point-per-item metric; a single stubborn item is a 92.3%
  ceiling, which clears the target and should be accepted rather than patched.
- **If `professional_tone` lands on 75% TNR**, report 75% with the n=4
  granularity caveat. Do not add a clause aimed at the specific item that
  flipped.
- **Stop at v3** unless a v4 is clearly justified by a new failure *shape*, not
  by a residual count.

## Provenance and no-leakage

- Every few-shot example in every prompt file is held out: invented loads,
  carriers, lanes and dollar figures that appear in neither
  `evals/calibration.jsonl` nor `evals/cases.jsonl`. No calibration draft is
  quoted verbatim or paraphrased, so all 20 calibration items remain scoreable.
  `judge.test.ts` asserts that no version file contains a `CAL\d\d` identifier.
- The prompt files were tuned only against calibration outcomes.
  `evals/cases.jsonl` and `evals/report.md` were not opened at any point during
  judge construction.
- `evals/calibration.jsonl` is treated as read-only input. Two items are flagged
  in the handoff notes as arguably under-specified (the drafts that announce a
  load as covered while the accompanying load row reads `status: "open"`); the
  file was **not** edited to resolve the disagreement.
