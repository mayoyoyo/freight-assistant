/**
 * Pure-function tests for the draft_email renderer — no DB, no model, free to
 * run anywhere (CI included). The DB-backed integration path is covered in
 * `tools.test.ts` behind the usual skipIf guard.
 */
import { describe, expect, it } from "vitest";
import {
  composeDraft,
  type DraftCompliance,
  type DraftFacts,
  type DraftLoad,
} from "./draft-email";

const LOAD: DraftLoad = {
  load_id: "29372490",
  origin: "Scranton, PA",
  destination: "Newark, NJ",
  equipment_type: "Flatbed",
  weight_lbs: 42000,
  pickup_date: "2026-05-27",
  pickup_window: "08:00-12:00",
  delivery_date: "2026-05-28",
  offered_rate_usd: 950,
};

const CLEAR: DraftCompliance = {
  authority_status: "ACTIVE",
  insurance_expiry: "2027-01-31",
  insurance_expired: false,
  clear: true,
  concerns: [],
};

const CONDITIONAL: DraftCompliance = {
  authority_status: "CONDITIONAL",
  insurance_expiry: "2027-01-31",
  insurance_expired: false,
  clear: false,
  concerns: ["authority status is CONDITIONAL, not ACTIVE"],
};

function facts(overrides: Partial<DraftFacts> = {}): DraftFacts {
  return {
    intent: "rate_confirm",
    recipient: {
      name: "Clint Beauregard",
      email: "clint.frontier@gmail.com",
      carrier_mc: "885432",
    },
    inquiry_id: "CE0066",
    load: LOAD,
    compliance: CLEAR,
    rate_usd: 950,
    allowed_rates: [950],
    pickup_date: null,
    missing_info: [],
    ...overrides,
  };
}

function draftOf(result: ReturnType<typeof composeDraft>) {
  if ("refused" in result)
    throw new Error(`unexpected refusal: ${result.reason}`);
  return result;
}

function refusalOf(result: ReturnType<typeof composeDraft>) {
  if (!("refused" in result)) throw new Error("expected a refusal");
  return result;
}

describe("rate_confirm", () => {
  it("renders load, lane, rate and signature; no caveat when compliance is clear", () => {
    const r = draftOf(composeDraft(facts()));
    expect(r.draft.subject).toContain("29372490");
    expect(r.draft.subject).toContain("$950");
    expect(r.draft.body).toContain("Hi Clint,");
    expect(r.draft.body).toContain("Scranton, PA to Newark, NJ, Flatbed");
    expect(r.draft.body).toContain("$950");
    expect(r.draft.body).toContain("Pickup 2026-05-27 (08:00-12:00)");
    expect(r.draft.body).toContain("Goodlane Dispatch");
    expect(r.compliance_caveat).toBeNull();
    expect(r.draft.to_email).toBe("clint.frontier@gmail.com");
  });

  it("CONDITIONAL authority renders WITH a mandatory contingency paragraph (the D03 judgment call)", () => {
    const r = draftOf(composeDraft(facts({ compliance: CONDITIONAL })));
    expect(r.compliance_caveat).toContain("contingent");
    expect(r.draft.body).toContain(
      "authority status is CONDITIONAL, not ACTIVE",
    );
    expect(r.draft.body).toContain("contingent");
    // Still accepts at the real posted figure — the caveat conditions it.
    expect(r.draft.body).toContain("$950");
  });

  it("expired insurance refuses to render a booking draft", () => {
    const r = refusalOf(
      composeDraft(
        facts({
          compliance: {
            authority_status: "ACTIVE",
            insurance_expiry: "2026-03-01",
            insurance_expired: true,
            clear: false,
            concerns: ["insurance expired 2026-03-01 (before 2026-05-25)"],
          },
        }),
      ),
    );
    expect(r.reason).toContain("compliance gate");
    expect(r.reason).toContain("insurance expired");
  });

  it("revoked authority refuses to render a booking draft", () => {
    const r = refusalOf(
      composeDraft(
        facts({
          compliance: {
            authority_status: "REVOKED",
            insurance_expiry: "2027-01-31",
            insurance_expired: false,
            clear: false,
            concerns: ["authority status is REVOKED, not ACTIVE"],
          },
        }),
      ),
    );
    expect(r.reason).toContain("compliance gate");
  });

  it("refuses without a load, a rate, or carrier compliance", () => {
    expect(refusalOf(composeDraft(facts({ load: null }))).reason).toContain(
      "load",
    );
    expect(refusalOf(composeDraft(facts({ rate_usd: null }))).reason).toContain(
      "rate",
    );
    expect(
      refusalOf(composeDraft(facts({ compliance: null }))).reason,
    ).toContain("compliance");
  });
});

