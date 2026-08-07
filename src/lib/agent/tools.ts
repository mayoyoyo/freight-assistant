/**
 * The agent's tool surface: four narrow, typed reads over Postgres.
 *
 * Design rules (spec invariants):
 *  - Every query goes through the Drizzle query builder or a `sql` template
 *    with bound placeholders. No string interpolation into SQL, ever.
 *  - `market_rate` is a pure SQL aggregate. No LLM inside a tool.
 *  - `stated_*` columns are dataset decoys and are NEVER returned to the model;
 *    only `extracted_*` (+ the discrepancy flags computed against them).
 *  - Results are compact JSON: only fields the agent needs, always carrying the
 *    citable id (`inquiries.id`, `loads.load_id`, `carriers.mc_number`).
 *
 * Extension seam: `freightTools` below is a plain object. Adding a fifth tool
 * is "write a `tool({ inputSchema, execute })` and add one key" — no
 * registration, no codegen, and the UI picks it up automatically because the
 * chip renderer keys off the tool part type.
 */
import { tool } from "ai";
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  like,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { carriers, inquiries, loads, rateHistory } from "@/db/schema";
import { REFERENCE_DATE } from "@/lib/config";

/** The only equipment vocabulary in the corpus. "Reefer" maps to Refrigerated. */
const EQUIPMENT = [
  "Box Truck",
  "Flatbed",
  "Refrigerated",
  "Sprinter Van",
] as const;

/**
 * Intent vocabulary — imported conceptually from `scripts/extract.ts`, which is
 * what wrote these values. Duplicated as a literal (rather than imported) so the
 * Next bundle never pulls the ingestion script's Node-only deps into the route.
 * Keep in sync with `INTENTS` in scripts/extract.ts.
 */
const INTENTS = [
  "availability_offer",
  "rate_counter",
  "rate_question",
  "load_question",
  "booking_confirm",
  "factoring_notice",
  "compliance_update",
  "problem_report",
  "other",
] as const;

const AVAILABILITY = [
  "available",
  "unavailable",
  "conditional",
  "unknown",
] as const;

const SNIPPET_CHARS = 200;

/** Drizzle returns `date` columns as 'YYYY-MM-DD' strings; normalise defensively. */
function asDate(value: string | Date | null): string | null {
  if (value == null) return null;
  return value instanceof Date
    ? (value.toISOString().slice(0, 10) as string)
    : value;
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_CHARS
    ? `${flat.slice(0, SNIPPET_CHARS)}…`
    : flat;
}

// ---------------------------------------------------------------------------
// 1. get_load
// ---------------------------------------------------------------------------

const getLoad = tool({
  description:
    "Look up one load by its exact load ID (8 digits, e.g. 29372450). Returns the lane, equipment, dates, posted rate and status. Use this whenever the broker names a load number.",
  inputSchema: z.object({
    load_id: z.string().describe("Exact load ID, digits only, no '#'."),
  }),
  execute: async ({ load_id }) => {
    const [row] = await db()
      .select()
      .from(loads)
      .where(eq(loads.loadId, load_id))
      .limit(1);

    if (!row) return { not_found: true as const, load_id };

    return {
      load_id: row.loadId,
      origin: `${row.originCity}, ${row.originState}`,
      origin_state: row.originState,
      destination: `${row.destinationCity}, ${row.destinationState}`,
      destination_state: row.destinationState,
      distance_miles: row.distanceMiles,
      equipment_type: row.equipmentType,
      weight_lbs: row.weightLbs,
      pickup_date: asDate(row.pickupDate),
      pickup_window: row.pickupWindow,
      delivery_date: asDate(row.deliveryDate),
      offered_rate_usd: row.offeredRateUsd,
      status: row.status,
      shipper_name: row.shipperName,
      internal_notes: row.internalNotes,
    };
  },
});

// ---------------------------------------------------------------------------
// 2. search_inquiries
// ---------------------------------------------------------------------------

/**
 * NOTE — deviation from the plan doc: it listed `origin_state`/`dest_state` as
 * plain filters on this tool, but `inquiries` has no lane columns. A lane is a
 * property of a *load*, not of a message. So the two lane filters here are
 * implemented as a join through `extracted_load_reference -> loads.load_id`,
 * i.e. "inquiries about loads running this lane". That is what the broker means
 * by "who's available for PA-NJ box truck loads", and it is the only way to
 * answer the spec's first example query without a fifth tool.
 *
 * Consequence worth knowing: an inquiry with no extracted load reference cannot
 * match a lane filter, even if the body mentions the lane in prose. The `query`
 * argument (full-text) is the fallback for that case.
 */
