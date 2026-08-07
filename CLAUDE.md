@AGENTS.md

# freight-assistant

AI intake agent for a freight brokerage: answers questions over carrier emails, call
transcripts, loads, and market rates. Take-home exercise — see `docs/architecture.svg`
for the system overview and `.claude/specs/goodlane-freight-agent.md` for invariants
that must hold in every change.

## Commands

- `pnpm dev` / `pnpm build` — Next.js app
- `pnpm typecheck && pnpm lint && pnpm test` — quality gates (CI runs the same)
- `pnpm seed` — load committed data (`data/raw/` + `data/derived/`) into Postgres

## Layout

- `scripts/` — offline ingestion (transcribe → extract → resolve); outputs committed to `data/derived/`, never run at request time
- `src/db/` — Drizzle schema
- `src/lib/agent/` — system prompt + tools
- `evals/` — eval harness (`pnpm eval`), cases, graders, judge prompts

## Hard rules

- Pre-labeled dataset fields (`intent`, `equipment_mentioned`, `rate_quoted_usd`) are
  decoys — never treat as extracted truth; store only as `stated_*` columns.
- "Today" is `REFERENCE_DATE` (2026-05-25) from `src/lib/config.ts`; no `new Date()`
  in agent code.
- All DB access via Drizzle parameterized queries; secrets only via env
  (Zod-validated in `src/lib/env.ts`).
