/**
 * Phase 4C — single entry point for the pipeline component evals.
 *
 *   pnpm exec tsx evals/components/run.ts
 *
 * Runs the extraction eval and the resolution eval and prints one markdown
 * document, intended to be pasted into the Phase 4 report as-is.
 *
 * The two other component artefacts are static documents, not runnable checks,
 * and are linked rather than executed:
 *   - evals/components/fts-notes.md  (psql probes, re-run by hand)
 *   - evals/components/wer-check.md  (cross-track consistency + a human TODO)
 *
 * Structural assertions live in `assertInvariants` and are deliberately limited
 * to facts that are TRUE BY CONSTRUCTION of the committed gold files and the
 * committed pipeline output — sample composition, coverage, adjudication
 * completeness. Accuracy numbers are reported, never asserted: a green test
 * that pins "100%" would flip to red the day the pipeline legitimately changes,
 * which is the opposite of what an eval is for.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type ExtractionEvalResult,
  formatExtractionMarkdown,
  loadGold,
  runExtractionEval,
} from "./extraction-eval";
import {
  formatResolutionMarkdown,
  loadResolutionGold,
  type ResolutionEvalResult,
  runResolutionEval,
} from "./resolution-eval";

/** Records the Phase 2b write-up singled out as eval-critical. */
export const REQUIRED_EXTRACTION_IDS = [
  "call_006_rate_negotiation",
  "call_036_compliance_check",
  "call_046_load_details",
  "call_038_compliance_check",
  "CE0074",
] as const;

export const EXPECTED_CALL_COUNT = 55;

export type Invariant = { name: string; ok: boolean; detail: string };

export function assertInvariants(
  extraction: ExtractionEvalResult,
  resolution: ResolutionEvalResult,
): Invariant[] {
  const gold = loadGold();
  const resGold = loadResolutionGold();
  const ids = new Set(gold.map((g) => g.id));
  const resCalls = resGold.filter((g) => g.sourceType === "call");
  const resEmails = resGold.filter((g) => g.sourceType === "email");
  const missingRequired = REQUIRED_EXTRACTION_IDS.filter((id) => !ids.has(id));
  const missingFiles = [
    ...gold.map((g) => g.id),
    ...resGold.map((g) => g.id),
  ].filter((id) => !existsSync(join("data/derived/extractions", `${id}.json`)));
  const unadjudicated = extraction.disagreements.filter(
    (d) => d.verdict === "UNADJUDICATED",
  );
  /**
   * Every gold field that asserts a POSITIVE value must quote the raw text that
   * says so. `null`, and `availability: "unknown"`, are absence assertions —
   * there is by definition no quote for "the text never addresses this" — and
   * are justified in the record's `notes` instead.
   */
  const noEvidence = gold.filter((g) =>
    (Object.keys(g.gold) as (keyof typeof g.gold)[]).some(
      (f) =>
        g.gold[f] !== null &&
        !(f === "availability" && g.gold[f] === "unknown") &&
        g.evidence[f] === undefined,
    ),
  );

  return [
    {
      name: "extraction gold is the stratified 15 (8 emails / 7 calls)",
      ok:
        extraction.records === 15 &&
        extraction.emails === 8 &&
        extraction.calls === 7,
      detail: `${extraction.records} records = ${extraction.emails} emails + ${extraction.calls} calls`,
    },
    {
      name: "extraction gold contains every eval-critical record",
      ok: missingRequired.length === 0,
      detail:
        missingRequired.length === 0
          ? REQUIRED_EXTRACTION_IDS.join(", ")
          : `missing: ${missingRequired.join(", ")}`,
    },
    {
      name: "every positively-asserted gold field carries a raw-text quote",
      ok: noEvidence.length === 0,
      detail:
        noEvidence.length === 0
          ? "all positive assertions cite the source"
          : `unsourced: ${noEvidence.map((g) => g.id).join(", ")}`,
    },
    {
      name: "resolution gold covers all 55 calls + a 20-email sample",
      ok: resCalls.length === EXPECTED_CALL_COUNT && resEmails.length === 20,
      detail: `${resCalls.length} calls + ${resEmails.length} emails`,
    },
    {
      name: "every graded id has a cached extraction on disk",
      ok: missingFiles.length === 0,
      detail:
        missingFiles.length === 0
          ? "all present"
          : `missing: ${missingFiles.join(", ")}`,
    },
    {
      name: "every extraction disagreement has been adjudicated",
      ok: unadjudicated.length === 0,
      detail:
        unadjudicated.length === 0
          ? `${extraction.disagreements.length} disagreement(s), 0 unadjudicated`
          : `unadjudicated: ${unadjudicated.map((d) => `${d.id}:${d.field}`).join(", ")}`,
    },
    {
      name: "resolution hard set includes the 4 named records",
      ok: [
        "call_006_rate_negotiation",
        "call_036_compliance_check",
        "call_038_compliance_check",
        "call_046_load_details",
      ].every((id) => resolution.hardCaseIds.includes(id)),
      detail: `${resolution.hardCaseIds.length} records in the hard set`,
    },
  ];
}

export function buildReport(): { markdown: string; ok: boolean } {
  const extraction = runExtractionEval();
  const resolution = runResolutionEval();
  const invariants = assertInvariants(extraction, resolution);

  const pct = (c: number, t: number) =>
    t === 0 ? "n/a" : `${((100 * c) / t).toFixed(1)}%`;

  const summary = [
    "## Phase 4C — pipeline component evals",
    "",
    "| Component | Metric | Result |",
    "| --- | --- | --- |",
    `| Extraction | per-field accuracy vs hand gold (n=${extraction.records}) | ${pct(extraction.overall.correct, extraction.overall.total)} (${extraction.overall.correct}/${extraction.overall.total} fields) |`,
    `| Extraction | records with all 5 fields correct | ${pct(extraction.recordExact.correct, extraction.recordExact.total)} (${extraction.recordExact.correct}/${extraction.recordExact.total}) |`,
    ...resolution.slices.map(
      (s) =>
        `| Resolution | carrier identity — ${s.label} | ${pct(s.correct, s.total)} (${s.correct}/${s.total}) |`,
    ),
    "| FTS numerics | calls unfindable by FTS on their own MC | 38/55 — see `fts-notes.md` |",
    "| Transcription | calls with a non-numeric cross-track divergence | 1/55 — see `wer-check.md` (substitute for WER, not WER) |",
    "",
  ].join("\n");

  const checks = [
    "### Structural checks",
    "",
    ...invariants.map(
      (i) => `- ${i.ok ? "PASS" : "FAIL"} — ${i.name}: ${i.detail}`,
    ),
    "",
  ].join("\n");

  return {
    markdown: [
      summary,
      checks,
      formatExtractionMarkdown(extraction),
      formatResolutionMarkdown(resolution),
    ].join("\n"),
    ok: invariants.every((i) => i.ok),
  };
}

if (process.argv[1]?.endsWith("run.ts")) {
  const { markdown, ok } = buildReport();
  console.log(markdown);
  if (!ok) process.exitCode = 1;
}
