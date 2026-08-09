/**
 * Failure taxonomy + the 3-step failure localizer.
 *
 * The mode names are NOT invented here — they come from the axial coding in
 * `evals/error-analysis/failure-modes.md`, which was done before the case set
 * was authored (design doc: "error analysis comes BEFORE final case authoring").
 * Two modes are added for failure shapes the 40 open-coding traces never
 * produced but the graders can now detect; both are marked as such.
 *
 * `fix` and `expected_movement` are design knowledge, not measurements. They are
 * static prose and are labeled as predictions in the report — the whole point of
 * a baseline is that the next phase gets to check them.
 */
import type { EvalCase, RunRecord } from "./types";

export type ModeId =
  | "equipment_blind"
  | "lane_join_blind"
  | "asr_name_echo"
  | "phantom_total"
  | "verdict_flip"
  | "unreachable_carrier"
  | "ungrounded_citation"
  | "invented_content"
  | "compliance_miss"
  | "abstention_break"
  | "tool_omission"
  | "unclassified";

export type Mode = {
  id: ModeId;
  name: string;
  definition: string;
  /** Cost of this failure reaching a broker. Ranking input, not a measurement. */
  impact: "critical" | "high" | "medium";
  impact_why: string;
  fix: string;
  expected_movement: string;
  /** True when the mode was observed during pre-case error analysis. */
  observed_in_error_analysis: boolean;
};

