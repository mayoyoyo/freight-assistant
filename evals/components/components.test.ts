/**
 * Tests for the Phase 4C component evals.
 *
 * Two kinds only, both deterministic:
 *   1. META-TESTS — feed the comparators deliberately corrupted input and
 *      assert they report the failure. The eval scored 100% on the real
 *      pipeline; an eval that has never been observed to fail proves nothing,
 *      so these are the tests that make the 100% meaningful.
 *   2. STRUCTURAL — properties of the committed gold files that hold by
 *      construction (sample composition, coverage, sourcing).
 *
 * Deliberately NOT tested: the accuracy numbers themselves. Pinning "100%" in a
 * test turns any legitimate pipeline change into a red build and quietly
 * converts the eval into a regression lock.
 */
import { describe, expect, it } from "vitest";
import {
  fieldsEqual,
  type GoldFields,
  type GoldRecord,
  loadExtraction,
  loadGold,
  runExtractionEval,
  SCORED_FIELDS,
} from "./extraction-eval";
import {
  type InquiryRow,
  loadInquiries,
  loadResolutionGold,
  runResolutionEval,
} from "./resolution-eval";
import {
  assertInvariants,
  EXPECTED_CALL_COUNT,
  REQUIRED_EXTRACTION_IDS,
} from "./run";
import { wilson } from "./stats";

describe("fieldsEqual", () => {
  it("compares MC numbers and load refs as digits, so formatting is not a miss", () => {
    expect(fieldsEqual("mc_number", "456012", "45-6012")).toBe(true);
    expect(fieldsEqual("mc_number", "876543", "MC 876543")).toBe(true);
    expect(fieldsEqual("load_reference", "29372421", "#29372421")).toBe(true);
  });

  it("still catches a genuinely different number", () => {
    // call_006's trap: the pre-correction value must not be accepted.
    expect(fieldsEqual("mc_number", "345678", "345878")).toBe(false);
    expect(fieldsEqual("mc_number", "456012", "45601")).toBe(false);
  });

  it("treats null and a value as different in both directions", () => {
    expect(fieldsEqual("mc_number", null, "774321")).toBe(false);
    expect(fieldsEqual("mc_number", "774321", null)).toBe(false);
    expect(fieldsEqual("rate_usd", null, 280)).toBe(false);
  });

  it("does not normalise non-identifier fields", () => {
    expect(fieldsEqual("rate_usd", 280, 280)).toBe(true);
    expect(fieldsEqual("rate_usd", 280, 240)).toBe(false);
    expect(fieldsEqual("equipment", "Box Truck", "box truck")).toBe(false);
  });
});

describe("extraction eval meta-tests", () => {
  const corrupt = (
    id: string,
    field: keyof GoldFields,
    value: unknown,
  ): ((i: string) => GoldFields) => {
    return (i: string) => {
      const base = loadExtraction(i);
      return i === id ? { ...base, [field]: value } : base;
    };
  };

  it("reports zero disagreements on the real, uncorrupted pipeline output", () => {
    const r = runExtractionEval();
    expect(r.disagreements.map((d) => `${d.id}:${d.field}`)).toEqual([]);
  });

  it("catches the pre-correction MC on call_006 (345878 instead of 345678)", () => {
    const r = runExtractionEval(
      loadGold(),
      corrupt("call_006_rate_negotiation", "mc_number", "345878"),
    );
    expect(r.disagreements).toHaveLength(1);
    expect(r.disagreements[0]).toMatchObject({
      id: "call_006_rate_negotiation",
      field: "mc_number",
      gold: "345678",
      extracted: "345878",
    });
    expect(r.recordExact.correct).toBe(14);
  });

  it("catches an omission decoy being 'filled in' from the dataset label", () => {
    // CE0042 states no MC in its body; the dataset claims 774321. An extractor
    // that leaked the decoy would look like this.
    const r = runExtractionEval(
      loadGold(),
      corrupt("CE0042", "mc_number", "774321"),
    );
    expect(r.disagreements).toHaveLength(1);
    expect(r.disagreements[0]?.gold).toBeNull();
  });

  it("catches the broker's rate being taken instead of the carrier's", () => {
    // CE0149: $250 is the broker's posted rate, $290 the carrier's ask.
    const r = runExtractionEval(loadGold(), corrupt("CE0149", "rate_usd", 250));
    expect(r.disagreements).toHaveLength(1);
    expect(r.disagreements[0]).toMatchObject({ field: "rate_usd", gold: 290 });
  });

  it("marks any unexplained disagreement UNADJUDICATED rather than passing it", () => {
    const r = runExtractionEval(
      loadGold(),
      corrupt("CE0074", "equipment", "Flatbed"),
    );
    expect(r.disagreements[0]?.verdict).toBe("UNADJUDICATED");
  });
});

