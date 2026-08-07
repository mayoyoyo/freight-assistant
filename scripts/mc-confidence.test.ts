import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type ConfWord, mcLowConfidence, mcSpanWords } from "./mc-confidence";

/** Build a word list from a sentence; `low` names words given confidence 0.5. */
const words = (sentence: string, low: string[] = []): ConfWord[] =>
  sentence.split(" ").map((word, i) => ({
    word,
    confidence: low.includes(`${i}`) ? 0.5 : 0.99,
  }));

describe("mcSpanWords", () => {
  it("captures the digits following an MC mention", () => {
    const span = mcSpanWords(
      words("what's your mc number it's seven seven six four nine one got it"),
    );
    expect(span.map((w) => w.word)).toEqual([
      "seven",
      "seven",
      "six",
      "four",
      "nine",
      "one",
    ]);
  });

  it("spans a compound number including its internal 'and'", () => {
    const span = mcSpanWords(
      words("mc number is three hundred and forty five thousand okay"),
    );
    expect(span.map((w) => w.word)).toEqual([
      "three",
      "hundred",
      "and",
      "forty",
      "five",
      "thousand",
    ]);
  });

  it("captures a self-correction as part of the same dictation", () => {
    const span = mcSpanWords(
      words("mc number it's four five six wait number seven eight nine"),
    );
    expect(span.map((w) => w.word)).toEqual([
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
    ]);
  });

  it("does not reach past the digits into an unrelated later number", () => {
    const span = mcSpanWords(
      words(
        "mc number it's seven seven six four nine one got it and you're saying three hundred and ten dollars minimum",
      ),
    );
    expect(span.map((w) => w.word)).not.toContain("hundred");
    expect(span).toHaveLength(6);
  });

  it("returns nothing when the MC is not stated", () => {
    expect(
      mcSpanWords(words("can i get your mc number first it's not on file")),
    ).toEqual([]);
  });

  it("treats dash and nil as part of the span", () => {
    const span = mcSpanWords(
      words("mc number is four five dash six nil one two"),
    );
    expect(span.map((w) => w.word)).toEqual([
      "four",
      "five",
      "dash",
      "six",
      "nil",
      "one",
      "two",
    ]);
  });
});

describe("mcLowConfidence", () => {
  it("is false when every word in the span is confident", () => {
    expect(
      mcLowConfidence(words("mc number seven seven six four nine one")),
    ).toBe(false);
  });

  it("is true when any word in the span is below threshold", () => {
    // index 4 == "six"
    expect(
      mcLowConfidence(words("mc number seven seven six four nine one", ["4"])),
    ).toBe(true);
  });

  it("ignores low confidence outside the MC span", () => {
    // index 0 == "goodlane", nowhere near the digits
    expect(
      mcLowConfidence(
        words("goodlane dispatch mc number seven seven six", ["0"]),
      ),
    ).toBe(false);
  });

  it("is false when no MC was stated — nothing to doubt", () => {
    expect(
      mcLowConfidence(words("can i get your mc number first it's not on file")),
    ).toBe(false);
  });

  it("respects a custom threshold", () => {
    const w: ConfWord[] = [
      { word: "mc", confidence: 0.99 },
      { word: "seven", confidence: 0.9 },
    ];
    expect(mcLowConfidence(w, 0.85)).toBe(false);
    expect(mcLowConfidence(w, 0.95)).toBe(true);
  });
});

describe("call_006 verbatim fixture (real Deepgram output)", () => {
  const alt = (
    JSON.parse(
      readFileSync(
        "data/derived/transcripts-verbatim/call_006_rate_negotiation.json",
        "utf8",
      ),
    ) as {
      results: {
        channels: {
          alternatives: { transcript: string; words: ConfWord[] }[];
        }[];
      };
    }
  ).results.channels[0]?.alternatives[0];

  it("keeps the dictated MC as decodable number-words", () => {
    // The smart_format track renders this same span as "300And45800And78" —
    // unrecoverable. Verbatim keeps both the misspoken value and the correction.
    expect(alt?.transcript).toContain(
      "three hundred and forty five thousand eight hundred and seventy eight",
    );
    expect(alt?.transcript).toContain(
      "three hundred and forty five thousand six hundred and seventy eight",
    );
  });

  it("spans both the misspoken value and the self-correction", () => {
    const span = mcSpanWords(alt?.words ?? []);
    const text = span.map((w) => w.word).join(" ");
    expect(text).toContain("eight hundred and seventy eight");
    expect(text).toContain("six hundred and seventy eight");
  });
});
