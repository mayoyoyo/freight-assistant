/**
 * Phase 4C — component eval #2: MC-resolution accuracy.
 *
 * Gold (`resolution-gold.jsonl`) covers ALL 55 calls plus a 20-email sample.
 * For every call the true carrier was derived by decoding the MC out of the
 * VERBATIM transcript by hand (self-corrections resolved to the last value
 * stated) and looking it up in carrier_profiles.json; where the spoken MC
 * matches no carrier, the spoken company name is the fallback. For emails the
 * rule is MC-in-body first, sender address second.
 *
 * The scored quantity is CARRIER IDENTITY (`resolvedCarrierId`), not the MC
 * string. Two records make that distinction load-bearing:
 *   - call_038 / CE0145 / CE0045 resolve to carriers whose own MC is null, so a
 *     null `resolvedCarrierMc` means "carrier found, no MC on file" — scoring
 *     the MC would call a correct resolution a failure.
 *   - call_046 states MC 665432, which matches nothing; the correct carrier is
 *     663210 via company name, so extraction and resolution must disagree here.
 *     That is why the two evals are scored separately.
 *
 * `resolutionMethod` is NOT scored: when an email carries both an MC and a
 * known sender address, mc_exact and email_exact are both legitimate routes to
 * the same carrier. It is reported as a distribution instead.
 *
 * Usage: pnpm exec tsx evals/components/resolution-eval.ts
 */
import { readFileSync } from "node:fs";
import { formatInterval } from "./stats";

export const RESOLUTION_GOLD_PATH = "evals/components/resolution-gold.jsonl";
const INQUIRIES_PATH = "data/derived/inquiries.ndjson";

/**
 * The hard set: the four records the Phase 2b write-up singled out as
 * eval-critical, plus every call the pipeline itself flagged
 * `mcLowConfidence`. Membership is computed, not typed out, so it tracks the
 * pipeline if the confidence heuristic changes.
 */
export const NAMED_HARD_CASES = [
  "call_006_rate_negotiation",
  "call_036_compliance_check",
  "call_038_compliance_check",
  "call_046_load_details",
] as const;

export type ResolutionGold = {
  id: string;
  sourceType: "email" | "call";
  gold: { carrierId: number | null; carrierMc: string | null };
  basis: string;
};

export type InquiryRow = {
  id: string;
  sourceType: "email" | "call";
  resolvedCarrierId: number | null;
  resolvedCarrierMc: string | null;
  resolutionMethod: string | null;
  mcLowConfidence: boolean;
};

export function loadResolutionGold(): ResolutionGold[] {
  return readFileSync(RESOLUTION_GOLD_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as ResolutionGold);
}

export function loadInquiries(): Map<string, InquiryRow> {
  const rows = readFileSync(INQUIRIES_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as InquiryRow);
  return new Map(rows.map((r) => [r.id, r]));
}

export type ResolutionMiss = {
  id: string;
  goldCarrierId: number | null;
  goldCarrierMc: string | null;
  gotCarrierId: number | null;
  gotCarrierMc: string | null;
  method: string | null;
  basis: string;
};

export type Slice = { label: string; correct: number; total: number };

export type ResolutionEvalResult = {
  slices: Slice[];
  hardCaseIds: string[];
  misses: ResolutionMiss[];
  methodCounts: [string, number][];
  /** Cases where the resolved carrier is right but its MC differs from the stated one. */
  mcSalvaged: string[];
};

