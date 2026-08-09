import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const loads = pgTable("loads", {
  loadId: text("load_id").primaryKey(),
  originCity: text("origin_city").notNull(),
  originState: text("origin_state").notNull(),
  originZip: text("origin_zip"),
  destinationCity: text("destination_city").notNull(),
  destinationState: text("destination_state").notNull(),
  destinationZip: text("destination_zip"),
  distanceMiles: integer("distance_miles"),
  equipmentType: text("equipment_type").notNull(),
  weightLbs: integer("weight_lbs"),
  pickupDate: date("pickup_date"),
  pickupWindow: text("pickup_window"),
  deliveryDate: date("delivery_date"),
  offeredRateUsd: doublePrecision("offered_rate_usd"),
  status: text("status").notNull(),
  shipperName: text("shipper_name"),
  internalNotes: text("internal_notes"),
});

export const carriers = pgTable(
  "carriers",
  {
    id: serial("id").primaryKey(),
    // Nullable on purpose: 2 of 48 profiles have no MC number.
    mcNumber: text("mc_number"),
    dotNumber: text("dot_number"),
    // Nullable on purpose: one profile is "company name unknown" (WhatsApp-only contact).
    companyName: text("company_name"),
    primaryContact: text("primary_contact"),
    email: text("email"),
    phone: text("phone"),
    address: text("address"),
    homeBaseZip: text("home_base_zip"),
    equipmentTypes: jsonb("equipment_types").$type<string[]>(),
    preferredLanes: jsonb("preferred_lanes").$type<string[]>(),
    factoringCompany: text("factoring_company"),
    paymentTermsPreference: text("payment_terms_preference"),
    reliabilityScore: doublePrecision("reliability_score"),
    loadsCompletedWithGoodlane: integer("loads_completed_with_goodlane"),
    avgResponseTimeHours: doublePrecision("avg_response_time_hours"),
    insuranceExpiry: date("insurance_expiry"),
    authorityStatus: text("authority_status"),
    safetyRating: text("safety_rating"),
    // Boolean in the source data ("is this carrier onboarded with Goodlane"),
    // not a date — review finding from PR #1.
    onboarded: boolean("onboarded"),
    notes: text("notes"),
  },
  (t) => [uniqueIndex("carriers_mc_number_idx").on(t.mcNumber)],
);

export const rateHistory = pgTable(
  "rate_history",
  {
    id: serial("id").primaryKey(),
    weekStart: date("week_start").notNull(),
    originState: text("origin_state").notNull(),
    destinationState: text("destination_state").notNull(),
    equipmentType: text("equipment_type").notNull(),
    avgRatePerMile: doublePrecision("avg_rate_per_mile").notNull(),
    minRatePerMile: doublePrecision("min_rate_per_mile").notNull(),
    maxRatePerMile: doublePrecision("max_rate_per_mile").notNull(),
    loadVolume: integer("load_volume").notNull(),
  },
  (t) => [
    // Unique: one observation per lane per week — duplicates would silently
    // distort the market_rate aggregate (verified 720/720 distinct in source).
    uniqueIndex("rate_history_lane_idx").on(
      t.originState,
      t.destinationState,
      t.equipmentType,
      t.weekStart,
    ),
  ],
);

/**
 * Unified emails + calls. The `stated*` columns mirror the dataset's pre-labeled
 * fields, which are DECOYS (spec invariant): they are stored only so extraction
 * results can be cross-checked against them, never served as truth.
 * `extracted*` columns are filled by the offline pipeline (Phase 2).
 */
export const inquiries = pgTable(
  "inquiries",
  {
    // Human-citable ID: email_id (CE0074) or call file stem (call_014).
    id: text("id").primaryKey(),
    sourceType: text("source_type").$type<"email" | "call">().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    fromName: text("from_name"),
    fromEmail: text("from_email"),
    subject: text("subject"),
    // Email body or full call transcript.
    rawText: text("raw_text").notNull(),

    statedMcNumber: text("stated_mc_number"),
    statedLoadReference: text("stated_load_reference"),
    statedEquipment: text("stated_equipment"),
    statedIntent: text("stated_intent"),
    statedRateQuotedUsd: doublePrecision("stated_rate_quoted_usd"),

    extractedMcNumber: text("extracted_mc_number"),
    extractedLoadReference: text("extracted_load_reference"),
    extractedEquipment: text("extracted_equipment"),
    extractedIntent: text("extracted_intent"),
    extractedRateUsd: doublePrecision("extracted_rate_usd"),
    // First-class filter dimension (spec example query asks who confirmed
    // availability): 'available' | 'unavailable' | 'conditional' | 'unknown'.
    extractedAvailability: text("extracted_availability"),
    // Non-filterable extraction output (questions, free-text notes).
    extractedExtras: jsonb("extracted_extras").$type<Record<string, unknown>>(),

    resolvedCarrierId: integer("resolved_carrier_id").references(
      () => carriers.id,
    ),
    resolvedCarrierMc: text("resolved_carrier_mc"),
    resolutionMethod: text("resolution_method"),
    discrepancyFlags: jsonb("discrepancy_flags")
      .$type<string[]>()
      .notNull()
      .default([]),
    // True when any word in a transcribed MC digit span had confidence < 0.85.
    mcLowConfidence: boolean("mc_low_confidence").notNull().default(false),

    search: tsvector("search").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(from_name, '') || ' ' || coalesce(subject, '') || ' ' || raw_text)`,
    ),
  },
  (t) => [
    index("inquiries_search_idx").using("gin", t.search),
    check("inquiries_source_type_check", sql`source_type in ('email', 'call')`),
  ],
);
