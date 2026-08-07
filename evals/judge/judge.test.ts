/**
 * Offline tests for the judge harness. NO API CALLS, NO DATABASE.
 *
 * These run in CI without `ANTHROPIC_API_KEY` and without network access. That
 * constraint is why `metrics.ts`, `prompts.ts` and the scoring halves of
 * `calibrate.ts` / `stability.ts` are pure functions with the judge injected as
 * a parameter: the whole scoring path is exercised here with a fake judge.
 *
 * `judge.ts` itself is imported (for the schema and `truncateReason`) but never
 * invoked — importing the provider factory does not construct a client or read
 * an API key.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Cell,
  isUsageLimitError,
  loadCalibration,
  mapWithConcurrency,
  parseArgs,
  renderMarkdown,
  runCalibration,
  scoreCells,
  serializeContext,
} from "./calibrate";
import { truncateReason, verdictSchema } from "./judge";
import { cohensKappa, confusionFrom, metricsFrom, pct } from "./metrics";
import {
  buildUserPrompt,
  CHECKS,
  loadCheckPrompt,
  PROMPT_DIR,
  parsePromptFile,
  promptPath,
  REQUIRED_SECTION_HEADINGS,
} from "./prompts";
import {
  collectStability,
  STABILITY_ITEM_IDS,
  summarizeStability,
} from "./stability";

/** Every prompt version file present on disk. */
const VERSION_FILES = readdirSync(PROMPT_DIR)
  .filter((f) => /^prompt-.+\.md$/.test(f))
  .sort();

const VERSIONS = VERSION_FILES.map((f) =>
  f.replace(/^prompt-/, "").replace(/\.md$/, ""),
);

/** First version on disk — used for the single-shot loader assertions. */
const V0 = VERSIONS[0] as string;

/** Read one check section, failing loudly rather than returning undefined. */
function section(version: string, check: string): string {
  const body = parsePromptFile(readFileSync(promptPath(version), "utf8"))[
    check
  ];
  if (body === undefined) {
    throw new Error(`prompt-${version}.md has no "${check}" section`);
  }
  return body;
}

describe("cohensKappa", () => {
  it("matches a hand-computed 2x2", () => {
    // Hand computation, rows = human, cols = judge:
    //            judge PASS  judge FAIL   total
    // human pass     20 (tp)      5 (fn)     25
    // human fail     10 (fp)     15 (tn)     25
    // total          30           20         50
    //
    // po = (20 + 15) / 50 = 0.70
    // pe = (25/50)(30/50) + (25/50)(20/50)
    //    = (0.5)(0.6) + (0.5)(0.4) = 0.30 + 0.20 = 0.50
    // kappa = (0.70 - 0.50) / (1 - 0.50) = 0.20 / 0.50 = 0.40
    expect(cohensKappa({ tp: 20, fn: 5, fp: 10, tn: 15 })).toBeCloseTo(0.4, 10);
  });

  it("matches a second hand-computed 2x2 with unequal marginals", () => {
    //            judge PASS  judge FAIL   total
    // human pass     40 (tp)     10 (fn)     50
    // human fail      5 (fp)     25 (tn)     30
    // total          45          35          80
    //
    // po = (40 + 25) / 80 = 65/80 = 0.8125
    // pe = (50/80)(45/80) + (30/80)(35/80)
    //    = 0.625*0.5625 + 0.375*0.4375 = 0.3515625 + 0.1640625 = 0.515625
    // kappa = (0.8125 - 0.515625) / (1 - 0.515625)
    //       = 0.296875 / 0.484375 = 0.612903225806...
    expect(cohensKappa({ tp: 40, fn: 10, fp: 5, tn: 25 })).toBeCloseTo(
      0.6129032258064516,
      12,
    );
  });

  it("is 1 on perfect agreement and 0 on chance-level agreement", () => {
    expect(cohensKappa({ tp: 10, fn: 0, fp: 0, tn: 10 })).toBe(1);
    // po = 0.5, pe = (0.5)(0.5) + (0.5)(0.5) = 0.5 -> kappa = 0
    expect(cohensKappa({ tp: 5, fn: 5, fp: 5, tn: 5 })).toBeCloseTo(0, 10);
  });

  it("goes negative when agreement is worse than chance", () => {
    // po = 0.2, pe = (0.5)(0.5)+(0.5)(0.5) = 0.5 -> (0.2-0.5)/0.5 = -0.6
    expect(cohensKappa({ tp: 2, fn: 8, fp: 8, tn: 2 })).toBeCloseTo(-0.6, 10);
  });

  it("handles the degenerate single-label table without NaN", () => {
    // Both raters used only PASS: pe == 1, kappa undefined. Perfect agreement
    // reports 1; anything else reports the conservative 0.
    expect(cohensKappa({ tp: 10, fn: 0, fp: 0, tn: 0 })).toBe(1);
    expect(cohensKappa({ tp: 0, fn: 0, fp: 0, tn: 0 })).toBe(0);
  });
});

