# Implementation Status: Goodlane Freight Carrier Agent
Plan: .claude/plans/goodlane-freight-agent-2026-08-06.md
Last Updated: 2026-08-10 (session 5 — polish round; project LIVE, PR #6 open)

## SESSION 5 (2026-08-10) — interview-prep polish round
1. DONE ADR trim — PR #6 (docs/adr-trim): all 4 ADRs tightened (2,431→1,848
   words), ADR 004 gains the missing v2-retraction update block, ADR 003 the
   v3 re-grade note. Codex adversarial review: 6 findings, 5 accepted+fixed
   (blocker: prediction claim over-reached — only L05's fix prediction was
   validated; L06/L07 prompt-rule fixes were never applied). CI green.
   ⛔ MERGE BLOCKED by tool-permission classifier — Hanson merges PR #6.
   Follow-ups flagged, not fixed: report-postfix.md:5 stale "BASELINE" label
   (report generator); versions.md:243 says CAL07/17 were v1 false alarms —
   actual v1 misses CAL05/06/16 (calibration-v1.json) — needs a dated
   correction note, never a silent edit.
2. DONE draft_email tool DESIGN (not implemented) — private note
   HANDOFF-2026-08-10-draft-email-design.md. Implementation reserved as the
   live-extension rehearsal rep with Hanson (schema → tools.ts → prompt line
   → live probe → D-bucket before/after, ~$5).
3. DONE WALKTHROUGH.md restructured (gitignored): one-page overview + 5
   headline numbers / per-layer detail / topic-indexed Q&A.
