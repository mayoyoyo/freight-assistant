# Spec: Goodlane Freight Carrier Agent
Created: 2026-08-06
Status: active
Derived from: .claude/plans/goodlane-freight-agent-2026-08-06.md

## Summary
Persistent invariants for the freight-assistant build — enforced across all phases and the live-extension session.

## Invariants
- [ ] Pre-labeled dataset fields (`intent`, `equipment_mentioned`, `rate_quoted_usd`) are never treated as extracted truth — stored only as `stated_*` for discrepancy flagging.
- [ ] Every extracted record has provenance: `source_type`, `source_id`, `discrepancy_flags[]`.
- [ ] Agent numeric claims cite source record IDs present in that turn's tool results.
- [ ] Compliance state (non-ACTIVE authority, expired insurance vs REFERENCE_DATE 2026-05-25) is surfaced in any carrier-recommending answer.
- [ ] Deployed app never calls Deepgram; transcripts are committed artifacts.
- [ ] Judge prompt is a versioned file with recorded calibration TPR/TNR; `evals/cases.jsonl` is never used for judge tuning.
- [ ] MC digit spans with word-confidence < 0.85 are flagged `low_confidence`.
- [ ] Secrets only via env; Zod-validated at boot.

## Constraints
- [ ] No embeddings/vector DB in core path (FTS + parameterized SQL tools only).
- [ ] `market_rate` is a SQL aggregate — no LLM inside tools.
- [ ] All DB access via Drizzle parameterized queries.
- [ ] Eval harness deps: `DATABASE_URL` + `ANTHROPIC_API_KEY` only — no eval SaaS.
- [ ] UI stays minimal (chat + tool-call visibility).

## Verification Commands
```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm eval
grep -rn "rate_quoted_usd\|equipment_mentioned" src/ | grep -v stated_
grep -rn "new Date()" src/lib/agent/
```

## Changelog
- 2026-08-06: Created from plan