describe("confusion + metric math", () => {
  it("assigns cells with PASS as the positive class", () => {
    const c = confusionFrom([
      { human: "pass", judgePassed: true }, // tp
      { human: "pass", judgePassed: false }, // fn (false alarm)
      { human: "fail", judgePassed: true }, // fp (missed failure)
      { human: "fail", judgePassed: false }, // tn (caught failure)
      { human: "fail", judgePassed: false }, // tn
    ]);
    expect(c).toEqual({ tp: 1, fn: 1, fp: 1, tn: 2 });
  });

  it("computes TPR/TNR/accuracy from a synthetic confusion matrix", () => {
    // 13 human passes (10 tp + 3 fn), 7 human fails (7 tn + 0 fp).
    const m = metricsFrom({ tp: 10, fn: 3, fp: 0, tn: 7 });
    expect(m.n).toBe(20);
    expect(m.tpr).toBeCloseTo(10 / 13, 12); // 0.7692...
    expect(m.tnr).toBe(1); // 7 / 7
    expect(m.accuracy).toBe(0.85); // 17 / 20
  });

  it("TNR granularity at n=4 negatives is 25 points", () => {
    // professional_tone has only 4 human 'fail' labels, so a single missed
    // failure moves TNR from 100% to exactly 75%. Documented resolution limit.
    expect(metricsFrom({ tp: 16, fn: 0, fp: 0, tn: 4 }).tnr).toBe(1);
    expect(metricsFrom({ tp: 16, fn: 0, fp: 1, tn: 3 }).tnr).toBe(0.75);
  });

  it("reports 0 rather than NaN for an empty class", () => {
    const m = metricsFrom({ tp: 0, fn: 0, fp: 3, tn: 2 });
    expect(m.tpr).toBe(0);
    expect(Number.isNaN(m.tnr)).toBe(false);
  });

  it("formats percentages", () => {
    expect(pct(0.7692307692307693)).toBe("76.9%");
    expect(pct(1)).toBe("100.0%");
  });
});

