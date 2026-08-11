# ADR 001 — Transcribe call audio with Deepgram, on two tracks

Status: accepted (Phase 2a) · Date: 2026-08-07

## Context

55 of 329 inquiries are `.wav` recordings whose payload is mostly dictated
numbers (MC numbers, load IDs, rates), often self-corrected mid-sentence
("…878, wait, …678"). `smart_format=true` — required for readable prose —
mangles exactly that content, measured on our audio: "three hundred and forty
five thousand eight hundred and seventy eight" → `300And45800And78`
(call_006); "four five dash six zero one two" → `45Dash6Nil12` (call_036).
The damage is unrecoverable from the string, and one mangled digit is a
booked load on the wrong carrier.

## Decision

Transcribe every recording twice in one invocation, keep both tracks:

- **smart** (`nova-3, smart_format=true, numerals=true`) — readable prose;
  stored as `inquiries.raw_text`, read by FTS and the agent's snippets.
- **verbatim** (`smart_format=false, numerals=false`) — numbers stay as
  spoken words (decode unambiguously, trustworthy per-word confidence).
  **Authoritative for every number.**

`nova-3` general, not `phonecall` (16 kHz wideband audio); diarization;
`keyterm` boost for "MC". Full responses persisted per track; reruns skip
existing outputs.

## Consequences

- Closes the number-recall hole at the source — what makes ADR 002's typed
  `extracted_*` columns trustworthy.
- Two API calls/artifacts per clip — accepted; offline and one-time.
- Cross-track disagreement is a free quality signal: exactly **1** non-numeric
  divergence across 55 calls ("Chesapeake Haulers"). Both tracks preserve
  call_006's self-correction, so "last value stated wins" acts on a real
  feature, not a decoder artifact.
- **Not WER, never reported as WER**: two decodes of one waveform agreeing is
  weak evidence. Real WER needs a human against an independent reference —
  pending, clip list in `wer-check.md`, never estimated.

Evidence: `evals/components/wer-check.md`, `evals/components/fts-notes.md`
§Probe 3, `scripts/transcribe.ts`.
