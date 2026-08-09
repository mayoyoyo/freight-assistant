/**
 * Phase 2b: Claude extraction over all 329 inquiries (274 emails + 55 calls).
 *   → data/derived/extractions/<id>.json (one cached result per item)
 *
 * SPEC INVARIANT: the dataset's pre-labeled fields are DECOYS and NEVER appear
 * in a prompt. The prompt is built only from `ExtractionInput` (see sources.ts),
 * which structurally cannot carry them. Discrepancies between what the carrier
 * actually wrote/said and what the dataset claims are computed later, in code,
 * by resolve.ts.
 *
 * Calls get BOTH transcript tracks. The readable (smart_format) track is easy
 * to reason over but mangles dictated digits; the verbatim track keeps them as
 * number-words and is declared authoritative for every number.
 *
 * Reruns are cheap: any item whose extraction JSON already exists is skipped.
 *
 * Usage: pnpm exec tsx scripts/extract.ts   (needs ANTHROPIC_API_KEY)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { extractionSchema } from "./extraction-schema";

export type { Extraction } from "./extraction-schema";

import type { Extraction } from "./extraction-schema";

export { extractionSchema } from "./extraction-schema";

import {
  callExtractionInput,
  type ExtractionInput,
  emailExtractionInput,
  loadCalls,
  loadEmails,
} from "./sources";

try {
  process.loadEnvFile(".env");
} catch {
  // no .env file — rely on ambient env (CI)
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "ANTHROPIC_API_KEY is required (set it in .env or the environment)",
  );
  process.exit(1);
}

const OUT_DIR = "data/derived/extractions";
const CONCURRENCY = 4;
const MODEL = "claude-opus-5";
// claude-opus-5 list price, USD per million tokens.
const USD_PER_M_INPUT = 5;
const USD_PER_M_OUTPUT = 25;

const SYSTEM = `You extract structured facts from freight-carrier inquiries for a brokerage's intake system.

Rules:
- Extract ONLY what the text actually states. Never infer a value that isn't there, and never invent an MC number, load ID, or rate. Absent means null.
- mc_number: digits only. Strip "MC", "MC#", dashes and spaces. If the speaker says the MC is not on file / unavailable / they don't have it, return null — do not substitute anything.
- load_reference: digits only, strip "#" and "load".
- rate_usd: the rate the CARRIER wants or accepts. If a broker-posted rate and a carrier ask are both mentioned, take the CARRIER's number. Plain number, no currency symbol.
- equipment: only if a specific trailer type is named for this inquiry.
- availability: "available" if they state a truck/driver is ready; "unavailable" if they decline or cannot cover; "conditional" if their availability depends on something (rate, weight, dock, approval); "unknown" if not addressed.

For phone calls you are given two transcripts of the same audio:
- READABLE TRACK: auto-formatted. Convenient prose, but its NUMBERS ARE CORRUPTED — the formatter mangles dictated digit strings into nonsense like "300And45800And78" or "45Dash6Nil12". Never read a number off this track.
- VERBATIM TRACK: word-for-word, no formatting, numbers left as spoken words. This is AUTHORITATIVE for every number (MC, load ID, rate). Decode the number-words yourself:
  * "four five dash six nil one two" -> 456012 ("nil" and "oh" both mean zero, "dash" is a separator to drop)
  * "three hundred and forty five thousand six hundred and seventy eight" -> 345678
  * "seven seven six four nine one" -> 776491
- CONCATENATE segments, never add them. Callers dictate an MC in chunks, and each chunk is a run of digits to write down in order:
  * "one hundred and two, three thousand four hundred and fifty six" -> "102" then "3456" -> 1023456 (NOT 123456, NOT 105456)
  * "four hundred and forty, nine hundred and eighty seven" -> "440" then "987" -> 440987 (NOT 449987)
  * "seven seven six, four nine one" -> "776" then "491" -> 776491
  Decode each segment to its own digits, then join them left to right. Do not drop, merge, or invent a digit — MC numbers here run 5 to 7 digits.
- Speakers correct themselves. If a number is stated and then revised ("...eight hundred and seventy eight, wait, number ...six hundred and seventy eight"), the LAST value stated is the correct one. A repeat-back that matches is just confirmation.
- Filler before a number is not a refusal: "it's — hold on — 774321" MEANS the MC is 774321. Only an explicit statement that the number is unavailable ("it's not on file", "I don't have it") yields null.`;

function userPrompt(input: ExtractionInput): string {
  if (input.sourceType === "email") {
    return [
      "Source: inbound carrier EMAIL.",
      `From: ${input.fromName ?? "(unknown)"} <${input.fromEmail ?? "(unknown)"}>`,
      `Subject: ${input.subject ?? "(none)"}`,
      "Body:",
      input.body,
    ].join("\n");
  }
  return [
    "Source: recorded broker/carrier PHONE CALL.",
    "",
    "READABLE TRACK (auto-formatted; numbers here are unreliable):",
    input.smartTranscript,
    "",
    "VERBATIM WORD-FOR-WORD TRACK (authoritative for spoken numbers):",
    input.verbatimTranscript,
  ].join("\n");
}

type Usage = { input: number; output: number };
type Cached = {
  id: string;
  sourceType: "email" | "call";
  model: string;
  thinking: "disabled" | "default";
  usage: Usage;
  extraction: Extraction;
};

/**
 * Thinking is ON by default on claude-opus-5 and is pure overhead for a
 * mechanical read-and-copy task, so we disable it (valid at the default `high`
 * effort). Disabled thinking has a known failure mode where the model writes a
 * tool call as plain text instead of emitting the structured block — which
 * surfaces here as a generateObject failure — so any item that fails is retried
 * once with thinking left at its default.
 */
