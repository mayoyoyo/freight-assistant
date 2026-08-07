import type { EvalCase, RunRecord, ToolCallRecord, Usage } from "../lib/types";

/**
 * Meta-test fixtures — three per code grader (design doc §"Meta-test the
 * evaluators": clean-pass, corrupted-fail, out-of-scope-pass).
 *
 * Every object here is SYNTHETIC and hand-written. Nothing is replayed from a
 * live run, nothing is read from `cases.jsonl`, and no fixture needs an API key
 * or a DATABASE_URL — a grader that only passes against a recorded run is a
 * grader nobody can debug at 2am.
 *
 * The case ids are real (L04, L07, S01, D01, …) because two graders key off
 * them (`gold-specs.ts`, and the neutral/gate tables in `set-f1.ts` and
 * `compliance-surfacing.ts`); the gold payloads below are hand-written subsets
 * of those cases, not copies of the file.
 */

const NO_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  reasoning_tokens: 0,
  cached_input_tokens: 0,
};

export function makeCase(
  partial: Partial<EvalCase> & Pick<EvalCase, "id" | "bucket">,
): EvalCase {
  return {
    query: "synthetic fixture query",
    gold: {},
    required_tools: [],
    required_source_ids: [],
    compliance_must_surface: [],
    origin: "ground_truth",
    notes: "synthetic meta-test fixture",
    ...partial,
  };
}

/**
 * `result` (the verbatim tool payload) defaults to null: no code grader reads
 * it — they read `ids`, `figures` and `args` — so a fixture only supplies a
 * realistic payload where it documents what the run actually retrieved.
 */
export function makeTool(
  partial: Partial<ToolCallRecord> & Pick<ToolCallRecord, "name">,
): ToolCallRecord {
  return {
    args: {},
    rows: 0,
    ids: [],
    figures: [],
    ms: 1,
    result: null,
    ...partial,
  };
}

export function makeRun(
  c: EvalCase,
  partial: Partial<RunRecord> = {},
): RunRecord {
  return {
    run_id: "fixture",
    case_id: c.id,
    bucket: c.bucket,
    origin: c.origin,
    run_index: 0,
    prompt_version: "sp-v1",
    judge_version: null,
    model: "fixture-model",
    query: c.query,
    text: "",
    tools: [],
    steps: 1,
    latency_ms: 0,
    usage: NO_USAGE,
    error: null,
    verdicts: {},
    passed: null,
    ...partial,
  };
}

export type GraderFixture = {
  /** What this fixture pins, in one line. */
  about: string;
  case: EvalCase;
  run: RunRecord;
  /** corrupted-fail only: the reason must name the specific defect. */
  expectReason?: RegExp;
};

export type GraderFixtureSet = {
  cleanPass: GraderFixture;
  corruptedFail: GraderFixture;
  outOfScopePass: GraderFixture;
};

// ---------------------------------------------------------------------------
// Shared case shells (hand-written subsets of the real cases)
// ---------------------------------------------------------------------------

const caseL04 = makeCase({
  id: "L04",
  bucket: "factual_lookup",
  query: "Is MC 712843 good to book right now?",
  gold: {
    bookable: false,
    company_name: "Blue Ridge Transport LLC",
    authority_status: "ACTIVE",
    insurance_expiry: "2026-05-15",
  },
  required_tools: [
    { name: "carrier_history", args_subset: { mc_number: "712843" } },
  ],
  compliance_must_surface: ["insurance expired 2026-05-15 (before 2026-05-25)"],
});

const caseL07 = makeCase({
  id: "L07",
  bucket: "factual_lookup",
  query: "Load 29372343 is posted at $275. Are we above or below market?",
  gold: {
    verdict: "above",
    load_rate_per_mile: 5.09,
    offered_rate_usd: 275,
    market_avg_rate_per_mile_4wk: 3.925,
  },
  required_tools: [{ name: "get_load", args_subset: { load_id: "29372343" } }],
  origin: "regression",
});

const caseS01 = makeCase({
  id: "S01",
  bucket: "set_retrieval",
  query:
    "Which carriers have confirmed availability for PA-NJ Box Truck loads this week?",
  gold: {
    dated_inquiry_ids: ["CE0044"],
    undated_call_ids: [
      "call_017_availability_check",
      "call_024_availability_check",
    ],
    must_state_calls_are_undated: true,
  },
  required_tools: [
    {
      name: "search_inquiries",
      args_subset: { origin_state: "PA", dest_state: "NJ" },
    },
  ],
  origin: "regression",
});

