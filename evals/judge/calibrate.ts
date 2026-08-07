/**
 * Judge calibration runner.
 *
 *   pnpm exec tsx evals/judge/calibrate.ts --version v1 [--concurrency 4]
 *
 * Runs BOTH judge checks over ALL 20 hand-labeled items in
 * `evals/calibration.jsonl` and reports, per check, the confusion counts,
 * TPR, TNR, accuracy and Cohen's kappa against the human labels.
 *
 * Positive-class convention: **PASS = positive.** TPR is recall on drafts a
 * human passed; TNR is the failure-catching rate. Raw agreement is not reported
 * as a headline because it is misleading when failures are rare.
 *
 * The calibration set is the ONLY tuning signal for the judge prompt. The 24
 * reported cases in `evals/cases.jsonl` are never read here — that is the
 * no-leakage principle the design doc substitutes for train/dev/test splits.
 *
 * Writes `evals/judge/calibration-<version>.json`, which is the machine-readable
 * artifact the report generator reads. Deterministic given that file.
 *
 * Structure note: the scoring half (`scoreCells`, `renderMarkdown`) is a pure
 * function over `{id, check, human, judgePassed}` triples, and `runCalibration`
 * takes the judge as a parameter. That is what lets `judge.test.ts` drive the
 * whole path offline with a fake judge, no API key and no network.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureEnv } from "./env";
import {
  JUDGE_MODEL,
  type JudgeCheck,
  type JudgeVerdict,
  judge,
} from "./judge";
import {
  type Confusion,
  confusionFrom,
  type HumanLabel,
  type Metrics,
  metricsFrom,
  pct,
} from "./metrics";
import { CHECKS, PROMPT_DIR } from "./prompts";

export type CalibrationItem = {
  id: string;
  draft_text: string;
  source_context: unknown;
  labels: Record<JudgeCheck, HumanLabel>;
  rationale: string;
  corruption_type?: string;
  derived_from?: string;
};

/** One (item, check) outcome. The unit the scoring math operates on. */
export type Cell = {
  id: string;
  check: JudgeCheck;
  human: HumanLabel;
  judgePassed: boolean;
  judgeReason: string;
  confidence: string;
};

export type Miss = {
  id: string;
  human: HumanLabel;
  judge: HumanLabel;
  judge_reason: string;
};

export type CheckReport = Metrics & { misses: Miss[] };

export type CalibrationResult = {
  version: string;
  model: string;
  date: string;
  checks: Record<JudgeCheck, CheckReport>;
};

/** Signature the runner depends on — `judge` satisfies it, so do test fakes. */
export type JudgeFn = (
  check: JudgeCheck,
  draftText: string,
  sourceContext: string,
  opts?: { version?: string; model?: string },
) => Promise<JudgeVerdict>;

const CALIBRATION_PATH = join(PROMPT_DIR, "..", "calibration.jsonl");

export function loadCalibration(path = CALIBRATION_PATH): CalibrationItem[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as CalibrationItem);
}

/** The judge sees the retrieved records as a JSON blob, same as the harness. */
export function serializeContext(ctx: unknown): string {
  return JSON.stringify(ctx, null, 2);
}

export function parseArgs(argv: string[]): {
  version: string;
  concurrency: number;
} {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const concurrency = Number(get("--concurrency") ?? 4);
  return {
    version: get("--version") ?? "v1",
    concurrency:
      Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 4,
  };
}

/** Minimal worker pool — no dependency needed for 40 calls. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * True when an error is Anthropic's org spend-cap 400. Distinguishable from a
 * transient failure: it is not retryable and every subsequent call will also
 * fail, so the runner aborts rather than burning 40 calls into a wall.
 */
export function isUsageLimitError(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const body = (err as { responseBody?: string } | null)?.responseBody ?? "";
  return /usage limits|rate_limit_error|credit balance/i.test(`${msg} ${body}`);
}

/** PURE. All the confusion/kappa math, driven by outcomes only. */
export function scoreCells(
  cells: Cell[],
  meta: { version: string; model: string; date: string },
): CalibrationResult {
  const checks = {} as Record<JudgeCheck, CheckReport>;
  for (const check of CHECKS) {
    const rows = cells.filter((c) => c.check === check);
    const confusion: Confusion = confusionFrom(rows);
    checks[check] = {
      ...metricsFrom(confusion),
      misses: rows
        .filter((r) => (r.human === "pass") !== r.judgePassed)
        .map((r) => ({
          id: r.id,
          human: r.human,
          judge: (r.judgePassed ? "pass" : "fail") as HumanLabel,
          judge_reason: r.judgeReason,
        })),
    };
  }
  return { ...meta, checks };
}