describe("output schema", () => {
  it("declares explanation BEFORE label so reasoning precedes the verdict", () => {
    const keys = Object.keys(verdictSchema.shape);
    expect(keys).toEqual(["explanation", "label", "confidence"]);
    expect(keys.indexOf("explanation")).toBeLessThan(keys.indexOf("label"));
  });

  it("accepts a well-formed verdict and rejects bad labels", () => {
    expect(
      verdictSchema.parse({
        explanation: "grounded",
        label: "PASS",
        confidence: "high",
      }).label,
    ).toBe("PASS");
    expect(() =>
      verdictSchema.parse({
        explanation: "x",
        label: "pass",
        confidence: "high",
      }),
    ).toThrow();
    expect(() =>
      verdictSchema.parse({ explanation: "x", label: "PASS" }),
    ).toThrow();
  });

  it("truncates the reason to ~400 chars without dropping short ones", () => {
    expect(truncateReason("  short   reason ")).toBe("short reason");
    const long = "a".repeat(1000);
    const out = truncateReason(long);
    expect(out.length).toBe(400);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("prompt files", () => {
  it("finds at least one version file", () => {
    expect(VERSIONS.length).toBeGreaterThan(0);
  });

  it.each(VERSIONS)("prompt-%s.md has both CHECK sections", (version) => {
    const sections = parsePromptFile(readFileSync(promptPath(version), "utf8"));
    for (const check of CHECKS) {
      expect(Object.keys(sections)).toContain(check);
      expect(section(version, check).length).toBeGreaterThan(500);
    }
  });

  it.each(VERSIONS)(
    "prompt-%s.md follows the required skeleton in every check",
    (version) => {
      for (const check of CHECKS) {
        const body = section(version, check);
        let cursor = -1;
        for (const heading of REQUIRED_SECTION_HEADINGS) {
          const at = body.indexOf(heading);
          expect(
            at,
            `prompt-${version}.md / ${check} is missing "${heading}"`,
          ).toBeGreaterThan(-1);
          // Skeleton order is load-bearing: criteria before examples, output
          // contract last.
          expect(
            at,
            `prompt-${version}.md / ${check} has "${heading}" out of order`,
          ).toBeGreaterThan(cursor);
          cursor = at;
        }
      }
    },
  );

  it.each(VERSIONS)(
    "prompt-%s.md contains exactly 3 few-shot examples per check",
    (version) => {
      for (const check of CHECKS) {
        const examples =
          section(version, check).match(/^#### Example \d+/gm) ?? [];
        expect(examples.length, `${version} / ${check}`).toBe(3);
      }
    },
  );

  it.each(VERSIONS)(
    "prompt-%s.md never quotes a calibration item id (no-leakage)",
    (version) => {
      // Tuning on the calibration set is allowed; pasting its drafts into the
      // prompt is not, because it would make those items unscoreable.
      const text = readFileSync(promptPath(version), "utf8");
      const body = text.replace(/^<!--[\s\S]*?-->/, ""); // header comment may name the file
      expect(body).not.toMatch(/\bCAL\d{2}\b/);
    },
  );

  it("loadCheckPrompt returns a single labelled check section", () => {
    const body = loadCheckPrompt(V0, "professional_tone");
    expect(body.startsWith("## CHECK: professional_tone")).toBe(true);
    expect(body).not.toContain("## CHECK: no_invented_commitments");
  });

  it("loadCheckPrompt throws a useful error for a missing section", () => {
    expect(() => loadCheckPrompt(V0, "not_a_check" as never)).toThrow(
      /no "## CHECK: not_a_check" section/,
    );
  });

  it("parsePromptFile ignores the file-level preamble", () => {
    const parsed = parsePromptFile(
      "<!-- header -->\ntext\n\n## CHECK: a\nbody a\n\n## CHECK: b\nbody b\n",
    );
    expect(parsed).toEqual({ a: "body a", b: "body b" });
  });

  it("resolves prompt paths from the module directory, not cwd", () => {
    expect(existsSync(join(PROMPT_DIR, `prompt-${V0}.md`))).toBe(true);
    expect(promptPath("v9").startsWith(PROMPT_DIR)).toBe(true);
  });

  it("buildUserPrompt fences the draft and the source separately", () => {
    const p = buildUserPrompt("DRAFT BODY", '{"load":1}');
    expect(p).toContain('<source_context>\n{"load":1}\n</source_context>');
    expect(p).toContain("<draft_email>\nDRAFT BODY\n</draft_email>");
  });
});

describe("calibration set", () => {
  const items = loadCalibration();

  it("has 20 items, each labeled on both checks", () => {
    expect(items).toHaveLength(20);
    for (const item of items) {
      for (const check of CHECKS) {
        expect(["pass", "fail"]).toContain(item.labels[check]);
      }
    }
  });

  it("has the label counts the calibration report assumes", () => {
    const count = (check: (typeof CHECKS)[number], label: string) =>
      items.filter((i) => i.labels[check] === label).length;
    expect(count("no_invented_commitments", "pass")).toBe(13);
    expect(count("no_invented_commitments", "fail")).toBe(7);
    expect(count("professional_tone", "pass")).toBe(16);
    expect(count("professional_tone", "fail")).toBe(4);
  });

  it("contains every hardcoded stability item", () => {
    const ids = new Set(items.map((i) => i.id));
    for (const id of STABILITY_ITEM_IDS) expect(ids.has(id)).toBe(true);
  });

  it("stability items mix human passes and fails on both checks", () => {
    const chosen = items.filter((i) =>
      (STABILITY_ITEM_IDS as readonly string[]).includes(i.id),
    );
    for (const check of CHECKS) {
      const labels = chosen.map((i) => i.labels[check]);
      expect(labels).toContain("pass");
      expect(labels).toContain("fail");
    }
  });

  it("serializes source context as pretty JSON", () => {
    expect(serializeContext({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

describe("calibration scoring path (offline, injected judge)", () => {
  const items = loadCalibration();

  const byDraft = new Map(items.map((i) => [i.draft_text, i.id]));

  /** Fake judge: PASS unless the item id is listed under that check in `failOn`. */
  const fakeJudge =
    (failOn: Record<string, string[]>) =>
    async (
      check: string,
      draftText: string,
      _ctx: string,
    ): Promise<{
      passed: boolean;
      reason: string;
      confidence: "high" | "medium" | "low";
    }> => {
      const id = byDraft.get(draftText) ?? "";
      return {
        passed: !(failOn[check] ?? []).includes(id),
        reason: `fake verdict for ${check}`,
        confidence: "high",
      };
    };

  it("an always-PASS judge scores TPR 100% / TNR 0% — the failure mode raw agreement hides", async () => {
    const cells = await runCalibration(items, "v1", 4, async () => ({
      passed: true,
      reason: "always pass",
      confidence: "high",
    }));
    expect(cells).toHaveLength(40);
    const result = scoreCells(cells, {
      version: "v1",
      model: "fake",
      date: "2026-08-06",
    });
    const nic = result.checks.no_invented_commitments;
    expect(nic).toMatchObject({ tp: 13, fn: 0, fp: 7, tn: 0 });
    expect(nic.tpr).toBe(1);
    expect(nic.tnr).toBe(0);
    expect(nic.kappa).toBe(0);
    // 65% "agreement" while catching zero failures — exactly why accuracy is
    // not the headline metric.
    expect(nic.accuracy).toBe(0.65);
    expect(nic.misses).toHaveLength(7);

    const tone = result.checks.professional_tone;
    expect(tone.accuracy).toBe(0.8);
    expect(tone.tnr).toBe(0);
  });

  it("a perfect judge scores TPR/TNR 100% and kappa 1 with no misses", async () => {
    const byId = new Map(items.map((i) => [i.draft_text, i]));
    const cells = await runCalibration(
      items,
      "v1",
      4,
      async (check, draftText) => ({
        passed: byId.get(draftText)?.labels[check] === "pass",
        reason: "oracle",
        confidence: "high",
      }),
    );
    const result = scoreCells(cells, {
      version: "v1",
      model: "fake",
      date: "2026-08-06",
    });
    for (const check of CHECKS) {
      expect(result.checks[check].tpr).toBe(1);
      expect(result.checks[check].tnr).toBe(1);
      expect(result.checks[check].kappa).toBe(1);
      expect(result.checks[check].misses).toHaveLength(0);
    }
  });

  it("records misses with the judge's own stated reason", async () => {
    const cells: Cell[] = [
      {
        id: "X1",
        check: "no_invented_commitments",
        human: "fail",
        judgePassed: true,
        judgeReason: "looked fine to me",
        confidence: "low",
      },
      {
        id: "X2",
        check: "no_invented_commitments",
        human: "pass",
        judgePassed: true,
        judgeReason: "grounded",
        confidence: "high",
      },
    ];
    const r = scoreCells(cells, {
      version: "vT",
      model: "fake",
      date: "2026-08-06",
    });
    expect(r.checks.no_invented_commitments.misses).toEqual([
      {
        id: "X1",
        human: "fail",
        judge: "pass",
        judge_reason: "looked fine to me",
      },
    ]);
    expect(r.checks.professional_tone.n).toBe(0);
  });

  it("the injected-failure fake produces the expected confusion", async () => {
    // Fail exactly CAL01 on the tone check, and nothing else anywhere.
    const cells = await runCalibration(
      items,
      "v1",
      2,
      fakeJudge({ professional_tone: ["CAL01"] }),
    );
    const r = scoreCells(cells, {
      version: "v1",
      model: "fake",
      date: "2026-08-06",
    });
    const tone = r.checks.professional_tone;
    // CAL01 is a human pass on tone, so this is one false alarm (fn).
    expect(tone.fn).toBe(1);
    expect(tone.tp).toBe(15);
  });

  it("renders a markdown summary containing the convention and the table", () => {
    const md = renderMarkdown({
      version: "v1",
      model: "claude-opus-5",
      date: "2026-08-06",
      checks: {
        // These are the real measured v1 numbers; the render must reproduce
        // them verbatim in the report table.
        no_invented_commitments: {
          ...metricsFrom({ tp: 10, fn: 3, fp: 0, tn: 7 }),
          misses: [
            {
              id: "X1",
              human: "pass",
              judge: "fail",
              judge_reason: "over-triggered",
            },
          ],
        },
        professional_tone: {
          ...metricsFrom({ tp: 16, fn: 0, fp: 0, tn: 4 }),
          misses: [],
        },
      },
    });
    expect(md).toContain("Positive class = **PASS**");
    expect(md).toContain(
      "| no_invented_commitments | 20 | 10 | 0 | 7 | 3 | 76.9% | 100.0% | 85.0% | 0.700 |",
    );
    expect(md).toContain(
      "| professional_tone | 20 | 16 | 0 | 4 | 0 | 100.0% | 100.0% | 100.0% | 1.000 |",
    );
    expect(md).toContain("### no_invented_commitments — 1 miss(es)");
    expect(md).toContain("- **X1** human=pass judge=fail — over-triggered");
    expect(md).toContain("_none_");
  });
});

describe("stability flip-rate math", () => {
  it("counts a cell as flipped when the repeat labels disagree", () => {
    const r = summarizeStability(
      [
        {
          id: "A",
          check: "no_invented_commitments",
          labels: ["PASS", "PASS", "PASS"],
        },
        {
          id: "A",
          check: "professional_tone",
          labels: ["PASS", "FAIL", "PASS"],
        },
        {
          id: "B",
          check: "no_invented_commitments",
          labels: ["FAIL", "FAIL", "FAIL"],
        },
        {
          id: "B",
          check: "professional_tone",
          labels: ["FAIL", "FAIL", "PASS"],
        },
      ],
      { version: "v1", model: "fake", date: "2026-08-06", repeats: 3 },
    );
    expect(r.cells).toBe(4);
    expect(r.flipped).toBe(2);
    expect(r.flip_rate).toBe(0.5);
    expect(r.items).toEqual(["A", "B"]);
    expect(r.detail.filter((d) => d.flipped).map((d) => d.check)).toEqual([
      "professional_tone",
      "professional_tone",
    ]);
  });

  it("reports a 0% flip rate for a fully deterministic judge", () => {
    const r = summarizeStability(
      [
        {
          id: "A",
          check: "no_invented_commitments",
          labels: ["PASS", "PASS", "PASS"],
        },
        {
          id: "A",
          check: "professional_tone",
          labels: ["FAIL", "FAIL", "FAIL"],
        },
      ],
      { version: "v1", model: "fake", date: "2026-08-06", repeats: 3 },
    );
    expect(r.flipped).toBe(0);
    expect(r.flip_rate).toBe(0);
  });

  it("collects 6 items x 2 checks = 12 cells with an injected judge", async () => {
    const all = loadCalibration();
    const items = STABILITY_ITEM_IDS.map(
      (id) => all.find((i) => i.id === id) as (typeof all)[number],
    );
    let calls = 0;
    const detail = await collectStability(items, "v1", 3, 4, async () => {
      calls++;
      return { passed: true, reason: "fake", confidence: "high" };
    });
    expect(calls).toBe(36); // 6 items x 2 checks x 3 repeats
    expect(detail).toHaveLength(12);
    for (const d of detail) expect(d.labels).toHaveLength(3);
    const r = summarizeStability(detail, {
      version: "v1",
      model: "fake",
      date: "2026-08-06",
      repeats: 3,
    });
    expect(r.cells).toBe(12);
    expect(r.flip_rate).toBe(0);
  });
});

describe("runner plumbing", () => {
  it("parses CLI args with defaults", () => {
    expect(parseArgs([])).toEqual({ version: "v1", concurrency: 4 });
    expect(parseArgs(["--version", "v3", "--concurrency", "8"])).toEqual({
      version: "v3",
      concurrency: 8,
    });
    expect(parseArgs(["--concurrency", "nope"]).concurrency).toBe(4);
  });

  it("respects the concurrency limit and preserves input order", async () => {
    let live = 0;
    let peak = 0;
    const out = await mapWithConcurrency(
      [1, 2, 3, 4, 5, 6, 7],
      3,
      async (n) => {
        live++;
        peak = Math.max(peak, live);
        await Promise.resolve();
        live--;
        return n * 2;
      },
    );
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("detects the Anthropic spend-cap 400 and nothing else", () => {
    expect(
      isUsageLimitError(
        new Error("You have reached your specified API usage limits."),
      ),
    ).toBe(true);
    expect(
      isUsageLimitError(
        Object.assign(new Error("Bad Request"), {
          responseBody:
            '{"error":{"message":"You have reached your specified API usage limits."}}',
        }),
      ),
    ).toBe(true);
    expect(isUsageLimitError(new Error("ECONNRESET"))).toBe(false);
    expect(isUsageLimitError(null)).toBe(false);
  });
});
