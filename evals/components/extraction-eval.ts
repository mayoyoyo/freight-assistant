/**
 * Phase 4C — component eval #1: extraction accuracy vs hand-labeled gold.
 *
 * Gold (`extraction-gold.jsonl`) was written by reading the RAW source only —
 * email body/subject, or BOTH transcript tracks for a call, with the verbatim
 * track authoritative for every number — and was committed BEFORE the
 * pipeline's own output for those records was opened. That ordering is the
 * whole point: a gold set built by eyeballing model output measures nothing.
 *
 * Scored fields are the five the downstream agent actually depends on:
 * mc_number, load_reference, rate_usd, equipment, availability. `intent`,
 * `questions`, `notes` are excluded — they have no single defensible gold.
 *
 * Usage: pnpm exec tsx evals/components/extraction-eval.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeMc } from "../../scripts/resolve-helpers";
import { formatInterval } from "./stats";

export const GOLD_PATH = "evals/components/extraction-gold.jsonl";
const EXTRACTIONS_DIR = "data/derived/extractions";

export const SCORED_FIELDS = [
  "mc_number",
  "load_reference",
  "rate_usd",
  "equipment",
  "availability",
] as const;

export type ScoredField = (typeof SCORED_FIELDS)[number];

export type GoldFields = {
  mc_number: string | null;
  load_reference: string | null;
  rate_usd: number | null;
  equipment: string | null;
  availability: string;
};

export type GoldRecord = {
  id: string;
  sourceType: "email" | "call";
  stratum: string;
  gold: GoldFields;
  evidence: Record<string, string>;
  notes?: string;
};

type CachedExtraction = {
  id: string;
  extraction: Record<string, unknown>;
};

export function loadGold(): GoldRecord[] {
  return readFileSync(GOLD_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as GoldRecord);
}

export function loadExtraction(id: string): GoldFields {
  const path = join(EXTRACTIONS_DIR, `${id}.json`);
  const x = (JSON.parse(readFileSync(path, "utf8")) as CachedExtraction)
    .extraction;
  return {
    mc_number: (x.mc_number as string | null) ?? null,
    load_reference: (x.load_reference as string | null) ?? null,
    rate_usd: (x.rate_usd as number | null) ?? null,
    equipment: (x.equipment as string | null) ?? null,
    availability: String(x.availability ?? "unknown"),
  };
}

/**
 * Field equality. MC numbers and load references are compared as digit strings
 * so "MC 876543" / "876543" / "45-6012" vs "456012" never register as a miss —
 * formatting is the resolver's problem, not the extractor's.
 */
export function fieldsEqual(
  field: ScoredField,
  gold: unknown,
  got: unknown,
): boolean {
  if (field === "mc_number" || field === "load_reference") {
    return (
      normalizeMc(gold as string | null) === normalizeMc(got as string | null)
    );
  }
  return gold === got;
}

export type Disagreement = {
  id: string;
  sourceType: "email" | "call";
  field: ScoredField;
  gold: unknown;
  extracted: unknown;
  /** Adjudication written after inspecting both sides — see VERDICTS. */
  verdict: string;
};

/**
 * Every disagreement found on the first comparison run, adjudicated by
 * re-reading the raw source a second time. Keyed `id:field`.
 *
 * Where the verdict is "gold wrong" the gold file was corrected and the entry
 * is kept here as the audit trail — a gold set that silently rewrites itself is
 * indistinguishable from no gold set at all.
 */
export const VERDICTS: Record<string, string> = {};

export type FieldStat = { field: ScoredField; correct: number; total: number };

export type ExtractionEvalResult = {
  records: number;
  emails: number;
  calls: number;
  perField: FieldStat[];
  overall: { correct: number; total: number };
  /** Records where all five fields matched — the unit a reader actually cares about. */
  recordExact: { correct: number; total: number };
  disagreements: Disagreement[];
};

/**
 * `gold` and `load` are injectable so the comparator can be meta-tested against
 * deliberately corrupted extractions (see extraction-eval.test.ts). An eval
 * harness that has never been shown to fail is not evidence of anything.
 */
export function runExtractionEval(
  gold: GoldRecord[] = loadGold(),
  load: (id: string) => GoldFields = loadExtraction,
): ExtractionEvalResult {
  const stats = new Map<ScoredField, FieldStat>(
    SCORED_FIELDS.map((f) => [f, { field: f, correct: 0, total: 0 }]),
  );
  const disagreements: Disagreement[] = [];
  let recordExact = 0;

  for (const rec of gold) {
    const got = load(rec.id);
    let allOk = true;
    for (const field of SCORED_FIELDS) {
      const stat = stats.get(field);
      if (stat === undefined) continue;
      stat.total++;
      if (fieldsEqual(field, rec.gold[field], got[field])) {
        stat.correct++;
      } else {
        allOk = false;
        disagreements.push({
          id: rec.id,
          sourceType: rec.sourceType,
          field,
          gold: rec.gold[field],
          extracted: got[field],
          verdict: VERDICTS[`${rec.id}:${field}`] ?? "UNADJUDICATED",
        });
      }
    }
    if (allOk) recordExact++;
  }

  const perField = [...stats.values()];
  return {
    records: gold.length,
    emails: gold.filter((g) => g.sourceType === "email").length,
    calls: gold.filter((g) => g.sourceType === "call").length,
    perField,
    overall: {
      correct: perField.reduce((a, s) => a + s.correct, 0),
      total: perField.reduce((a, s) => a + s.total, 0),
    },
    recordExact: { correct: recordExact, total: gold.length },
    disagreements,
  };
}

const pct = (c: number, t: number) =>
  t === 0 ? "n/a" : `${((100 * c) / t).toFixed(1)}%`;

const show = (v: unknown) => (v === null ? "`null`" : `\`${String(v)}\``);

export function formatExtractionMarkdown(r: ExtractionEvalResult): string {
  const lines: string[] = [];
  lines.push(
    `### Extraction accuracy vs hand-labeled gold (n=${r.records}: ${r.emails} emails, ${r.calls} calls)`,
    "",
    "| Field | Correct | Total | Accuracy |",
    "| --- | ---: | ---: | ---: |",
  );
  for (const s of r.perField) {
    lines.push(
      `| ${s.field} | ${s.correct} | ${s.total} | ${pct(s.correct, s.total)} |`,
    );
  }
  lines.push(
    `| **all fields** | **${r.overall.correct}** | **${r.overall.total}** | **${pct(r.overall.correct, r.overall.total)}** |`,
    "",
    `All-five-fields-correct per record: ${r.recordExact.correct}/${r.recordExact.total}, Wilson 95% CI ${formatInterval(r.recordExact.correct, r.recordExact.total)}.`,
    "",
    `The field-level CI ${formatInterval(r.overall.correct, r.overall.total)} is printed for completeness but is optimistic: the ${r.overall.total} field decisions are clustered inside ${r.records} records, not independent draws. The record-level interval is the one to quote.`,
    "",
  );

  if (r.disagreements.length === 0) {
    lines.push("No disagreements: extraction matched gold on every field.", "");
  } else {
    lines.push(
      `Disagreements (${r.disagreements.length}):`,
      "",
      "| id | field | gold | extracted | verdict |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const d of r.disagreements) {
      lines.push(
        `| ${d.id} | ${d.field} | ${show(d.gold)} | ${show(d.extracted)} | ${d.verdict} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

if (process.argv[1]?.endsWith("extraction-eval.ts")) {
  console.log(formatExtractionMarkdown(runExtractionEval()));
}