describe("resolution eval meta-tests", () => {
  it("reports zero misses on the real, uncorrupted pipeline output", () => {
    expect(runResolutionEval().misses).toEqual([]);
  });

  it("catches call_046 resolving to the planted MC instead of the real carrier", () => {
    // 665432 matches no carrier; resolving to "nothing" must score as a miss.
    const rows = new Map(loadInquiries());
    const row = rows.get("call_046_load_details") as InquiryRow;
    rows.set("call_046_load_details", {
      ...row,
      resolvedCarrierId: null,
      resolvedCarrierMc: null,
      resolutionMethod: null,
    });
    const r = runResolutionEval(loadResolutionGold(), rows);
    expect(r.misses).toHaveLength(1);
    expect(r.misses[0]).toMatchObject({
      id: "call_046_load_details",
      goldCarrierId: 41,
      gotCarrierId: null,
    });
  });

  it("does NOT penalise a correct resolution to a carrier whose own MC is null", () => {
    // call_038 resolves to BLUE EAGLE LOGISTICS, which has no MC on file.
    // Scoring resolvedCarrierMc instead of carrier identity would fail this.
    const r = runResolutionEval();
    expect(r.misses.some((m) => m.id === "call_038_compliance_check")).toBe(
      false,
    );
    const row = loadInquiries().get("call_038_compliance_check");
    expect(row?.resolvedCarrierMc).toBeNull();
    expect(row?.resolvedCarrierId).toBe(30);
  });

  it("catches a wrong-carrier resolution on an ordinary call", () => {
    const rows = new Map(loadInquiries());
    const row = rows.get("call_001_rate_negotiation") as InquiryRow;
    rows.set("call_001_rate_negotiation", { ...row, resolvedCarrierId: 2 });
    const r = runResolutionEval(loadResolutionGold(), rows);
    expect(r.misses.map((m) => m.id)).toEqual(["call_001_rate_negotiation"]);
  });
});

describe("gold file structure", () => {
  it("passes every structural invariant", () => {
    const failures = assertInvariants(runExtractionEval(), runResolutionEval())
      .filter((i) => !i.ok)
      .map((i) => `${i.name}: ${i.detail}`);
    expect(failures).toEqual([]);
  });

  it("covers the stratification the eval design asked for", () => {
    const gold = loadGold();
    const calls = gold.filter((g) => g.sourceType === "call");
    const emails = gold.filter((g) => g.sourceType === "email");

    expect(emails).toHaveLength(8);
    expect(calls).toHaveLength(7);
    // >= 2 emails with an MC actually present in the body
    expect(
      emails.filter((e) => e.gold.mc_number !== null).length,
    ).toBeGreaterThanOrEqual(2);
    // >= 3 omission decoys (dataset claims an MC, body has none)
    expect(
      emails.filter((e) => e.gold.mc_number === null).length,
    ).toBeGreaterThanOrEqual(3);
    // >= 2 emails carrying a dollar figure
    expect(
      emails.filter((e) => e.gold.rate_usd !== null).length,
    ).toBeGreaterThanOrEqual(2);
    for (const id of REQUIRED_EXTRACTION_IDS) {
      expect(gold.map((g) => g.id)).toContain(id);
    }
  });

  it("grades every call in the corpus for resolution", () => {
    const calls = loadResolutionGold().filter((g) => g.sourceType === "call");
    expect(calls).toHaveLength(EXPECTED_CALL_COUNT);
    expect(new Set(calls.map((c) => c.id)).size).toBe(EXPECTED_CALL_COUNT);
  });

  it("has a scored value for every field of every gold record", () => {
    for (const g of loadGold()) {
      for (const f of SCORED_FIELDS) {
        expect(g.gold, `${g.id} missing ${f}`).toHaveProperty(f);
      }
    }
  });

  it("records exactly one gold entry per id", () => {
    const check = (rows: { id: string }[]) =>
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    check(loadGold() as GoldRecord[]);
    check(loadResolutionGold());
  });
});

describe("wilson", () => {
  it("returns a real lower bound at p=1, where the normal interval degenerates", () => {
    const { lower, upper } = wilson(15, 15);
    expect(upper).toBe(1);
    expect(lower).toBeGreaterThan(0.79);
    expect(lower).toBeLessThan(0.8);
  });

  it("is symmetric about 0.5 and matches the textbook 50/100 interval", () => {
    const { lower, upper } = wilson(50, 100);
    expect(lower).toBeCloseTo(0.4038, 3);
    expect(upper).toBeCloseTo(0.5962, 3);
  });

  it("narrows as n grows", () => {
    const small = wilson(9, 10);
    const large = wilson(900, 1000);
    expect(large.upper - large.lower).toBeLessThan(small.upper - small.lower);
  });
});
