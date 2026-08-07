import { describe, expect, it } from "vitest";
import { median, percentile, wilson } from "./stats";

describe("wilson", () => {
  /**
   * Three published anchors. The first two are the textbook worked examples;
   * the third is the case the design doc quotes (and quotes wrongly).
   */
  it("matches the published 50/100 interval", () => {
    const { lo, hi } = wilson(50, 100);
    expect(lo).toBeCloseTo(0.4038, 4);
    expect(hi).toBeCloseTo(0.5962, 4);
  });

  it("matches the published 0/10 rule-of-three-ish interval", () => {
    const { lo, hi } = wilson(0, 10);
    expect(lo).toBeCloseTo(0, 6);
    expect(hi).toBeCloseTo(0.2775, 4);
  });

  it("gives [64.1%, 93.3%] at 20/24 (design doc says ~96% upper — it is wrong)", () => {
    const { lo, hi } = wilson(20, 24);
    expect(lo).toBeCloseTo(0.6415, 3);
    expect(hi).toBeCloseTo(0.9332, 3);
  });

  it("never runs outside [0, 1]", () => {
    for (const [x, n] of [
      [0, 1],
      [1, 1],
      [24, 24],
      [0, 24],
    ] as const) {
      const { lo, hi } = wilson(x, n);
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(1);
      expect(lo).toBeLessThanOrEqual(hi);
    }
  });

  it("has non-zero width at p = 1, unlike Wald", () => {
    const { lo, hi } = wilson(24, 24);
    expect(hi).toBe(1);
    expect(lo).toBeGreaterThan(0.8);
    expect(lo).toBeLessThan(1);
  });

  it("narrows as n grows at fixed p", () => {
    const small = wilson(8, 10);
    const large = wilson(800, 1000);
    expect(large.hi - large.lo).toBeLessThan(small.hi - small.lo);
  });
});

describe("median / percentile", () => {
  it("handles even and odd lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("uses nearest-rank for percentiles", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(xs, 0.95)).toBe(19);
    expect(percentile(xs, 0.5)).toBe(10);
    expect(percentile(xs, 1)).toBe(20);
  });

  it("is empty-safe", () => {
    expect(median([])).toBe(0);
    expect(percentile([], 0.95)).toBe(0);
  });
});
