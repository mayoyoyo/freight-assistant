/**
 * Harness-level tests: the plumbing between the runner, the graders and the
 * report. Offline — no API key, no DATABASE_URL, no network.
 */
import { describe, expect, it } from "vitest";
import { costPerQuery, PRICING, summarise } from "../compare";
import { loadCases } from "./cases";
import { DIMENSIONS, dimensionsFor } from "./dimensions";
import {
  dollarFiguresInText,
  figuresInToolResult,
  idsInToolResult,
} from "./extract";
import { isNotApplicable, runPassed } from "./pipeline";
import {
  classifyFailure,
  localize,
  MODES,
  REGRESSION_ORIGIN,
} from "./taxonomy";
import type { EvalCase, RunRecord } from "./types";

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: "t",
    case_id: "L01",
    bucket: "factual_lookup",
    origin: "ground_truth",
    run_index: 0,
    prompt_version: "sp-v1",
    judge_version: null,
    model: "claude-opus-5",
    query: "q",
    text: "",
    tools: [],
    steps: 1,
    latency_ms: 100,
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      total_tokens: 1100,
      reasoning_tokens: 0,
      cached_input_tokens: 0,
    },
    error: null,
    verdicts: {},
    passed: null,
    ...over,
  };
}

describe("extract", () => {
  it("pulls every citable id out of a nested tool result", () => {
    const result = {
      total_matches: 2,
      results: [
        {
          id: "CE0044",
          resolved_carrier_mc: "68333",
          extracted_load_reference: "29372343",
        },
        { id: "call_017_availability_check", resolved_carrier_mc: null },
      ],
    };
    expect(idsInToolResult(result).sort()).toEqual([
      "29372343",
      "68333",
      "CE0044",
      "call_017_availability_check",
    ]);
  });

  it("ignores non-id keys", () => {
    expect(idsInToolResult({ company_name: "ACME", weight_lbs: 5200 })).toEqual(
      [],
    );
  });

  it("collects structured AND in-text dollar figures", () => {
    // The in-text half is what makes case L08 gradeable: the body says $280
    // while the extracted column says 2800.
    const result = {
      results: [
        { extracted_rate_usd: 2800, snippet: "We could do $280 - any room?" },
      ],
    };
    expect(figuresInToolResult(result)).toEqual([280, 2800]);
  });

  it("parses money with separators and cents", () => {
    expect(dollarFiguresInText("$1,250.50 and $875 and $ 90")).toEqual([
      1250.5, 875, 90,
    ]);
  });

  it("does not read a bare number as money", () => {
    expect(dollarFiguresInText("220 miles, 5200 lbs")).toEqual([]);
  });
});

describe("pipeline verdict aggregation", () => {
  it("treats an n/a: reason as not-applicable", () => {
    expect(isNotApplicable({ passed: true, reason: "n/a: not a draft" })).toBe(
      true,
    );
    expect(
      isNotApplicable({ passed: true, reason: "all figures sourced" }),
    ).toBe(false);
  });

  it("passes only when every verdict passed", () => {
    expect(
      runPassed({
        a: { passed: true, reason: "ok" },
        b: { passed: true, reason: "n/a: x" },
      }),
    ).toBe(true);
    expect(
      runPassed({
        a: { passed: true, reason: "ok" },
        b: { passed: false, reason: "nope" },
      }),
    ).toBe(false);
  });
});

describe("dimensions", () => {
  it("tags all 24 cases and nothing else", () => {
    const cases = loadCases();
    expect(Object.keys(DIMENSIONS).sort()).toEqual(
      cases.map((c) => c.id).sort(),
    );
    for (const c of cases) expect(dimensionsFor(c)).toBeDefined();
  });

  it("marks every abstention case as data-absent", () => {
    for (const c of loadCases().filter((c) => c.bucket === "abstention"))
      expect(dimensionsFor(c).availability).toBe("absent");
  });
});

describe("taxonomy", () => {
  it("maps every regression case to a known mode", () => {
    const ids = new Set(MODES.map((m) => m.id));
    const regression = loadCases()
      .filter((c) => c.origin === "regression")
      .map((c) => c.id);
    expect(Object.keys(REGRESSION_ORIGIN).sort()).toEqual(regression.sort());
    for (const mode of Object.values(REGRESSION_ORIGIN))
      expect(ids.has(mode)).toBe(true);
  });

  it("files a phantom citation as ungrounded_citation ahead of anything else", () => {
    const c = { id: "S01", bucket: "set_retrieval" } as unknown as EvalCase;
    const r = run({
      verdicts: {
        groundedness: { passed: false, reason: "cited CE9999" },
        "set-f1": { passed: false, reason: "F1 0.5" },
      },
    });
    expect(classifyFailure(c, r)).toBe("ungrounded_citation");
  });

  it("falls back to the case's originating mode for a regression retrieval failure", () => {
    const c = { id: "S06", bucket: "set_retrieval" } as unknown as EvalCase;
    const r = run({
      verdicts: { "set-f1": { passed: false, reason: "F1 0" } },
    });
    expect(classifyFailure(c, r)).toBe("lane_join_blind");
  });
});

