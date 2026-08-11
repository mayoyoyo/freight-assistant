# ADR 002 — Postgres FTS + typed extraction, no vector database

Status: accepted (Phase 1/2b) · Date: 2026-08-07

## Context

The spec asks for an ingestion format the agent can reason over, with the
store choice justified. The corpus — 329 inquiries (274 emails, 55 calls)
over 50 loads and 48 carriers — is small, and the questions are
**identifier-keyed**, not semantic ("who is MC 345678"). Embeddings solve the
opposite problem and are actively bad at digit strings, the one thing that
must never be approximately right.

Plain FTS is measurably insufficient too: call `raw_text` is the smart-format
track (ADR 001), whose mangled digits tokenize as one opaque lexeme —
`to_tsvector('45Dash6Nil12')` → `45dash6nil12` — that nothing a broker types
will match.

> **38 of 55 calls cannot be found by FTS on their own MC number; 0 of 274
> emails have the problem.** 32 rows from `And`/`Dash`/`Nil` concatenation, 6
> from punctuation splits (`It's 776. 491.` → lexemes `776`, `491`).

## Decision

**Postgres, two retrieval paths, no embeddings.**

1. **Typed `extracted_*` columns for identifiers** — an offline pass reads
   both tracks (verbatim wins on numbers) and writes `extracted_mc_number`,
   `_load_reference`, `_rate_usd`, `_equipment`, `resolved_carrier_mc`.
   Agent tools filter on them.
2. **FTS for the free-text half** — generated `tsvector` over
   `from_name || subject || raw_text`, GIN-indexed: lanes, equipment words,
   names, phrases like "liftgate".

Not adopted: `pg_trgm` — fixes the hyphen split but `45dash6nil12` is not
usefully trigram-similar to `456012`.

## Consequences

- **Closes the 38-row hole exactly**: MC resolution 55/55 on calls, 75/75
  overall vs hand-derived gold, incl. a 19-record low-confidence hard set.
  FTS cannot see those rows; no query tuning makes it.
- **One store, one query language, transactional joins**
  (`extracted_load_reference → loads.load_id`); a vector store would need a
  second system plus a hand-rolled join for the spec's first example query.
- **The failure mode moves and is documented**: an inquiry with neither load
  reference nor equipment tag can't match a structured filter — failure mode 2
  (lane-join blind); `query` (FTS) is the stated fallback in the tool
  description.
- **Normalize identifiers at both ends**, or `45-6012` and `456012` become
  different questions.
- **Revisit on a change of shape, not of size**: semantic retrieval pays for
  conceptual questions over a corpus too large to filter structurally —
  neither holds here.

Evidence: `evals/components/fts-notes.md` (four probes with SQL),
`evals/report.md` §Phase 4C.
