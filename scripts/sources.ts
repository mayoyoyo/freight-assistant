/**
 * Loads the raw inquiry sources (emails + call transcripts) for the offline
 * pipeline. Shared by extract.ts and resolve.ts so both agree on exactly which
 * 329 items exist and what text each one is made of.
 *
 * SPEC INVARIANT: an email's pre-labeled fields (mc_number, load_reference,
 * equipment_mentioned, intent, rate_quoted_usd) are DECOYS. `RawEmail` carries
 * them because resolve.ts needs them for discrepancy flagging, but
 * `extractionInput()` returns ONLY subject/body/from — the extractor never sees
 * a label. That narrowing is the single enforcement point.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const EMAILS_PATH = "data/raw/carrier_emails.json";
export const AUDIO_DIR = "data/raw/call_recordings";
export const SMART_DIR = "data/derived/transcripts";
export const VERBATIM_DIR = "data/derived/transcripts-verbatim";

export type RawEmail = {
  email_id: string;
  timestamp: string;
  from_name: string | null;
  from_email: string | null;
  subject: string | null;
  body: string;
  // Pre-labeled decoys — never passed to extraction.
  mc_number: string | null;
  load_reference: string | null;
  equipment_mentioned: string | null;
  rate_quoted_usd: number | null;
  intent: string | null;
};

export type DeepgramWord = {
  word: string;
  confidence?: number;
  speaker?: number;
  punctuated_word?: string;
};

export type DeepgramResponse = {
  results?: { channels?: { alternatives?: DeepgramAlternative[] }[] };
};

type DeepgramAlternative = {
  transcript?: string;
  words?: DeepgramWord[];
};

export type RawCall = {
  id: string;
  /** smart_format track — readable, numerals rendered; UNRELIABLE for dictated digits. */
  smartTranscript: string;
  /** smart_format=false track — number-words; authoritative for spoken numbers. */
  verbatimTranscript: string;
  verbatimWords: DeepgramWord[];
  smartWords: DeepgramWord[];
};

export type RawCarrier = {
  mc_number: string | null;
  company_name: string | null;
  email: string | null;
};

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8")) as T;

const alternative = (r: DeepgramResponse): DeepgramAlternative =>
  r.results?.channels?.[0]?.alternatives?.[0] ?? {};

export function loadEmails(): RawEmail[] {
  return readJson<RawEmail[]>(EMAILS_PATH);
}

export function loadCarriers(): RawCarrier[] {
  return readJson<RawCarrier[]>("data/raw/carrier_profiles.json");
}

/** Call stems, derived from the audio so coverage is anchored to the raw source. */
export function callIds(): string[] {
  return readdirSync(AUDIO_DIR)
    .filter((f) => f.endsWith(".wav"))
    .map((f) => f.replace(/\.wav$/, ""))
    .sort();
}

export function loadCalls(): RawCall[] {
  return callIds().map((id) => {
    const smart = alternative(
      readJson<DeepgramResponse>(join(SMART_DIR, `${id}.json`)),
    );
    const verbatim = alternative(
      readJson<DeepgramResponse>(join(VERBATIM_DIR, `${id}.json`)),
    );
    return {
      id,
      smartTranscript: smart.transcript ?? "",
      verbatimTranscript: verbatim.transcript ?? "",
      verbatimWords: verbatim.words ?? [],
      smartWords: smart.words ?? [],
    };
  });
}

/** The ONLY text an extraction prompt may contain. */
export type ExtractionInput =
  | {
      id: string;
      sourceType: "email";
      fromName: string | null;
      fromEmail: string | null;
      subject: string | null;
      body: string;
    }
  | {
      id: string;
      sourceType: "call";
      smartTranscript: string;
      verbatimTranscript: string;
    };

export function emailExtractionInput(e: RawEmail): ExtractionInput {
  return {
    id: e.email_id,
    sourceType: "email",
    fromName: e.from_name,
    fromEmail: e.from_email,
    subject: e.subject,
    body: e.body,
  };
}

export function callExtractionInput(c: RawCall): ExtractionInput {
  return {
    id: c.id,
    sourceType: "call",
    smartTranscript: c.smartTranscript,
    verbatimTranscript: c.verbatimTranscript,
  };
}