describe("localizer", () => {
  const c: EvalCase = {
    id: "S06",
    bucket: "set_retrieval",
    query: "q",
    gold: { inquiry_ids: ["call_004_rate_negotiation"], rates_usd: [530] },
    required_tools: [],
    required_source_ids: ["call_004_rate_negotiation"],
    compliance_must_surface: [],
    origin: "regression",
    notes: "",
  };

  it("says RETRIEVAL when the gold record never came back", () => {
    const v = localize(
      c,
      run({ case_id: "S06", bucket: "set_retrieval", tools: [] }),
    );
    expect(v.verdict).toBe("RETRIEVAL");
  });

  it("says GENERATION when the gold record came back and contains the answer", () => {
    const v = localize(
      c,
      run({
        case_id: "S06",
        bucket: "set_retrieval",
        tools: [
          {
            name: "search_inquiries",
            args: {},
            rows: 1,
            ids: ["call_004_rate_negotiation"],
            figures: [530],
            ms: 5,
            result: {
              results: [
                { id: "call_004_rate_negotiation", extracted_rate_usd: 530 },
              ],
            },
          },
        ],
      }),
    );
    expect(v.verdict).toBe("GENERATION");
  });

  it("says CORPUS when the record came back but holds none of the gold values", () => {
    const v = localize(
      c,
      run({
        case_id: "S06",
        bucket: "set_retrieval",
        tools: [
          {
            name: "search_inquiries",
            args: {},
            rows: 1,
            ids: ["call_004_rate_negotiation"],
            figures: [],
            ms: 5,
            result: {
              results: [
                { id: "call_004_rate_negotiation", extracted_rate_usd: null },
              ],
            },
          },
        ],
      }),
    );
    expect(v.verdict).toBe("CORPUS");
  });

  it("is N/A outside the retrieval buckets", () => {
    const draft = { ...c, id: "D01", bucket: "email_draft" as const };
    expect(localize(draft, run({ bucket: "email_draft" })).verdict).toBe("N/A");
  });
});

describe("compare scaffold", () => {
  it("prices a run from its recorded usage, not an average", () => {
    // 1M input + 1M output on opus = $5 + $25 over 1 run.
    const r = run({
      usage: {
        input_tokens: 1e6,
        output_tokens: 1e6,
        total_tokens: 2e6,
        reasoning_tokens: 0,
        cached_input_tokens: 0,
      },
    });
    expect(costPerQuery([r], "claude-opus-5")).toBeCloseTo(30, 6);
    expect(costPerQuery([r, r], "claude-opus-5")).toBeCloseTo(30, 6);
  });

  it("prices the OpenAI comparison leg (verified 2026-08-07)", () => {
    // 1M input + 1M output on gpt-5.6-luna = $0.20 + $1.20 over 1 run.
    const r = run({
      usage: {
        input_tokens: 1e6,
        output_tokens: 1e6,
        total_tokens: 2e6,
        reasoning_tokens: 0,
        cached_input_tokens: 0,
      },
    });
    expect(costPerQuery([r], "gpt-5.6-luna")).toBeCloseTo(1.4, 6);
  });

  it("returns null for models absent from the pricing map", () => {
    expect(PRICING["some-unpriced-model"]).toBeUndefined();
    expect(costPerQuery([run()], "some-unpriced-model")).toBeNull();
  });

  it("excludes errored runs from every summary column", () => {
    const s = summarise("claude-opus-5", [
      run({ case_id: "L01", run_index: 0, passed: true }),
      run({ case_id: "L01", run_index: 1, passed: true }),
      run({ case_id: "L02", run_index: 0, error: "boom", passed: false }),
    ]);
    expect(s.errored_runs).toBe(1);
    expect(s.graded_runs).toBe(2);
    expect(s.pass_at_1).toEqual({ passed: 1, n: 1 });
    expect(s.pass_pow_k).toEqual({ passed: 1, n: 1 });
  });
});
