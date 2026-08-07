# ADR 001 — Transcribe call audio with Deepgram, on two tracks

Status: accepted (Phase 2a) · Date: 2026-08-07

## Context

55 of 329 inquiries are `.wav` recordings, and what the brokerage needs from
them is almost entirely numbers — MC numbers, load IDs, rates — dictated aloud
in chunks, often with a mid-sentence self-correction ("…878, wait, …678").

The obvious single pass with `smart_format=true`, which is what makes a
transcript readable, is a liability on exactly that content. Measured on our
own audio:

| spoken | `smart_format=true` renders |
| --- | --- |
| "three hundred and forty five thousand eight hundred and seventy eight" | `300And45800And78` (call_006) |
| "four five dash six zero one two" | `45Dash6Nil12` (call_036) |

The formatter is not mishearing — the acoustics are fine. It post-processes
number words into a shape that is neither the digits nor the words, and the
damage is unrecoverable from that string. One mangled digit is a booked load on
the wrong carrier.

## Decision

Transcribe every recording **twice**, in one invocation, and keep both tracks:

- **smart** (`nova-3, smart_format=true, numerals=true`) — readable prose,
  stored as `inquiries.raw_text`; this is what FTS and the agent's snippets read.
- **verbatim** (`smart_format=false, numerals=false`) — numbers stay as spoken
  words, which decode unambiguously, with trustworthy per-word confidence on
  digit spans. **Authoritative for every number.**

`nova-3` general, not `phonecall` (16 kHz wideband audio), with diarization and
the nova-3-only `keyterm` boost for "MC". The full Deepgram response is
persisted per track — per-word confidence, speaker labels, timings — so
downstream work can quote spans without re-billing audio. Extraction reads both
and is told the verbatim track wins on any number.

## Consequences

- **The number-recall hole is closed at the source**, which is what makes the
  typed `extracted_*` columns in ADR 002 trustworthy.
- **Two API calls and two artifacts per clip.** Accepted: transcription is
  offline and one-time; reruns skip any clip whose output exists, per track.
- **Cross-track disagreement is a free quality signal.** Across all 55 calls
  exactly **1** divergence is non-numeric ("Chesapeake Haulers"); every other is
  a number rendering. Both tracks independently preserve call_006's
  self-correction, so the extractor's "last value stated wins" rule acts on a
  feature both decodes heard, not an artifact of one.
- **This is not WER and is not reported as WER.** Agreement between two decodes
  of one waveform is weak evidence (a shared acoustic error appears in both);
  only disagreement is strong. Real WER needs a human listening against an
  independent reference — pending, clip list ready in `wer-check.md`, never
  estimated.

Evidence: `evals/components/wer-check.md`, `evals/components/fts-notes.md`
§Probe 3, `scripts/transcribe.ts`.
