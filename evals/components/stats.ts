/**
 * Wilson score interval for a binomial proportion.
 *
 * Used instead of the normal ("Wald") interval because every result in this
 * phase sits at or near p=1, where Wald degenerates to the useless [1, 1].
 * Wilson still returns a real lower bound, and publishing that width is the
 * point: 15/15 is not evidence of a 100% extractor, it is evidence that the
 * true rate is probably above ~80%.
 */
export type Interval = { lower: number; upper: number };

export function wilson(successes: number, n: number, z = 1.96): Interval {
  if (n === 0) return { lower: 0, upper: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = n + z2;
  const center = (successes + z2 / 2) / denom;
  const half = (z / denom) * Math.sqrt(p * (1 - p) * n + z2 / 4);
  return {
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
  };
}

export function formatInterval(successes: number, n: number): string {
  const { lower, upper } = wilson(successes, n);
  return `[${(100 * lower).toFixed(1)}%, ${(100 * upper).toFixed(1)}%]`;
}
