# Implementation Status: Goodlane Freight Carrier Agent
Plan: .claude/plans/goodlane-freight-agent-2026-08-06.md
Last Updated: 2026-08-06 (session 2)

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

## RESUME CHECKLIST when API access returns (in order)
1. `pnpm re-extract --ids CE0027` → re-run resolve → `pnpm seed` (fixes 10× rate bug)
2. Finish baseline: `EVAL_RUN_ID=<id> pnpm eval` (48 remaining runs; baseline label!)
3. Judge: `calibrate.ts --version v2` (target TPR>80 on commitments) + `stability.ts`
4. Post-fix full run → before/after table into report (expect L05 3/3→0/3 etc.)
5. Model comparison: compare.ts --models opus-5,sonnet-5,haiku-4.5 + OpenAI Codex 5.6
   "Luna" leg (verify model ID via web search; needs OPENAI_API_KEY in .env)
6. Fill ADR 003/004 pending numbers; then Phase 5 (deploy/README/PR merges).

## ⛔ HARD BLOCKER — Anthropic org monthly spend cap exhausted
API returns 400 "reached your specified API usage limits… regain access 2026-09-01" —
org-wide, all models (verified with direct HTTP probe). This blocks: 48 remaining baseline
runs (~$4), judge v2 calibration + stability (~$2), fix-round re-run (~$6), model comparison
(~$15-25), AND THE LIVE DEMO ITSELF. Fix: Hanson raises the monthly spend limit in
console.anthropic.com (Settings → Limits) — takes effect immediately.
Resume commands are documented in evals/judge/versions.md; missing runs:
`EVAL_RUN_ID=<id> pnpm eval` then `calibrate.ts --version v2` then `stability.ts`.

**FIX ROUND after baseline (do NOT fix before)**: equipment filter joins through loads;
CE0027 10× extraction bug ($280→2800, locked as case L08); weightedAvg misnomer in tools.ts;
then re-run eval → before/after row. Live-extension rehearsal candidates: name-keyed
carrier lookup (fixes unreachable-carrier + A05), chat persistence.

**Model comparison (after fix round)**: opus-5 / sonnet-5 / haiku-4.5 / OpenAI Codex 5.6
"Luna" (verify model ID+pricing via web search — post-cutoff; needs OPENAI_API_KEY).

## Blockers
- PRs #1→#2→#3 stacked, awaiting Hanson review/merge in order.
- OPENAI_API_KEY needed before the Codex leg of the model comparison.
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
