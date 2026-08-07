# Implementation Plan: Goodlane Freight Carrier Agent
Date: 2026-08-06
Based on research: `.claude/research/goodlane-agent-scoping-2026-08-04.md` + `.claude/research/goodlane-eval-design-2026-08-06.md`

## Summary
Build, eval, and deploy a freight-broker intake agent: Next.js 15 + Vercel AI SDK tool loop over Neon Postgres, fed by a committed offline ingestion pipeline (Deepgram transcription + Claude extraction), graded by a ~24-case eval harness with TPR/TNR-validated judge, deployed on Vercel with decision-log documentation. Process artifacts (PRs, ADRs) are graded deliverables — work in feature branches with PRs.

**Guiding principle (Hanson, 2026-08-06): simple and defensible over clever.** Hanson is new to agent-writing and must defend every piece live. Prefer the boring, explainable construction; if a component can't be explained in two sentences, simplify it. Every phase must be understandable end-to-end by reading the walkthrough doc.

**Standing deliverable — walkthrough doc (NOT committed):** maintain `WALKTHROUGH.md` at repo root, listed in `.gitignore`. After each phase, append a section written for a novice agent-builder: what was built, how the pieces connect, why each choice was made (plain language, no jargon), what to say if asked about it, and the 2–3 questions an interviewer would most likely ask with answers. This is Hanson's study/defense document — update it in the same PR-cycle as the code, but never commit it.

**Pre-implementation deliverable — architecture diagram:** before Phase 0 code, produce a high-level SVG architecture diagram (dataset → ingestion pipeline → Postgres → agent tool loop → UI, with the eval harness as a sidecar instrument) and show it to Hanson for sign-off. Keep the source in `docs/architecture.svg` (committed — it doubles as README material); walkthrough references it.

## Prerequisites
- [x] Vercel account with GitHub integration (done; CLI logged in as `mayoyoyo`)
- [x] GitHub remote `mayoyoyo/freight-assistant` (empty — first push unblocks Vercel import)
- [ ] `ANTHROPIC_API_KEY` for extraction scripts + deployed agent (env var, never committed)
- [ ] `DEEPGRAM_API_KEY` (free tier covers the ~$0.77 job)
- [ ] Copy dataset into repo `data/raw/` (reviewers need reproducibility; dataset was provided to us for this exercise)
- [ ] Neon DB provisioned via Vercel dashboard once repo imported (Phase 5); local dev can use the same `DATABASE_URL` via `vercel env pull`

