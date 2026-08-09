# Postgres FTS and freight numerics

Probes run 2026-08-06 against the live dev database (PostgreSQL 14.20, Postgres.app),
`default_text_search_config = pg_catalog.english`. The searched column is generated:

```sql
search tsvector GENERATED ALWAYS AS (
  to_tsvector('english',
    coalesce(from_name,'') || ' ' || coalesce(subject,'') || ' ' || raw_text)
) STORED
-- indexed by inquiries_search_idx, a GIN index
```

Freight text is number-dense — MC numbers, load IDs, rates, weights — so how
`to_tsvector` cuts numbers decides what the agent can and cannot retrieve.

## Probe 1 — token classes

```sql
select alias, token, lexemes
from ts_debug('english', 'MC 876543 MC#876543 load #29372421 45-6012 $290 5,200 lbs 2026-05-25 net 21 74/100');
```

| input | alias | lexeme(s) |
| --- | --- | --- |
| `876543` | `uint` | `876543` |
| `MC#876543` | `asciiword` + `blank` + `uint` | `mc`, `876543` |
| `#29372421` | `blank` + `uint` | `29372421` |
| `45-6012` | `uint` + `int` | `45`, `-6012` |
| `$290` | `blank` + `uint` | `290` |
| `5,200` | `uint` + `blank` + `uint` | `5`, `200` |
| `2026-05-25` | `uint` + `int` + `int` | `2026`, `-05`, `-25` |
| `74/100` | `file` | `74/100` |

Bare digit runs survive whole and are exact-matchable. `#`, `$` and `MC#`'s hash
are separators, so prefixes and currency symbols cost nothing.

## Probe 2 — hyphenated identifiers do not round-trip

```sql
select to_tsvector('english','our mc is 45-6012') @@ websearch_to_tsquery('english','45-6012')  as matches_hyphenated,  -- t
       to_tsvector('english','our mc is 45-6012') @@ websearch_to_tsquery('english','456012')   as matches_digits_only, -- f
       to_tsvector('english','our mc is 456012')  @@ websearch_to_tsquery('english','45-6012')  as reverse_direction;   -- f
```

`45-6012` becomes two lexemes (`45`, `-6012`), so it matches only a query with
the identical hyphenation. Neither direction of the digits-only ↔ hyphenated
pair matches. The same split hits `5,200` vs `5200` and `1,250` vs `1250`.

## Probe 3 — the failure that actually occurs in this corpus

Calls store the Deepgram **smart_format** track as `raw_text`, and that
formatter mangles dictated digit strings (a Phase 2a finding). Those mangled
forms tokenize as one opaque word:

```sql
select to_tsvector('english', 'MC number is 45Dash6Nil12 and 300And45600And78');
-- '300and45600and78':6 '45dash6nil12':4 'mc':1 'number':2
```

Nothing a user could type retrieves those rows by MC. Quantified over the whole
table:

```sql
select count(*) from inquiries
where extracted_mc_number is not null
  and not (search @@ websearch_to_tsquery('english', extracted_mc_number));
-- 38
```

**38 of 55 calls cannot be found by full-text search on their own MC number.
Zero of 274 emails have the problem.** Two mechanisms:

- 32 rows: `And` / `Dash` / `Nil` concatenation (`500And38700And72`, `14Dash8Nil35Dash5`).
- 6 rows: the smart formatter splits a dictated MC on punctuation
  (`It's 776. 491.` → lexemes `776`, `491`; a search for `776491` misses).

Worked example — MC `456012` (Summit Ridge Carriers):

```sql
select (select count(*) from inquiries where search @@ websearch_to_tsquery('english','456012')) as fts,      -- 5
       (select count(*) from inquiries where extracted_mc_number = '456012')                     as column_;  -- 6
-- the missing row is call_036_compliance_check, whose raw_text reads "45Dash6Nil12"
```

## Probe 4 — the index is genuinely used for numeric terms

```sql
explain (costs off)
select id from inquiries where search @@ websearch_to_tsquery('english','29372421');
--  Bitmap Heap Scan on inquiries
--    ->  Bitmap Index Scan on inquiries_search_idx
```

Numbers are ordinary lexemes; the GIN index serves them like any word. No
trigram index or `LIKE '%…%'` fallback is needed for the digit-string case.

## What this means for the design

1. **Typed columns, not FTS, are the retrieval path for identifiers.**
   `extracted_mc_number`, `extracted_load_reference` and `resolved_carrier_mc`
   are populated by the extractor reading the *verbatim* track, so they carry
   the correct digits even when `raw_text` carries mangled ones. Routing
   MC/load lookups through those columns closes a 38-row recall hole that FTS
   cannot see. This is the concrete answer to "why not just full-text search
   the transcripts".
2. **FTS keeps its job**, which is the free-text half: lanes, equipment words,
   contact names, phrases like "liftgate" or "insurance cert".
3. **Normalize identifiers at both ends.** Ingest strips non-digits
   (`normalizeMc`); any user-facing search on an identifier should do the same
   before it reaches a `tsquery`, or `45-6012` and `456012` become different
   questions.
4. **Not adopted:** `pg_trgm`. It would paper over the hyphen split, but the
   real corpus hazard is ASR mangling, which trigram similarity does not fix
   either (`45dash6nil12` is not trigram-similar to `456012` in any useful
   sense). Fixing it upstream — extract from the verbatim track into a typed
   column — is both cheaper and correct.