4. DONE (2026-08-11, Hanson's call: ship it into PR #6) draft_email tool +
   prompt caching IMPLEMENTED — ADR 005. Deterministic template renderer
   (src/lib/agent/draft-email.ts), compliance gate in code (CONDITIONAL →
   mandatory contingency; expired/revoked → refuse), rate/pickup validated
   vs DB. Codex review of the first cut: 1 blocker + 4 major, all real —
   cross-load rate transplant, contradictory anchors, LIKE-wildcard ids,
   stale schedules rendered live, PROMPT_VERSION not bumped — fixed with
   regression tests (+ sp-v2, extractor-visible based_on ids, null-MC
   carrier reach via resolved_carrier_id, email-required refusal, README
   count). 27 new tests (268 total), build green. Final D-bucket rerun
   15/15, draft_email 15/15, D03 caveat 3/3, D01/D05 stale flag rendered
   (runs-20260811T100150Z.jsonl; superseded first-run file removed).
   Caching: ephemeral breakpoint at route/run-agent/judge; measured 61.9%
   input cached (~$1.15 vs $2.12 uncached). Flagged not fixed: grade-only
   has no guard against re-grading pre-tool runs under new labels (human
   warning in cases.jsonl notes + ADR). Session spend ~$5.
Reminder standing: Deployment Protection OFF for demo — re-enable after
the interview.

## Pre-implementation (done)
- [x] Architecture diagram `docs/architecture.svg` — APPROVED by Hanson
- [x] `WALKTHROUGH.md` seeded (diagram explanation, glossary, Q&A) — gitignored, never commit
- [x] DECIDED: chat persistence stays stateless (client-held history; what-I'd-improve item)

## Completed Phases
- [x] Phase 0: Scaffold + first push — 3 commits on main, pushed (Hanson), CI green on GitHub.
- [x] Phase 1: Schema + seed — PR #1 (feat/phase1-schema-seed). Local verify: seed idempotent,
      counts 48/50/720/274; FTS number tokens VERIFIED searchable (websearch_to_tsquery on MC
      numbers + load IDs works; no trigram fallback needed); equipment vocab uniform across sources.
      Local dev DB: Postgres.app 14.20 on :5432, db `freight_assistant`, `.env` written (gitignored).

## Current Phase
Phase 2: Ingestion pipeline — 2a DONE, 2b agent running

- [x] Codex CLI review of PR #1: 8 findings; #1 CONFIRMED real data loss (num/str dropped JSON
      numbers/booleans — 0/41 reliability scores survived; onboarded is boolean not date). Fixed:
      coercion helpers + tests, transactional parse-first seed, strict Zod NDJSON validation +
      coverage check, reqNum throws, extracted_availability column, source_type CHECK, unique
      lane/week index, dbEnv(). Rejected with rationale: surrogate-key split, numeric money.
      Triage table posted as PR #1 comment. Reseed verified: reliability 41/41, onboarded 48/48.
- [x] Phase 2a (worktree agent): 55/55 transcribed, nova-3 general. KEY FINDINGS:
      smart_format mangles dictated digits in 33 files ("300And45800And78"=345878) — raw ASR
      correct without smart_format; diarization collapses to 1 speaker on 28/55; per-word
      confidence discriminates, alternative-level saturated; 15 calls legitimately have no MC.
      Merged into feat/phase2-ingestion (branch stacked on phase-1).
- [x] Phase 2b DONE + independently verified — PR #2 (stacked on #1). 329/329 extracted,
      $4.54, 0 failures/unresolved; resolution mc_exact 174 / email_exact 153 / fuzzy 2;
      flags: rate_found_but_stated_null 67, intent_mismatch 16, equipment_mismatch 15;
      mc_low_confidence 16. 46 unit tests green.
      **EVAL-CRITICAL corrections to prior beliefs:**
      * "15 no-MC calls" was WRONG — only call_038 lacks an MC (matches a null-MC carrier).
      * call_006 MC = 345678 (self-correction "…878 wait …678"); NOT 345878.
      * Decoy pattern is OMISSION not contradiction: 145 emails have stated_mc but NO MC in
        body — correct extraction returns null; eval must not score that as a miss.
      * call_046 = planted wrong MC (665432 → nothing); name_fuzzy recovers Crossroads
        Transport 663210. Signal: resolution_method='name_fuzzy' + non-null extracted MC.
      * Calls have occurred_at NULL (no timestamps) — "this week" queries must handle it.
      * Extraction prompt bug caught+fixed: summed concatenated MC segments instead of
        concatenating; all calls re-run under final prompt.

- [x] Phase 3 DONE — PR #3 (stacked on #2). 4 tools (search_inquiries gained lane-join,
      ids, mc_low_confidence filters — all probe-driven), frozen system prompt (grounding/
      citations, compliance gate, abstention, REFERENCE_DATE, undated-calls caveat),
      chat UI w/ tool chips. All 5 probes verified live + my own smoke test (compliance
      query: citations, low-conf caveat, abstention behavior all correct). 52 tests+build
      green. **AI SDK is v7 (installed ai@7.0.54) — big API drift from training priors:
      instructions: not system:, await convertToModelMessages, createUIMessageStreamResponse,
      onToolExecutionEnd, MockLanguageModelV4, useChat has no input/handleSubmit. Know this
      before live-extension.** Spec example queries live in data/raw/README.md:91 (NOT the
      scoping doc): PA-NJ availability this week; best rate for load #29372450 (a best-OFFER
      lookup, not market rate — both inquiries on it ask US for a rate; correct answer is
      "no carrier has quoted").

## Current Phase
Phase 4: Eval (THE emphasized deliverable) — 4A+4C done, 4B (harness+judge+baseline) running

- [x] 4A error analysis (40 traces): 6 named failure modes. Top root cause: equipment/lane
      filters see only inquiry-level extracted fields (NULL on 169/329) → truncated sets
      reported as complete ("equipment-blind" 5, "lane-join-blind" 2). Also: phantom-total
      (20-row cap), unreachable null-MC carriers (carrier_history is MC-keyed), ASR-name echo,
      verdict-flip. Abstention 10/10 clean; citations/figures all spot-check correct — the
      weakness is FINDING what's there, not inventing. 24 cases (8 regression-origin) +
      20-item calibration set (10 clean/10 corrupted, disjoint from cases).
      **My review of its 7 gold judgment calls: ALL ACCEPTED** (inclusive week boundary;
      load-equipment semantics; posted-rate-passes; no-provisional-when-flag-false; S05 set
      semantics; S04 week-scoped for row cap; A05 refusal-passes).
