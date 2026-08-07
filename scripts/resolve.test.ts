import { describe, expect, it } from "vitest";
import {
  callDiscrepancyFlags,
  emailDiscrepancyFlags,
  normalizeMc,
  normalizeName,
  quotesARate,
  resolveCarrier,
} from "./resolve-helpers";
import type { RawCarrier, RawEmail } from "./sources";

const carriers: RawCarrier[] = [
  {
    mc_number: "776491",
    company_name: "SMR TRUCKING INC",
    email: "rummy@smr.com",
  },
  {
    mc_number: "345678",
    company_name: "Garden State Express LLC",
    email: "pramos@gardenstatexpress.com",
  },
  {
    mc_number: "456012",
    company_name: "SUMMIT RIDGE CARRIERS INC",
    email: null,
  },
  // Two carriers sharing a contact address — the ambiguity case.
  {
    mc_number: "111111",
    company_name: "Twin Pines A",
    email: "shared@broker.com",
  },
  {
    mc_number: "222222",
    company_name: "Twin Pines B",
    email: "shared@broker.com",
  },
  // No MC on file at all.
  { mc_number: null, company_name: "BLUE EAGLE LOGISTICS", email: null },
];

describe("resolveCarrier", () => {
  it("matches on MC first, and reports a 1-based carrier id", () => {
    const r = resolveCarrier(carriers, {
      mc: "776491",
      email: "someone-else@example.com",
      companyName: "Garden State Express",
    });
    expect(r).toEqual({
      carrierId: 1,
      carrierMc: "776491",
      method: "mc_exact",
      ambiguous: false,
    });
  });

  it("matches a dashed/prefixed MC against the stored digits", () => {
    const r = resolveCarrier(carriers, {
      mc: "MC# 45-6012",
      email: null,
      companyName: null,
    });
    expect(r.carrierId).toBe(3);
    expect(r.method).toBe("mc_exact");
  });

  it("falls back to an exact email match when the MC is absent", () => {
    const r = resolveCarrier(carriers, {
      mc: null,
      email: "PRamos@GardenStateXpress.com",
      companyName: null,
    });
    expect(r.carrierId).toBe(2);
    expect(r.method).toBe("email_exact");
  });

  it("falls back to a fuzzy company-name match, ignoring the legal suffix", () => {
    const r = resolveCarrier(carriers, {
      mc: null,
      email: null,
      companyName: "SMR Trucking Incorporated",
    });
    expect(r.carrierId).toBe(1);
    expect(r.method).toBe("name_fuzzy");
  });

  it("flags ambiguity when more than one carrier matches at the winning tier", () => {
    const r = resolveCarrier(carriers, {
      mc: null,
      email: "shared@broker.com",
      companyName: null,
    });
    expect(r.method).toBe("email_exact");
    expect(r.ambiguous).toBe(true);
    expect(r.carrierId).toBe(4);
  });

  it("returns an unresolved result when nothing matches", () => {
    const r = resolveCarrier(carriers, {
      mc: "999999",
      email: "nobody@nowhere.com",
      companyName: "Acme Hauling",
    });
    expect(r).toEqual({
      carrierId: null,
      carrierMc: null,
      method: null,
      ambiguous: false,
    });
  });

  it("does not match a null-MC carrier when the inquiry states no MC", () => {
    // A carrier with mc_number: null must never be reached by MC matching, or
    // every MC-less inquiry would collapse onto it.
    const r = resolveCarrier(carriers, {
      mc: null,
      email: null,
      companyName: null,
    });
    expect(r.method).toBeNull();
  });

  it("resolves a null-MC carrier by name", () => {
    const r = resolveCarrier(carriers, {
      mc: null,
      email: null,
      companyName: "Blue Eagle Logistics",
    });
    expect(r.carrierId).toBe(6);
    expect(r.carrierMc).toBeNull();
    expect(r.method).toBe("name_fuzzy");
  });
});

describe("normalizers", () => {
  it("reduces an MC to digits", () => {
    expect(normalizeMc("MC# 45-6012")).toBe("456012");
    expect(normalizeMc("  ")).toBeNull();
    expect(normalizeMc(null)).toBeNull();
  });

  it("folds case, punctuation, and legal suffixes out of a company name", () => {
    expect(normalizeName("SMR TRUCKING INC.")).toBe("smr trucking");
    expect(normalizeName("Smr Trucking Incorporated")).toBe("smr trucking");
    expect(normalizeName("")).toBeNull();
  });
});

