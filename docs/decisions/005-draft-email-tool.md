# ADR 005 — draft_email: structured drafts through a deterministic template

Status: accepted (live extension) · Date: 2026-08-11

## Context

Email drafts were freeform model prose, constrained only by the EMAIL DRAFTS
prompt section. Two of the system's strongest guarantees therefore lived in
the prompt, not in code: "no invented figures" and the compliance gate. The
failure taxonomy (`evals/report.md`) had already named the fix for the
Compliance-miss mode: a hard code gate that refuses to emit a booking draft
without the carrier's compliance state in the same run.

## Decision

**The model selects and fills; a template speaks.** A fifth tool,
`draft_email` (`{to_inquiry_id | to_carrier_mc, intent, load_id?, rate_usd?,
pickup_date?, missing_info?}`), renders one of four intents (`rate_confirm`,
`decline`, `availability_reply`, `info_request`) through pure string assembly
in `src/lib/agent/draft-email.ts` — no LLM inside the tool (spec invariant),
one obvious file to edit to change Goodlane's outbound voice.

The tool re-fetches and validates everything it says:

- **Recipient** resolves from the carrier record first (the name of record
  beats an ASR rendering — the L06 lesson), falling back to the inquiry
  sender.
- **Figures**: `rate_usd` must equal the load's posted rate or the anchored
  inquiry's quoted rate; `pickup_date` must match the load record. A mismatch
  is a structured refusal naming what IS on record — the model must relay it,
  not work around it.
- **Compliance gate in code**, sharing `carrier_history`'s exact computation:
  expired insurance or revoked authority refuses a booking draft outright;
  non-blocking concerns (CONDITIONAL authority, unknown expiry) render with a
  mandatory, non-removable contingency paragraph — D03's judgment call
  ("accept at the posted figure only if conditioned on verification"),
  formerly model behavior, now code.

The prompt's EMAIL DRAFTS section now mandates the tool and forbids
hand-written bodies.

**Shipped alongside (same PR): prompt caching.** Anthropic cache breakpoints
on the agent's system prompt (covers tools+system, route and eval runner
mirrored) and the judge rubric — previously 0 cached tokens on 1.36M input in
a sweep. Verified live by `cached_input_tokens > 0` in the run records.
Caching changes billing and latency, never outputs.

## Eval impact

- **D01–D05 required_tools now include `draft_email`** — a dated label change
  recorded in each case's notes. Runs generated before the tool existed fail
  the check by construction; pre-tool runs must not be re-graded against the
  new labels.
- **The judge's checks become partially structural but are NOT retired**: the
  model can still smuggle an invented commitment into slot values or into the
  prose around the draft, so `no_invented_commitments` and
  `professional_tone` still run unchanged, against the same calibration set.
- **Measured D-bucket before/after** (same cases, k=3, judge v3): before
  15/15 (freeform drafts, `runs-postfix-20260807.jsonl`) → after **15/15**
  (`runs-20260811T093603Z.jsonl`), with `draft_email` called in **15/15 runs**
  and D03's contingency caveat rendered by code in 3/3. Aggregate unchanged at
  the bucket's ceiling — the win is invariance (figures and the gate can no
  longer regress by prompt drift), not a score delta.
- **Token accounting, stated honestly**: per-run input GREW ~67% (202,825 →
  338,015 tokens for the bucket — one extra loop step plus a fifth tool
  schema), while caching served **65.5%** of input from cache (221,340 /
  338,015). Net: ~$1.07 for the after-bucket vs $1.44 the before-bucket cost
  uncached (read-discount arithmetic; the 1.25x write premium is not itemized
  in the runs file). First smoke run cached 11,067 / 19,928 (55%) with zero
  code beyond the breakpoint.

## Consequences

- Two prompt-level guarantees are now code, each with a direct test: figure
  invention and ungated bookings are refusals, not graded model behavior.
- 19 new tests (suite 241 → 260): 15 pure-renderer tests need no database or
  model; 4 DB-backed tests pin recipient resolution and the CONDITIONAL trap
  (`tools.test.ts`).
- New failure surface, stated: an over-strict validator can refuse legitimate
  drafts (e.g. negotiating a NEW rate is not expressible — by design, a
  human decision); the refusal path is loud and the model relays the reason.
- Templates constrain tone; judge tone checks on tool-rendered drafts mostly
  measure the template. Kept anyway — the surrounding turn is still model
  prose.

Evidence: `src/lib/agent/draft-email.ts`, `src/lib/agent/draft-email.test.ts`,
`evals/results/` (D-bucket rerun), ADR 003/004 for the harness this plugs
into.
