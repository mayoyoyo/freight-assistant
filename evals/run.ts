/**
 * Phase 4B eval runner.
 *
 *   pnpm eval                              full suite, k=3, claude-opus-5
 *   pnpm eval --model claude-sonnet-5      model sweep
 *   pnpm eval --cases evals/smoke.jsonl    alternate case file
 *   pnpm eval --only L01,S01 --k 1         one-off probe
 *   pnpm eval --dry-run                    no API calls, no DB — CI-safe
 *   pnpm eval --generate-only              stop after the expensive pass
 *   pnpm eval --grade-only evals/results/runs-<id>.jsonl
 *
 * TWO PASSES over one file:
 *
 *   1. GENERATE — calls the agent k times per case and writes a `RunRecord`
 *      per (case, run_index) to `evals/results/runs-<runId>.jsonl`.
 *   2. GRADE — reads that file, applies the code graders and the LLM judge,
 *      fills in `verdicts` / `passed`, rewrites the file in place.
 *
 * They are separate because pass 1 costs real money and ~40 minutes while pass
 * 2 costs almost nothing: a grader fix, a new judge version or a changed
 * threshold is a RE-GRADE of the committed runs file, not a re-run.
 * `--grade-only` is that door. It also means a bug in a grader can never burn
 * an API budget, and the runs file is written to disk BEFORE grading starts.
 *
 * DETERMINISM: the only wall-clock read here is the run id, and it is supplied
 * from outside (EVAL_RUN_ID, set by the `pnpm eval` script, or --run-id).
 * Everything downstream is a pure function of (cases, runs file, graders).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_CASES_PATH,
  loadCases,
  loadRuns,
  RESULTS_DIR,
  writeJsonl,
} from "./lib/cases";
import "./lib/load-env";
import { generate, grade, isNotApplicable } from "./lib/pipeline";
import type { EvalCase, RunRecord } from "./lib/types";
import { PROMPT_VERSION } from "./lib/types";

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_K = 3;
/** 3 cases in flight; the k runs inside a case stay sequential. */
const DEFAULT_CONCURRENCY = 3;

type Args = {
  model: string;
  cases: string;
  k: number;
  concurrency: number;
  only: string[] | null;
  runId: string;
  dryRun: boolean;
  gradeOnly: string | null;
  generateOnly: boolean;
  noJudge: boolean;
};

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string) => argv.includes(flag);

  const runId =
    get("--run-id") ??
    process.env.EVAL_RUN_ID ??
    // Fallback so `--dry-run` works anywhere without ceremony. Loud on purpose:
    // a baseline run should carry an id chosen by the operator, not by chance.
    (() => {
      const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
      console.warn(
        `[warn] no --run-id / EVAL_RUN_ID; falling back to ${stamp}`,
      );
      return stamp;
    })();

  return {
    model: get("--model") ?? DEFAULT_MODEL,
    cases: get("--cases") ?? DEFAULT_CASES_PATH,
    k: Number(get("--k") ?? DEFAULT_K),
    concurrency: Number(get("--concurrency") ?? DEFAULT_CONCURRENCY),
    only:
      get("--only")
        ?.split(",")
        .map((s) => s.trim()) ?? null,
    runId,
    dryRun: has("--dry-run"),
    gradeOnly: get("--grade-only") ?? null,
    generateOnly: has("--generate-only"),
    noJudge: has("--no-judge"),
  };
}

/** Structural validation only. No API key, no DATABASE_URL, no network. */
async function dryRun(args: Args, cases: EvalCase[]): Promise<void> {
  const { CODE_GRADERS } = await import("./graders/index");
  console.log(`cases:      ${cases.length} from ${args.cases}`);
  console.log(`buckets:    ${summarise(cases.map((c) => c.bucket))}`);
  console.log(`origins:    ${summarise(cases.map((c) => c.origin))}`);
  console.log(`graders:    ${CODE_GRADERS.map((g) => g.name).join(", ")}`);
  console.log(
    `plan:       ${cases.length} x k=${args.k} = ${cases.length * args.k} agent calls on ${args.model}`,
  );

  const blank: RunRecord = {
    run_id: "dry",
    case_id: "",
    bucket: "factual_lookup",
    origin: "ground_truth",
    run_index: 0,
    prompt_version: PROMPT_VERSION,
    judge_version: null,
    model: args.model,
    query: "",
    text: "",
    tools: [],
    steps: 0,
    latency_ms: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      reasoning_tokens: 0,
      cached_input_tokens: 0,
    },
    error: null,
    verdicts: {},
    passed: null,
  };

  // Every case must be reachable by at least one grader. A case that nothing
  // grades is an invisible hole in the suite, and this is where it surfaces.
  const ungraded: string[] = [];
  for (const c of cases) {
    const applied = CODE_GRADERS.filter(
      (g) =>
        !isNotApplicable(
          g.grade(c, { ...blank, case_id: c.id, bucket: c.bucket }),
        ),
    );
    const judged = c.bucket === "email_draft" ? ["judge x2"] : [];
    if (applied.length === 0 && judged.length === 0) ungraded.push(c.id);
    console.log(
      `  ${c.id.padEnd(4)} ${c.bucket.padEnd(15)} ${[...applied.map((g) => g.name), ...judged].join(", ")}`,
    );
  }
  if (ungraded.length > 0) {
    console.error(`FAIL: no grader applies to ${ungraded.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("dry run OK — no API calls made");
}

function summarise(xs: string[]): string {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts].map(([k, v]) => `${k}=${v}`).join(" ");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const all = loadCases(args.cases);
  const cases = args.only ? all.filter((c) => args.only?.includes(c.id)) : all;
  if (cases.length === 0) throw new Error("no cases selected");

  if (args.dryRun) {
    await dryRun(args, cases);
    return;
  }

  const gradeOpts = {
    cases: new Map(all.map((c) => [c.id, c])),
    useJudge: !args.noJudge,
    onProgress: (l: string) => console.log(l),
  };

  if (args.gradeOnly) {
    const runs = loadRuns(args.gradeOnly);
    await grade(runs, gradeOpts);
    writeJsonl(args.gradeOnly, runs);
    report(runs, args.gradeOnly);
    return;
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, `runs-${args.runId}.jsonl`);

  const runs = await generate(cases, {
    runId: args.runId,
    model: args.model,
    k: args.k,
    concurrency: args.concurrency,
    onProgress: (l) => console.log(l),
  });

  // Written before grading: the expensive artifact is safe on disk even if a
  // grader or the judge throws.
  writeJsonl(path, runs);
  console.log(`\nwrote ${runs.length} runs -> ${path}`);

  if (args.generateOnly) {
    console.log(`generate-only: grade later with --grade-only ${path}`);
    return;
  }

  await grade(runs, gradeOpts);
  writeJsonl(path, runs);
  report(runs, path);
}

function report(runs: RunRecord[], path: string): void {
  const errored = runs.filter((r) => r.error).length;
  const graded = runs.filter((r) => !r.error);
  const passed = graded.filter((r) => r.passed).length;
  console.log(
    `\n${passed}/${graded.length} graded runs passed${errored > 0 ? `; ${errored} runs ERRORED and are excluded` : ""} -> ${path}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
