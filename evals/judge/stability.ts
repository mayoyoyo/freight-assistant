/**
 * Repeat-stability measurement — the substitute for "judge at temperature 0".
 *
 *   pnpm exec tsx evals/judge/stability.ts --version v1 [--repeats 3] [--concurrency 4]
 *
 * WHY THIS EXISTS. The eval design doc pins the judge to temperature 0 so that
 * run-to-run variance in the reported pass rate is attributable to the AGENT,
 * not to the grader. `claude-opus-5` rejects `temperature`, `top_p` and
 * `top_k` outright (HTTP 400), so temperature 0 is not available. Pinning the
 * sampler was never the goal in itself — it was a proxy for "the judge returns
 * the same verdict on the same input". So we measure that property directly
 * instead of assuming it from a parameter:
 *
 *   - decode is constrained by a strict `generateObject` schema,
 *   - extended thinking is disabled (`providerOptions.anthropic.thinking`),
 *   - and this script runs the judge 3x over the same items and reports the
 *     flip rate.
 *
 * A measured flip rate is strictly more informative than `temperature: 0`,
 * which is itself only an approximate determinism guarantee on a production
 * inference stack. The number belongs in the report next to pass@1 / pass^3:
 * it bounds how much of the observed agent variance could actually be judge
 * variance.
 *
 * Flip rate = (item x check cells where the 3 labels are not unanimous) /
 *             (total cells = 6 items x 2 checks = 12).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CalibrationItem,
  isUsageLimitError,
  type JudgeFn,
  loadCalibration,
  mapWithConcurrency,
  serializeContext,
} from "./calibrate";
import { ensureEnv } from "./env";
import { JUDGE_MODEL, type JudgeCheck, judge } from "./judge";
import { CHECKS, PROMPT_DIR } from "./prompts";

/**
 * Six calibration items, hardcoded so the measurement is comparable across
 * versions. Chosen to mix human pass and human fail on BOTH checks and to
 * over-weight the items where a flip is actually plausible — a stability
 * number computed only on easy items is decoration.
 *
 *   CAL01  pass / pass  — clean, fully sourced draft. The floor: if this flips,
 *                         the judge is unusable.
 *   CAL13  fail / pass  — fabricated facility and appointment detail with a
 *                         correct rate. The highest-value catch in the set.
 *   CAL14  pass / pass  — the out-of-scope-pass fixture: genuinely defective in
 *                         a way that belongs to a CODE check, not to either
 *                         judge check. If any cell flips, this is the one, and
 *                         it flips toward FAIL.
 *   CAL15  pass / fail  — grounded but unprofessional. Tests that the tone
 *                         verdict stays put while groundedness stays PASS.
 *   CAL19  fail / fail  — both checks must fire on the same text.
 *   CAL20  fail / pass  — the subtlest corruption: a real corpus figure applied
 *                         to the wrong load, wrapped in a warm, professional
 *                         tone. Most likely nondeterministic cell in the set.
 */
export const STABILITY_ITEM_IDS = [
  "CAL01",
  "CAL13",
  "CAL14",
  "CAL15",
  "CAL19",
  "CAL20",
] as const;

export const DEFAULT_REPEATS = 3;

export type StabilityRow = {
  id: string;
  check: JudgeCheck;
  labels: ("PASS" | "FAIL")[];
  flipped: boolean;
};

export type StabilityResult = {
  version: string;
  model: string;
  date: string;
  repeats: number;
  items: string[];
  cells: number;
  flipped: number;
  flip_rate: number;
  detail: StabilityRow[];
};

/** PURE. Flip-rate math over collected labels — no I/O, no API. */
export function summarizeStability(
  detail: { id: string; check: JudgeCheck; labels: ("PASS" | "FAIL")[] }[],
  meta: { version: string; model: string; date: string; repeats: number },
): StabilityResult {
  const rows: StabilityRow[] = detail.map((d) => ({
    ...d,
    flipped: new Set(d.labels).size > 1,
  }));
  const flipped = rows.filter((r) => r.flipped).length;
  const cells = rows.length;
  return {
    ...meta,
    items: [...new Set(rows.map((r) => r.id))],
    cells,
    flipped,
    flip_rate: cells === 0 ? 0 : flipped / cells,
    detail: rows,
  };
}

