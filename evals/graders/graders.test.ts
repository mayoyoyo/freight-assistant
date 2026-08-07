import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EvalCase } from "../lib/types";
import { GRADER_FIXTURES, makeRun } from "./fixtures";
import { CODE_GRADERS, isNotApplicable } from "./index";

/**
 * Meta-tests for the code graders (design doc §"Meta-test the evaluators").
 *
 * Every grader gets all three fixtures — clean-pass, corrupted-fail, and the
 * out-of-scope-pass that the design doc says everyone skips. Two structural
 * tests then make the coverage self-enforcing: a new grader cannot be added
 * without fixtures, and a new case cannot be added without a grader that
 * actually grades it.
 *
 * Offline by construction: no API key, no DATABASE_URL, no network. The only
 * file read is `evals/cases.jsonl`, and it is read-only.
 */

const casesPath = fileURLToPath(new URL("../cases.jsonl", import.meta.url));
const CASES: EvalCase[] = readFileSync(casesPath, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as EvalCase);

describe("CODE_GRADERS registry", () => {
  it("exposes uniquely-named graders in a stable order", () => {
    const names = CODE_GRADERS.map((g) => g.name);
    expect(names).toEqual([
      "required-tools",
      "groundedness",
      "exact-match",
      "set-f1",
      "dollar-figures-subset",
      "load-ref-present",
      "compliance-surfacing",
      "abstention",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("has exactly three meta-test fixtures for every grader, and no orphan fixtures", () => {
    const graderNames = CODE_GRADERS.map((g) => g.name).sort();
    const fixtureNames = Object.keys(GRADER_FIXTURES).sort();
    expect(fixtureNames).toEqual(graderNames);

    for (const name of graderNames) {
      const set = GRADER_FIXTURES[name];
      expect(set, `${name} has no fixtures`).toBeDefined();
      expect(set?.cleanPass, `${name} clean-pass`).toBeDefined();
      expect(set?.corruptedFail, `${name} corrupted-fail`).toBeDefined();
      expect(set?.outOfScopePass, `${name} out-of-scope-pass`).toBeDefined();
    }
  });
});

describe.each(CODE_GRADERS.map((g) => [g.name, g] as const))(
  "%s",
  (name, grader) => {
    const fixtures = GRADER_FIXTURES[name];
    if (!fixtures) throw new Error(`no fixtures registered for ${name}`);

    it(`clean-pass: ${fixtures.cleanPass.about}`, () => {
      const v = grader.grade(fixtures.cleanPass.case, fixtures.cleanPass.run);
      expect(v.passed, `expected a pass, got: ${v.reason}`).toBe(true);
      // The grader must have actually RUN — a silent n/a is not a pass.
      expect(isNotApplicable(v), `unexpected n/a: ${v.reason}`).toBe(false);
      expect(v.reason.length).toBeGreaterThan(0);
    });

    it(`corrupted-fail: ${fixtures.corruptedFail.about}`, () => {
      const v = grader.grade(
        fixtures.corruptedFail.case,
        fixtures.corruptedFail.run,
      );
      expect(v.passed, `expected a fail, got: ${v.reason}`).toBe(false);
      expect(isNotApplicable(v)).toBe(false);
      const pattern = fixtures.corruptedFail.expectReason;
      expect(
        pattern,
        "corrupted-fail fixture must pin the reason",
      ).toBeDefined();
      if (pattern) {
        expect(
          v.reason,
          `reason does not name the defect: ${v.reason}`,
        ).toMatch(pattern);
      }
    });

    it(`out-of-scope-pass: ${fixtures.outOfScopePass.about}`, () => {
      const v = grader.grade(
        fixtures.outOfScopePass.case,
        fixtures.outOfScopePass.run,
      );
      expect(v.passed, `expected a pass, got: ${v.reason}`).toBe(true);
      expect(
        v.reason.startsWith("n/a:"),
        `out-of-scope reason must start with "n/a:", got: ${v.reason}`,
      ).toBe(true);
    });

    it("is pure: grading the same inputs twice returns the same verdict", () => {
      for (const f of [
        fixtures.cleanPass,
        fixtures.corruptedFail,
        fixtures.outOfScopePass,
      ]) {
        const a = grader.grade(f.case, f.run);
        const b = grader.grade(f.case, f.run);
        expect(b).toEqual(a);
      }
    });
  },
);

describe("coverage over the real case set", () => {
  it("reads all 24 cases with unique ids", () => {
    expect(CASES).toHaveLength(24);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(24);
  });

  it("grades every case with at least one non-N/A grader", () => {
    // A trivially-empty run: the question is only "which graders APPLY here",
    // so an ungraded case shows up as a case where every grader short-circuits.
    const uncovered: string[] = [];
    for (const c of CASES) {
      const empty = makeRun(c, { text: "", tools: [] });
      const applied = CODE_GRADERS.filter(
        (g) => !isNotApplicable(g.grade(c, empty)),
      );
      if (applied.length === 0) uncovered.push(c.id);
    }
    expect(
      uncovered,
      `cases no code grader grades: ${uncovered.join(", ")}`,
    ).toHaveLength(0);
  });

  it("routes each bucket to its bucket-specific grader", () => {
    const expected: Record<EvalCase["bucket"], string> = {
      factual_lookup: "exact-match",
      set_retrieval: "set-f1",
      email_draft: "dollar-figures-subset",
      abstention: "abstention",
    };
    for (const c of CASES) {
      const empty = makeRun(c, { text: "", tools: [] });
      const grader = CODE_GRADERS.find((g) => g.name === expected[c.bucket]);
      if (!grader) throw new Error(`no grader named ${expected[c.bucket]}`);
      const v = grader.grade(c, empty);
      expect(
        isNotApplicable(v),
        `${c.id} (${c.bucket}) is not graded by ${grader.name}: ${v.reason}`,
      ).toBe(false);
    }
  });

  it("applies required-tools to every case (all 24 declare required tools)", () => {
    for (const c of CASES) {
      const empty = makeRun(c, { text: "", tools: [] });
      const grader = CODE_GRADERS[0];
      if (!grader) throw new Error("CODE_GRADERS is empty");
      const v = grader.grade(c, empty);
      expect(isNotApplicable(v), `${c.id}: ${v.reason}`).toBe(false);
      expect(v.passed, `${c.id} passed required-tools with no tool calls`).toBe(
        false,
      );
    }
  });

  it("applies compliance-surfacing to exactly the cases carrying compliance requirements", () => {
    const grader = CODE_GRADERS.find((g) => g.name === "compliance-surfacing");
    if (!grader) throw new Error("compliance-surfacing missing");
    const applied = CASES.filter((c) => {
      // S02's requirement is conditional on the answer raising CE0060, so it is
      // exercised with the text that triggers it (see compliance-surfacing.ts).
      const run = makeRun(c, { text: "CE0060", tools: [] });
      return !isNotApplicable(grader.grade(c, run));
    }).map((c) => c.id);
    expect(applied).toEqual(["L04", "S02", "D03", "D04", "A05"]);
  });

  it("never returns an empty reason on any real case", () => {
    for (const c of CASES) {
      const empty = makeRun(c, { text: "", tools: [] });
      for (const g of CODE_GRADERS) {
        const v = g.grade(c, empty);
        expect(v.reason.trim().length, `${g.name} on ${c.id}`).toBeGreaterThan(
          0,
        );
      }
    }
  });
});
