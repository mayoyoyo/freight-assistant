/**
 * The two passes, extracted so `run.ts` (one model) and `compare.ts` (several)
 * share one implementation rather than drifting apart.
 *
 * Everything expensive is behind a dynamic import: a caller that only wants to
 * grade an existing file never constructs an Anthropic client or a DB pool, and
 * a `--dry-run` never touches either.
 */
import type { EvalCase, GraderResult, RunRecord } from "./types";
import { PROMPT_VERSION } from "./types";

export type GenerateOptions = {
  runId: string;
  model: string;
  k: number;
  concurrency: number;
  onProgress?: (line: string) => void;
};

/** A verdict is "applied" unless the grader short-circuited with `n/a:`. */
export function isNotApplicable(v: GraderResult): boolean {
  return v.reason.startsWith("n/a:");
}

/** A run passes when every grader that ran on it passed. */
export function runPassed(verdicts: Record<string, GraderResult>): boolean {
  return Object.values(verdicts).every((v) => v.passed);
}

/**
 * Pass 1. `concurrency` cases run in parallel; the k runs WITHIN a case stay
 * sequential, so a case's runs never race each other for the same DB rows and
 * per-case latency stays comparable.
 */
export async function generate(
  cases: EvalCase[],
  opts: GenerateOptions,
): Promise<RunRecord[]> {
  const { runAgent } = await import("./run-agent");
  const out: RunRecord[] = [];
  const queue = [...cases];
  const total = cases.length * opts.k;
  let done = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      for (let i = 0; i < opts.k; i++) {
        const run = await runAgent(c.query, { model: opts.model });
        out.push({
          run_id: opts.runId,
          case_id: c.id,
          bucket: c.bucket,
          origin: c.origin,
          run_index: i,
          prompt_version: PROMPT_VERSION,
          judge_version: null,
          model: opts.model,
          query: c.query,
          text: run.text,
          tools: run.tools,
          steps: run.steps,
          latency_ms: run.latency_ms,
          usage: run.usage,
          error: run.error,
          verdicts: {},
          passed: null,
        });
        done++;
        opts.onProgress?.(
          `[${done}/${total}] ${c.id} run ${i} — ${run.tools.length} tools, ${run.latency_ms}ms, ${run.usage.total_tokens} tok${run.error ? ` — ERROR: ${run.error}` : ""}`,
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, cases.length) }, worker),
  );

  // Workers finish out of order; sort so the file is diffable across runs.
  out.sort(
    (a, b) => a.case_id.localeCompare(b.case_id) || a.run_index - b.run_index,
  );
  return out;
}

export type GradeOptions = {
  cases: Map<string, EvalCase>;
  useJudge: boolean;
  onProgress?: (line: string) => void;
};

/**
 * Pass 2. Pure code graders first (free, synchronous), then the judge on draft
 * cases only. Mutates and returns the same records.
 */
export async function grade(
  runs: RunRecord[],
  opts: GradeOptions,
): Promise<RunRecord[]> {
  const { CODE_GRADERS } = await import("../graders/index");
  const judgeMod = opts.useJudge ? await import("../judge/judge") : null;

  for (const run of runs) {
    const c = opts.cases.get(run.case_id);
    if (!c) throw new Error(`run references unknown case ${run.case_id}`);

    const verdicts: Record<string, GraderResult> = {};
    for (const g of CODE_GRADERS) verdicts[g.name] = g.grade(c, run);

    if (judgeMod) {
      run.judge_version = judgeMod.JUDGE_VERSION;
      for (const check of [
        "no_invented_commitments",
        "professional_tone",
      ] as const) {
        const key = `judge:${check}`;
        if (c.bucket !== "email_draft") {
          verdicts[key] = {
            passed: true,
            reason: `n/a: judge runs on email_draft only (bucket ${c.bucket})`,
          };
        } else if (run.error) {
          verdicts[key] = {
            passed: true,
            reason: "n/a: run errored before producing a draft",
          };
        } else {
          // Everything the agent actually retrieved. The judge rules on
          // invented content against THIS, never against its own priors.
          const sourceContext = JSON.stringify(
            run.tools.map((t) => ({
              tool: t.name,
              args: t.args,
              result: t.result,
            })),
            null,
            1,
          );
          const v = await judgeMod.judge(check, run.text, sourceContext);
          verdicts[key] = { passed: v.passed, reason: v.reason };
        }
      }
    }

    run.verdicts = verdicts;
    // An errored run produced no answer; it is not evidence about the agent and
    // must not be scored as a pass just because every grader short-circuited.
    run.passed = run.error ? false : runPassed(verdicts);
    opts.onProgress?.(
      `${run.case_id} run ${run.run_index}: ${
        run.error
          ? "ERRORED"
          : run.passed
            ? "PASS"
            : `FAIL — ${Object.entries(verdicts)
                .filter(([, v]) => !v.passed)
                .map(([k]) => k)
                .join(", ")}`
      }`,
    );
  }
  return runs;
}