const searchInquiries = tool({
  description: [
    "Search carrier inquiries — both emails and transcribed phone calls — by full text and/or structured filters.",
    "Full-text search covers sender name, subject and the full body/transcript; MC numbers and load IDs are searchable as words.",
    "Call records have NO date (occurred_at is null for all 55 calls: the recordings are undated), so a `since` filter silently excludes every call. Say so when you time-scope an answer.",
    "origin_state/dest_state filter by the lane of the load the inquiry references.",
    "To pull up a specific message the broker names (e.g. CE0074, call_017), use `ids` — record ids are NOT full-text searchable.",
  ].join(" "),
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Free-text search (Postgres websearch syntax: bare words AND together, "quoted phrases" work).',
      ),
    ids: z
      .array(z.string())
      .max(20)
      .optional()
      .describe(
        "Exact inquiry ids, e.g. ['CE0074'] or ['call_017_availability_check']. Call ids may be given as a prefix like 'call_017'.",
      ),
    equipment: z.enum(EQUIPMENT).optional(),
    intent: z.enum(INTENTS).optional(),
    availability: z.enum(AVAILABILITY).optional(),
    mc_number: z
      .string()
      .optional()
      .describe("Resolved carrier MC number, digits only."),
    source_type: z.enum(["email", "call"]).optional(),
    origin_state: z
      .string()
      .length(2)
      .optional()
      .describe("2-letter state of the referenced load's origin, e.g. PA."),
    dest_state: z
      .string()
      .length(2)
      .optional()
      .describe(
        "2-letter state of the referenced load's destination, e.g. NJ.",
      ),
    since: z
      .string()
      .optional()
      .describe(
        "ISO date (YYYY-MM-DD) lower bound on occurred_at. Excludes all undated call records.",
      ),
    mc_low_confidence: z
      .boolean()
      .optional()
      .describe(
        "True to return only records where the MC digits were unclear on the recording ('garbled MC').",
      ),
    limit: z.number().int().min(1).max(20).default(10),
  }),
  execute: async (input) => {
    const filters = [
      input.query
        ? sql`${inquiries.search} @@ websearch_to_tsquery('english', ${input.query})`
        : undefined,
      // The generated tsvector covers from_name/subject/raw_text but NOT `id`,
      // so "show me CE0074" has to come through here, not through `query`.
      // Call ids are long (call_017_availability_check); accept a prefix.
      input.ids?.length
        ? or(
            inArray(inquiries.id, input.ids),
            ...input.ids.map((id) => like(inquiries.id, `${id}\\_%`)),
          )
        : undefined,
      input.mc_low_confidence !== undefined
        ? eq(inquiries.mcLowConfidence, input.mc_low_confidence)
        : undefined,
      input.equipment
        ? eq(inquiries.extractedEquipment, input.equipment)
        : undefined,
      input.intent ? eq(inquiries.extractedIntent, input.intent) : undefined,
      input.availability
        ? eq(inquiries.extractedAvailability, input.availability)
        : undefined,
      input.mc_number
        ? eq(inquiries.resolvedCarrierMc, input.mc_number)
        : undefined,
      input.source_type
        ? eq(inquiries.sourceType, input.source_type)
        : undefined,
      input.since
        ? gte(inquiries.occurredAt, new Date(input.since))
        : undefined,
      // Lane filters: subquery over loads, joined on the extracted reference.
      input.origin_state || input.dest_state
        ? inArray(
            inquiries.extractedLoadReference,
            db()
              .select({ loadId: loads.loadId })
              .from(loads)
              .where(
                and(
                  input.origin_state
                    ? eq(loads.originState, input.origin_state)
                    : undefined,
                  input.dest_state
                    ? eq(loads.destinationState, input.dest_state)
                    : undefined,
                ),
              ),
          )
        : undefined,
    ].filter((f) => f !== undefined);

    const where = filters.length > 0 ? and(...filters) : undefined;

    const rows = await db()
      .select({
        id: inquiries.id,
        sourceType: inquiries.sourceType,
        occurredAt: inquiries.occurredAt,
        fromName: inquiries.fromName,
        subject: inquiries.subject,
        rawText: inquiries.rawText,
        extractedMcNumber: inquiries.extractedMcNumber,
        extractedLoadReference: inquiries.extractedLoadReference,
        extractedRateUsd: inquiries.extractedRateUsd,
        extractedEquipment: inquiries.extractedEquipment,
        extractedIntent: inquiries.extractedIntent,
        extractedAvailability: inquiries.extractedAvailability,
        resolvedCarrierMc: inquiries.resolvedCarrierMc,
        discrepancyFlags: inquiries.discrepancyFlags,
        mcLowConfidence: inquiries.mcLowConfidence,
      })
      .from(inquiries)
      .where(where)
      // Postgres defaults DESC to NULLS FIRST; undated calls belong at the end.
      .orderBy(sql`${inquiries.occurredAt} desc nulls last`, inquiries.id)
      .limit(input.limit);

    const [totals] = await db()
      .select({ total: count() })
      .from(inquiries)
      .where(where);

    return {
      total_matches: totals?.total ?? 0,
      returned: rows.length,
      results: rows.map((r) => ({
        id: r.id,
        source_type: r.sourceType,
        occurred_at: r.occurredAt ? r.occurredAt.toISOString() : null,
        from_name: r.fromName,
        subject: r.subject,
        snippet: snippet(r.rawText),
        extracted_mc_number: r.extractedMcNumber,
        extracted_load_reference: r.extractedLoadReference,
        extracted_rate_usd: r.extractedRateUsd,
        extracted_equipment: r.extractedEquipment,
        extracted_intent: r.extractedIntent,
        extracted_availability: r.extractedAvailability,
        resolved_carrier_mc: r.resolvedCarrierMc,
        discrepancy_flags: r.discrepancyFlags,
        mc_low_confidence: r.mcLowConfidence,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// 3. carrier_history
// ---------------------------------------------------------------------------

const carrierHistory = tool({
  description:
    "Full profile + compliance status + recent inquiry history for one carrier, by MC number. Call this before recommending, booking, or speaking positively about any carrier — it is the only place authority status and insurance expiry are visible.",
  inputSchema: z.object({
    mc_number: z.string().describe("MC number, digits only, no 'MC' prefix."),
  }),
  execute: async ({ mc_number }) => {
    const [carrier] = await db()
      .select()
      .from(carriers)
      .where(eq(carriers.mcNumber, mc_number))
      .limit(1);

    if (!carrier) return { not_found: true as const, mc_number };

    const insuranceExpiry = asDate(carrier.insuranceExpiry);
    // Compliance is evaluated against the frozen snapshot date, never the clock.
    const insuranceExpired =
      insuranceExpiry === null ? null : insuranceExpiry < REFERENCE_DATE;
    const authorityOk =
      carrier.authorityStatus === null
        ? null
        : carrier.authorityStatus === "ACTIVE";

    const concerns: string[] = [];
    if (insuranceExpired === true)
      concerns.push(
        `insurance expired ${insuranceExpiry} (before ${REFERENCE_DATE})`,
      );
    if (insuranceExpired === null) concerns.push("insurance expiry unknown");
    if (authorityOk === false)
      concerns.push(
        `authority status is ${carrier.authorityStatus}, not ACTIVE`,
      );
    if (authorityOk === null) concerns.push("authority status unknown");

    const recent = await db()
      .select({
        id: inquiries.id,
        occurredAt: inquiries.occurredAt,
        sourceType: inquiries.sourceType,
        extractedIntent: inquiries.extractedIntent,
        extractedAvailability: inquiries.extractedAvailability,
        rawText: inquiries.rawText,
      })
      .from(inquiries)
      .where(eq(inquiries.resolvedCarrierMc, mc_number))
      .orderBy(sql`${inquiries.occurredAt} desc nulls last`, inquiries.id)
      .limit(10);

    const [totals] = await db()
      .select({ total: count() })
      .from(inquiries)
      .where(eq(inquiries.resolvedCarrierMc, mc_number));

    return {
      mc_number: carrier.mcNumber,
      dot_number: carrier.dotNumber,
      company_name: carrier.companyName,
      primary_contact: carrier.primaryContact,
      email: carrier.email,
      phone: carrier.phone,
      home_base_zip: carrier.homeBaseZip,
      equipment_types: carrier.equipmentTypes,
      preferred_lanes: carrier.preferredLanes,
      factoring_company: carrier.factoringCompany,
      payment_terms_preference: carrier.paymentTermsPreference,
      reliability_score: carrier.reliabilityScore,
      loads_completed: carrier.loadsCompletedWithGoodlane,
      avg_response_time_hours: carrier.avgResponseTimeHours,
      authority_status: carrier.authorityStatus,
      insurance_expiry: insuranceExpiry,
      safety_rating: carrier.safetyRating,
      onboarded: carrier.onboarded,
      notes: carrier.notes,
      compliance: {
        reference_date: REFERENCE_DATE,
        insurance_expired: insuranceExpired,
        authority_ok: authorityOk,
        clear: concerns.length === 0,
        concerns,
      },
      inquiry_count: totals?.total ?? 0,
      recent_inquiries: recent.map((r) => ({
        id: r.id,
        occurred_at: r.occurredAt ? r.occurredAt.toISOString() : null,
        source_type: r.sourceType,
        extracted_intent: r.extractedIntent,
        extracted_availability: r.extractedAvailability,
        snippet: snippet(r.rawText),
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// 4. market_rate
// ---------------------------------------------------------------------------

const marketRate = tool({
  description:
    "Historical market rate per mile for a state-to-state lane and equipment type, aggregated from weekly observations. Pure SQL aggregate over the rate_history table — it reports what the data says or reports no data; it never estimates. The window always ends at the snapshot date.",
  inputSchema: z.object({
    origin_state: z
      .string()
      .length(2)
      .describe("2-letter origin state, e.g. PA."),
    dest_state: z
      .string()
      .length(2)
      .describe("2-letter destination state, e.g. NJ."),
    equipment: z.enum(EQUIPMENT),
    window_weeks: z
      .number()
      .int()
      .min(1)
      .max(26)
      .default(4)
      .describe(
        "Weeks of history to include, counting back from the snapshot date.",
      ),
  }),
  execute: async (input) => {
    const rows = await db()
      .select({
        weekStart: rateHistory.weekStart,
        avgRatePerMile: rateHistory.avgRatePerMile,
        minRatePerMile: rateHistory.minRatePerMile,
        maxRatePerMile: rateHistory.maxRatePerMile,
        loadVolume: rateHistory.loadVolume,
      })
      .from(rateHistory)
      .where(
        and(
          eq(rateHistory.originState, input.origin_state),
          eq(rateHistory.destinationState, input.dest_state),
          eq(rateHistory.equipmentType, input.equipment),
          lte(rateHistory.weekStart, REFERENCE_DATE),
          sql`${rateHistory.weekStart} > ${REFERENCE_DATE}::date - make_interval(weeks => ${input.window_weeks})`,
        ),
      )
      .orderBy(desc(rateHistory.weekStart));

    const lane = `${input.origin_state}-${input.dest_state}`;

    if (rows.length === 0) {
      return {
        no_data: true as const,
        lane,
        equipment: input.equipment,
        window_weeks: input.window_weeks,
        reference_date: REFERENCE_DATE,
      };
    }

    const volume = rows.reduce((sum, r) => sum + r.loadVolume, 0);
    const weightedAvg =
      rows.reduce((sum, r) => sum + r.avgRatePerMile, 0) / rows.length;

    return {
      lane,
      equipment: input.equipment,
      reference_date: REFERENCE_DATE,
      window_weeks: input.window_weeks,
      weeks_found: rows.length,
      avg_rate_per_mile: Number(weightedAvg.toFixed(3)),
      min_rate_per_mile: Math.min(...rows.map((r) => r.minRatePerMile)),
      max_rate_per_mile: Math.max(...rows.map((r) => r.maxRatePerMile)),
      total_load_volume: volume,
      weeks: rows.map((r) => ({
        week_start: asDate(r.weekStart),
        avg_rate_per_mile: r.avgRatePerMile,
        min_rate_per_mile: r.minRatePerMile,
        max_rate_per_mile: r.maxRatePerMile,
        load_volume: r.loadVolume,
      })),
    };
  },
});

/**
 * The registry. Adding a tool = one more key here.
 * `satisfies` (not `:`) so per-tool input/output types survive for
 * `InferUITools` on the client.
 */
export const freightTools = {
  get_load: getLoad,
  search_inquiries: searchInquiries,
  carrier_history: carrierHistory,
  market_rate: marketRate,
};

export type FreightTools = typeof freightTools;
