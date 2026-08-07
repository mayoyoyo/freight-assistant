/**
 * Shared contract for the Phase 4B eval harness.
 *
 * Two files move through the harness:
 *   evals/results/runs-<runId>.jsonl    one line per (case, run_index)
 *   evals/report.md                     deterministic render of the above
 *
 * Generation and grading are separate passes over the SAME file so a re-grade
 * (new grader, new judge version) costs nothing: `pnpm eval --grade-only <f>`.
 */

/** A hand-labeled eval case. `gold` is per-bucket and deliberately untyped. */
export type EvalCase = {
  id: string;
  bucket: "factual_lookup" | "set_retrieval" | "email_draft" | "abstention";
  query: string;
  gold: Record<string, unknown>;
  required_tools: { name: string; args_subset: Record<string, unknown> }[];
  required_source_ids: string[];
  compliance_must_surface: string[];
  origin: "ground_truth" | "regression";
  original_failure?: string;
  notes: string;
};

/** What one tool call did. `ids` is what makes groundedness checkable. */
export type ToolCallRecord = {
  name: string;
  args: Record<string, unknown>;
  /** Rows returned, per `countRows` in src/lib/log.ts. */
  rows: number;
  /** Every citable id present anywhere in the tool result. */
  ids: string[];
  /** Every dollar-denominated figure present anywhere in the tool result. */
  figures: number[];
  ms: number;
  /**
   * The raw tool result. Kept verbatim (not just the derived ids/figures)
   * because the judge has to see what the agent actually retrieved in order to
   * rule on "no invented commitments", and because the 3-step failure
   * localizer's step 2 — "does the retrieved record actually contain the
   * answer?" — is unanswerable from a row count.
   */
  result: unknown;
};

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  reasoning_tokens: number;
  cached_input_tokens: number;
};

/** Every grader and every judge check returns exactly this. */
export type GraderResult = {
  passed: boolean;
  reason: string;
};

/** One (case, run_index) pair. Written by run.ts, consumed by report.ts. */
export type RunRecord = {
  run_id: string;
  case_id: string;
  bucket: EvalCase["bucket"];
  origin: EvalCase["origin"];
  run_index: number;
  prompt_version: string;
  judge_version: string | null;
  model: string;
  query: string;
  text: string;
  tools: ToolCallRecord[];
  steps: number;
  latency_ms: number;
  usage: Usage;
  error: string | null;
  /** Grader name -> verdict. Empty until the grading pass runs. */
  verdicts: Record<string, GraderResult>;
  /** AND over every non-N/A verdict. `null` before grading. */
  passed: boolean | null;
};

/**
 * Prompt version identifier written into every run record. Bump when
 * SYSTEM_PROMPT changes so before/after rows in the report are attributable.
 */
export const PROMPT_VERSION = "sp-v1";
