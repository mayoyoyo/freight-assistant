# Research & Scoping: Goodlane Freight Carrier Agent
Date: 2026-08-04 · Depth: thorough (3 parallel research agents + inline dataset profiling)

## Executive Summary
Build a Next.js web app with a single-agent tool-calling loop (Vercel AI SDK) over Postgres, fed by an offline ingestion pipeline (Deepgram transcription + LLM extraction) whose outputs are committed to the repo. Eval = ~20-case hand-labeled harness with deterministic graders + LLM-judge for email drafts, run in CI. The interview currency is *defensible decisions*, and every major choice below has an explicit rejected alternative.

## The Exercise (verified from PDF)
- Deployed web app; AI agent processing inbound carrier inquiries across **email + call recordings**.
- Must: multi-modal ingestion (parse emails, transcribe 55 WAVs, extract structured fields), agent with retrieval + ≥1 tool call, minimal query UI, **small eval set (1 core workflow) with scores + improvement narrative**, deployed, documented, quality checks.
- Explicitly NOT wanted: polished UI, scalable infra, perfect transcription.
- 3–4h focused work, up to 1 week. Deliverables: GitHub repo (grant: ellencbrandenberger-blip, jonhmchan, danfriedman), deployed link, VCS history, decision docs, AI-use artifacts. **Due EOD before the interview.**
- Live session: 30min walkthrough + 30min surprise live extension (architecture must make "add a tool/endpoint" trivial).

## Dataset Profile (verified inline)
| File | Records | Key findings |
|---|---|---|
| carrier_emails.json | 274 | 43 senders; intents: confirm 79, terse 69, inquiry 65, counter 44, info 9, factoring 6, problem 2. **`rate_quoted_usd` is null in ALL 274** — 71 bodies contain $ amounts. First record: subject "Box Truck" vs `equipment_mentioned` "Refrigerated". 8 missing MC numbers. → **Pre-labeled fields are decoys; extract from body text.** |
| carrier_profiles.json | 48 | 2 null MC, 3 null + 2 CONDITIONAL authority_status, 1 insurance expired before dataset date (2026-05-25). → compliance-gate angle. |
| loads.csv | 50 | 8 open / 16 covered / 22 delivered / 4 cancelled. Blank weights, inconsistent pickup windows. Equipment: Box Truck 28, Flatbed 9, Sprinter 9, Reefer 4. |
| rate_history.csv | 720 | Clean weekly per-mile stats by state-pair lane × equipment, Dec 2025–May 2026. |
| call_recordings/ | 55 | Mono 16kHz Int16, 60–90s. Types: rate_negotiation, availability_check, compliance_check, load_details, voicemail. Garbled spoken MC numbers = reconciliation challenge. |
- Every email `mc_number` field that is present matches a profile; every `load_reference` field matches loads.csv — but README warns of wrong-load references *in bodies*, so cross-validate extracted vs stated.

## Decisions (with rejected alternatives)

### D1. Transcription: Deepgram nova-3 (~$0.77 total)
Only option with all four in one sync POST: diarization, word timestamps, **per-word confidence**, telephony pedigree (~5.3% WER). `numerals`/`smart_format` + keyterm prompting ("MC", carrier names) for digit accuracy. Word-level confidence → programmatically flag garbled MC spans for human review (differentiator).
- Runner-up: AssemblyAI Universal-3.5 (best published alphanumeric accuracy, cheaper, but async poll flow + self-published benchmarks).
- Rejected: OpenAI (diarize model and word-timestamps/confidence are mutually exclusive across its models); Groq (no diarization); local Whisper (pyannote gating, digit weakness, silence hallucination — defensible only as "no data leaves machine" fallback).
- Caveat to state aloud: audio is 16kHz wideband → general nova-3, not the `phonecall` narrowband variant.