const caseD01 = makeCase({
  id: "D01",
  bucket: "email_draft",
  query: "Draft a reply to Reed Barlus about load 29372343 at the posted rate.",
  gold: {
    recipient_name: "Reed Barlus",
    load_ref_required: "29372343",
    allowed_dollar_figures: [275],
  },
  required_tools: [{ name: "get_load", args_subset: { load_id: "29372343" } }],
});

const caseD04 = makeCase({
  id: "D04",
  bucket: "email_draft",
  query: "Draft a note to Blue Ridge Transport booking them on load 29372421.",
  gold: {
    load_ref_required: "29372421",
    allowed_dollar_figures: [220],
  },
  required_tools: [
    { name: "carrier_history", args_subset: { mc_number: "712843" } },
  ],
  compliance_must_surface: ["insurance expired 2026-05-15 (before 2026-05-25)"],
});

const caseA01 = makeCase({
  id: "A01",
  bucket: "abstention",
  query: "What's the story on load 29999999? Shipper's asking.",
  gold: {
    must_refuse: true,
    expected_phrase_class: "not_in_data",
    must_not_invent: ["any lane, rate, date or status for this load"],
  },
  required_tools: [{ name: "get_load", args_subset: { load_id: "29999999" } }],
});

const caseA04 = makeCase({
  id: "A04",
  bucket: "abstention",
  query: "What's the compliance status on Northeast Transport LLC?",
  gold: {
    must_refuse: true,
    expected_phrase_class: "no_such_carrier",
    must_not_invent: [
      "an authority status or insurance date for a carrier named Northeast Transport LLC",
    ],
  },
  required_tools: [{ name: "search_inquiries", args_subset: {} }],
});

/** A case that requires no tools at all — the out-of-scope shell. */
const caseNoRequirements = makeCase({
  id: "X99",
  bucket: "factual_lookup",
  query: "synthetic case with no required tools",
});

// ---------------------------------------------------------------------------
// Reusable tool-call records
// ---------------------------------------------------------------------------

const carrierHistory712843 = makeTool({
  name: "carrier_history",
  args: { mc_number: "712843" },
  rows: 1,
  ids: ["712843", "CE0027"],
  figures: [220],
  ms: 40,
  result: {
    mc_number: "712843",
    company_name: "Blue Ridge Transport LLC",
    authority_status: "ACTIVE",
    insurance_expiry: "2026-05-15",
    compliance: {
      reference_date: "2026-05-25",
      insurance_expired: true,
      authority_ok: true,
      clear: false,
      concerns: ["insurance expired 2026-05-15 (before 2026-05-25)"],
    },
  },
});

const getLoad29372343 = makeTool({
  name: "get_load",
  args: { load_id: "29372343" },
  rows: 1,
  ids: ["29372343"],
  figures: [275],
  ms: 22,
  result: {
    load_id: "29372343",
    origin_state: "PA",
    destination_state: "NJ",
    distance_miles: 54,
    equipment_type: "Box Truck",
    weight_lbs: null,
    pickup_date: "2026-05-21",
    offered_rate_usd: 275,
    status: "open",
  },
});

// ---------------------------------------------------------------------------
// The fixtures, keyed by grader name
// ---------------------------------------------------------------------------

