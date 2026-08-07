import { describe, expect, it } from "vitest";
import {
  assertDerivedCoverage,
  bool,
  type DerivedInquiry,
  derivedInquirySchema,
  num,
  reqNum,
  str,
} from "./seed-helpers";

describe("coercion helpers", () => {
  it("num accepts native JSON numbers (PR #1 review: carrier profiles are JSON, not CSV)", () => {
    expect(num(4.2)).toBe(4.2);
    expect(num(0)).toBe(0);
    expect(num("4.2")).toBe(4.2);
    expect(num("")).toBeNull();
    expect(num(null)).toBeNull();
    expect(num("abc")).toBeNull();
    expect(num(Number.NaN)).toBeNull();
  });

  it("str trims and nulls empties, never stringifies non-strings", () => {
    expect(str(" x ")).toBe("x");
    expect(str("")).toBeNull();
    expect(str(false)).toBeNull();
    expect(str(3)).toBeNull();
  });

  it("bool passes booleans through and nulls everything else", () => {
    expect(bool(true)).toBe(true);
    expect(bool(false)).toBe(false);
    expect(bool("true")).toBeNull();
    expect(bool(1)).toBeNull();
  });

  it("reqNum throws with context instead of silently defaulting", () => {
    expect(reqNum("5.01", "rate_history row 1")).toBe(5.01);
    expect(() => reqNum("", "rate_history row 2 avg_rate_per_mile")).toThrow(
      /rate_history row 2/,
    );
  });
});

const validRow: DerivedInquiry = {
  id: "CE0001",
  sourceType: "email",
  occurredAt: "2026-05-20T10:00:00Z",
  fromName: "A",
  fromEmail: "a@b.c",
  subject: "s",
  rawText: "body",
  statedMcNumber: null,
  statedLoadReference: null,
  statedEquipment: null,
  statedIntent: null,
  statedRateQuotedUsd: null,
  extractedMcNumber: "123456",
  extractedLoadReference: null,
  extractedEquipment: null,
  extractedIntent: "inquiry",
  extractedRateUsd: null,
  extractedAvailability: "unknown",
  extractedExtras: null,
  resolvedCarrierId: null,
  resolvedCarrierMc: null,
  resolutionMethod: null,
  discrepancyFlags: [],
  mcLowConfidence: false,
};

describe("derivedInquirySchema", () => {
  it("accepts a complete row", () => {
    expect(derivedInquirySchema.parse(validRow)).toBeTruthy();
  });

  it("rejects unknown keys (catches stated/extracted field crossover)", () => {
    expect(() =>
      derivedInquirySchema.parse({ ...validRow, extracted_mc_number: "x" }),
    ).toThrow();
  });

  it("rejects missing provenance fields", () => {
    const { sourceType: _drop, ...withoutSourceType } = validRow;
    expect(() => derivedInquirySchema.parse(withoutSourceType)).toThrow();
  });
});

describe("assertDerivedCoverage", () => {
  const rowFor = (id: string): DerivedInquiry => ({ ...validRow, id });

  it("passes on exact coverage", () => {
    expect(() =>
      assertDerivedCoverage(
        [rowFor("CE1"), rowFor("call_001")],
        ["CE1"],
        ["call_001"],
      ),
    ).not.toThrow();
  });

  it("fails when a partial file would replace the full dataset", () => {
    expect(() =>
      assertDerivedCoverage([rowFor("CE1")], ["CE1", "CE2"], ["call_001"]),
    ).toThrow(/Missing/);
  });

  it("fails on duplicates and unexpected ids", () => {
    expect(() =>
      assertDerivedCoverage([rowFor("CE1"), rowFor("CE1")], ["CE1"], []),
    ).toThrow(/Duplicate/);
    expect(() =>
      assertDerivedCoverage([rowFor("CE1"), rowFor("ghost")], ["CE1"], []),
    ).toThrow(/unexpected/);
  });
});
