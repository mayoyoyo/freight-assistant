/**
 * Model comparison — SCAFFOLD ONLY, not executed in this phase.
 *
 *   pnpm exec tsx evals/compare.ts --models claude-opus-5,claude-sonnet-5 \
 *     --run-id cmp-2026-08-07 [--k 3] [--concurrency 3] [--out evals/compare.md]
 *
 * Runs the SAME case set against each model in turn and emits one markdown
 * table: pass@1, pass^3, latency, and estimated cost per query computed from
 * the recorded token usage rather than guessed.
 *
 * NOT RUN in Phase 4B, for two reasons:
 *   1. The interesting comparison is Anthropic vs OpenAI and there is no OpenAI
 *      key in this environment yet — the pricing slot below is left explicitly
 *      TBD rather than filled with a number nobody verified.
 *   2. The Anthropic org spend cap was exhausted during the baseline run, so
 *      even the single-provider sweep is blocked until it resets.
 * Each model sweep costs roughly what one baseline costs (~$15-25 at k=3 over
 * 24 cases on opus), so this is deliberately a manual, opt-in command.
 *
 * Per-model runs files are written separately (`runs-<runId>-<model>.jsonl`) so
 * a sweep is auditable case by case, not just as a summary row.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_CASES_PATH,
  loadCases,
  RESULTS_DIR,
  writeJsonl,
} from "./lib/cases";
import "./lib/load-env";
import { generate, grade } from "./lib/pipeline";
import { fmtInterval, mean, median, pct, wilson } from "./lib/stats";
import type { RunRecord } from "./lib/types";

/**
 * USD per million tokens, {input, output}. Sourced from published list prices;
 * update alongside any model change — a stale price silently corrupts the only
 * column of this table anyone acts on.
 */
export const PRICING: Record<string, { input: number; output: number } | null> =
  {
    "claude-opus-5": { input: 5, output: 25 },
    "claude-sonnet-5": { input: 3, output: 15 },
    "claude-haiku-4-5": { input: 1, output: 5 },
    // Slot reserved for the cross-provider comparison this scaffold exists for.
    // Left null on purpose: `null` renders as "TBD" instead of a wrong number.
    "gpt-openai-tbd": null,
  };

/** Cost of one query in USD, from measured usage. Returns null if unpriced. */
export function costPerQuery(runs: RunRecord[], model: string): number | null {
  const price = PRICING[model];
  if (!price || runs.length === 0) return null;
  const input = runs.reduce((a, r) => a + r.usage.input_tokens, 0);
  const output = runs.reduce((a, r) => a + r.usage.output_tokens, 0);
  return (
    ((input / 1e6) * price.input) / runs.length +
    ((output / 1e6) * price.output) / runs.length
  );
}

export type ModelSummary = {
  model: string;
  cases: number;
  graded_runs: number;
  errored_runs: number;
  pass_at_1: { passed: number; n: number };
  pass_pow_k: { passed: number; n: number };
  median_latency_ms: number;
  mean_tool_calls: number;
  cost_per_query_usd: number | null;
};

/** Pure: runs in, summary out. Unit-testable without touching the network. */
export function summarise(model: string, runs: RunRecord[]): ModelSummary {
  const byCase = new Map<string, RunRecord[]>();
  for (const r of runs)
    byCase.set(r.case_id, [...(byCase.get(r.case_id) ?? []), r]);

  const graded = runs.filter((r) => !r.error);
  const gradedCases = [...byCase.values()]
    .map((rs) =>
      rs.filter((r) => !r.error).sort((a, b) => a.run_index - b.run_index),
    )
    .filter((rs) => rs.length > 0);

  return {
    model,
    cases: byCase.size,
    graded_runs: graded.length,
    errored_runs: runs.length - graded.length,
    pass_at_1: {
      passed: gradedCases.filter((rs) => rs[0]?.passed).length,
      n: gradedCases.length,
    },
    pass_pow_k: {
      passed: gradedCases.filter((rs) => rs.every((r) => r.passed)).length,
      n: gradedCases.length,
    },
    median_latency_ms: Math.round(median(graded.map((r) => r.latency_ms))),
    mean_tool_calls: Number(mean(graded.map((r) => r.tools.length)).toFixed(2)),
    cost_per_query_usd: costPerQuery(graded, model),
  };
}

export function renderTable(rows: ModelSummary[]): string {
  const cell = (n: number, d: number) =>
    d === 0 ? "—" : `${pct(n / d)} (${n}/${d}) ${fmtInterval(wilson(n, d))}`;
  return [
    "# Model comparison",
    "",
    "| Model | pass@1 (Wilson 95%) | pass^3 (Wilson 95%) | median latency | tool calls/run | est. cost/query |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) =>
      [
        r.model,
        cell(r.pass_at_1.passed, r.pass_at_1.n),
        cell(r.pass_pow_k.passed, r.pass_pow_k.n),
        `${r.median_latency_ms} ms`,
        r.mean_tool_calls,
        r.cost_per_query_usd === null
          ? "TBD (unpriced)"
          : `$${r.cost_per_query_usd.toFixed(4)}`,
      ].join(" | "),
    ),
    "",
    "Cost is computed from the token usage each run actually recorded, priced with the",
    "`PRICING` map in `evals/compare.ts` — not estimated from a per-call average.",
    "Errored runs are excluded from every column and reported separately:",
    "",
    ...rows.map(
      (r) =>
        `- ${r.model}: ${r.graded_runs} graded, ${r.errored_runs} errored, ${r.cases} cases`,
    ),
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const get = (f: string) => {
    const i = process.argv.indexOf(f);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const models = get("--models")
    ?.split(",")
    .map((s) => s.trim());
  if (!models || models.length === 0) {
    console.error(
      "usage: tsx evals/compare.ts --models m1,m2 [--run-id id] [--k 3] [--cases f] [--out f]",
    );
    process.exit(1);
  }
  const runId = get("--run-id") ?? process.env.EVAL_RUN_ID;
  if (!runId) {
    console.error(
      "--run-id (or EVAL_RUN_ID) is required: it names the output files",
    );
    process.exit(1);
  }
  const casesPath = get("--cases") ?? DEFAULT_CASES_PATH;
  const cases = loadCases(casesPath);
  const k = Number(get("--k") ?? 3);
  const concurrency = Number(get("--concurrency") ?? 3);

  mkdirSync(RESULTS_DIR, { recursive: true });
  const summaries: ModelSummary[] = [];

  // Sequential across models on purpose: a shared rate limit would otherwise
  // make the latency column a measurement of contention, not of the model.
  for (const model of models) {
    console.log(`\n=== ${model} ===`);
    const runs = await generate(cases, {
      runId,
      model,
      k,
      concurrency,
      onProgress: (l) => console.log(l),
    });
    const path = join(RESULTS_DIR, `runs-${runId}-${model}.jsonl`);
    writeJsonl(path, runs);
    await grade(runs, {
      cases: new Map(cases.map((c) => [c.id, c])),
      useJudge: true,
    });
    writeJsonl(path, runs);
    summaries.push(summarise(model, runs));
  }

  const out = get("--out") ?? join(RESULTS_DIR, `compare-${runId}.md`);
  writeFileSync(out, renderTable(summaries));
  console.log(`\nwrote ${out}`);
}

if (process.argv[1]?.endsWith("compare.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
