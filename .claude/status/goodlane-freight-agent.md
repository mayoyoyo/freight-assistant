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
Phase 4: Error analysis → eval harness → report (THE emphasized deliverable)

**Scope addition (Hanson, this session): model-comparison eval run** — same harness over
claude-opus-5 vs claude-sonnet-5 vs claude-haiku-4-5 vs OpenAI **Codex 5.6 "Luna"**
(cross-provider via @ai-sdk/openai; verify exact model ID + pricing via web search at run
time — post-cutoff model; needs OPENAI_API_KEY from Hanson). Output: pass-rate vs cost/query
table in evals/report.md.

## Blockers
- (none) PRs #1→#2→#3 stacked, awaiting Hanson review/merge in order.
- OPENAI_API_KEY needed only when the model-comparison run starts (late Phase 4).

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
