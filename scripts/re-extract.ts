/**
 * Re-run the Phase 2b extraction for SPECIFIC ids, and nothing else.
 *
 *   pnpm re-extract --ids CE0027
 *   pnpm re-extract --ids CE0027,call_006_rate_negotiation
 *   pnpm re-extract --ids CE0027 --dry-run     (no deletes, no API, no cost)
 *
 * WHY THIS EXISTS
 * `scripts/extract.ts` caches one JSON per item under data/derived/extractions
 * and skips any item whose file already exists. That makes a targeted re-run
 * a two-step manual dance — delete the right files, then re-run the whole
 * script — which is exactly the kind of thing that gets done wrong at 1am, or
 * gets "fixed" by hand-editing the derived JSON instead. Case L08 is a live
 * example: CE0027's body reads "We could do $280" while its cached extraction
 * says 2800, a real 10x bug the agent caught unprompted (trace P20). Hand-
 * editing the derived file would make the symptom disappear while leaving the
 * extractor unfixed and the artifact no longer reproducible from its inputs.
 * So: one command, and the derived data stays machine-produced.
 *
 * WHY IT SHELLS OUT INSTEAD OF IMPORTING THE EXTRACT LOGIC
 * Deliberate. `extract.ts` owns the model, the prompt, the schema, the
 * thinking-disabled fallback and the cost accounting; duplicating any of that
 * here would create a second extraction path that can silently drift from the
 * one that produced the committed corpus. This script does the only two things
 * extract.ts cannot do for itself — decide WHICH cache files to invalidate, and
 * prove afterwards that the re-run changed what it was supposed to — and
 * delegates the extraction itself, unmodified.
 *
 * WHAT IT GUARANTEES
 *  - Every id is validated against the corpus BEFORE anything is deleted, so a
 *    typo costs nothing.
 *  - The prior extraction is held in memory, so the run prints a real
 *    before/after field diff rather than "done".
 *  - A missing output file after the re-run is a hard failure (exit 1), not a
 *    silent no-op, and the prior extraction is restored so the corpus is never
 *    left with a hole.
 *
 * Needs ANTHROPIC_API_KEY (via .env), same as extract.ts, except under
 * --dry-run which touches neither disk nor network.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callIds, loadEmails } from "./sources";

const OUT_DIR = "data/derived/extractions";
const EXTRACT_SCRIPT = "scripts/extract.ts";

const outPath = (id: string) => join(OUT_DIR, `${id}.json`);

type Cached = {
  id: string;
  sourceType: "email" | "call";
  model: string;
  thinking: string;
  usage: { input: number; output: number };
  extraction: Record<string, unknown>;
};

function parseArgs(argv: string[]): { ids: string[]; dryRun: boolean } {
  const ids: string[] = [];
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--ids") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--ids needs a value");
      // Accept comma-separated and repeated --ids in the same invocation.
      ids.push(
        ...value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== ""),
      );
    }
  }
  return { ids: [...new Set(ids)], dryRun };
}

/** Every id extract.ts knows how to produce. Built from the same sources. */
function corpusIds(): Set<string> {
  return new Set([...loadEmails().map((e) => e.email_id), ...callIds()]);
}

/** Fields worth diffing — the extraction payload, one line each. */
function diffExtraction(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): string[] {
  const keys = [
    ...new Set([...Object.keys(before ?? {}), ...Object.keys(after)]),
  ].sort();
  const lines: string[] = [];
  for (const k of keys) {
    const b = JSON.stringify(before?.[k] ?? null);
    const a = JSON.stringify(after[k] ?? null);
    if (b !== a) lines.push(`    ${k}: ${b} -> ${a}`);
  }
  return lines;
}

function main() {
  const { ids, dryRun } = parseArgs(process.argv.slice(2));

  if (ids.length === 0) {
    console.error(
      "usage: pnpm re-extract --ids <id>[,<id>...] [--dry-run]\n" +
        "  e.g. pnpm re-extract --ids CE0027",
    );
    process.exit(2);
  }

  // Validate BEFORE deleting anything: an unknown id must cost nothing.
  const known = corpusIds();
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    console.error(
      `not in the corpus: ${unknown.join(", ")}\n` +
        "  ids are email ids (CE0027) or full call ids (call_006_rate_negotiation).",
    );
    process.exit(2);
  }

  // Snapshot what is on disk so the run can prove what it changed — and so a
  // failed re-run can be rolled back instead of leaving a hole in the corpus.
  const before = new Map<string, Cached | null>();
  for (const id of ids) {
    const p = outPath(id);
    before.set(
      id,
      existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Cached) : null,
    );
  }

  console.log(`re-extracting ${ids.length} id(s): ${ids.join(", ")}`);

  if (dryRun) {
    console.log("\n--dry-run: nothing deleted, no API calls made.");
    for (const id of ids) {
      const cached = before.get(id) ?? null;
      console.log(
        `  ${id}: would delete ${outPath(id)}${cached ? "" : " (not present)"}`,
      );
      if (cached) {
        console.log(
          `    current: ${JSON.stringify(cached.extraction).slice(0, 160)}`,
        );
      }
    }
    console.log(`  would then run: pnpm exec tsx ${EXTRACT_SCRIPT}`);
    return;
  }

  for (const id of ids) {
    const p = outPath(id);
    if (existsSync(p)) {
      unlinkSync(p);
      console.log(`  deleted ${p}`);
    } else {
      console.log(`  ${p} was not present — it will simply be produced`);
    }
  }

  // extract.ts skips every item whose JSON already exists, so with exactly
  // these files gone it re-extracts exactly these ids and nothing else.
  console.log(`\nrunning ${EXTRACT_SCRIPT} (it will skip everything cached)\n`);
  const run = spawnSync("pnpm", ["exec", "tsx", EXTRACT_SCRIPT], {
    stdio: "inherit",
  });

  const missing = ids.filter((id) => !existsSync(outPath(id)));
  if (missing.length > 0) {
    // Put the corpus back the way it was; a hole is worse than a stale value.
    for (const id of missing) {
      const prior = before.get(id);
      if (prior) {
        writeFileSync(outPath(id), `${JSON.stringify(prior, null, 2)}\n`);
        console.error(`restored prior extraction for ${id}`);
      }
    }
    console.error(
      `\nFAILED: no new extraction for ${missing.join(", ")} ` +
        `(extract.ts exited ${run.status ?? "unknown"})`,
    );
    process.exit(1);
  }

  console.log("\nbefore -> after:");
  for (const id of ids) {
    const after = JSON.parse(readFileSync(outPath(id), "utf8")) as Cached;
    const lines = diffExtraction(
      before.get(id)?.extraction ?? null,
      after.extraction,
    );
    console.log(`  ${id}: ${lines.length === 0 ? "no change" : ""}`);
    for (const line of lines) console.log(line);
  }

  // The extraction cache is not what the agent reads. Downstream is offline
  // (no API), so the rest of the chain can be run immediately.
  console.log(
    "\nnext, to push this through to Postgres:\n" +
      "  pnpm exec tsx scripts/resolve.ts   # extractions -> data/derived/inquiries.ndjson\n" +
      "  pnpm seed                          # inquiries.ndjson -> Postgres",
  );
}

main();
