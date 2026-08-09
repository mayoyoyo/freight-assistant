/**
 * Phase 2a/2b: transcribe the call recordings with Deepgram — two tracks.
 *   data/raw/call_recordings/*.wav → data/derived/transcripts/<stem>.json
 *                                  → data/derived/transcripts-verbatim/<stem>.json
 *
 * The FULL Deepgram response is persisted (per-word confidence, speaker labels,
 * timings) so downstream extraction can quote spans and flag low-confidence
 * fields without re-billing the audio. Model is nova-3 (general, not the
 * phonecall variant — this audio is 16 kHz wideband) with diarization and the
 * nova-3-only keyterm boost for "MC".
 *
 * Two tracks, because smart_format is a liability on dictated digit strings:
 *   - "smart"    (smart_format + numerals): readable prose, searchable numerals,
 *     but it MANGLES spoken MC numbers — call_006's "three hundred and forty
 *     five thousand eight hundred and seventy eight" comes back as
 *     "300And45800And78", and call_036's "four five dash six zero one two"
 *     becomes "45Dash6Nil12".
 *   - "verbatim" (smart_format=false, numerals=false): raw number-words, which
 *     decode unambiguously, plus trustworthy per-word confidence on digit spans.
 * Extraction reads both and treats the verbatim track as authoritative for
 * numbers; the smart track is what we store as searchable raw_text.
 *
 * Reruns are cheap: any file whose output JSON already exists is skipped, per
 * track. Both tracks run in one invocation.
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
const CONCURRENCY = 5;
const RETRIES = 1;

const endpoint = (params: Record<string, string>) =>
  `https://api.deepgram.com/v1/listen?${new URLSearchParams({
    model: "nova-3",
    diarize: "true",
    keyterm: "MC",
    ...params,
  })}`;

type Track = { name: string; outDir: string; endpoint: string };

const TRACKS: Track[] = [
  {
    name: "smart",
    outDir: "data/derived/transcripts",
    endpoint: endpoint({ smart_format: "true", numerals: "true" }),
  },
  {
    // No smart formatting: spoken numbers stay as number-words, which decode
    // unambiguously, and per-word confidence on those words is meaningful.
    name: "verbatim",
    outDir: "data/derived/transcripts-verbatim",
    endpoint: endpoint({ smart_format: "false", numerals: "false" }),
  },
];

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

async function transcribe(
  file: string,
  track: Track,
): Promise<DeepgramResponse> {
  const audio = readFileSync(join(AUDIO_DIR, file));
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(track.endpoint, {
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

async function runTrack(track: Track, files: string[]): Promise<number> {
  mkdirSync(track.outDir, { recursive: true });

  const outPath = (file: string) =>
    join(track.outDir, `${file.replace(/\.wav$/, "")}.json`);
  const pending = files.filter((f) => !existsSync(outPath(f)));
  const skipped = files.length - pending.length;
  const failures: { file: string; error: string }[] = [];
  let processed = 0;

  const queue = [...pending];
  const worker = async () => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const stem = file.replace(/\.wav$/, "");
      try {
        const response = await transcribe(file, track);
        writeFileSync(outPath(file), `${JSON.stringify(response, null, 2)}\n`);
        processed++;
        const { transcript, confidence } = bestAlternative(response);
        console.log(
          `ok   [${track.name}] ${stem} (${response.metadata?.duration?.toFixed(1) ?? "?"}s, confidence ${confidence?.toFixed(3) ?? "?"}, ${transcript?.length ?? 0} chars)`,
        );
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        failures.push({ file, error });
        console.error(`fail [${track.name}] ${stem}: ${error}`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker),
  );

  // Summary over everything on disk, not just this run's work.
  const onDisk = files
    .map(outPath)
    .filter((p) => existsSync(p))
    .map((p) => JSON.parse(readFileSync(p, "utf8")) as DeepgramResponse);
  const totalSeconds = onDisk.reduce(
    (sum, r) => sum + (r.metadata?.duration ?? 0),
    0,
  );

  console.log(
    `\n[${track.name}] ${files.length} recordings: ${processed} transcribed, ${skipped} skipped (cached), ${failures.length} failed`,
  );
  for (const { file, error } of failures) {
    console.log(`  failed: ${file} — ${error}`);
  }
  console.log(
    `[${track.name}] total audio: ${(totalSeconds / 60).toFixed(1)} min (${totalSeconds.toFixed(1)}s across ${onDisk.length} transcripts)`,
  );

  // Spot-check one voicemail and one rate negotiation.
  for (const kind of ["voicemail", "rate_negotiation"]) {
    const file = files.find((f) => f.includes(kind));
    if (!file || !existsSync(outPath(file))) continue;
    const alt = bestAlternative(
      JSON.parse(readFileSync(outPath(file), "utf8")) as DeepgramResponse,
    );
    const words = alt.words ?? [];
    const withConfidence = words.filter(
      (w) => typeof w.confidence === "number",
    );
    const withSpeaker = words.filter((w) => typeof w.speaker === "number");
    console.log(
      `\n[${track.name}] ${file.replace(/\.wav$/, "")} ${(alt.transcript ?? "").slice(0, 200)}`,
    );
    console.log(
      `  words: ${words.length}, with confidence: ${withConfidence.length}, with speaker: ${withSpeaker.length}, speakers: ${new Set(withSpeaker.map((w) => w.speaker)).size}`,
    );
  }

  return failures.length;
}

async function main() {
  const files = readdirSync(AUDIO_DIR)
    .filter((f) => f.endsWith(".wav"))
    .sort();

  let failures = 0;
  for (const track of TRACKS) {
    failures += await runTrack(track, files);
  }
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