describe("quotesARate", () => {
  it("detects a dollar figure in the source text", () => {
    expect(quotesARate("We could do $735 – any room?")).toBe(true);
    expect(quotesARate("we need 310 dollars on that run")).toBe(true);
  });

  it("does not fire on a bare load number", () => {
    expect(quotesARate("Interested in #29372421. Box truck ready.")).toBe(
      false,
    );
  });
});

const email = (over: Partial<RawEmail>): RawEmail => ({
  email_id: "CE0001",
  timestamp: "2026-05-25T15:00:00Z",
  from_name: "Test",
  from_email: "test@example.com",
  subject: "Subject",
  body: "Body",
  mc_number: null,
  load_reference: null,
  equipment_mentioned: null,
  rate_quoted_usd: null,
  intent: null,
  ...over,
});

const extraction = (
  over: Partial<Parameters<typeof emailDiscrepancyFlags>[1]>,
) => ({
  mc_number: null,
  load_reference: null,
  rate_usd: null,
  equipment: null,
  intent: "other",
  availability: "unknown" as const,
  caller_name: null,
  company_name: null,
  questions: [],
  notes: null,
  ...over,
});

describe("emailDiscrepancyFlags", () => {
  it("flags equipment stated one way and written another", () => {
    const flags = emailDiscrepancyFlags(
      email({ equipment_mentioned: "Refrigerated" }),
      extraction({ equipment: "Box Truck" }),
    );
    expect(flags).toContain("equipment_mismatch");
  });

  it("does not flag equipment when extraction found none", () => {
    const flags = emailDiscrepancyFlags(
      email({ equipment_mentioned: "Refrigerated" }),
      extraction({ equipment: null }),
    );
    expect(flags).not.toContain("equipment_mismatch");
  });

  it("flags a load reference mismatch on digits, not formatting", () => {
    expect(
      emailDiscrepancyFlags(
        email({ load_reference: "29372515" }),
        extraction({ load_reference: "#29372515" }),
      ),
    ).not.toContain("load_reference_mismatch");
    expect(
      emailDiscrepancyFlags(
        email({ load_reference: "29372515" }),
        extraction({ load_reference: "29372421" }),
      ),
    ).toContain("load_reference_mismatch");
  });

  it("flags an MC mismatch", () => {
    expect(
      emailDiscrepancyFlags(
        email({ mc_number: "876543" }),
        extraction({ mc_number: "MC 345678" }),
      ),
    ).toContain("mc_mismatch");
  });

  it("flags a rate found in the body that the dataset labelled null", () => {
    expect(
      emailDiscrepancyFlags(
        email({ rate_quoted_usd: null, body: "We could do $735 – any room?" }),
        extraction({ rate_usd: 735 }),
      ),
    ).toContain("rate_found_but_stated_null");
  });

  it("does not flag a rate the body never quotes", () => {
    expect(
      emailDiscrepancyFlags(
        email({ rate_quoted_usd: null, body: "Interested in #29372421." }),
        extraction({ rate_usd: 735 }),
      ),
    ).not.toContain("rate_found_but_stated_null");
  });

  it("treats an equivalent decoy intent label as agreement", () => {
    expect(
      emailDiscrepancyFlags(
        email({ intent: "counter" }),
        extraction({ intent: "rate_counter" }),
      ),
    ).not.toContain("intent_mismatch");
  });

  it("flags a genuine intent disagreement", () => {
    expect(
      emailDiscrepancyFlags(
        email({ intent: "confirm" }),
        extraction({ intent: "problem_report" }),
      ),
    ).toContain("intent_mismatch");
  });
});

describe("callDiscrepancyFlags", () => {
  const resolved = {
    carrierId: 1,
    carrierMc: "776491",
    method: "mc_exact" as const,
    ambiguous: false,
  };

  it("is empty for a cleanly resolved call", () => {
    expect(
      callDiscrepancyFlags(extraction({ mc_number: "776491" }), resolved),
    ).toEqual([]);
  });

  it("flags a call that states no MC", () => {
    const flags = callDiscrepancyFlags(extraction({ mc_number: null }), {
      carrierId: null,
      carrierMc: null,
      method: null,
      ambiguous: false,
    });
    expect(flags).toContain("mc_unresolved");
    expect(flags).toContain("ambiguous_resolution");
  });

  it("flags an ambiguous resolution even when an MC was stated", () => {
    expect(
      callDiscrepancyFlags(extraction({ mc_number: "111111" }), {
        ...resolved,
        ambiguous: true,
      }),
    ).toEqual(["ambiguous_resolution"]);
  });
});
