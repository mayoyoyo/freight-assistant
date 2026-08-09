/**
 * Spec invariant: "MC digit spans with word-confidence < 0.85 are flagged
 * low_confidence." This is computed in CODE from the VERBATIM Deepgram track,
 * never asked of the model — a model has no access to per-word ASR confidence
 * and would only be guessing.
 *
 * Why the verbatim track: the smart_format track collapses a dictated MC into
 * a single mangled token ("300And45800And78"), so there is no per-digit
 * confidence left to inspect. Without smart formatting the digits stay as
 * individual number-words, each with its own confidence score.
 */

/** Words that can appear inside a spoken MC number. */
const NUMBER_WORDS = new Set([
  "zero",
  "oh",
  "o",
  "nil",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fourty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
  "dash",
]);

/** Glue that occurs *inside* a spoken number ("three hundred AND forty five"). */
const GLUE_WORDS = new Set(["and"]);

/** How far after an "MC" mention we look for the digits. */
const SEARCH_WINDOW = 20;
/**
 * A repeat-back ("yeah, 345678") or correction ("wait, number 345678") starts
 * within a couple of words of the first span. Kept deliberately tight: widen it
 * and the span swallows the rate quoted a sentence later.
 */
const REPEAT_GAP = 4;

export const MC_CONFIDENCE_THRESHOLD = 0.85;

export type ConfWord = { word: string; confidence?: number };

const normalize = (w: string): string => w.toLowerCase().replace(/[^a-z]/g, "");

/**
 * Words belonging to the MC digit span(s) that follow each "MC" mention.
 *
 * Per mention we take the first run of number-words within SEARCH_WINDOW, plus
 * one immediately-following run if it starts within REPEAT_GAP words — that
 * second run is the confirmation repeat-back ("yeah, 345678") or the caller's
 * self-correction ("wait — number 345678"), both of which are part of the same
 * dictation. Anything further out (a rate, a load number) is deliberately
 * excluded.
 */
export function mcSpanWords(words: ConfWord[]): ConfWord[] {
  const norm = words.map((w) => normalize(w.word));
  const span: ConfWord[] = [];

  const runAt = (start: number): number => {
    // Returns the exclusive end index of the number-word run starting at `start`.
    let end = start;
    while (end < norm.length) {
      const w = norm[end] ?? "";
      if (NUMBER_WORDS.has(w) || (end > start && GLUE_WORDS.has(w))) end++;
      else break;
    }
    // A run must not end on glue ("...forty five and" → drop the "and").
    while (end > start && GLUE_WORDS.has(norm[end - 1] ?? "")) end--;
    return end;
  };

  for (let i = 0; i < norm.length; i++) {
    if (norm[i] !== "mc") continue;

    // First run of number-words inside the window after this "MC".
    let first = -1;
    for (let j = i + 1; j < Math.min(norm.length, i + 1 + SEARCH_WINDOW); j++) {
      if (NUMBER_WORDS.has(norm[j] ?? "")) {
        first = j;
        break;
      }
    }
    if (first === -1) continue;

    const firstEnd = runAt(first);
    span.push(...words.slice(first, firstEnd));

    // Confirmation repeat-back / self-correction.
    let second = -1;
    for (
      let j = firstEnd;
      j < Math.min(norm.length, firstEnd + REPEAT_GAP);
      j++
    ) {
      if (NUMBER_WORDS.has(norm[j] ?? "")) {
        second = j;
        break;
      }
    }
    if (second !== -1) span.push(...words.slice(second, runAt(second)));
  }

  return span;
}

/**
 * True when any word in a transcribed MC digit span scored below the
 * threshold. False when the call states no MC at all (nothing to doubt) —
 * "we couldn't hear it" and "they never said it" are different conditions, and
 * only the first is a low-confidence read.
 */
export function mcLowConfidence(
  words: ConfWord[],
  threshold: number = MC_CONFIDENCE_THRESHOLD,
): boolean {
  return mcSpanWords(words).some(
    (w) => typeof w.confidence === "number" && w.confidence < threshold,
  );
}
