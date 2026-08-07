/**
 * Confusion-matrix math for judge calibration. Pure, no I/O, no API.
 *
 * Positive-class convention: **PASS is the positive class.**
 *   TPR = P(judge PASS | human pass)  -> recall on good drafts
 *   TNR = P(judge FAIL | human fail)  -> the failure-catching rate
 * Raw agreement is deliberately NOT the headline: a judge that always says PASS
 * scores 80% agreement on this set while catching zero failures.
 */

export type HumanLabel = "pass" | "fail";

export type Confusion = {
  /** human pass, judge PASS */
  tp: number;
  /** human fail, judge PASS (a missed failure) */
  fp: number;
  /** human fail, judge FAIL */
  tn: number;
  /** human pass, judge FAIL (a false alarm) */
  fn: number;
};

export type Metrics = Confusion & {
  n: number;
  tpr: number;
  tnr: number;
  accuracy: number;
  kappa: number;
};

export function confusionFrom(
  pairs: { human: HumanLabel; judgePassed: boolean }[],
): Confusion {
  const c: Confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const p of pairs) {
    if (p.human === "pass") {
      if (p.judgePassed) c.tp++;
      else c.fn++;
    } else {
      if (p.judgePassed) c.fp++;
      else c.tn++;
    }
  }
  return c;
}

/**
 * Cohen's kappa for the 2x2 human-vs-judge table.
 *
 *   po = observed agreement = (tp + tn) / n
 *   pe = chance agreement   = P(both PASS) + P(both FAIL)
 *      = ((tp+fn)/n * (tp+fp)/n) + ((fp+tn)/n * (fn+tn)/n)
 *   kappa = (po - pe) / (1 - pe)
 *
 * Bands used in the report: >0.8 excellent, 0.6-0.8 good, <0.6 rewrite criteria.
 * Degenerate case (pe == 1, i.e. both raters used a single label): returns 1 on
 * perfect agreement, else 0 — kappa is undefined there and 0 is the
 * conservative read.
 */
export function cohensKappa({ tp, fp, tn, fn }: Confusion): number {
  const n = tp + fp + tn + fn;
  if (n === 0) return 0;
  const po = (tp + tn) / n;
  const humanPass = (tp + fn) / n;
  const humanFail = (fp + tn) / n;
  const judgePass = (tp + fp) / n;
  const judgeFail = (fn + tn) / n;
  const pe = humanPass * judgePass + humanFail * judgeFail;
  if (pe >= 1) return po === 1 ? 1 : 0;
  return (po - pe) / (1 - pe);
}

/** Rates are NaN-free: an empty class yields 0, which reads correctly in a report. */
export function metricsFrom(c: Confusion): Metrics {
  const n = c.tp + c.fp + c.tn + c.fn;
  const positives = c.tp + c.fn;
  const negatives = c.tn + c.fp;
  return {
    ...c,
    n,
    tpr: positives === 0 ? 0 : c.tp / positives,
    tnr: negatives === 0 ? 0 : c.tn / negatives,
    accuracy: n === 0 ? 0 : (c.tp + c.tn) / n,
    kappa: cohensKappa(c),
  };
}

export function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
