# Transcription check — cross-track consistency (a conscious substitute for WER)

> **This section is a conscious substitute, labelled as one.** The eval design
> calls for "WER spot-check on a handful of clips". WER requires an *independent
> reference transcript*, and the only way to produce one for this dataset is for
> a human to listen to the audio. I cannot listen to audio, so I did not compute
> a WER number — inventing one would have been the single most corrosive thing I
> could put in this report, because every downstream figure would inherit a
> fabricated denominator.
>
> What I did instead is stated below, together with exactly what it does and
> does not establish. The defence for accepting the substitute: **extraction
> accuracy against hand-labelled gold (`extraction-eval.ts`) is the metric that
> actually matters here.** WER measures the transcriber; the system's contract
> is that the right MC, rate, load ID and equipment reach the database. A 12%
> WER concentrated on filler words is harmless; a 2% WER that eats one digit of
> an MC number is a booked load on the wrong carrier. Task 1 measures the thing
> that has consequences, on the records where the digits are hardest.

## The substitute: two independent decodes of the same audio

Every call was transcribed twice by Deepgram nova-3 — once with
`smart_format=true` (readable track, stored as `raw_text`) and once with
`smart_format=false` (verbatim track, authoritative for numbers). These are two
decodes of the same waveform under different post-processing. Where they
disagree on a *word*, at least one is wrong. Where they agree, they are not
independently confirmed — a shared acoustic error appears in both — so
agreement is a weak signal and disagreement is a strong one. That asymmetry is
the entire limitation.

Method: lowercase, strip punctuation, align the two word sequences with a
sequence matcher, and classify each divergent span as *number-rendering*
(digits/mangled-digit token on one side, number words on the other) or
*substantive*.

## The three clips

| clip | audio | length | verbatim words | aligned identical | divergent spans | substantive divergences |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| call_006_rate_negotiation | `data/raw/call_recordings/call_006_rate_negotiation.wav` | 76.8s | 235 | 188 | 9 | **0** |
| call_046_load_details | `data/raw/call_recordings/call_046_load_details.wav` | 46.0s | 109 | 99 | 1 | **0** |
| call_044_load_details (ordinary control) | `data/raw/call_recordings/call_044_load_details.wav` | 42.7s | 109 | 101 | 1 | **0** |

Every divergence on all three clips is a number rendering. In full:

- **call_006** — `2`/`two`, `1`/`one`, `220`/`two hundred twenty dollars` (×2),
  `250`/`two hundred and fifty dollars` (×3),
  `300and45800and78`/`three hundred and forty five thousand eight hundred and seventy eight`,
  `300and45600and78`/`three hundred and forty five thousand six hundred and seventy eight`.
- **call_046** — `600and65 400and32`/`six hundred and sixty five four hundred and thirty two`.
- **call_044** — `887 642`/`eight hundred eighty seven six hundred forty two`.

Note what call_006's last two rows show: both tracks independently preserve the
**self-correction** (…878 → …678). The extractor's "last value stated wins" rule
is therefore acting on a feature both decodes heard, not on an artefact of one.

## Extending it to all 55 calls (cheap, so I ran it)

| | count |
| --- | ---: |
| calls where the two decodes diverge on anything | 55 / 55 |
| calls with a divergence that is **not** a number/unit rendering | **1 / 55** |

The single one is `call_011_rate_negotiation`: smart says *"chesapeake
**paulers** llc"*, verbatim says *"chesapeake **ballers** llc"*. The carrier is
**Chesapeake Haulers LLC** — so *both decodes are wrong*, differently.
(The remaining flagged spans — `7am`/`seven am`, `38f`/`thirty eight f`,
`3438f`/`thirty four thirty eight f` — are number+unit renderings my classifier
did not fold into the numeric bucket.)

That one row is the limitation made concrete and is worth more than the
aggregate: cross-track consistency found a proper-noun error only because the
two decoders happened to fail differently. Company names spoken once, with no
second decode to disagree, are exactly the blind spot — and company name is the
fallback signal for `name_fuzzy` resolution, so an ASR error there has a real
downstream path. In this corpus it did not fire (`call_011` resolves by MC), and
`call_027` shows the same carrier mangled again as *"chesapeake collars"*.

## What this establishes, and what it does not

**Establishes:** the readable and verbatim tracks carry the same lexical
content; essentially all disagreement between them is number formatting, which
is the documented `smart_format` defect and which the pipeline already routes
around by extracting numbers from the verbatim track. No evidence of
transcript-level content drift between the two inputs the extractor sees.

**Does not establish:** any absolute error rate. Both tracks could be wrong in
the same way — most plausibly on proper nouns and on rare digits — and this
method is blind to it by construction. `call_011` is a lower bound on that
class, not a measurement of it.

---

## TODO for Hanson — a real 5-minute listen

Four clips, **4.0 minutes of audio total**. Listening to them converts the
substitute above into an actual (small-n) WER anchor and closes the blind spot.
For each, type what you hear and diff it against
`data/derived/transcripts-verbatim/<id>.json`.

| # | clip | length | jump to | listen for |
| --- | --- | ---: | --- | --- |
| 1 | `data/raw/call_recordings/call_006_rate_negotiation.wav` | 76.8s | **~0:40** | The MC dictation and the self-correction. Gold says **345878 → "wait, number" → 345678**. Confirm the caller really does correct herself and that the *second* value is 345678, not the first. The whole "last value wins" extraction rule rests on this clip. |
| 2 | `data/raw/call_recordings/call_046_load_details.wav` | 46.0s | **~0:12** | The MC. Gold says **665432** — a number matching no carrier on file. Confirm she really says "six hundred sixty-five, four hundred thirty-two" and not 663210. If the audio says 663210, the "planted wrong MC" story collapses and `name_fuzzy` was covering an ASR bug instead. Also confirm the company is **"Crossroads Transport"**. |
| 3 | `data/raw/call_recordings/call_044_load_details.wav` | 42.7s | **~0:12** | Ordinary control. Gold says MC **887642** ("eight hundred eighty-seven, six hundred forty-two") and company **Sunrise Carriers**. Nothing should be surprising — that is the point of a control. |
| 4 | `data/raw/call_recordings/call_011_rate_negotiation.wav` | 73.0s | **~0:05 and ~1:04** | The one known ASR error. Company is spoken twice; ASR gives *"chesapeake haulers"* at 0:05 and *"chesapeake paulers"* / *"ballers"* at 1:04. Confirm the real name is **Chesapeake Haulers LLC** both times, and note how clear the audio is — that calibrates how much to trust company names elsewhere in the corpus. |

If clips 1–3 match gold, report extraction accuracy as **verified against audio
on 3 records**. If clip 2 disagrees, `call_046`'s gold row in
`extraction-gold.jsonl` and `resolution-gold.jsonl` both need revising, and the
"planted wrong MC" claim comes out of the Phase 4 report.
