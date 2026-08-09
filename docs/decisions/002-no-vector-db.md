# ADR 002 — Postgres FTS + typed extraction, no vector database

Status: accepted (Phase 1/2b) · Date: 2026-08-07

## Context

The spec asks for an ingestion format the agent can reason over, with the
data-store choice justified. The reflex for "make documents searchable by an
LLM" is embeddings plus a vector store, so the burden is on this ADR to say why
that is the wrong tool here.

The corpus is 329 inquiries (274 emails, 55 calls) over 50 loads and 48
carriers. It is small, and decisively the questions are **identifier-keyed**,
not semantic: "who is MC 345678", "what's on load 29372450", "who's available
for PA-NJ box truck". Nearest-neighbour search solves the opposite problem —
finding similar prose when you cannot name what you want — and embeddings are
actively bad at digit strings, the one thing that must never be approximately
right.

Plain full-text search is not sufficient either, and we measured why rather than
assuming it. Postgres tokenizes bare digit runs cleanly and the GIN index serves
them. The problem is upstream: call `raw_text` is the smart-format track
(ADR 001), whose mangled digits tokenize as one opaque lexeme —
`to_tsvector('45Dash6Nil12')` → `45dash6nil12`, which nothing a broker types
will match.

> **38 of 55 calls cannot be found by FTS on their own MC number. 0 of 274
> emails have the problem.** 32 rows from `And`/`Dash`/`Nil` concatenation, 6
> from the formatter splitting a dictated MC on punctuation (`It's 776. 491.`
> → lexemes `776`, `491`; a search for `776491` misses).

## Decision

**Postgres, two retrieval paths, no embeddings.**

1. **Typed `extracted_*` columns for identifiers.** An offline pass reads *both*
   transcript tracks and writes `extracted_mc_number`, `_load_reference`,
   `_rate_usd`, `_equipment`, plus `resolved_carrier_mc`. Because the verbatim
   track is authoritative for numbers, these columns carry correct digits even
   where `raw_text` carries mangled ones. Agent tools filter on them.
2. **FTS for the free-text half** — a generated `tsvector` over
   `from_name || subject || raw_text`, GIN-indexed, for lanes, equipment words,
   contact names, phrases like "liftgate".

Not adopted: `pg_trgm`. It would paper over the hyphen split (`45-6012` vs
`456012`) but does nothing for the real hazard — `45dash6nil12` is not
trigram-similar to `456012` in any useful sense.

## Consequences

- **Typed extraction closes the 38-row hole exactly.** MC resolution scores
  55/55 on calls and 75/75 overall against hand-derived gold, including a
  19-record hard set of every low-confidence call. That is the concrete answer
  to "why not just full-text search the transcripts": FTS cannot see the rows,
  and no query tuning makes it.
- **One store, one query language, transactional joins.** Lane filters resolve
  through a real join (`extracted_load_reference → loads.load_id`); a vector
  store would need a second system plus a hand-rolled join to answer the spec's
  own first example query.
- **The failure mode moves and is documented.** An inquiry with neither a load
  reference nor an equipment tag cannot match a structured filter even when its
  body names the lane in prose; `query` (FTS) is the stated fallback. This is
  exactly failure mode 2 (lane-join blind), now called out in the tool
  description.
- **Normalize identifiers at both ends**, or `45-6012` and `456012` become
  different questions.
- **Revisit on a change of shape, not of size**: semantic retrieval starts
  paying when questions become genuinely conceptual over a corpus too large to
  filter structurally. Neither holds at 329 identifier-keyed records.

Evidence: `evals/components/fts-notes.md` (four probes with SQL),
`evals/report.md` §Phase 4C.