/** Runs every (item, check) pair through `judgeFn`. Injectable for tests. */
export async function runCalibration(
  items: CalibrationItem[],
  version: string,
  concurrency: number,
  judgeFn: JudgeFn,
  onCell?: (cell: Cell) => void,
): Promise<Cell[]> {
  const jobs = CHECKS.flatMap((check) =>
    items.map((item) => ({ check, item })),
  );
  return mapWithConcurrency(jobs, concurrency, async ({ check, item }) => {
    const verdict = await judgeFn(
      check,
      item.draft_text,
      serializeContext(item.source_context),
      { version },
    );
    const cell: Cell = {
      id: item.id,
      check,
      human: item.labels[check],
      judgePassed: verdict.passed,
      judgeReason: verdict.reason,
      confidence: verdict.confidence,
    };
    onCell?.(cell);
    return cell;
  });
}

export function renderMarkdown(result: CalibrationResult): string {
  const lines: string[] = [];
  lines.push(`## Judge calibration — ${result.version} — ${result.model}`);
  lines.push("");
  lines.push(
    "Positive class = **PASS**. TPR = P(judge PASS | human pass); TNR = P(judge FAIL | human fail) = failure-catching rate.",
  );
  lines.push("");
  lines.push("| check | n | TP | FP | TN | FN | TPR | TNR | acc | kappa |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const [name, c] of Object.entries(result.checks)) {
    lines.push(
      `| ${name} | ${c.n} | ${c.tp} | ${c.fp} | ${c.tn} | ${c.fn} | ${pct(c.tpr)} | ${pct(c.tnr)} | ${pct(c.accuracy)} | ${c.kappa.toFixed(3)} |`,
    );
  }
  lines.push("");
  for (const [name, c] of Object.entries(result.checks)) {
    lines.push(`### ${name} — ${c.misses.length} miss(es)`);
    if (c.misses.length === 0) lines.push("_none_");
    for (const m of c.misses) {
      lines.push(
        `- **${m.id}** human=${m.human} judge=${m.judge} — ${m.judge_reason}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  ensureEnv();
  const { version, concurrency } = parseArgs(process.argv.slice(2));
  const items = loadCalibration();
  const first = items[0];
  if (!first) throw new Error("calibration.jsonl is empty");

  console.error(
    `judge calibration: version=${version} model=${JUDGE_MODEL} items=${items.length} calls=${items.length * CHECKS.length} concurrency=${concurrency}`,
  );

  // Preflight: one call before spending 40. A spend-cap 400 fails every call,
  // so detecting it here costs one request instead of the whole loop.
  try {
    await judge(
      "no_invented_commitments",
      first.draft_text,
      serializeContext(first.source_context),
      { version },
    );
  } catch (err) {
    if (isUsageLimitError(err)) {
      console.error(
        "\nABORT: the Anthropic API returned a usage-limit error on the preflight call.\n" +
          "Every subsequent call would fail identically, so no calibration was run and\n" +
          "no artifact was written. Re-run this exact command once budget is available:\n" +
          `  pnpm exec tsx evals/judge/calibrate.ts --version ${version} --concurrency ${concurrency}\n`,
      );
      process.exit(2);
    }
    throw err;
  }

  const cells = await runCalibration(
    items,
    version,
    concurrency,
    judge,
    (c) => {
      const agree = (c.human === "pass") === c.judgePassed;
      console.error(
        `${agree ? "  ok" : "MISS"} ${c.id} ${c.check.padEnd(24)} human=${c.human} judge=${c.judgePassed ? "PASS" : "FAIL"} (${c.confidence})`,
      );
    },
  );

  const result = scoreCells(cells, {
    version,
    model: JUDGE_MODEL,
    date: new Date().toISOString().slice(0, 10),
  });

  const outPath = join(PROMPT_DIR, `calibration-${version}.json`);
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);

  console.log(renderMarkdown(result));
  console.error(`\nwrote ${outPath}`);
}

// Only run when executed directly, so the pure helpers stay importable.
if (process.argv[1]?.endsWith("calibrate.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
