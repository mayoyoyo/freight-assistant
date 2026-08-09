/**
 * Idempotent seed: parses + validates every committed artifact FIRST, then
 * truncates and reloads all tables inside a single transaction (a failed run
 * can never leave the DB empty or partial).
 *
 *   - data/raw/ → carriers, loads, rate_history (structured source data)
 *   - inquiries: data/derived/inquiries.ndjson when the offline ingestion
 *     pipeline has produced it (validated: strict row schema + exact coverage
 *     of all raw email IDs and call stems). Until then, falls back to raw
 *     emails with the dataset's pre-labeled DECOY fields stored as stated_*
 *     only (spec invariant: never treated as extracted truth).
 *
 * Usage: pnpm seed   (needs DATABASE_URL; reads .env if present)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { carriers, inquiries, loads, rateHistory } from "../src/db/schema";
import { dbEnv } from "../src/lib/env";
import {
  assertDerivedCoverage,
  bool,
  derivedInquirySchema,
  num,
  reqNum,
  str,
} from "./seed-helpers";

try {
  process.loadEnvFile(".env");
} catch {
  // no .env file — rely on ambient env (CI, Vercel)
}

const db = drizzle(dbEnv().DATABASE_URL);

function readCsv(path: string): Record<string, string>[] {
  return parse(readFileSync(path, "utf8"), {
    columns: true,
    skip_empty_lines: true,
  });
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

type RawCarrier = Record<string, unknown>;
type RawEmail = Record<string, unknown> & {
  email_id: string;
  timestamp: string;
  body: string;
};

async function main() {
  // ---- Parse + validate everything before touching the database ----

  const rawCarriers = readJson<RawCarrier[]>("data/raw/carrier_profiles.json");
  const carrierRows = rawCarriers.map((c) => ({
    mcNumber: str(c.mc_number),
    dotNumber: str(c.dot_number),
    companyName: str(c.company_name),
    primaryContact: str(c.primary_contact),
    email: str(c.email),
    phone: str(c.phone),
    address: str(c.address),
    homeBaseZip: str(c.home_base_zip),
    equipmentTypes: (c.equipment_types as string[] | undefined) ?? [],
    preferredLanes: (c.preferred_lanes as string[] | undefined) ?? [],
    factoringCompany: str(c.factoring_company),
    paymentTermsPreference: str(c.payment_terms_preference),
    reliabilityScore: num(c.reliability_score),
    loadsCompletedWithGoodlane: num(c.loads_completed_with_goodlane),
    avgResponseTimeHours: num(c.avg_response_time_hours),
    insuranceExpiry: str(c.insurance_expiry),
    authorityStatus: str(c.authority_status),
    safetyRating: str(c.safety_rating),
    onboarded: bool(c.onboarded),
    notes: str(c.notes),
  }));

  const loadRows = readCsv("data/raw/loads.csv").map((l) => ({
    loadId: l.load_id as string,
    originCity: l.origin_city as string,
    originState: l.origin_state as string,
    originZip: str(l.origin_zip),
    destinationCity: l.destination_city as string,
    destinationState: l.destination_state as string,
    destinationZip: str(l.destination_zip),
    distanceMiles: num(l.distance_miles),
    equipmentType: l.equipment_type as string,
    weightLbs: num(l.weight_lbs),
    pickupDate: str(l.pickup_date),
    pickupWindow: str(l.pickup_window),
    deliveryDate: str(l.delivery_date),
    offeredRateUsd: num(l.offered_rate_usd),
    status: l.status as string,
    shipperName: str(l.shipper_name),
    internalNotes: str(l.internal_notes),
  }));

  const rateRows = readCsv("data/raw/rate_history.csv").map((r, i) => ({
    weekStart: r.week_start as string,
    originState: r.origin_state as string,
    destinationState: r.destination_state as string,
    equipmentType: r.equipment_type as string,
    avgRatePerMile: reqNum(
      r.avg_rate_per_mile,
      `rate_history row ${i + 1} avg`,
    ),
    minRatePerMile: reqNum(
      r.min_rate_per_mile,
      `rate_history row ${i + 1} min`,
    ),
    maxRatePerMile: reqNum(
      r.max_rate_per_mile,
      `rate_history row ${i + 1} max`,
    ),
    loadVolume: reqNum(r.load_volume, `rate_history row ${i + 1} volume`),
  }));

  const rawEmails = readJson<RawEmail[]>("data/raw/carrier_emails.json");
  const callIds = readdirSync("data/raw/call_recordings")
    .filter((f) => f.endsWith(".wav"))
    .map((f) => f.replace(/\.wav$/, ""));

  const derivedPath = "data/derived/inquiries.ndjson";
  let inquiryRows: (typeof inquiries.$inferInsert)[];
  let inquirySource: string;

  if (existsSync(derivedPath)) {
    const parsed = readFileSync(derivedPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line, i) => {
        try {
          return derivedInquirySchema.parse(JSON.parse(line));
        } catch (err) {
          throw new Error(`${derivedPath} line ${i + 1}: ${err}`);
        }
      });
    assertDerivedCoverage(
      parsed,
      rawEmails.map((e) => e.email_id),
      callIds,
    );
    inquiryRows = parsed.map((r) => ({
      ...r,
      occurredAt: r.occurredAt ? new Date(r.occurredAt) : null,
    }));
    inquirySource = `${derivedPath} (validated, full coverage)`;
  } else {
    inquiryRows = rawEmails.map((e) => ({
      id: e.email_id,
      sourceType: "email" as const,
      occurredAt: new Date(e.timestamp),
      fromName: str(e.from_name),
      fromEmail: str(e.from_email),
      subject: str(e.subject),
      rawText: e.body,
      statedMcNumber: str(e.mc_number),
      statedLoadReference: str(e.load_reference),
      statedEquipment: str(e.equipment_mentioned),
      statedIntent: str(e.intent),
      statedRateQuotedUsd: num(e.rate_quoted_usd),
    }));
    inquirySource =
      "raw emails only (run the ingestion pipeline for calls + extraction)";
  }

  // ---- Single transaction: truncate + insert ----

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`truncate table inquiries, loads, carriers, rate_history restart identity cascade`,
    );
    await tx.insert(carriers).values(carrierRows);
    await tx.insert(loads).values(loadRows);
    await tx.insert(rateHistory).values(rateRows);
    await tx.insert(inquiries).values(inquiryRows);
  });

  // ---- Verify values, not just counts (PR #1 review finding) ----

  const expectReliability = rawCarriers.filter(
    (c) => c.reliability_score != null,
  ).length;
  const [check] = await db
    .select({
      carriers: sql<number>`(select count(*) from carriers)::int`,
      reliability: sql<number>`(select count(*) from carriers where reliability_score is not null)::int`,
      onboarded: sql<number>`(select count(*) from carriers where onboarded is not null)::int`,
      loads: sql<number>`(select count(*) from loads)::int`,
      rates: sql<number>`(select count(*) from rate_history)::int`,
      inquiries: sql<number>`(select count(*) from inquiries)::int`,
      ce74equipment: sql<string>`(select stated_equipment from inquiries where id = 'CE0074')`,
    })
    .from(sql`(select 1) as _`);

  if (!check) throw new Error("verification query returned nothing");
  if (check.reliability !== expectReliability) {
    throw new Error(
      `Seed verification failed: ${check.reliability} non-null reliability scores in DB, ${expectReliability} in source`,
    );
  }
  if (check.onboarded !== rawCarriers.length) {
    throw new Error(
      `Seed verification failed: onboarded flags lost (${check.onboarded}/${rawCarriers.length})`,
    );
  }
  if (check.ce74equipment !== "Refrigerated") {
    throw new Error(
      `Seed verification failed: CE0074 stated_equipment should be the decoy value 'Refrigerated', got ${check.ce74equipment}`,
    );
  }

  console.log(`inquiries source: ${inquirySource}`);
  console.log(
    `carriers: ${check.carriers} (reliability ${check.reliability}/${expectReliability}, onboarded ${check.onboarded}) | loads: ${check.loads} | rate_history: ${check.rates} | inquiries: ${check.inquiries}`,
  );
  console.log("value-level verification passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
