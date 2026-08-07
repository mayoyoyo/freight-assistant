/**
 * Reporting statistics. Pure functions, unit-tested — the headline number in
 * the report is only as trustworthy as this file.
 */

/** 95% two-sided normal quantile. */
export const Z_95 = 1.959963984540054;

export type Interval = { lo: number; hi: number };

/**
 * Wilson score interval for a binomial proportion.
 *
 *   centre = (p + z^2/2n) / (1 + z^2/n)
 *   half   = z/(1 + z^2/n) * sqrt( p(1-p)/n + z^2/(4n^2) )
 *
 * Chosen over the normal (Wald) approximation because at n=24 with p near 1
 * Wald produces intervals that run past 1.0 and collapse to zero width at
 * p=1 — both nonsense. Wilson is well behaved at the boundaries.
 *
 * Verified in `stats.test.ts` against three published values:
 *   50/100 -> [40.4%, 59.6%],  0/10 -> [0%, 27.75%],  20/24 -> [64.1%, 93.3%].
 * Note the design doc quotes 20/24 as "~[65%, 96%]" — the upper bound there is
 * wrong; the correct Wilson upper bound is 93.3%. The report uses this code.
 */
export function wilson(successes: number, n: number, z = Z_95): Interval {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

export function pct(x: number, digits = 1): string {
  return `${(100 * x).toFixed(digits)}%`;
}

export function fmtInterval(i: Interval): string {
  return `[${pct(i.lo)}, ${pct(i.hi)}]`;
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Nearest-rank percentile (p in [0,1]). p95 of 20 samples is the 19th. */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil(p * s.length);
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))] as number;
}