### D2. Orchestration: Vercel AI SDK tool loop (single agent)
`streamText`/agent loop, Zod-typed tools, step cap. Tool registry = plain object → live extension is "add ~15-line tool + Zod schema + SQL function".
- Runner-up: hand-rolled Anthropic SDK loop (~60 lines) — the "why a framework at all" answer.
- Rejected: LangGraph (graph/checkpointer machinery for one loop = over-engineering); Claude Agent SDK (it's the Claude Code filesystem-agent harness — wrong shape for domain tools; knowing the distinction is free interview credit); Pydantic AI (great, but then hand-build streaming chat UI).
- Model: claude-opus-5 per research agent — **verify model ID/pricing against claude-api skill at implementation**.

### D3. Data & retrieval: Postgres (Neon) + FTS + narrow parameterized tools. No vector DB.
~1,150 records is 3 orders of magnitude below vector-DB territory — say it with numbers. Freight queries are entity-scoped (load IDs, MC numbers, lanes) where lexical beats embeddings.
- Tools: `get_load(id)`, `search_inquiries(query, filters)` (FTS over emails+transcripts), `carrier_history(mc)`, `market_rate(origin, dest, equipment, window)` (SQL aggregate, not LLM guess).
- 2026 framing: **agentic retrieval** (agent issues search tool calls, refines) has displaced single-shot top-k RAG.
- Optional stretch: pgvector hybrid RRF for paraphrase queries ("who pushed back on detention?") — cents to add, ship FTS first.

### D4. Ingestion: committed offline scripts, artifacts in repo
`scripts/ingest` → transcription JSON + normalized NDJSON committed → `db:seed`. App has zero runtime STT dependency; reviewers re-seed in seconds. Extraction via LLM structured output over bodies/transcripts with provenance (extracted vs stated-field, discrepancy flags). Entity resolution: MC exact → email/name fuzzy → flagged-ambiguous.
- Rejected: ingestion endpoint (invites auth/idempotency/queue questions for zero benefit).

### D5. Eval: hand-rolled harness, JSONL cases, CI-run
> **SUPERSEDED 2026-08-06** by `goodlane-eval-design-2026-08-06.md` (v2, incorporating the ai-system-design-guide distillation: error-analysis-first ordering, code/judge split, TPR/TNR + kappa instead of raw agreement, calibration set, Wilson CI). Kept below for history.
Anthropic Jan 2026 guidance: outcome-over-trajectory (don't grade exact tool sequences — brittle); 20–50 tasks; deterministic graders where possible; binary over Likert for judges.
- ~20–24 cases, 4 buckets: factual lookup (exact-match), set retrieval (P/R/F1 vs gold carrier sets), email drafts (LLM-judge, 4 independent binary checks: rate matches source, no invented commitments, load ref present, tone), abstention/not-in-corpus (must say unknown).
- Cross-cutting programmatic checks: required-tool-called + arg correctness, reported separately. Groundedness via required source IDs → deterministic trace check.
- Differentiators: hand-label all cases, report judge-vs-human agreement on judged bucket; run k=3, report pass@1 + pass^3 (flakiness signal). Failure taxonomy with counts + named fixes + stated coverage limits.
- Rejected: Braintrust/LangSmith (account dependency reviewers can't run); promptfoo acceptable alternative (MIT, OpenAI-acquired 2026-03).
- Note: eval agent assumed pytest/uv; stack is TS → implement harness in TS (single-language repo), same design.

### D6. App & deploy: Next.js 15 App Router on Vercel + Neon
git push → preview URLs reviewers can click; streaming built-in; set `maxDuration` on chat route. 
- Runner-up: FastAPI + Vite on Fly.io (Hanson has Bun+Fly muscle memory — see Open Questions).
- Quality bar: TS strict + noUncheckedIndexedAccess, Biome, Vitest (incl. one mocked agent-loop test via MockLanguageModelV2), Zod for tool params + env, GH Actions typecheck→lint→test→eval. Structured per-tool-call logs (name, args, latency, rows).

## Build Phases (target 3–4h with AI assistance)
1. **Scaffold + schema + seed** (repo, CI, Postgres schema, load CSV/JSON seeds).
2. **Ingestion**: transcribe (batch script, cache raw JSON) → LLM extraction (emails + transcripts, shared schema) → entity resolution → committed artifacts.
3. **Agent + tools + minimal chat UI** (4 tools, streaming, tool-call visibility in UI is cheap and demo-strong).
4. **Eval harness + run + report** (JSONL cases hand-labeled from dataset ground truth).
5. **Deploy + docs** (README with decision log/ADRs, AI-use artifacts, PR history).
- Process artifacts count as deliverables: work in PRs, document decisions in-repo, keep AI-session artifacts.

## Risks & Considerations
- **Pre-labeled field trap**: trusting `intent`/`equipment_mentioned`/`rate_quoted_usd` fields = failing the hidden test. Extract from raw text; cross-validate; keep provenance.
- **"This week"/temporal grounding**: dataset frozen at ~2026-05-25; agent needs an injected "current date" convention or queries like "this week" silently break.
- **Compliance gating**: answers recommending carriers must surface authority_status/insurance issues (README: "check before booking").
- **Live extension prep**: rehearse adding a tool end-to-end; keep one obvious extension seam (e.g., new tool, new intent type, compliance filter).
- **Judge/model costs**: trivial at this scale (<$5 total including transcription).
- Eval "1 core workflow" scope: pick "broker question → tool lookups → grounded answer" as the workflow; drafting graded on a subset. Don't over-expand.

## Open Questions (for Hanson)
1. **Stack familiarity vs research pick**: Next.js/Vercel is the research-optimal pick, but your demonstrated stack is Bun + Fly.io. Live-extension fluency may matter more than platform elegance. Both defensible; pick the one you can extend fastest under observation.
2. Repo: build in `freight-assistant` (this repo, currently empty)? Public vs private (private → grant 3 usernames)?
3. Interview date → real deadline for submission (EOD day before).

## Sources
- Anthropic "Demystifying evals for AI agents" (Jan 2026); Hamel Husain evals FAQ; Anthropic tool-evaluation cookbook.
- Deepgram/AssemblyAI/OpenAI/Groq/ElevenLabs pricing + docs (verified by agent against primary sources, Aug 2026).
- AI SDK 7 release notes; Speakeasy framework comparison; agentic-retrieval 2026 posts.

## Confidence
High on dataset facts (verified inline) and eval conventions (primary sources). Medium-high on stack pick (sound, but the Bun+Fly familiarity tradeoff is a judgment call only Hanson can make). Model ID (claude-opus-5) unverified by me — check claude-api skill before implementation.
