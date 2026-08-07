/**
 * Pure resolution + discrepancy logic for scripts/resolve.ts. Split out so it
 * is unit-testable without executing the pipeline (same split as
 * seed-helpers.ts / seed.ts).
 *
 * SPEC INVARIANT: `emailDiscrepancyFlags` is the one function in the codebase
 * that reads the dataset's pre-labeled DECOY fields alongside extraction
 * output, and it reads them only to compare. No decoy value is ever returned as
 * an extracted value.
 */
import type { RawCarrier, RawEmail } from "./sources";

export type Extraction = {
  mc_number: string | null;
  load_reference: string | null;
  rate_usd: number | null;
  equipment: string | null;
  intent: string;
  availability: "available" | "unavailable" | "conditional" | "unknown";
  caller_name: string | null;
  company_name: string | null;
  questions: string[];
  notes: string | null;
};

// ---------------------------------------------------------------- resolution

export type ResolutionMethod = "mc_exact" | "email_exact" | "name_fuzzy";

export type Resolution = {
  carrierId: number | null;
  carrierMc: string | null;
  method: ResolutionMethod | null;
  /** More than one carrier matched at the winning tier — resolution is a guess. */
  ambiguous: boolean;
};

/** MC numbers appear as "MC 876543", "MC#876543", "45-6012" — compare digits. */
export const normalizeMc = (v: string | null | undefined): string | null => {
  const digits = (v ?? "").replace(/\D/g, "");
  return digits === "" ? null : digits;
};

export const normalizeEmail = (v: string | null | undefined): string | null => {
  const s = (v ?? "").trim().toLowerCase();
  return s === "" ? null : s;
};

/**
 * Company names arrive as "SMR TRUCKING INC", "SMR Trucking Incorporated",
 * "Smr Trucking". Fold case, drop punctuation, and drop the legal suffix —
 * which is exactly the token that varies between how a carrier is registered
 * and how a caller says it out loud.
 */
export const normalizeName = (v: string | null | undefined): string | null => {
  const s = (v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(incorporated|inc|llc|ltd|corp|corporation|co|company)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s === "" ? null : s;
};

/**
 * Resolve an inquiry to a carrier. Order is strongest-evidence-first:
 * a stated MC beats an email address beats a fuzzy company-name match.
 *
 * `carrierId` is the carrier's 1-based position in carrier_profiles.json.
 * VERIFIED against scripts/seed.ts: it truncates with `restart identity` and
 * then inserts `carrierRows` — built by mapping the raw JSON array in order —
 * in a single `insert().values()`, so the serial `id` column is assigned in
 * array order starting at 1. If seed.ts ever sorts or filters carriers, this
 * mapping breaks and must change with it.
 */
export function resolveCarrier(
  carriers: RawCarrier[],
  input: {
    mc: string | null;
    email: string | null;
    companyName: string | null;
  },
): Resolution {
  const at = (matches: number[], method: ResolutionMethod): Resolution => {
    const first = matches[0] ?? 0;
    return {
      carrierId: first + 1,
      carrierMc: carriers[first]?.mc_number ?? null,
      method,
      ambiguous: matches.length > 1,
    };
  };

  const mc = normalizeMc(input.mc);
  if (mc !== null) {
    const hits = carriers
      .map((c, i) => (normalizeMc(c.mc_number) === mc ? i : -1))
      .filter((i) => i >= 0);
    if (hits.length > 0) return at(hits, "mc_exact");
  }

  const email = normalizeEmail(input.email);
  if (email !== null) {
    const hits = carriers
      .map((c, i) => (normalizeEmail(c.email) === email ? i : -1))
      .filter((i) => i >= 0);
    if (hits.length > 0) return at(hits, "email_exact");
  }

  const name = normalizeName(input.companyName);
  if (name !== null) {
    const hits = carriers
      .map((c, i) => {
        const cn = normalizeName(c.company_name);
        if (cn === null) return -1;
        return cn === name || cn.includes(name) || name.includes(cn) ? i : -1;
      })
      .filter((i) => i >= 0);
    if (hits.length > 0) return at(hits, "name_fuzzy");
  }

  return { carrierId: null, carrierMc: null, method: null, ambiguous: false };
}

// ------------------------------------------------------------- discrepancies

/** Does the free text quote a dollar amount? Used only for the stated-null check. */
export const quotesARate = (text: string): boolean =>
  /\$\s?\d/.test(text) || /\b\d{3,4}\s*(?:dollars|usd)\b/i.test(text);

/**
 * Map our intent vocabulary onto the dataset's decoy labels so an
 * `intent_mismatch` means "these disagree about what the carrier wants", not
 * "these use different words". The decoy set mixes register with intent
 * ("terse"), so the mapping is many-to-many by necessity.
 */
const INTENT_EQUIVALENTS: Record<string, string[]> = {
  availability_offer: ["inquiry", "terse", "info"],
  rate_counter: ["counter"],
  rate_question: ["inquiry", "terse"],
  load_question: ["info", "inquiry"],
  booking_confirm: ["confirm"],
  factoring_notice: ["factoring"],
  compliance_update: ["info"],
  problem_report: ["problem"],
  other: [],
};

export function emailDiscrepancyFlags(
  email: RawEmail,
  x: Extraction,
): string[] {
  const flags: string[] = [];

  const statedEquip = (email.equipment_mentioned ?? "").trim();
  if (
    statedEquip !== "" &&
    x.equipment !== null &&
    statedEquip !== x.equipment
  ) {
    flags.push("equipment_mismatch");
  }

  const statedLoad = normalizeMc(email.load_reference);
  const extractedLoad = normalizeMc(x.load_reference);
  if (
    statedLoad !== null &&
    extractedLoad !== null &&
    statedLoad !== extractedLoad
  ) {
    flags.push("load_reference_mismatch");
  }

  const statedMc = normalizeMc(email.mc_number);
  const extractedMc = normalizeMc(x.mc_number);
  if (statedMc !== null && extractedMc !== null && statedMc !== extractedMc) {
    flags.push("mc_mismatch");
  }

  // Only trust this when the source text really does contain a dollar figure —
  // otherwise a hallucinated rate would masquerade as a dataset defect.
  if (
    email.rate_quoted_usd === null &&
    x.rate_usd !== null &&
    quotesARate(`${email.subject ?? ""}\n${email.body}`)
  ) {
    flags.push("rate_found_but_stated_null");
  }

  const statedIntent = (email.intent ?? "").trim();
  if (statedIntent !== "") {
    const equivalents = INTENT_EQUIVALENTS[x.intent] ?? [];
    if (!equivalents.includes(statedIntent)) flags.push("intent_mismatch");
  }

  return flags;
}

/** Calls have no pre-labeled fields, so their only flags come from resolution. */
export function callDiscrepancyFlags(
  x: Extraction,
  resolution: Resolution,
): string[] {
  const flags: string[] = [];
  if (normalizeMc(x.mc_number) === null) flags.push("mc_unresolved");
  if (resolution.carrierId === null || resolution.ambiguous) {
    flags.push("ambiguous_resolution");
  }
  return flags;
}