describe("figure validation (all intents)", () => {
  it("a rate the data does not contain is refused, naming what IS on record", () => {
    const r = refusalOf(composeDraft(facts({ rate_usd: 1200 })));
    expect(r.reason).toContain("$1,200");
    expect(r.reason).toContain("$950");
  });

  it("a pickup_date contradicting the load record is refused", () => {
    const r = refusalOf(composeDraft(facts({ pickup_date: "2026-05-30" })));
    expect(r.reason).toContain("2026-05-30");
    expect(r.reason).toContain("2026-05-27");
  });

  it("an unresolvable recipient is refused", () => {
    const r = refusalOf(
      composeDraft(
        facts({ recipient: { name: null, email: null, carrier_mc: null } }),
      ),
    );
    expect(r.reason).toContain("recipient");
  });

  it("formats thousands with separators", () => {
    const r = draftOf(
      composeDraft(
        facts({
          rate_usd: 1850,
          allowed_rates: [1850],
          load: { ...LOAD, offered_rate_usd: 1850 },
        }),
      ),
    );
    expect(r.draft.body).toContain("$1,850");
  });
});

describe("decline", () => {
  it("names the load and rate when known, commits to nothing", () => {
    const r = draftOf(composeDraft(facts({ intent: "decline" })));
    expect(r.draft.subject).toBe("Re: load 29372490");
    expect(r.draft.body).toContain("pass on this one");
    expect(r.draft.body).toContain("$950");
  });

  it("renders without a load", () => {
    const r = draftOf(
      composeDraft(
        facts({
          intent: "decline",
          load: null,
          rate_usd: null,
          allowed_rates: [],
        }),
      ),
    );
    expect(r.draft.subject).toBe("Re: your message");
    expect(r.draft.body).not.toContain("load");
  });
});

describe("availability_reply", () => {
  it("pitches the load with the posted rate when no rate_usd was given", () => {
    const r = draftOf(
      composeDraft(facts({ intent: "availability_reply", rate_usd: null })),
    );
    expect(r.draft.body).toContain("load 29372490");
    expect(r.draft.body).toContain("posted at $950");
  });

  it("without a load, acknowledges without inventing one", () => {
    const r = draftOf(
      composeDraft(
        facts({
          intent: "availability_reply",
          load: null,
          rate_usd: null,
          allowed_rates: [],
        }),
      ),
    );
    expect(r.draft.body).toContain("nothing on the board fits right now");
    expect(r.draft.body).not.toMatch(/\$\d/);
  });
});

describe("info_request", () => {
  it("bullets the requested items", () => {
    const r = draftOf(
      composeDraft(
        facts({
          intent: "info_request",
          rate_usd: null,
          missing_info: ["updated insurance certificate", "MC number"],
        }),
      ),
    );
    expect(r.draft.body).toContain("- updated insurance certificate");
    expect(r.draft.body).toContain("- MC number");
    expect(r.draft.subject).toContain("29372490");
  });

  it("refuses with nothing to ask for", () => {
    const r = refusalOf(
      composeDraft(
        facts({ intent: "info_request", rate_usd: null, missing_info: [] }),
      ),
    );
    expect(r.reason).toContain("missing_info");
  });
});

describe("review-round regressions", () => {
  it("a resolved name without an email address is still refused (dead letter)", () => {
    const r = refusalOf(
      composeDraft(
        facts({
          recipient: { name: "Tarek", email: null, carrier_mc: null },
        }),
      ),
    );
    expect(r.reason).toContain("email address");
  });

  it("a pickup date before REFERENCE_DATE is flagged as past, never restated as live", () => {
    const stale = { ...LOAD, pickup_date: "2026-05-21" };
    const r = draftOf(composeDraft(facts({ load: stale })));
    expect(r.draft.body).toContain("has passed");
    expect(r.draft.body).toContain("2026-05-21");
    expect(r.draft.body).not.toContain("Pickup 2026-05-21");
  });

  it("availability_reply also flags a stale schedule", () => {
    const stale = { ...LOAD, pickup_date: "2026-05-20" };
    const r = draftOf(
      composeDraft(
        facts({ intent: "availability_reply", load: stale, rate_usd: null }),
      ),
    );
    expect(r.draft.body).toContain("has passed");
    expect(r.draft.body).not.toContain("Pickup 2026-05-20");
  });

  it("a future schedule still renders as live detail", () => {
    const r = draftOf(composeDraft(facts()));
    expect(r.draft.body).toContain("Pickup 2026-05-27");
    expect(r.draft.body).not.toContain("has passed");
  });
});
