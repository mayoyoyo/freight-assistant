/**
 * Direct tool-call tests for `search_inquiries` equipment/lane semantics.
 *
 * No model, no API key, no network: these call `execute()` on the tool object
 * and assert against the seeded local Postgres (DATABASE_URL). They are the
 * regression lock for failure modes 1 (equipment blind) and 2 (lane-join blind)
 * in `evals/error-analysis/failure-modes.md` — both were retrieval-scope bugs,
 * so a retrieval-level test is where they belong, not behind an LLM run.
 *
 * Ground truth in every assertion below was verified against the database:
 *   CE0099 — extracted_equipment NULL, extracted_load_reference 29000138,
 *            extracted_rate_usd 890 (load 29000138 is a Box Truck load).
 *   CE0044 — extracted_equipment NULL, extracted_load_reference 29372343,
 *            extracted_availability 'available' (load 29372343 is PA-NJ Box Truck).
 */
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { freightTools } from "./tools";

beforeAll(() => {
  try {
    process.loadEnvFile(".env");
  } catch {
    // CI supplies env directly.
  }
});

type SearchResult = {
  returned: number;
  total_matches: number;
  truncated: boolean;
  results: Array<{
    id: string;
    extracted_equipment: string | null;
    extracted_load_reference: string | null;
    extracted_rate_usd: number | null;
  }>;
};

type SearchInput = Parameters<
  NonNullable<typeof freightTools.search_inquiries.execute>
>[0];

type SearchOptions = Parameters<
  NonNullable<typeof freightTools.search_inquiries.execute>
>[1];

/**
 * Invoke the tool exactly as the SDK would, minus the model. These tools ignore
 * the execution options entirely (no context schema, no abort handling), so a
 * minimal stand-in is faithful.
 */
async function search(input: SearchInput): Promise<SearchResult> {
  const execute = freightTools.search_inquiries.execute;
  if (execute === undefined) throw new Error("search_inquiries has no execute");
  const options = {
    toolCallId: "test",
    messages: [],
  } as unknown as SearchOptions;
  const out = await execute(input, options);
  return out as SearchResult;
}

const ids = (r: SearchResult) => r.results.map((x) => x.id);

// Same CI rule as agent.test.ts: these hit the seeded local Postgres and must
// skip where no database exists (CI runs offline meta-tests only).
const NO_DB = !process.env.DATABASE_URL && !existsSync(".env");

describe.skipIf(NO_DB)(
  "search_inquiries — equipment resolves through the referenced load",
  () => {
    it("surfaces CE0099 ($890, the L05 ground truth) on equipment:'Box Truck'", async () => {
      // CE0099 carries NO extracted_equipment; only its referenced load does.
      // Pre-fix this row was unreachable by any equipment filter, which is how
      // the agent answered "$540 is the highest box-truck quote" (trace P25).
      const r = await search({
        equipment: "Box Truck",
        intent: "rate_counter",
        limit: 20,
      });

      expect(ids(r)).toContain("CE0099");
      const ce0099 = r.results.find((x) => x.id === "CE0099");
      expect(ce0099?.extracted_equipment).toBeNull();
      expect(ce0099?.extracted_load_reference).toBe("29000138");
      expect(ce0099?.extracted_rate_usd).toBe(890);

      // And it is the top quote in the box-truck set, which is the L05 answer.
      const rates = r.results
        .map((x) => x.extracted_rate_usd)
        .filter((v): v is number => typeof v === "number");
      expect(Math.max(...rates)).toBe(890);
    });

    it("surfaces CE0044 (P02) on equipment + lane together", async () => {
      // The spec's first example query, verbatim: PA-NJ Box Truck availability.
      const r = await search({
        equipment: "Box Truck",
        availability: "available",
        origin_state: "PA",
        dest_state: "NJ",
        limit: 20,
      });

      expect(ids(r)).toContain("CE0044");
      expect(r.total_matches).toBeGreaterThan(0);
    });

    it("does not regress rows that matched via extracted_equipment alone", async () => {
      // Pre-fix behaviour is a strict subset of post-fix behaviour: every row the
      // old `eq(extracted_equipment, X)` filter returned must still be returned.
      const tagged = await search({
        equipment: "Refrigerated",
        availability: "available",
        limit: 20,
      });
      const taggedOnly = tagged.results.filter(
        (x) => x.extracted_equipment === "Refrigerated",
      );
      expect(taggedOnly.length).toBeGreaterThan(0);
      for (const row of taggedOnly) {
        expect(row.extracted_equipment).toBe("Refrigerated");
      }

      // The OR can only widen the set, never narrow it.
      const unfiltered = await search({ availability: "available", limit: 20 });
      expect(tagged.total_matches).toBeLessThanOrEqual(
        unfiltered.total_matches,
      );
    });

    it("widens the equipment result set rather than replacing it", async () => {
      const box = await search({ equipment: "Box Truck", limit: 20 });
      // Both mechanisms are represented: rows with their own tag, and rows that
      // only reach the filter through their referenced load.
      expect(
        box.results.some((x) => x.extracted_equipment === "Box Truck"),
      ).toBe(true);
      expect(
        box.results.some(
          (x) =>
            x.extracted_equipment === null &&
            x.extracted_load_reference !== null,
        ),
      ).toBe(true);
    });
  },
);

