import { z } from "zod";

/** Trimmed string, or null for empty/absent values. Non-strings stay null. */
export const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

/** Finite number from a native number or a numeric string; null otherwise. */
export const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = str(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Native boolean or null — never coerces strings/numbers. */
export const bool = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : null;

/** Required finite number; throws with context instead of silently defaulting. */
export const reqNum = (v: unknown, context: string): number => {
  const n = num(v);
  if (n === null) {
    throw new Error(
      `Invalid required numeric value in ${context}: ${JSON.stringify(v)}`,
    );
  }
  return n;
};

/**
 * One line of data/derived/inquiries.ndjson — the ingestion pipeline's output
 * contract. Strict: unknown keys are rejected so a stated/extracted field
 * crossover in the pipeline fails the seed instead of landing in the DB.
 */
export const derivedInquirySchema = z
  .object({
    id: z.string().min(1),
    sourceType: z.enum(["email", "call"]),
    occurredAt: z.string().nullable(),
    fromName: z.string().nullable(),
    fromEmail: z.string().nullable(),
    subject: z.string().nullable(),
    rawText: z.string().min(1),
    statedMcNumber: z.string().nullable(),
    statedLoadReference: z.string().nullable(),
    statedEquipment: z.string().nullable(),
    statedIntent: z.string().nullable(),
    statedRateQuotedUsd: z.number().nullable(),
    extractedMcNumber: z.string().nullable(),
    extractedLoadReference: z.string().nullable(),
    extractedEquipment: z.string().nullable(),
    extractedIntent: z.string().nullable(),
    extractedRateUsd: z.number().nullable(),
    extractedAvailability: z.enum([
      "available",
      "unavailable",
      "conditional",
      "unknown",
    ]),
    extractedExtras: z.record(z.string(), z.unknown()).nullable(),
    resolvedCarrierId: z.number().int().nullable(),
    resolvedCarrierMc: z.string().nullable(),
    resolutionMethod: z.string().nullable(),
    discrepancyFlags: z.array(z.string()),
    mcLowConfidence: z.boolean(),
  })
  .strict();

export type DerivedInquiry = z.infer<typeof derivedInquirySchema>;

/**
 * The derived file is only authoritative if it covers every raw source exactly
 * once: all email IDs and all call stems, no extras, no duplicates.
 */
export function assertDerivedCoverage(
  rows: DerivedInquiry[],
  expectedEmailIds: string[],
  expectedCallIds: string[],
): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id))
      throw new Error(`Duplicate inquiry id in derived file: ${row.id}`);
    seen.add(row.id);
  }
  const expected = new Set([...expectedEmailIds, ...expectedCallIds]);
  const missing = [...expected].filter((id) => !seen.has(id));
  const extra = [...seen].filter((id) => !expected.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Derived inquiries file does not match raw sources. Missing: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""} (${missing.length}); unexpected: ${extra.slice(0, 5).join(", ")}${extra.length > 5 ? "…" : ""} (${extra.length}). Re-run the ingestion pipeline.`,
    );
  }
}
