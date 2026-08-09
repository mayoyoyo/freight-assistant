/**
 * The extraction contract, in a module with NO side effects.
 *
 * extract.ts runs main() on import and exits without ANTHROPIC_API_KEY, so
 * anything needing the schema (resolve.ts validates its cached inputs against
 * it) must import from here, never from the script.
 */
import { z } from "zod";

/**
 * Intent vocabulary — OURS, derived from reading the corpus, deliberately not
 * the dataset's decoy labels (info/counter/inquiry/terse/confirm/factoring/
 * problem). Theirs mixes register ("terse") with intent; ours is intent only,
 * so an `intent_mismatch` flag means something.
 *
 *   availability_offer — offering a truck / declaring interest in a load
 *   rate_counter       — pushing back on a posted rate or naming their own
 *   rate_question      — asking what a load pays, no number of their own
 *   load_question      — operational questions (weight, dock, appointment, door)
 *   booking_confirm    — accepting; committing a driver
 *   factoring_notice   — factoring company / NOA / payment-terms notice
 *   compliance_update  — insurance, authority, or safety-status matters
 *   problem_report     — something went wrong (wrong equipment, nobody at dock)
 *   other              — none of the above
 */
export const INTENTS = [
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

export const EQUIPMENT = [
  "Box Truck",
  "Flatbed",
  "Refrigerated",
  "Sprinter Van",
] as const;

export const extractionSchema = z.object({
  mc_number: z
    .string()
    // Enforced, not just described: a multi-number answer ("123 or 456") must
    // fail validation and retry, never weld into a wrong-but-valid identifier
    // downstream (Codex review of PR #2, finding 2). All 329 committed
    // extractions already conform.
    .regex(/^\d+$/, "digits only")
    .nullable()
    .describe(
      "The carrier's MC number as digits only, no 'MC' prefix, no dashes. null if not stated or explicitly unavailable.",
    ),
  load_reference: z
    .string()
    .regex(/^\d+$/, "digits only")
    .nullable()
    .describe("Load ID referenced, digits only. null if none."),
  rate_usd: z
    .number()
    .nullable()
    .describe(
      "The dollar rate the CARRIER is asking for or agreeing to, as a number. null if no rate is discussed.",
    ),
  equipment: z.enum(EQUIPMENT).nullable(),
  intent: z.enum(INTENTS),
  availability: z.enum(["available", "unavailable", "conditional", "unknown"]),
  caller_name: z
    .string()
    .nullable()
    .describe("Person's name on the carrier side, if clearly stated."),
  company_name: z
    .string()
    .nullable()
    .describe("Carrier company name, if clearly stated."),
  questions: z
    .array(z.string())
    .describe("Questions the carrier asks, verbatim-ish, one per entry."),
  notes: z
    .string()
    .nullable()
    .describe("One short sentence of anything else material."),
});

export type Extraction = z.infer<typeof extractionSchema>;