export const GRADER_FIXTURES: Record<string, GraderFixtureSet> = {
  // -------------------------------------------------------------------------
  "required-tools": {
    cleanPass: {
      about:
        "carrier_history called with the required mc_number, plus an extra unrelated call",
      case: caseL04,
      run: makeRun(caseL04, {
        text: "Blue Ridge Transport LLC [MC 712843] — insurance expired 2026-05-15.",
        tools: [
          makeTool({ name: "search_inquiries", args: { query: "Blue Ridge" } }),
          carrierHistory712843,
        ],
      }),
    },
    corruptedFail: {
      about: "same run, one digit changed in the tool's mc_number argument",
      case: caseL04,
      run: makeRun(caseL04, {
        text: "Blue Ridge Transport LLC [MC 712843] — insurance expired 2026-05-15.",
        tools: [
          makeTool({ name: "search_inquiries", args: { query: "Blue Ridge" } }),
          makeTool({ ...carrierHistory712843, args: { mc_number: "712849" } }),
        ],
      }),
      // [\s\S] rather than the `s` (dotAll) flag: tsconfig pins target ES2017.
      expectReason: /carrier_history[\s\S]*712849/,
    },
    outOfScopePass: {
      about: "a case that declares no required_tools",
      case: caseNoRequirements,
      run: makeRun(caseNoRequirements, { text: "anything" }),
    },
  },

  // -------------------------------------------------------------------------
  groundedness: {
    cleanPass: {
      about:
        "all four citation forms resolve; a footnote [1] and a markdown link are correctly ignored",
      case: caseD01,
      run: makeRun(caseD01, {
        text: "Reed Barlus [CE0044] offered on load 29372343 [load 29372343]; MC is 68333 [MC 68333]. Also [call_017]. Footnote [1]. See the [rate sheet](https://example.com).",
        tools: [
          makeTool({
            name: "search_inquiries",
            args: {},
            rows: 3,
            ids: ["CE0044", "call_017_availability_check", "68333"],
          }),
          getLoad29372343,
        ],
      }),
    },
    corruptedFail: {
      about: "one citation swapped for an id no tool in this run returned",
      case: caseD01,
      run: makeRun(caseD01, {
        text: "Reed Barlus [CE0099] offered on load 29372343 [load 29372343]; MC is 68333 [MC 68333]. Also [call_017]. Footnote [1]. See the [rate sheet](https://example.com).",
        tools: [
          makeTool({
            name: "search_inquiries",
            args: {},
            rows: 3,
            ids: ["CE0044", "call_017_availability_check", "68333"],
          }),
          getLoad29372343,
        ],
      }),
      expectReason: /CE0099/,
    },
    outOfScopePass: {
      about:
        "an abstention answer that cites nothing — there is nothing to ground",
      case: caseA01,
      run: makeRun(caseA01, {
        text: "No such load — 29999999 is not in our data. I searched loads by exact id.",
        tools: [makeTool({ name: "get_load", args: { load_id: "29999999" } })],
      }),
    },
  },

  // -------------------------------------------------------------------------
  "exact-match": {
    cleanPass: {
      about:
        "L07 answers 'above market' with the $5.09/mi and $3.93/mi arithmetic",
      case: caseL07,
      run: makeRun(caseL07, {
        text: "Above market. Load 29372343 is posted at $275 over 54 miles — $5.09/mi against a 4-week PA-NJ Box Truck average of $3.93/mi [load 29372343].",
        tools: [getLoad29372343],
      }),
    },
    corruptedFail: {
      about:
        "the same answer with the verdict-flip headline restored (case notes: GRADER NOTE — a mid-answer self-correction still fails)",
      case: caseL07,
      run: makeRun(caseL07, {
        text: "Yes — meaningfully below market. Load 29372343 is posted at $275 over 54 miles — $5.09/mi against a 4-week PA-NJ Box Truck average of $3.93/mi, so it is actually above market [load 29372343].",
        tools: [getLoad29372343],
      }),
      expectReason: /below market/i,
    },
    outOfScopePass: {
      about: "a set_retrieval case — exact-match grades factual_lookup only",
      case: caseS01,
      run: makeRun(caseS01, { text: "CE0044 is available." }),
    },
  },

  // -------------------------------------------------------------------------
  "set-f1": {
    cleanPass: {
      about:
        "S01: the dated set {CE0044} exactly, plus both undated calls named and labelled undated",
      case: caseS01,
      run: makeRun(caseS01, {
        text: "One dated confirmation: CE0044 — Reed Barlus, 2026-05-18, MC 68333 [CE0044]. Two phone calls also offered: call_017 (MC 776491) and call_024 (MC 901234) — call records are undated, so no date filter reaches them.",
        tools: [
          makeTool({
            name: "search_inquiries",
            args: { origin_state: "PA", dest_state: "NJ" },
            rows: 3,
            ids: [
              "CE0044",
              "call_017_availability_check",
              "call_024_availability_check",
            ],
          }),
        ],
      }),
    },
    corruptedFail: {
      about: "the gold id CE0044 replaced by the neighbouring CE0045",
      case: caseS01,
      run: makeRun(caseS01, {
        text: "One dated confirmation: CE0045 — Reed Barlus, 2026-05-18, MC 68333 [CE0045]. Two phone calls also offered: call_017 (MC 776491) and call_024 (MC 901234) — call records are undated, so no date filter reaches them.",
        tools: [
          makeTool({
            name: "search_inquiries",
            args: { origin_state: "PA", dest_state: "NJ" },
            rows: 3,
            ids: [
              "CE0045",
              "call_017_availability_check",
              "call_024_availability_check",
            ],
          }),
        ],
      }),
      expectReason: /missing=\[CE0044\].*spurious=\[CE0045\]/,
    },
    outOfScopePass: {
      about: "a factual_lookup case — set-f1 grades set_retrieval only",
      case: caseL07,
      run: makeRun(caseL07, { text: "Above market, $5.09/mi." }),
    },
  },

  // -------------------------------------------------------------------------
  "dollar-figures-subset": {
    cleanPass: {
      about:
        "the draft quotes only the posted $275, which the load tool returned",
      case: caseD01,
      run: makeRun(caseD01, {
        text: "Reed — we can do the posted $275 on load 29372343. — Goodlane Dispatch",
        tools: [getLoad29372343],
      }),
    },
    corruptedFail: {
      about: "an invented $50 detention fee added to the same draft",
      case: caseD01,
      run: makeRun(caseD01, {
        text: "Reed — we can do the posted $275 on load 29372343, plus $50 detention after 2 hours. — Goodlane Dispatch",
        tools: [getLoad29372343],
      }),
      expectReason: /\$50/,
    },
    outOfScopePass: {
      about:
        "a factual_lookup case with no allowed_dollar_figures — derived arithmetic makes the subset property unsound there",
      case: caseL07,
      run: makeRun(caseL07, {
        text: "Above market: $275 over 54 miles is $5.09/mi.",
        tools: [getLoad29372343],
      }),
    },
  },

  // -------------------------------------------------------------------------
  "load-ref-present": {
    cleanPass: {
      about: "the draft names load 29372343",
      case: caseD01,
      run: makeRun(caseD01, {
        text: "Reed — we can do the posted $275 on load 29372343. — Goodlane Dispatch",
        tools: [getLoad29372343],
      }),
    },
    corruptedFail: {
      about: "the same draft with the load number replaced by 'that load'",
      case: caseD01,
      run: makeRun(caseD01, {
        text: "Reed — we can do the posted $275 on that load. — Goodlane Dispatch",
        tools: [getLoad29372343],
      }),
      expectReason: /29372343/,
    },
    outOfScopePass: {
      about: "an abstention case with no gold.load_ref_required",
      case: caseA01,
      run: makeRun(caseA01, {
        text: "No such load — 29999999 is not in our data.",
      }),
    },
  },

  // -------------------------------------------------------------------------
  "compliance-surfacing": {
    cleanPass: {
      about: "D04 surfaces insurance + expired + the 2026-05-15 expiry date",
      case: caseD04,
      run: makeRun(caseD04, {
        text: "Before I send this: Blue Ridge's insurance expired 2026-05-15, so I can't confirm them on 29372421 until a current certificate is on file.",
        tools: [carrierHistory712843],
      }),
    },
    corruptedFail: {
      about: "the same answer with the expiry DATE dropped — the vague version",
      case: caseD04,
      run: makeRun(caseD04, {
        text: "Before I send this: Blue Ridge's insurance has expired, so I can't confirm them on 29372421 until a current certificate is on file.",
        tools: [carrierHistory712843],
      }),
      expectReason: /2026-05-15/,
    },
    outOfScopePass: {
      about: "a draft case with an empty compliance_must_surface list",
      case: caseD01,
      run: makeRun(caseD01, {
        text: "Reed — we can do the posted $275 on load 29372343.",
        tools: [getLoad29372343],
      }),
    },
  },

  // -------------------------------------------------------------------------
  abstention: {
    cleanPass: {
      about:
        "A04 refuses, then volunteers the near-match explicitly labelled a different company (case notes say this PASSES)",
      case: caseA04,
      run: makeRun(caseA04, {
        text: "No carrier named Northeast Transport LLC is in our data. The closest match is Northeast Cargo LLC [MC 1123456] — a different company; confirm with the broker before I pull its compliance record.",
        tools: [
          makeTool({ name: "search_inquiries", args: {}, ids: ["1123456"] }),
        ],
      }),
    },
    corruptedFail: {
      about:
        "the near-match's status re-attributed to the non-existent Northeast Transport",
      case: caseA04,
      run: makeRun(caseA04, {
        text: "No carrier named Northeast Transport LLC is in our data. Northeast Transport LLC's authority is ACTIVE and its insurance is valid through 2027-02-28.",
        tools: [
          makeTool({ name: "search_inquiries", args: {}, ids: ["1123456"] }),
        ],
      }),
      expectReason: /Northeast TRANSPORT/i,
    },
    outOfScopePass: {
      about: "a draft case — abstention grades the abstention bucket only",
      case: caseD01,
      run: makeRun(caseD01, {
        text: "Reed — we can do the posted $275 on load 29372343.",
        tools: [getLoad29372343],
      }),
    },
  },
};
