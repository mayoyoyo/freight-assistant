/**
 * JSONL readers/writers. Paths resolve against the repo root (derived from this
 * module's own location) so every entry point works from any cwd.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalCase, RunRecord } from "./types";

export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export const DEFAULT_CASES_PATH = join(REPO_ROOT, "evals", "cases.jsonl");
export const RESULTS_DIR = join(REPO_ROOT, "evals", "results");

export function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l) as T;
      } catch (e) {
        throw new Error(
          `${path}:${i + 1} is not valid JSON: ${e instanceof Error ? e.message : e}`,
        );
      }
    });
}

export function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

const BUCKETS = new Set([
  "factual_lookup",
  "set_retrieval",
  "email_draft",
  "abstention",
]);

/** Loads and structurally validates the case set. Fails loudly, never silently. */
export function loadCases(path = DEFAULT_CASES_PATH): EvalCase[] {
  const cases = readJsonl<EvalCase>(path);
  const seen = new Set<string>();
  for (const c of cases) {
    if (!c.id) throw new Error(`${path}: a case is missing an id`);
    if (seen.has(c.id)) throw new Error(`${path}: duplicate case id ${c.id}`);
    seen.add(c.id);
    if (!BUCKETS.has(c.bucket))
      throw new Error(`${path}: ${c.id} has unknown bucket ${c.bucket}`);
    if (typeof c.query !== "string" || c.query.length === 0)
      throw new Error(`${path}: ${c.id} has no query`);
    if (!Array.isArray(c.required_tools))
      throw new Error(`${path}: ${c.id} has no required_tools array`);
  }
  return cases;
}

export function loadRuns(path: string): RunRecord[] {
  return readJsonl<RunRecord>(path);
}