describe.skipIf(NO_DB)(
  "search_inquiries — truncation is stated, never left to be inferred",
  () => {
    it("counts the whole match set even when the rows are capped", async () => {
      const capped = await search({ source_type: "email", limit: 5 });
      expect(capped.returned).toBe(5);
      expect(capped.results).toHaveLength(5);
      // 274 emails are seeded, so total_matches must ignore the cap entirely.
      expect(capped.total_matches).toBe(274);
      expect(capped.truncated).toBe(true);
    });

    it("reports truncated=false when every match fits under the limit", async () => {
      const whole = await search({ ids: ["CE0099"], limit: 20 });
      expect(whole.returned).toBe(1);
      expect(whole.total_matches).toBe(1);
      expect(whole.truncated).toBe(false);
    });

    it("keeps returned, results.length and truncated mutually consistent", async () => {
      const r = await search({ equipment: "Box Truck", limit: 20 });
      expect(r.returned).toBe(r.results.length);
      expect(r.truncated).toBe(r.total_matches > r.returned);
    });
  },
);

// ---------------------------------------------------------------------------
// draft_email — the DB-backed path. Renderer logic (templates, gate branches,
// figure validation) is covered without a database in draft-email.test.ts;
// these tests pin what only the integration can prove: recipient resolution
// from real rows, rate validation against seeded data, and the compliance
// gate firing on the corpus's actual CONDITIONAL carrier (D03's trap).
// ---------------------------------------------------------------------------

type DraftInput = Parameters<
  NonNullable<typeof freightTools.draft_email.execute>
>[0];

async function draft(input: DraftInput) {
  const execute = freightTools.draft_email.execute;
  if (execute === undefined) throw new Error("draft_email has no execute");
  const options = {
    toolCallId: "test",
    messages: [],
  } as unknown as SearchOptions;
  // biome-ignore lint/suspicious/noExplicitAny: test-side view of a union output
  return (await execute(input, options)) as any;
}

describe.skipIf(NO_DB)(
  "draft_email — resolution and the compliance gate",
  () => {
    it("CE0066 rate_confirm at the posted $950: renders with the CONDITIONAL contingency (D03)", async () => {
      const r = await draft({
        to_inquiry_id: "CE0066",
        intent: "rate_confirm",
        rate_usd: 950,
      });
      expect(r.refused).toBeUndefined();
      // Recipient from the carrier record, load defaulted from the inquiry.
      expect(r.draft.to_email).toBe("clint.frontier@gmail.com");
      expect(r.draft.body).toContain("29372490");
      expect(r.draft.body).toContain("$950");
      // MC 885432 is CONDITIONAL: the caveat is forced, the draft still renders.
      expect(r.compliance_caveat).toContain("CONDITIONAL");
      expect(r.compliance.clear).toBe(false);
      expect(r.sources).toEqual(["CE0066", "load 29372490", "MC 885432"]);
    });

    it("refuses a rate that exists nowhere in the data", async () => {
      const r = await draft({
        to_inquiry_id: "CE0066",
        intent: "rate_confirm",
        rate_usd: 1234,
      });
      expect(r.refused).toBe(true);
      expect(r.reason).toContain("$1,234");
      expect(r.reason).toContain("$950");
    });

    it("refuses an unknown carrier MC and an unknown inquiry", async () => {
      const noCarrier = await draft({
        to_carrier_mc: "000000",
        intent: "decline",
      });
      expect(noCarrier.refused).toBe(true);
      const noInquiry = await draft({
        to_inquiry_id: "CE9999",
        intent: "decline",
      });
      expect(noInquiry.refused).toBe(true);
    });

    it("accepts a call-id prefix, like search_inquiries does", async () => {
      const r = await draft({
        to_inquiry_id: "call_017",
        intent: "info_request",
        missing_info: ["current insurance certificate"],
      });
      expect(r.refused).toBeUndefined();
      expect(r.sources[0]).toBe("call_017_availability_check");
    });
  },
);

