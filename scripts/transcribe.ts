/**
 * Phase 2a: transcribe the call recordings with Deepgram.
 *   data/raw/call_recordings/*.wav → data/derived/transcripts/<stem>.json
 *
 * The FULL Deepgram response is persisted (per-word confidence, speaker labels,
 * timings) so downstream extraction can quote spans and flag low-confidence
 * fields without re-billing the audio. Model is nova-3 (general, not the
 * phonecall variant — this audio is 16 kHz wideband) with diarization,
 * smart_format, numerals, and the nova-3-only keyterm boost for "MC".
 *
 * Reruns are cheap: any file whose output JSON already exists is skipped.
 *
 * Usage: pnpm exec tsx scripts/transcribe.ts   (needs DEEPGRAM_API_KEY)
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

try {
  process.loadEnvFile(".env");
} catch {
  // no .env file — rely on ambient env (CI)
}

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
if (!DEEPGRAM_API_KEY) {
  console.error(
    "DEEPGRAM_API_KEY is required (set it in .env or the environment)",
  );
  process.exit(1);
}

const AUDIO_DIR = "data/raw/call_recordings";
const OUT_DIR = "data/derived/transcripts";
const CONCURRENCY = 5;
const RETRIES = 1;

const ENDPOINT = `https://api.deepgram.com/v1/listen?${new URLSearchParams({
  model: "nova-3",
  diarize: "true",
  smart_format: "true",
  numerals: "true",
  keyterm: "MC",
})}`;

type DeepgramWord = {
  word: string;
  start: number;
  end: number;
  confidence: number;
  punctuated_word?: string;
  speaker?: number;
};
type DeepgramAlternative = {
  transcript?: string;
  confidence?: number;
  words?: DeepgramWord[];
};
type DeepgramResponse = {
  metadata?: { duration?: number };
  results?: { channels?: { alternatives?: DeepgramAlternative[] }[] };
};

const bestAlternative = (r: DeepgramResponse): DeepgramAlternative =>
  r.results?.channels?.[0]?.alternatives?.[0] ?? {};

async function transcribe(file: string): Promise<DeepgramResponse> {
  const audio = readFileSync(join(AUDIO_DIR, file));
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Token ${DEEPGRAM_API_KEY}`,
          "Content-Type": "audio/wav",
        },
        body: new Uint8Array(audio),
      });
      if (!res.ok) {
        throw new Error(
          `HTTP ${res.status} ${(await res.text()).slice(0, 200)}`,
        );
      }
      return (await res.json()) as DeepgramResponse;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const files = readdirSync(AUDIO_DIR)
    .filter((f) => f.endsWith(".wav"))
    .sort();
  const pending = files.filter(
    (f) => !existsSync(join(OUT_DIR, `${f.replace(/\.wav$/, "")}.json`)),
  );
  const skipped = files.length - pending.length;
  const failures: { file: string; error: string }[] = [];
  let processed = 0;

  const queue = [...pending];
  const worker = async () => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const stem = file.replace(/\.wav$/, "");
      try {
        const response = await transcribe(file);
        writeFileSync(
          join(OUT_DIR, `${stem}.json`),
          `${JSON.stringify(response, null, 2)}\n`,
        );
        processed++;
        const { transcript, confidence } = bestAlternative(response);
        console.log(
          `ok   ${stem} (${response.metadata?.duration?.toFixed(1) ?? "?"}s, confidence ${confidence?.toFixed(3) ?? "?"}, ${transcript?.length ?? 0} chars)`,
        );
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        failures.push({ file, error });
        console.error(`fail ${stem}: ${error}`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker),
  );

  // Summary over everything on disk, not just this run's work.
  const onDisk = files
    .map((f) => join(OUT_DIR, `${f.replace(/\.wav$/, "")}.json`))
    .filter((p) => existsSync(p))
    .map((p) => JSON.parse(readFileSync(p, "utf8")) as DeepgramResponse);
  const totalSeconds = onDisk.reduce(
    (sum, r) => sum + (r.metadata?.duration ?? 0),
    0,
  );

  console.log(
    `\n${files.length} recordings: ${processed} transcribed, ${skipped} skipped (cached), ${failures.length} failed`,
  );
  for (const { file, error } of failures) {
    console.log(`  failed: ${file} — ${error}`);
  }
  console.log(
    `total audio: ${(totalSeconds / 60).toFixed(1)} min (${totalSeconds.toFixed(1)}s across ${onDisk.length} transcripts)`,
  );

  // Spot-check one voicemail and one rate negotiation.
  for (const kind of ["voicemail", "rate_negotiation"]) {
    const stem = files.find((f) => f.includes(kind))?.replace(/\.wav$/, "");
    const path = stem ? join(OUT_DIR, `${stem}.json`) : undefined;
    if (!path || !existsSync(path)) continue;
    const alt = bestAlternative(
      JSON.parse(readFileSync(path, "utf8")) as DeepgramResponse,
    );
    const words = alt.words ?? [];
    const withConfidence = words.filter(
      (w) => typeof w.confidence === "number",
    );
    const withSpeaker = words.filter((w) => typeof w.speaker === "number");
    console.log(`\n[${stem}] ${(alt.transcript ?? "").slice(0, 200)}`);
    console.log(
      `  words: ${words.length}, with confidence: ${withConfidence.length}, with speaker: ${withSpeaker.length}, speakers: ${new Set(withSpeaker.map((w) => w.speaker)).size}`,
    );
  }

  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
