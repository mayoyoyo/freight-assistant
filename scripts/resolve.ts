/**
 * Phase 2b: entity resolution + discrepancy flagging.
 *   data/raw/ + data/derived/transcripts*(/) + data/derived/extractions/
 *     → data/derived/inquiries.ndjson
 *
 * One line per inquiry, camelCase keys matching `derivedInquirySchema` in
 * seed-helpers.ts exactly (it is .strict() — an unknown key fails the seed).
 * Rows are validated here so a bad row fails in the script that produced it
 * rather than halfway through a database load.
 *
 * SPEC INVARIANT: the dataset's pre-labeled decoy fields are written to
 * stated* columns and compared against extraction output (in
 * resolve-helpers.ts) to produce discrepancy flags. They never become an
 * extracted* value.
 *
 * Usage: pnpm exec tsx scripts/resolve.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractionSchema } from "./extraction-schema";
import { mcLowConfidence } from "./mc-confidence";
import {
  callDiscrepancyFlags,
  type Extraction,
  emailDiscrepancyFlags,
  normalizeMc,
  resolveCarrier,
} from "./resolve-helpers";
import { type DerivedInquiry, derivedInquirySchema } from "./seed-helpers";
import { loadCalls, loadCarriers, loadEmails } from "./sources";

const EXTRACTIONS_DIR = "data/derived/extractions";
const OUT_PATH = "data/derived/inquiries.ndjson";

function readExtraction(id: string): Extraction {
  const path = join(EXTRACTIONS_DIR, `${id}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `Missing extraction for ${id} — run scripts/extract.ts first`,
    );
  }
  // Parsed, not type-asserted: the committed cache is an input like any other,
  // and a stale or hand-edited artifact must fail loudly here rather than
  // launder invalid enums into inquiries.ndjson (Codex review of PR #2,
  // finding 5).
  const parsed = extractionSchema.safeParse(
    (JSON.parse(readFileSync(path, "utf8")) as { extraction: unknown })
      .extraction,
  );
  if (!parsed.success) {
    throw new Error(`Invalid cached extraction for ${id}: ${parsed.error}`);
  }
  return parsed.data;
}

function main() {
  const carriers = loadCarriers();
  const rows: DerivedInquiry[] = [];

  for (const email of loadEmails()) {
    const x = readExtraction(email.email_id);
    const resolution = resolveCarrier(carriers, {
      mc: x.mc_number,
      email: email.from_email,
      companyName: x.company_name,
    });
    const flags = emailDiscrepancyFlags(email, x);
    if (resolution.ambiguous) flags.push("ambiguous_resolution");

    rows.push({
      id: email.email_id,
      sourceType: "email",
      occurredAt: email.timestamp,
      fromName: email.from_name,
      fromEmail: email.from_email,
      subject: email.subject,
      rawText: email.body,
      statedMcNumber: email.mc_number,
      statedLoadReference: email.load_reference,
      statedEquipment: email.equipment_mentioned,
      statedIntent: email.intent,
      statedRateQuotedUsd: email.rate_quoted_usd,
      extractedMcNumber: normalizeMc(x.mc_number),
      extractedLoadReference: normalizeMc(x.load_reference),
      extractedEquipment: x.equipment,
      extractedIntent: x.intent,
      extractedRateUsd: x.rate_usd,
      extractedAvailability: x.availability,
      extractedExtras: {
        questions: x.questions,
        notes: x.notes,
        companyName: x.company_name,
      },
      resolvedCarrierId: resolution.carrierId,
      resolvedCarrierMc: resolution.carrierMc,
      resolutionMethod: resolution.method,
      discrepancyFlags: flags,
      // Emails are text: there is no ASR confidence to doubt.
      mcLowConfidence: false,
    });
  }

  for (const call of loadCalls()) {
    const x = readExtraction(call.id);
    const resolution = resolveCarrier(carriers, {
      mc: x.mc_number,
      // Calls carry no email address; company name is the fallback signal.
      email: null,
      companyName: x.company_name,
    });

    rows.push({
      id: call.id,
      sourceType: "call",
      // The recordings carry no timestamp. Inventing one would give the agent a
      // date it could cite as fact.
      occurredAt: null,
      fromName: x.caller_name,
      fromEmail: null,
      subject: null,
      // The SMART track is stored as raw_text: it renders numerals as digits,
      // so Postgres FTS matches "29372421" the way a user would type it. The
      // verbatim track stays on disk for extraction and confidence scoring.
      rawText: call.smartTranscript,
      // Calls have no pre-labeled fields at all.
      statedMcNumber: null,
      statedLoadReference: null,
      statedEquipment: null,
      statedIntent: null,
      statedRateQuotedUsd: null,
      extractedMcNumber: normalizeMc(x.mc_number),
      extractedLoadReference: normalizeMc(x.load_reference),
      extractedEquipment: x.equipment,
      extractedIntent: x.intent,
      extractedRateUsd: x.rate_usd,
      extractedAvailability: x.availability,
      extractedExtras: {
        questions: x.questions,
        notes: x.notes,
        companyName: x.company_name,
      },
      resolvedCarrierId: resolution.carrierId,
      resolvedCarrierMc: resolution.carrierMc,
      resolutionMethod: resolution.method,
      discrepancyFlags: callDiscrepancyFlags(x, resolution),
      mcLowConfidence: mcLowConfidence(call.verbatimWords),
    });
  }

  const lines = rows.map((r, i) => {
    try {
      return JSON.stringify(derivedInquirySchema.parse(r));
    } catch (err) {
      throw new Error(
        `row ${i + 1} (${r.id}) failed the derived schema: ${err}`,
      );
    }
  });
  writeFileSync(OUT_PATH, `${lines.join("\n")}\n`);

  const tally = (pick: (r: DerivedInquiry) => string[]) => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      for (const k of pick(r)) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  };

  console.log(`wrote ${OUT_PATH}: ${rows.length} inquiries`);
  console.log(
    `  emails: ${rows.filter((r) => r.sourceType === "email").length}, calls: ${rows.filter((r) => r.sourceType === "call").length}`,
  );
  console.log("resolutionMethod:");
  for (const [k, n] of tally((r) => [r.resolutionMethod ?? "unresolved"])) {
    console.log(`  ${k}: ${n}`);
  }
  console.log("discrepancyFlags:");
  for (const [k, n] of tally((r) => r.discrepancyFlags)) {
    console.log(`  ${k}: ${n}`);
  }
  console.log(
    `mcLowConfidence=true: ${rows.filter((r) => r.mcLowConfidence).length}`,
  );
  console.log(
    `unresolved: ${rows.filter((r) => r.resolvedCarrierId === null).length}`,
  );
}

main();