/** Injectable for the same meta-testing reason as `runExtractionEval`. */
export function runResolutionEval(
  gold: ResolutionGold[] = loadResolutionGold(),
  inquiries: Map<string, InquiryRow> = loadInquiries(),
): ResolutionEvalResult {
  const hardCaseIds = [
    ...new Set([
      ...NAMED_HARD_CASES,
      ...[...inquiries.values()]
        .filter((r) => r.mcLowConfidence)
        .map((r) => r.id),
    ]),
  ]
    .filter((id) => gold.some((g) => g.id === id))
    .sort();

  const counters = new Map<string, Slice>();
  const bump = (label: string, ok: boolean) => {
    const s = counters.get(label) ?? { label, correct: 0, total: 0 };
    s.total++;
    if (ok) s.correct++;
    counters.set(label, s);
  };

  const misses: ResolutionMiss[] = [];
  const methods = new Map<string, number>();
  const mcSalvaged: string[] = [];

  for (const g of gold) {
    const row = inquiries.get(g.id);
    if (row === undefined) {
      throw new Error(
        `${g.id} is in the resolution gold but not in ${INQUIRIES_PATH}`,
      );
    }
    const ok = row.resolvedCarrierId === g.gold.carrierId;

    bump("overall", ok);
    bump(g.sourceType === "call" ? "calls (all 55)" : "emails (20 sample)", ok);
    if (hardCaseIds.includes(g.id)) bump("hard set", ok);

    const m = row.resolutionMethod ?? "unresolved";
    methods.set(m, (methods.get(m) ?? 0) + 1);

    if (!ok) {
      misses.push({
        id: g.id,
        goldCarrierId: g.gold.carrierId,
        goldCarrierMc: g.gold.carrierMc,
        gotCarrierId: row.resolvedCarrierId,
        gotCarrierMc: row.resolvedCarrierMc,
        method: row.resolutionMethod,
        basis: g.basis,
      });
    } else if (row.resolutionMethod === "name_fuzzy") {
      mcSalvaged.push(g.id);
    }
  }

  const order = ["overall", "calls (all 55)", "emails (20 sample)", "hard set"];
  const slices = order
    .map((l) => counters.get(l))
    .filter((s): s is Slice => s !== undefined);

  return {
    slices,
    hardCaseIds,
    misses,
    methodCounts: [...methods.entries()].sort((a, b) => b[1] - a[1]),
    mcSalvaged,
  };
}

const pct = (c: number, t: number) =>
  t === 0 ? "n/a" : `${((100 * c) / t).toFixed(1)}%`;

export function formatResolutionMarkdown(r: ResolutionEvalResult): string {
  const lines: string[] = [];
  lines.push(
    "### MC-resolution accuracy vs hand-derived gold (carrier identity)",
    "",
    "| Slice | Correct | Total | Accuracy | Wilson 95% CI |",
    "| --- | ---: | ---: | ---: | --- |",
  );
  for (const s of r.slices) {
    lines.push(
      `| ${s.label} | ${s.correct} | ${s.total} | ${pct(s.correct, s.total)} | ${formatInterval(s.correct, s.total)} |`,
    );
  }
  lines.push(
    "",
    `Hard set (${r.hardCaseIds.length}) = the 4 eval-critical records + every \`mcLowConfidence\` call: ${r.hardCaseIds.join(", ")}`,
    "",
    `Resolution methods used across the graded set: ${r.methodCounts.map(([k, n]) => `${k} ${n}`).join(", ")}`,
    "",
  );
  if (r.mcSalvaged.length > 0) {
    lines.push(
      `Recovered by company name after the MC route failed: ${r.mcSalvaged.join(", ")}`,
      "",
    );
  }
  if (r.misses.length === 0) {
    lines.push("No resolution misses.", "");
  } else {
    lines.push(
      `Misses (${r.misses.length}):`,
      "",
      "| id | gold carrier | got carrier | method | why gold says so |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const m of r.misses) {
      lines.push(
        `| ${m.id} | #${m.goldCarrierId} (${m.goldCarrierMc ?? "no MC"}) | #${m.gotCarrierId ?? "none"} (${m.gotCarrierMc ?? "no MC"}) | ${m.method ?? "unresolved"} | ${m.basis} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

if (process.argv[1]?.endsWith("resolution-eval.ts")) {
  console.log(formatResolutionMarkdown(runResolutionEval()));
}