- [x] 4C component evals: extraction 75/75 vs gold (Wilson [79.6,100]) + meta-tests proving
      the comparator catches corruption; MC resolution 75/75 incl. 19-case hard set (scores
      carrier IDENTITY not MC string — 3 null-MC carriers make that load-bearing); FTS: 38/55
      calls unfindable by FTS on own MC (measured "why typed columns" defense); 4-min human
      listen list in evals/components/wer-check.md (call_006 645678 confirm etc.).
      New: "Chesapeake Haulers" only real ASR word error (both tracks wrong differently);
      extractor can hallucinate company names from ASR noise (latent name_fuzzy risk);
      5 emails say "MC #N/A" (all Blue Eagle).
- [x] 4B harness BUILT + merged to feat/phase4-eval (pushed): runner (generate/grade split —
      re-gradeable from disk), 8 graders + 71 meta-tests (215 tests total), judge v1
      MEASURED (tone TPR/TNR 100/100 kappa 1.0; commitments TPR 76.9 TNR 100 kappa 0.70 —
      3 false alarms diagnosed, v2 prompt written but UNCALIBRATED, JUDGE_VERSION stays v1),
      report gen w/ Wilson (design doc's [65,96] was wrong; correct [64.1,93.3], unit-pinned),
      CI eval job (offline meta-tests only, cost rationale in comments), compare.ts scaffold.
      **BASELINE PARTIAL: 24/72 runs (factual_lookup bucket complete): pass@1 5/8, run-level
      18/24 (75%, Wilson [55.1,88.0]). Failures = exactly the predicted regression cases:
      L05 equipment-blind 3/3 (RETRIEVAL), L06 ASR-name echo 2/3, L07 verdict-flip 1/3
      (GENERATION, flip-floppers). $1.97 for 24 runs.**
      Case-label issues reported (S02 inconsistent compliance field, L02/S04 drift) — fix
      in fix round. generateObject defaults max_tokens 128K on opus-5 — pin it.

- [x] Fix round CODED offline + merged (feat/phase4-eval @ ed5cde3, 222 tests green):
      equipment/lane OR-join through loads (L05: $540→$890 w/ CE0099 present; P02: CE0044
      present — direct-tool tests lock it); explicit truncated flag + prompt line;
      weightedAvg→meanOfWeeklyAvgs; maxOutputTokens pinned (judge 4096, agent+route 8192 —
      WATCH: opus-5 caps thinking+text together, bump if max_tokens stops appear);
      cases.jsonl S02/L02/S04 label fixes (documented); `pnpm re-extract` one-command
      CE0027 fix (unexercised — needs API); 4 ADR drafts in docs/decisions/ (003/004 have
      pending-number placeholders). Two tests changed because they encoded the bug as
      contract (agent.test.ts equipment assert; graders.test.ts S02 list) — reviewed, correct.

## SESSION 3 RESULTS (2026-08-07) — checklist state
1. DONE CE0027 re-extract -> resolve -> seed. Direction note: raw body says $280;
   2800 was the extraction bug; L08 gold = 280. DB verified: 280 + flag intact.
2. DONE baseline COMPLETE: 48 runs generated from pre-fix e4ff03f (worktree
   ../freight-assistant-baseline, branch baseline-rerun) vs pre-fix data, merged
   with 24 on-disk, 48 old cap-400 error records dropped, all 72 graded one pass
   (corrected labels, judge v2): pass@1 17/24, pass^3 15/24, run-level 51/72
   (70.8%). Buckets: abstention 14/15, email_draft 15/15, factual 18/24,
   set_retrieval 4/18 (dominant failure, as 4A predicted).
   THREE GRADER FALSE-FAIL CLASSES found via cross-provider run + fixed + pinned
   as regressions (commit 8abca6e): U+2019 apostrophes defeating negation regexes
   (foldPunctuation), conditionals read as fabrications, unlisted different-
   company labels. Cross-provider grading is now part of grader validation.
3. DONE judge v2 PROMOTED: TPR/TNR 100/100 both checks, kappa 1.0, 12/12
   repeat-stability. JUDGE_VERSION="v2". calibration-v2.json + stability-v2.json.
4. PARTIAL post-fix run (runs-postfix-20260807.jsonl): 36/72 generated before the
   cap re-hit; 23/36 graded pass. L05 0/3->3/3 (fix verified). L06/L07 persist.
   **S01/S02 FLIPPED failure mode: R=1.0 but precision drops (spurious ids) — the
   OR-join over-returns and the agent doesn't filter. Next-round candidate:
   intersection guidance in prompt.** 36 errored runs = cap-400 artifacts; on
   resume, drop them and regenerate missing runs with --only (merge like baseline).
5. Luna leg DONE (fair-graded): pass@1 7/24, run-level 15/72, $0.0026/query,
   set_retrieval 0/18. Ran on post-fix code + PRE-fix data (only L08 affected);
   fold into final table by re-running with the other legs post-cap ($0.20).
6. DONE (cap raised to $70): post-fix run COMPLETE 52/72 (L05 fixed 0/3->3/3;
   set_retrieval flipped recall->precision, aggregate flat — analysis in
   evals/before-after.md). Model comparison COMPLETE (all post-fix, judge v2):
   opus 70.8% $0.121/q · sonnet 62.5% $0.061/q · haiku 29.2% $0.008/q · luna
   25.0% $0.0026/q; set_retrieval ~3/18 for EVERY model (task-level failure);
   sonnet-vs-opus unresolved at n=24, recorded as future promotion decision.
   ADR 003/004 filled (dated updates). report.md regenerated + report-postfix.md.
   **PR #4 OPEN: https://github.com/mayoyoyo/freight-assistant/pull/4**
   Session-3 total spend ~= $20 Anthropic + $0.60 OpenAI; cap headroom left ~$25.
7. NEXT (Phase 5): Codex review of PR #4 per process; Neon attach + deploy;
   README; live-extension rehearsal. Known next fix round: prompt-side
   intersection guidance for set queries, verify via before-after table.

## Blockers
- ⛔ Anthropic cap RE-HIT 2026-08-07 at the raised $40 limit (mid post-fix run).
  Remaining Anthropic work needs ~$10-12: ask Hanson to raise to ~$55-60.
  Session-3 spend: ~$10 Anthropic (48 baseline gen ~$4, judge v2 calib+stability
  ~$1.5, 3 judge grade passes ~$1.5, 36 post-fix runs ~$3), $0.40 OpenAI.
- PRs #1→#2→#3 stacked, awaiting Hanson review/merge in order.
- ~~OPENAI_API_KEY needed~~ RESOLVED 2026-08-07: key in .env, leg wired + smoke-tested.
- Optional 4-min human listen: evals/components/wer-check.md.

## Deviations from Plan
- Next.js 16.3 instead of 15 (create-next-app@latest current stable; plan predates 16; no API concerns —
  note AGENTS.md warns Next 16 differs from training data → read `node_modules/next/dist/docs/` before route code in Phase 3).
- `typecheck` script is `next typegen && tsc --noEmit` (Next 16 generates route types, e.g. `LayoutProps`).
- Biome excludes CSS (`!**/*.css`) — cannot parse Tailwind v4 at-rules.
- create-next-app generated AGENTS.md (Next-maintained, kept) and CLAUDE.md (rewritten with project content).
- `.claude/observability/` gitignored (session telemetry, not a deliverable).

## Notes for next phases
- User emphasized (2026-08-06): ingestion output must be a format the agent can reason over, with the data-store
  choice justified — Phase 5 ADR must frame Postgres+FTS explicitly as the answer to that spec line.
- Phase 0 committed straight to main (no PR possible on empty repo); Phases 1+ are feature-branch PRs.