async function extractOne(input: ExtractionInput): Promise<{
  extraction: Extraction;
  usage: Usage;
  thinking: "disabled" | "default";
}> {
  const call = async (disableThinking: boolean) =>
    generateObject({
      model: anthropic(MODEL),
      schema: extractionSchema,
      system: SYSTEM,
      prompt: userPrompt(input),
      maxRetries: 3,
      ...(disableThinking
        ? { providerOptions: { anthropic: { thinking: { type: "disabled" } } } }
        : {}),
    });

  let disabled = true;
  let result: Awaited<ReturnType<typeof call>>;
  try {
    result = await call(true);
  } catch (err) {
    console.warn(
      `warn ${input.id}: retrying with default thinking after ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
    );
    disabled = false;
    result = await call(false);
  }

  return {
    extraction: result.object,
    usage: {
      input: result.usage.inputTokens ?? 0,
      output: result.usage.outputTokens ?? 0,
    },
    thinking: disabled ? "disabled" : "default",
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const items: { input: ExtractionInput; sourceType: "email" | "call" }[] = [
    ...loadEmails().map((e) => ({
      input: emailExtractionInput(e),
      sourceType: "email" as const,
    })),
    ...loadCalls().map((c) => ({
      input: callExtractionInput(c),
      sourceType: "call" as const,
    })),
  ];

  const outPath = (id: string) => join(OUT_DIR, `${id}.json`);
  const pending = items.filter((i) => !existsSync(outPath(i.input.id)));
  const skipped = items.length - pending.length;
  const failures: { id: string; error: string }[] = [];
  let done = 0;
  let fallbacks = 0;

  const queue = [...pending];
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      const { input, sourceType } = item;
      try {
        const { extraction, usage, thinking } = await extractOne(input);
        if (thinking === "default") fallbacks++;
        const cached: Cached = {
          id: input.id,
          sourceType,
          model: MODEL,
          thinking,
          usage,
          extraction,
        };
        writeFileSync(
          outPath(input.id),
          `${JSON.stringify(cached, null, 2)}\n`,
        );
        done++;
        if (done % 25 === 0 || done === pending.length) {
          console.log(`  ${done}/${pending.length} extracted`);
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        failures.push({ id: input.id, error });
        console.error(`fail ${input.id}: ${error.slice(0, 200)}`);
      }
    }
  };

  console.log(
    `${items.length} items: ${pending.length} to extract, ${skipped} cached`,
  );
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker),
  );

  // Cost over everything on disk, so a resumed run still reports the true total.
  let inTok = 0;
  let outTok = 0;
  let onDisk = 0;
  for (const { input } of items) {
    if (!existsSync(outPath(input.id))) continue;
    const c = JSON.parse(readFileSync(outPath(input.id), "utf8")) as Cached;
    inTok += c.usage.input;
    outTok += c.usage.output;
    onDisk++;
  }
  const cost =
    (inTok / 1_000_000) * USD_PER_M_INPUT +
    (outTok / 1_000_000) * USD_PER_M_OUTPUT;

  console.log(
    `\n${onDisk}/${items.length} extractions on disk (${done} this run, ${failures.length} failed, ${fallbacks} needed the thinking fallback)`,
  );
  for (const { id, error } of failures) {
    console.log(`  failed: ${id} — ${error.slice(0, 160)}`);
  }
  console.log(
    `tokens: ${inTok.toLocaleString()} in / ${outTok.toLocaleString()} out — estimated $${cost.toFixed(2)} at ${MODEL} list price`,
  );

  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