export function renderStabilityMarkdown(r: StabilityResult): string {
  const lines: string[] = [];
  lines.push(`## Judge repeat-stability — ${r.version} — ${r.model}`);
  lines.push("");
  lines.push(
    `${r.repeats} repeat runs over ${r.items.length} items x ${CHECKS.length} checks = ${r.cells} cells. ` +
      `**Flip rate ${(r.flip_rate * 100).toFixed(1)}%** (${r.flipped}/${r.cells} cells not unanimous).`,
  );
  lines.push("");
  lines.push("| item | check | labels | unanimous |");
  lines.push("|---|---|---|---|");
  for (const d of r.detail) {
    lines.push(
      `| ${d.id} | ${d.check} | ${d.labels.join(", ")} | ${d.flipped ? "**no**" : "yes"} |`,
    );
  }
  return lines.join("\n");
}

/** Runs repeats x items x checks through `judgeFn`. Injectable for tests. */
export async function collectStability(
  items: CalibrationItem[],
  version: string,
  repeats: number,
  concurrency: number,
  judgeFn: JudgeFn,
): Promise<{ id: string; check: JudgeCheck; labels: ("PASS" | "FAIL")[] }[]> {
  const jobs = items.flatMap((item) =>
    CHECKS.flatMap((check) =>
      Array.from({ length: repeats }, (_, run) => ({ item, check, run })),
    ),
  );
  const results = await mapWithConcurrency(
    jobs,
    concurrency,
    async ({ item, check }) => {
      const v = await judgeFn(
        check,
        item.draft_text,
        serializeContext(item.source_context),
        { version },
      );
      return {
        id: item.id,
        check,
        label: v.passed ? "PASS" : ("FAIL" as const),
      };
    },
  );

  // Key by (id, check) but keep the components alongside, so no string-splitting
  // is needed on the way out.
  const byCell = new Map<
    string,
    { id: string; check: JudgeCheck; labels: ("PASS" | "FAIL")[] }
  >();
  for (const item of items) {
    for (const check of CHECKS) {
      byCell.set(`${item.id}|${check}`, { id: item.id, check, labels: [] });
    }
  }
  for (const r of results) {
    byCell.get(`${r.id}|${r.check}`)?.labels.push(r.label as "PASS" | "FAIL");
  }
  return [...byCell.values()];
}

function parseStabilityArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    version: get("--version") ?? "v1",
    repeats: Number(get("--repeats") ?? DEFAULT_REPEATS),
    concurrency: Number(get("--concurrency") ?? 4),
  };
}

async function main() {
  ensureEnv();
  const { version, repeats, concurrency } = parseStabilityArgs(
    process.argv.slice(2),
  );
  const all = loadCalibration();
  const items = STABILITY_ITEM_IDS.map((id) => {
    const found = all.find((i) => i.id === id);
    if (!found) throw new Error(`calibration.jsonl has no item ${id}`);
    return found;
  });

  const totalCalls = items.length * CHECKS.length * repeats;
  console.error(
    `judge stability: version=${version} model=${JUDGE_MODEL} items=${items.map((i) => i.id).join(",")} repeats=${repeats} calls=${totalCalls}`,
  );

  let detail: Awaited<ReturnType<typeof collectStability>>;
  try {
    detail = await collectStability(
      items,
      version,
      repeats,
      concurrency,
      judge,
    );
  } catch (err) {
    if (isUsageLimitError(err)) {
      console.error(
        "\nABORT: the Anthropic API returned a usage-limit error. No artifact was\n" +
          "written. Re-run once budget is available:\n" +
          `  pnpm exec tsx evals/judge/stability.ts --version ${version} --repeats ${repeats}\n`,
      );
      process.exit(2);
    }
    throw err;
  }

  const result = summarizeStability(detail, {
    version,
    model: JUDGE_MODEL,
    date: new Date().toISOString().slice(0, 10),
    repeats,
  });

  const outPath = join(PROMPT_DIR, `stability-${version}.json`);
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(renderStabilityMarkdown(result));
  console.error(`\nwrote ${outPath}`);
}

if (process.argv[1]?.endsWith("stability.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