## Design Decisions
| Decision | Chosen Approach | Rationale (full defense in research docs) |
|---|---|---|
| Stack | Next.js 15 App Router, TypeScript strict, pnpm | Vercel-native, streaming built-in, one language across app+ingestion+eval |
| Agent loop | Vercel AI SDK (`streamText` + tool loop, `stopWhen stepCountIs(6)`) | Plain-object tool registry → live extension = ~15-line change; rejected LangGraph (over-engineering), Agent SDK (wrong shape) |
| Model | `claude-opus-5` via `@ai-sdk/anthropic` (verified against claude-api skill 2026-08-06) | Current Opus, $5/$25; used for agent, extraction, and judge |
| DB | Neon Postgres + Drizzle ORM, `tsvector` FTS | ~1,150 records = 3 orders below vector-DB territory; entity-scoped queries favor lexical; agentic retrieval framing |
| Transcription | Deepgram nova-3 (general, not `phonecall` — 16kHz wideband), diarization + `smart_format`/`numerals` + keyterm "MC" | Only provider with diarization + word timestamps + per-word confidence in one sync POST; confidence flags garbled MC numbers |
| Ingestion | Offline scripts (`scripts/`), outputs committed to `data/derived/` | Zero runtime STT dependency; reviewers re-seed in seconds; rejected ingestion endpoint |
| Extraction | Claude structured outputs over raw text; pre-labeled fields stored as `stated_*` only | Dataset trap: `rate_quoted_usd` null in all 274, `equipment_mentioned` contradictions — extract from body/transcript, flag discrepancies |
| Eval | Hand-rolled TS harness, JSONL cases, `pnpm eval`, CI | Per eval-design v2; rejected Braintrust/LangSmith (account deps) |
| Judge determinism | Structured binary output + explanation-before-verdict; **no temperature param** (Opus 5 rejects sampling params — documented deviation from guide's "temp 0" convention); report judge repeat-stability on calibration set | API constraint discovered at plan time; honest handling beats pretending |
| Reference "now" | Fixed `REFERENCE_DATE=2026-05-25` injected into system prompt from config | Dataset frozen; "this week" queries must resolve deterministically; also cache-friendly (no Date.now() in prompt) |

## Source of Truth (Spec Extract)

### Invariants (MUST always be true after implementation)
- [ ] Extraction pipeline never uses `intent`, `equipment_mentioned`, or `rate_quoted_usd` from carrier_emails.json as extracted values; they are persisted only as `stated_*` columns for discrepancy flagging.
- [ ] Every extracted record carries provenance: `source_type` (email|call), `source_id`, and `discrepancy_flags[]`.
- [ ] Agent answers containing numbers (rates, weights, counts) cite source record IDs present in that turn's tool results (eval-enforced groundedness check).
- [ ] Carrier-recommending answers surface compliance state when `authority_status != 'ACTIVE'` or `insurance_expiry < REFERENCE_DATE` (eval-enforced).
- [ ] All DB access through Drizzle parameterized queries; no string-interpolated SQL anywhere.
- [ ] Deployed app makes zero calls to Deepgram; transcripts are committed artifacts.
- [ ] Judge prompt lives in a versioned file with its calibration TPR/TNR recorded; eval cases (`evals/cases.jsonl`) are never used to tune the judge (calibration set is separate).
- [ ] MC numbers transcribed with any word-confidence < 0.85 in the digit span are flagged `low_confidence` in the derived transcript record.
- [ ] `ANTHROPIC_API_KEY`/`DEEPGRAM_API_KEY` never committed; env validated via Zod at boot (fail-fast).

### Constraints (MUST NOT be violated)
- [ ] No vector DB / embeddings in the core path (FTS only; pgvector is an explicitly-labeled stretch, off by default).
- [ ] No LLM call inside `market_rate` — it is a SQL aggregate.
- [ ] Eval harness has no external SaaS dependency (runs with `DATABASE_URL` + `ANTHROPIC_API_KEY` only).
- [ ] UI stays minimal (single chat page + tool-call visibility); no auth, no polish.

### Verification Commands
```bash
pnpm typecheck && pnpm lint && pnpm test        # quality gates
pnpm eval                                        # eval harness (writes evals/report.md)
grep -rn "rate_quoted_usd\|equipment_mentioned" src/ | grep -v stated_   # invariant 1 spot-check
grep -rn "new Date()" src/lib/agent/             # reference-date invariant (expect none)
psql "$DATABASE_URL" -c "select count(*) from inquiries"   # seed check (274 emails + 55 calls)
```

## Implementation Steps
(Per Hanson's standing preference, phases 1–4 module work is delegated to parallel subagents where independent; main session orchestrates + reviews. One PR per phase.)

### Phase 0: Scaffold + first push (~20 min)
**Objective:** Repo skeleton, quality gates, CI; push so Vercel import becomes possible.
**Steps:**
1. `pnpm create next-app` (App Router, TS, no tailwind opinions beyond default), strict tsconfig + `noUncheckedIndexedAccess`.
2. Biome config; Vitest; GitHub Actions: typecheck → lint → test (eval job added Phase 4, non-blocking).
3. Drizzle + `@neondatabase/serverless` + Zod env validation (`src/lib/env.ts`).
4. Copy dataset to `data/raw/`; commit; push `main`; open repo settings note to grant the 3 reviewers when going private.
**Verification:** CI green on GitHub; `pnpm dev` renders.

### Phase 1: Schema + structured seed (~25 min)
**Objective:** Postgres schema + seed for loads/carriers/rates; FTS-ready inquiries table.
**Files:** `src/db/schema.ts`, `scripts/seed.ts`, `drizzle.config.ts`.
**Steps:**
1. Tables: `loads`, `carriers`, `rate_history`, `inquiries` (unified email+call: source_type, source_id, raw_text/transcript, extracted fields, `stated_*` columns, discrepancy_flags jsonb, mc_resolved, confidence flags, tsvector column w/ trigger or generated column — config must handle number-dense text: verify load IDs/MC numbers tokenize searchably, else add a plain trigram/ILIKE fallback column).
2. `scripts/seed.ts`: idempotent (truncate+insert), parses CSVs/JSON from `data/raw/` + derived NDJSON when present.
**Verification:** seed against local/Neon DB; row counts match (50/48/720; inquiries after Phase 2).

### Phase 2: Ingestion pipeline (~45 min, parallelizable into 2a/2b)
**Objective:** WAVs → transcripts; emails+transcripts → extracted, entity-resolved records; committed artifacts.
**Files:** `scripts/transcribe.ts`, `scripts/extract.ts`, `scripts/resolve.ts`, `data/derived/transcripts/*.json`, `data/derived/inquiries.ndjson`.
**Steps:**
1. **2a Transcribe:** Deepgram nova-3, diarize+smart_format+numerals+keyterm("MC"); persist full response JSON per call (words, confidences, speakers); cache — skip files whose output exists.
2. **2b Extract:** Claude structured output per email/transcript → {mc_number, load_reference, rate_quoted, equipment, availability, intent, questions}; batch with concurrency limit; never feed `stated_*` fields into the prompt as truth (include them separately for discrepancy comparison only). For calls: use diarized transcript, flag low-confidence MC digit spans (<0.85).
3. **Resolve:** MC exact → email exact → fuzzy name match against carriers; write `mc_resolved` + `resolution_method` + ambiguity flags. Cross-validate extracted load_reference vs stated field → discrepancy_flags.
4. Commit derived artifacts; re-run seed.
**Verification:** counts (55 transcripts, 274+55 inquiries); spot-check 3 known-messy records (CE0074 equipment mismatch; a garbled-MC call; a wrong-load-reference email); unit tests on resolver with fixture inputs.

### Phase 3: Agent + tools + UI (~45 min)
**Objective:** Chat route with tool loop; minimal UI with visible tool calls.
**Files:** `src/app/api/chat/route.ts`, `src/lib/agent/{system-prompt,tools}.ts`, `src/app/page.tsx`, `src/lib/log.ts`.
**Steps:**
1. Tools (Zod-typed, narrow): `get_load(load_id)`, `search_inquiries(query, {equipment?, origin_state?, dest_state?, intent?, since?})` (FTS + filters, returns source IDs), `carrier_history(mc_number)` (profile + inquiry rollup + compliance fields), `market_rate(origin_state, dest_state, equipment, window_weeks)` (SQL aggregate: avg/min/max per mile + volume).
2. System prompt: role, REFERENCE_DATE, grounding rule (cite source IDs; numbers only from tool results), compliance gate rule, abstention rule ("say unknown if not in data"), draft-email capability guidance. Keep prompt frozen/stable (cache-friendly).
3. Route: AI SDK `streamText` w/ anthropic('claude-opus-5'), `stopWhen: stepCountIs(6)`, `maxDuration` set. Structured per-tool-call logging (name, args, ms, rows) → `src/lib/log.ts` JSONL-style console.
4. UI: `useChat`, message list, tool-call chips (name+args+row count) — demo-strong, cheap.
5. One mocked agent-loop test (`MockLanguageModelV2`): asserts tool selected + args for a canned query.
**Verification:** manual: the 2 spec example queries + 1 draft-email ask + 1 abstention probe; mocked test green.

### Phase 4: Error analysis → eval harness → report (~60 min)
**Objective:** The tight eval, per eval-design v2 (this is an emphasized deliverable).
**Files:** `evals/{cases.jsonl,calibration.jsonl,run.ts,graders/*.ts,judge/prompt-v*.md,report.md}`.
**Steps:**
1. **Error analysis first:** dimensional sampling (question type × entity ambiguity × data availability × time scope) → ~25–30 queries; run agent; open-code notes; axial-code into 4–6 named failure modes (recorded in report).
2. Author ~24 cases from failure modes + dataset ground truth: 8 factual lookup (exact match), 6 set retrieval (P/R/F1 vs gold IDs), 5 email drafts, 5 abstention. Hand-label gold; tag any fixed-failure case `origin: regression` + `original_failure`.
3. Code graders (`{passed, reason}`, N/A short-circuit): exact-match; set P/R/F1; $-figures-⊆-source; load-ref present; required-tool+args (membership not order); groundedness (cited IDs ∈ retrieved); compliance-flag surfacing; abstention. Meta-test each with clean-pass/corrupted-fail/out-of-scope-pass fixtures (Vitest).
4. Judge (2 binary checks: no-invented-commitments, tone): skeleton per guide (role → PASS/FAIL criteria → failure types → does-NOT-count section → 3 few-shot incl. borderline → JSON explanation-before-label). Build ~16–20-item calibration set (half deliberately corrupted); hand-label; iterate prompt to TPR/TNR >80%; record kappa; version file with metrics. Never tune on cases.jsonl.
5. Runner: k=3 per case, pass@1 + pass^3, flag flip-floppers; Wilson 95% CI on headline rate; per-bucket breakdown; failure taxonomy w/ counts; 3-step localizer (RETRIEVAL/CORPUS/GENERATION) on retrieval failures; conscious-skips table (judgy, splits, multi-turn, platforms — with defenses). Output `evals/report.md`.
6. Component evals (small): extraction accuracy vs 15 hand-labeled gold records; MC-resolution accuracy incl. garbled cases; WER spot-check on 3 clips vs hand transcription.
7. Wire `pnpm eval` into CI as non-blocking job w/ report artifact.
**Verification:** meta-tests green; judge TPR/TNR recorded; report generated with all sections; at least one before/after regression row if a fix lands.

### Phase 5: Deploy + docs (~30 min)
**Objective:** Live URL + graded documentation.
**Steps:**
1. Import repo in Vercel dashboard (Hanson); attach Neon via Storage tab; add `ANTHROPIC_API_KEY`; `vercel env pull` locally; run seed against Neon; verify prod URL answers the two spec queries.
2. README: architecture diagram, decisions table (link research docs), how-to-run/reseed/eval, eval results summary, what-I'd-improve, AI-use artifacts section (link `.claude/` docs, session notes).
3. `docs/decisions/` ADRs: transcription, no-vector-DB, eval design, judge-determinism deviation.
4. If repo goes private: grant ellencbrandenberger-blip, jonhmchan, danfriedman.
**Verification:** Live URL cold-start check; README commands run clean on fresh clone (`pnpm i && pnpm seed && pnpm dev`).

## Testing Strategy
- Unit: resolver, graders (meta-tests), market_rate SQL, env validation.
- Integration: seeded-fixture DB tool tests; one mocked agent-loop test.
- Eval harness: the primary quality instrument (Phase 4).
- Manual: spec's example queries on the deployed URL before submission.

## Rollback Plan
Git-only project; each phase is a PR — revert the PR. DB is re-seedable from committed artifacts at any commit. Vercel keeps per-deploy rollback.

## Risk Mitigation
| Risk | Mitigation |
|---|---|
| Deepgram output worse than expected on garbled MCs | Word-confidence flagging + low_confidence surfaced in agent answers; "perfect transcription" explicitly not required by spec |
| Extraction cost/time on 329 items | Concurrency-limited batch; ~$3–5 total at Opus 5 rates; cache derived artifacts so it runs once |
| Judge non-determinism (no temp control on Opus 5) | Binary structured output + explanation-first; measure repeat-stability on calibration set; document as ADR |
| Neon cold start in live demo | Hit prod URL before screen share |
| Live-extension fumble | Rehearse one add-a-tool rep end-to-end before the session |
| Time overrun vs 3–4h target | Phases 2a/2b/3 parallelized via subagents; pgvector and extra polish are cut lines |

## Estimated Complexity
Medium — ~35–50 files, 5 PRs, one new service dependency (Deepgram, offline only).
