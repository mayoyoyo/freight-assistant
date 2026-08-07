/**
 * Idempotent seed: truncates and reloads every table from committed files.
 *   - data/raw/        → carriers, loads, rate_history (structured source data)
 *   - data/raw/carrier_emails.json → inquiries (raw email rows, stated_* decoy
 *     fields kept for discrepancy checking only — spec invariant)
 *   - data/derived/inquiries.ndjson (when present, after the offline ingestion
 *     pipeline has run) → authoritative inquiries: extraction + resolution for
 *     emails AND transcribed calls. Replaces the raw-email fallback entirely.
 *
 * Usage: pnpm seed   (needs DATABASE_URL; reads .env if present)
 */
import { existsSync, readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { carriers, inquiries, loads, rateHistory } from "../src/db/schema";

try {
  process.loadEnvFile(".env");
} catch {
  // no .env file — rely on ambient env (CI, Vercel)
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required (set it in .env or the environment)");
  process.exit(1);
}

const db = drizzle(DATABASE_URL);

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;
const num = (v: unknown): number | null => {
  const s = str(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function readCsv(path: string): Record<string, string>[] {
  return parse(readFileSync(path, "utf8"), {
    columns: true,
    skip_empty_lines: true,
  });
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

type RawCarrier = Record<string, unknown> & {
  company_name: string;
  equipment_types?: string[];
  preferred_lanes?: string[];
};
type RawEmail = Record<string, unknown> & {
  email_id: string;
  timestamp: string;
  body: string;
};

async function main() {
  await db.execute(
    sql`truncate table inquiries, loads, carriers, rate_history restart identity cascade`,
  );

  const rawCarriers = readJson<RawCarrier[]>("data/raw/carrier_profiles.json");
  await db.insert(carriers).values(
    rawCarriers.map((c) => ({
      mcNumber: str(c.mc_number),
      dotNumber: str(c.dot_number),
      companyName: str(c.company_name),
      primaryContact: str(c.primary_contact),
      email: str(c.email),
      phone: str(c.phone),
      address: str(c.address),
      homeBaseZip: str(c.home_base_zip),
      equipmentTypes: c.equipment_types ?? [],
      preferredLanes: c.preferred_lanes ?? [],
      factoringCompany: str(c.factoring_company),
      paymentTermsPreference: str(c.payment_terms_preference),
      reliabilityScore: num(c.reliability_score),
      loadsCompletedWithGoodlane: num(c.loads_completed_with_goodlane),
      avgResponseTimeHours: num(c.avg_response_time_hours),
      insuranceExpiry: str(c.insurance_expiry),
      authorityStatus: str(c.authority_status),
      safetyRating: str(c.safety_rating),
      onboarded: str(c.onboarded),
      notes: str(c.notes),
    })),
  );

  const rawLoads = readCsv("data/raw/loads.csv");
  await db.insert(loads).values(
    rawLoads.map((l) => ({
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
    })),
  );

  const rawRates = readCsv("data/raw/rate_history.csv");
  await db.insert(rateHistory).values(
    rawRates.map((r) => ({
      weekStart: r.week_start as string,
      originState: r.origin_state as string,
      destinationState: r.destination_state as string,
      equipmentType: r.equipment_type as string,
      avgRatePerMile: num(r.avg_rate_per_mile) ?? 0,
      minRatePerMile: num(r.min_rate_per_mile) ?? 0,
      maxRatePerMile: num(r.max_rate_per_mile) ?? 0,
      loadVolume: num(r.load_volume) ?? 0,
    })),
  );

  const derivedPath = "data/derived/inquiries.ndjson";
  if (existsSync(derivedPath)) {
    // Post-ingestion: each line is a complete inquiries row (camelCase keys
    // matching the schema), covering enriched emails and transcribed calls.
    const rows = readFileSync(derivedPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const r = JSON.parse(line);
        return {
          ...r,
          occurredAt: r.occurredAt ? new Date(r.occurredAt) : null,
        };
      });
    await db.insert(inquiries).values(rows);
    console.log(`inquiries: ${rows.length} (from ${derivedPath})`);
  } else {
    // Pre-ingestion fallback: raw emails only, decoy fields stored as stated_*.
    const rawEmails = readJson<RawEmail[]>("data/raw/carrier_emails.json");
    await db.insert(inquiries).values(
      rawEmails.map((e) => ({
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
      })),
    );
    console.log(
      `inquiries: ${rawEmails.length} raw emails (no derived data yet — run the ingestion pipeline for calls + extraction)`,
    );
  }

  for (const [name, table] of [
    ["carriers", carriers],
    ["loads", loads],
    ["rate_history", rateHistory],
    ["inquiries", inquiries],
  ] as const) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(table);
    console.log(`${name}: ${row?.n}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