export const MODES: Mode[] = [
  {
    id: "equipment_blind",
    name: "Equipment blind",
    definition:
      "`search_inquiries.equipment` filters the inquiry's `extracted_equipment` (NULL on 169/329 records), not the referenced load's equipment type — and the truncated result set is reported as complete.",
    impact: "critical",
    impact_why:
      "Produces confidently wrong capacity and rate answers ('$540' when the truth is $890). A broker acts on it directly.",
    fix: "Resolve `equipment` through the same `extracted_load_reference -> loads` subquery the lane filters already use, OR-ed with `extracted_equipment`.",
    expected_movement:
      "S01, S05, L05 move to pass; set-retrieval bucket pass@1 rises by ~3 cases.",
    observed_in_error_analysis: true,
  },
  {
    id: "lane_join_blind",
    name: "Lane-join blind",
    definition:
      "`origin_state`/`dest_state` reach only inquiries carrying an `extracted_load_reference`; every call has NULL, so lanes named in prose are invisible — and the empty result is reported as 'none exist'.",
    impact: "critical",
    impact_why:
      "Answers 'nobody' when two carriers are on record with live quotes. Silently loses capacity.",
    fix: "Same subquery fix as equipment_blind, plus a mandatory FTS fallback when a structured search returns zero rows.",
    expected_movement: "S06 moves to pass.",
    observed_in_error_analysis: true,
  },
  {
    id: "asr_name_echo",
    name: "ASR-name echo",
    definition:
      "Reports the transcript's mangled company name instead of the resolved carrier's name of record, though `resolved_carrier_mc` is in the same tool result.",
    impact: "medium",
    impact_why:
      "Wrong name on a real carrier — recoverable by a human, but it breaks search and looks careless in a customer-facing draft.",
    fix: "System-prompt rule: when `resolved_carrier_mc` is present, the carrier's name of record is the canonical answer; the transcript rendering may be offered as an aside.",
    expected_movement: "L06 moves to pass.",
    observed_in_error_analysis: true,
  },
  {
    id: "phantom_total",
    name: "Phantom total",
    definition:
      "States an aggregate count as if exhaustive when the 20-row cap and a missing filter mean the enumeration was partial.",
    impact: "high",
    impact_why:
      "A fabricated count is indistinguishable from a real one downstream; the P20 trace stated 41 against a true 94.",
    fix: "Tools already return `total_matches`; require the answer to cite it whenever it states a count, and to label any enumeration that hit `limit` as partial.",
    expected_movement: "S04 stabilises; phantom_total instances go to zero.",
    observed_in_error_analysis: true,
  },
  {
    id: "verdict_flip",
    name: "Verdict flip",
    definition:
      "The answer-first headline is emitted before the arithmetic finishes, then reversed mid-answer — the contradicting lead sentence stays in the output.",
    impact: "high",
    impact_why:
      "The headline is the deliverable for a broker skimming between calls; a contradicted lead is worse than no lead.",
    fix: "Prompt rule: compute before you lead. Any comparative verdict must be stated once, after the figures it rests on.",
    expected_movement: "L07 moves to pass.",
    observed_in_error_analysis: true,
  },
  {
    id: "unreachable_carrier",
    name: "Unreachable carrier",
    definition:
      "Carriers with `mc_number IS NULL` cannot be reached by the MC-keyed `carrier_history`, so a real compliance record is structurally invisible.",
    impact: "high",
    impact_why:
      "The agent refuses honestly, but a compliance record that exists is never surfaced — the answer is right for the wrong reason and will not improve on its own.",
    fix: "Add a name-keyed carrier lookup (or a `company_name` argument to `carrier_history`).",
    expected_movement:
      "A05 keeps passing but on the sharper ground ('on file with no authority status'); the case's grading tightens.",
    observed_in_error_analysis: true,
  },
  {
    id: "ungrounded_citation",
    name: "Ungrounded citation",
    definition:
      "A bracketed source id in the answer does not appear in any tool result from that run.",
    impact: "critical",
    impact_why:
      "A citation is the trust surface. A fabricated one is the single most damaging output shape in this domain.",
    fix: "Post-generation guard: strip or flag citations absent from the run's retrieved id set.",
    expected_movement: "Should already be zero; any instance is a red alert.",
    observed_in_error_analysis: false,
  },
  {
    id: "invented_content",
    name: "Invented commitment",
    definition:
      "A draft commits to a figure, appointment, term or fact that no tool result supports (code: dollar-figure subset; judge: no_invented_commitments).",
    impact: "critical",
    impact_why:
      "This is a promise to a carrier in Goodlane's name. It is the failure with legal and financial consequences.",
    fix: "Retrieval-grounded draft template plus the existing judge check as a release gate.",
    expected_movement: "Baseline dependent; target zero on the draft bucket.",
    observed_in_error_analysis: false,
  },
  {
    id: "compliance_miss",
    name: "Compliance miss",
    definition:
      "A blocking compliance fact (expired insurance, non-ACTIVE authority, unknown status) is not surfaced where the case requires it.",
    impact: "critical",
    impact_why:
      "Booking an out-of-authority or uninsured carrier is the highest-cost mistake a freight desk can make.",
    fix: "Already prompted; escalate to a hard code gate that refuses to emit a booking draft without a `carrier_history` call in the same run.",
    expected_movement: "D03, D04, L04 stay green; any regression is blocking.",
    observed_in_error_analysis: false,
  },
  {
    id: "abstention_break",
    name: "Abstention break",
    definition:
      "The agent answers a question whose subject is not in the corpus, or invents an attribute for an absent entity.",
    impact: "critical",
    impact_why:
      "Hallucinated freight facts are unrecoverable downstream — nobody re-checks a confident answer.",
    fix: "None needed at baseline (all 10 abstention probes passed in error analysis); monitor.",
    expected_movement: "Expected to stay at zero.",
    observed_in_error_analysis: false,
  },
  {
    id: "tool_omission",
    name: "Tool omission",
    definition:
      "A tool the case requires (by name + argument subset, order-insensitive) was never called.",
    impact: "medium",
    impact_why:
      "Sometimes the answer is right anyway; but an answer reached without the compliance lookup is right by luck.",
    fix: "Prompt reinforcement on the compliance gate; consider a required-tool precondition in the route.",
    expected_movement: "Diagnostic, not a headline metric.",
    observed_in_error_analysis: false,
  },
  {
    id: "unclassified",
    name: "Unclassified",
    definition: "A failure the rule table below does not recognise.",
    impact: "medium",
    impact_why:
      "A non-empty unclassified bucket means the taxonomy has drifted from reality and needs another coding pass.",
    fix: "Re-run open coding on these traces.",
    expected_movement: "n/a",
    observed_in_error_analysis: false,
  },
];

export const MODE_BY_ID = new Map(MODES.map((m) => [m.id, m]));

/**
 * Regression cases carry their originating mode from the axial coding table in
 * `failure-modes.md` §"What this hands to the case set". When such a case fails
 * on a retrieval grader, it is by construction that mode recurring.
 */
export const REGRESSION_ORIGIN: Record<string, ModeId> = {
  S01: "equipment_blind",
  L05: "equipment_blind",
  S05: "equipment_blind",
  S06: "lane_join_blind",
  L06: "asr_name_echo",
  S04: "phantom_total",
  L07: "verdict_flip",
  A05: "unreachable_carrier",
};