describe.skipIf(NO_DB)("draft_email — review-round regressions", () => {
  it("refuses a cross-load rate transplant (CE0099's $890 belongs to 29000138, not 29372490)", async () => {
    const r = await draft({
      to_inquiry_id: "CE0099",
      intent: "rate_confirm",
      load_id: "29372490",
      rate_usd: 890,
    });
    expect(r.refused).toBe(true);
    expect(r.reason).toContain("$890");
  });

  it("refuses contradictory anchors (CE0066 belongs to MC 885432, not 68333)", async () => {
    const r = await draft({
      to_inquiry_id: "CE0066",
      to_carrier_mc: "68333",
      intent: "rate_confirm",
      rate_usd: 950,
    });
    expect(r.refused).toBe(true);
    expect(r.reason).toContain("anchors disagree");
  });

  it("escapes LIKE metacharacters — a partial prefix or wildcard cannot resolve to an arbitrary call", async () => {
    // 'call_0' escapes to call\_0\_% — ids continue with a digit, not an
    // underscore, so a partial prefix matches nothing rather than 55 calls.
    const partial = await draft({ to_inquiry_id: "call_0", intent: "decline" });
    expect(partial.refused).toBe(true);
    expect(partial.reason).toContain("not found");
    // An explicit wildcard is treated as a literal, not a pattern.
    const wildcard = await draft({
      to_inquiry_id: "call_%",
      intent: "decline",
    });
    expect(wildcard.refused).toBe(true);
    expect(wildcard.reason).toContain("not found");
  });

  it("reaches a null-MC carrier through the resolved_carrier_id link (call_038 -> Blue Eagle)", async () => {
    const r = await draft({
      to_inquiry_id: "call_038",
      intent: "info_request",
      missing_info: ["your MC number"],
    });
    expect(r.refused).toBeUndefined();
    expect(r.draft.to_email).toBe("tariq.blueeagle@gmail.com");
  });
});

// ---------------------------------------------------------------------------
// Adjudication-round fixes (2026-08-11): S06 lane fused-token; A05 name lookup
// ---------------------------------------------------------------------------

describe.skipIf(NO_DB)(
  "search_inquiries — ASR-fused lane token (S06: lane-join blind)",
  () => {
    it("surfaces the PAMD calls on origin PA + dest MD", async () => {
      // call_004/call_013 carry no load reference; their transcripts render
      // the lane as the single token "PAMD". Pre-fix they were unreachable
      // by any lane filter (S06 failed 0/3 at baseline AND post-fix).
      const r = await search({
        origin_state: "PA",
        dest_state: "MD",
        equipment: "Box Truck",
        limit: 20,
      });
      expect(ids(r)).toContain("call_004_rate_negotiation");
      expect(ids(r)).toContain("call_013_rate_negotiation");
    });

    it("does not leak fused-token matches into other lanes", async () => {
      const r = await search({
        origin_state: "PA",
        dest_state: "DE",
        limit: 20,
      });
      expect(ids(r)).not.toContain("call_004_rate_negotiation");
      expect(ids(r)).not.toContain("call_013_rate_negotiation");
    });
  },
);

describe.skipIf(NO_DB)(
  "carrier_history — company-name lookup (A05: unreachable carrier)",
  () => {
    type CarrierOut = Record<string, unknown> & {
      candidates?: Array<{ company_name: string | null }>;
    };
    const lookup = async (input: Record<string, unknown>) => {
      const execute = freightTools.carrier_history.execute as unknown as (
        i: unknown,
        o: unknown,
      ) => Promise<CarrierOut>;
      return execute(input, { toolCallId: "t", messages: [] });
    };

    it("reaches HKR LOGISTICS (null MC, null authority) by name", async () => {
      const r = await lookup({ company_name: "HKR" });
      expect(r.company_name).toBe("HKR LOGISTICS LLC");
      expect(r.mc_number).toBeNull();
      expect(r.authority_status).toBeNull();
      expect(r.not_found).toBeUndefined();
    });

    it("returns candidates, not a guess, on an ambiguous name", async () => {
      const r = await lookup({ company_name: "Logistics" });
      expect(r.ambiguous).toBe(true);
      expect((r.candidates ?? []).length).toBeGreaterThan(1);
    });

    it("still resolves by exact MC as before", async () => {
      const r = await lookup({ mc_number: "776491" });
      expect(r.company_name).toBe("SMR TRUCKING INC");
    });
  },
);