/**
 * Classify one failing run. Ordered most-specific-first: the first matching
 * rule wins, so a run that both cites a phantom id and misses a compliance fact
 * is filed under the citation failure (the more damaging shape).
 */
export function classifyFailure(c: EvalCase, r: RunRecord): ModeId {
  const failed = (name: string) => r.verdicts[name]?.passed === false;

  if (failed("groundedness")) return "ungrounded_citation";
  if (failed("abstention")) return "abstention_break";
  if (failed("compliance-surfacing")) return "compliance_miss";
  if (
    failed("dollar-figures-subset") ||
    failed("judge:no_invented_commitments") ||
    failed("judge:professional_tone") ||
    failed("load-ref-present")
  )
    return "invented_content";

  if (failed("exact-match") || failed("set-f1")) {
    const origin = REGRESSION_ORIGIN[c.id];
    if (origin) return origin;
    return "unclassified";
  }
  if (failed("required-tools")) return "tool_omission";
  return "unclassified";
}

// ---------------------------------------------------------------------------
// 3-step failure localizer (design doc §Pipeline component evals)
// ---------------------------------------------------------------------------

export type Localization = "RETRIEVAL" | "CORPUS" | "GENERATION" | "N/A";

export type LocalizerVerdict = {
  case_id: string;
  run_index: number;
  verdict: Localization;
  detail: string;
};

/** Gold ids the case says must be reachable. Empty for abstention cases. */
export function goldIds(c: EvalCase): string[] {
  const fromGold = new Set<string>();
  const push = (v: unknown) => {
    if (typeof v === "string" && v.length > 0) fromGold.add(v);
  };
  for (const [key, value] of Object.entries(c.gold)) {
    if (!/id|ids|mc|reference/i.test(key)) continue;
    if (Array.isArray(value)) for (const v of value) push(v);
    else push(value);
  }
  for (const id of c.required_source_ids) fromGold.add(id);
  return [...fromGold];
}

/** Loose membership: `[load 29372343]` and `29372343` are the same id. */
function retrieved(id: string, ids: Set<string>): boolean {
  const bare = id.replace(/^(load|MC)\s+/i, "").trim();
  if (ids.has(bare)) return true;
  // Call ids may be cited or golded by prefix (`call_017`).
  for (const got of ids)
    if (got.startsWith(bare) || bare.startsWith(got)) return true;
  return false;
}

/**
 * Step 1: was the gold record retrieved at all? no -> RETRIEVAL.
 * Step 2: does the retrieved payload actually contain the gold answer?
 *         no -> CORPUS (the trap-catcher: a "retrieval bug" that is really a
 *         data bug).
 * Step 3: otherwise the data was in hand and the answer is still wrong ->
 *         GENERATION.
 */
export function localize(c: EvalCase, r: RunRecord): LocalizerVerdict {
  if (c.bucket !== "set_retrieval" && c.bucket !== "factual_lookup")
    return {
      case_id: c.id,
      run_index: r.run_index,
      verdict: "N/A",
      detail: `localizer applies to retrieval buckets; ${c.id} is ${c.bucket}`,
    };

  const got = new Set(r.tools.flatMap((t) => t.ids));
  const wanted = goldIds(c);
  const missing = wanted.filter((id) => !retrieved(id, got));
  if (missing.length > 0)
    return {
      case_id: c.id,
      run_index: r.run_index,
      verdict: "RETRIEVAL",
      detail: `gold ids never returned by any tool call: ${missing.join(", ")}`,
    };

  // Step 2 — the gold answer values must be findable in what came back.
  const payload = JSON.stringify(r.tools.map((t) => t.result));
  const answerValues = Object.entries(c.gold)
    .filter(([k]) => !/id|ids|reference|expected_claim|notes/i.test(k))
    .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
    .filter(
      (v) => typeof v === "number" || (typeof v === "string" && v.length > 2),
    )
    .map(String);
  const absent = answerValues.filter((v) => !payload.includes(v));
  if (answerValues.length > 0 && absent.length === answerValues.length)
    return {
      case_id: c.id,
      run_index: r.run_index,
      verdict: "CORPUS",
      detail: `gold records retrieved but none of the gold values (${answerValues.join(", ")}) appear in the returned payload`,
    };

  return {
    case_id: c.id,
    run_index: r.run_index,
    verdict: "GENERATION",
    detail:
      "gold records were retrieved and contain the answer; the answer is still wrong",
  };
}
