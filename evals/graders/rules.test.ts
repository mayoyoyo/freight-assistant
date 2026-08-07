import { describe, expect, it } from "vitest";
import { abstention } from "./abstention";
import { complianceSurfacing, complianceTokens } from "./compliance-surfacing";
import { exactMatch } from "./exact-match";
import { makeCase, makeRun, makeTool } from "./fixtures";
import { requiredTools } from "./required-tools";
import { setF1 } from "./set-f1";
import {
  datePresent,
  dollarFigures,
  extractInquiryIds,
  numberPresent,
  parseCitations,
} from "./text";

/**
 * Unit tests for the documented rules the graders rest on.
 *
 * The three-fixture meta-tests in `graders.test.ts` prove each grader runs,
 * catches its defect and short-circuits out of scope. These pin the *rules* —
 * number tolerance, the citation ignore-list, the compliance token conjunction,
 * and the per-case judgment calls quoted from `cases.jsonl` notes — so a
 * well-meant tweak to a regex cannot silently change what "pass" means.
 */

describe("number tolerance", () => {
  it("accepts the renderings a broker-facing answer actually uses", () => {
    expect(numberPresent("we can do $890", 890)).toBe(true);
    expect(numberPresent("890.00 flat", 890)).toBe(true);
    expect(numberPresent("total 1,480,355 lbs", 1480355)).toBe(true);
    expect(numberPresent("$5.09/mi", 5.09)).toBe(true);
    // market_rate returns 3.925; "$3.93/mi" and "$3.92/mi" are both it.
    expect(numberPresent("market is $3.93/mi", 3.925)).toBe(true);
    expect(numberPresent("market is $3.92/mi", 3.925)).toBe(true);
    expect(numberPresent("market is 3.925", 3.925)).toBe(true);
  });

  it("does not match a gold number hiding inside another number", () => {
    expect(numberPresent("load 1890 pays", 890)).toBe(false);
    expect(numberPresent("$8900", 890)).toBe(false);
    expect(numberPresent("$890.50", 890)).toBe(false);
    expect(numberPresent("$275", 27)).toBe(false);
  });
});

describe("date tolerance", () => {
  it("accepts ISO and the two US renderings", () => {
    expect(datePresent("expired 2026-05-15", "2026-05-15")).toBe(true);
    expect(datePresent("expired May 15, 2026", "2026-05-15")).toBe(true);
    expect(datePresent("expired 5/15/2026", "2026-05-15")).toBe(true);
  });
  it("rejects a neighbouring date", () => {
    expect(datePresent("expired 2026-05-16", "2026-05-15")).toBe(false);
  });
});

describe("dollar figure extraction", () => {
  it("collects quoted figures and skips derived rate-per-mile", () => {
    expect(dollarFigures("posted $275, market $3.93/mi, fuel $1,200")).toEqual([
      275, 1200,
    ]);
    expect(dollarFigures("$5.09 per mile")).toEqual([]);
  });
});

describe("citation parsing", () => {
  it("recognizes the four system-prompt forms, including multi-id spans", () => {
    const tokens = parseCitations(
      "a [CE0074] b [call_006] c [load 29372515] d [MC 876543] e [CE0044, CE0045]",
    ).map((c) => c.token);
    expect(tokens).toEqual([
      "CE0074",
      "CALL_006",
      "29372515",
      "876543",
      "CE0044",
      "CE0045",
    ]);
  });

  it("ignores markdown links, footnote markers and prose brackets", () => {
    expect(
      parseCitations(
        "see the [rate sheet](https://x.test) [1] [12] [see below]",
      ),
    ).toEqual([]);
  });

  it("still reads an id out of a mixed span", () => {
    expect(parseCitations("[CE0044, see below]").map((c) => c.token)).toEqual([
      "CE0044",
    ]);
  });

  it("normalizes call ids to the prefix the system prompt asks agents to cite", () => {
    expect(
      extractInquiryIds("call_017_availability_check and call_017"),
    ).toEqual(["CALL_017"]);
  });
});

describe("compliance token conjunction", () => {
  it("derives the load-bearing tokens of the four live requirement strings", () => {
    const tokens = (s: string) => complianceTokens(s).map((t) => t.token);
    // Parenthetical dropped: the snapshot date is context, not the claim.
    expect(tokens("insurance expired 2026-05-15 (before 2026-05-25)")).toEqual([
      "insurance",
      "expired",
      "2026-05-15",
    ]);
    // "not ACTIVE" — ACTIVE is the negated foil and is dropped.
    expect(tokens("authority status is CONDITIONAL, not ACTIVE")).toEqual([
      "authority",
      "conditional",
    ]);
    expect(tokens("MC 678234 insurance expiry unknown")).toEqual([
      "678234",
      "insurance",
      "expiry",
      "unknown",
    ]);
    expect(tokens("authority status cannot be verified")).toEqual([
      "authority",
      "cannot",
      "verified",
    ]);
  });

  it("accepts synonyms for the status words but still requires every token", () => {
    const c = makeCase({
      id: "S02",
      bucket: "set_retrieval",
      compliance_must_surface: ["MC 678234 insurance expiry unknown"],
    });
    const ok = complianceSurfacing.grade(
      c,
      makeRun(c, {
        text: "CE0060 is from MC 678234, whose insurance expiration date is not on file.",
      }),
    );
    expect(ok.passed).toBe(true);

    const bad = complianceSurfacing.grade(
      c,
      makeRun(c, {
        text: "CE0060 is from MC 678234, insurance on file.",
      }),
    );
    expect(bad.passed).toBe(false);
    expect(bad.reason).toMatch(/missing/);
  });

  it("S02: the caveat is only owed when the answer raises CE0060 (per the case notes)", () => {
    const c = makeCase({
      id: "S02",
      bucket: "set_retrieval",
      compliance_must_surface: ["MC 678234 insurance expiry unknown"],
    });
    const v = complianceSurfacing.grade(
      c,
      makeRun(c, { text: "CE0062, CE0063, CE0064 and CE0065 are available." }),
    );
    expect(v.passed).toBe(true);
    expect(v.reason.startsWith("n/a:")).toBe(true);
  });

  it("D03: flagging insurance (which is valid) fails; flagging authority passes", () => {
    const c = makeCase({
      id: "D03",
      bucket: "email_draft",
      compliance_must_surface: ["authority status is CONDITIONAL, not ACTIVE"],
    });
    const right = complianceSurfacing.grade(
      c,
      makeRun(c, {
        text: "Before dispatch: Frontier's operating authority is CONDITIONAL, so I've made the acceptance conditional on verification.",
      }),
    );
    expect(right.passed).toBe(true);

    const wrong = complianceSurfacing.grade(
      c,
      makeRun(c, {
        text: "Frontier's authority is CONDITIONAL. Also their insurance has expired, so we can't dispatch.",
      }),
    );
    expect(wrong.passed).toBe(false);
    expect(wrong.reason).toMatch(/insurance flagged as a problem/);
  });
});

describe("exact-match judgment calls quoted from the case notes", () => {
  const caseL02 = makeCase({
    id: "L02",
    bucket: "factual_lookup",
    gold: { correct_mc_number: "345678", mc_low_confidence: false },
  });

  it("L02 grades the MC digits only — no provisional caveat is required", () => {
    const v = exactMatch.grade(
      caseL02,
      makeRun(caseL02, {
        text: "She said MC 345678, not 345878 [call_006].",
      }),
    );
    expect(v.passed).toBe(true);
  });

  const caseL08 = makeCase({
    id: "L08",
    bucket: "factual_lookup",
    gold: { rate_offered_usd: 280, extracted_rate_usd: 2800 },
  });

  it("L08 allows 2800 only when it is flagged as the bad extraction", () => {
    const flagged = exactMatch.grade(
      caseL08,
      makeRun(caseL08, {
        text: "Carlos offered $280 [CE0027]. The extracted_rate_usd of 2800 is a 10x extraction error.",
      }),
    );
    expect(flagged.passed).toBe(true);

    const unflagged = exactMatch.grade(
      caseL08,
      makeRun(caseL08, {
        text: "Carlos offered $280 [CE0027]; the record also shows 2800.",
      }),
    );
    expect(unflagged.passed).toBe(false);
    expect(unflagged.reason).toMatch(/2800/);
  });

  it("fails loudly when a factual case has no gold spec (rather than silently n/a)", () => {
    const orphan = makeCase({ id: "L99", bucket: "factual_lookup" });
    const v = exactMatch.grade(orphan, makeRun(orphan, { text: "anything" }));
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/no gold spec for L99/);
  });
});

describe("set-f1 judgment calls quoted from the case notes", () => {
  const caseS02 = makeCase({
    id: "S02",
    bucket: "set_retrieval",
    gold: {
      dated_inquiry_ids: ["CE0062", "CE0063", "CE0064", "CE0065"],
      undated_call_ids: [
        "call_021_availability_check",
        "call_023_availability_check",
      ],
      must_state_calls_are_undated: true,
    },
  });

  it("S02: CE0060 / CE0061 are precision-neutral, not spurious", () => {
    const v = setF1.grade(
      caseS02,
      makeRun(caseS02, {
        text: "Four dated offers: CE0062, CE0063, CE0064, CE0065. CE0060 (availability unknown) and CE0061 (conditional) are outside that set. Calls call_021 and call_023 are undated, so no date filter reaches them.",
      }),
    );
    expect(v.passed).toBe(true);
    expect(v.reason).toMatch(/P=1 R=1 F1=1/);
  });

  it("S02: omitting the undated calls silently is a fail even at F1 1.0", () => {
    const v = setF1.grade(
      caseS02,
      makeRun(caseS02, {
        text: "Four available: CE0062, CE0063, CE0064, CE0065.",
      }),
    );
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/undated call\(s\) omitted silently/);
  });

  const caseS05 = makeCase({
    id: "S05",
    bucket: "set_retrieval",
    gold: {
      inquiry_ids: [
        "CE0044",
        "CE0045",
        "call_017_availability_check",
        "call_024_availability_check",
      ],
      excluded_ids: ["CE0046"],
    },
  });

  it("S05: excluded_ids is a must-not-appear check, named as such", () => {
    const clean = setF1.grade(
      caseS05,
      makeRun(caseS05, {
        text: "CE0044, CE0045, call_017 and call_024 all offered to cover it.",
      }),
    );
    expect(clean.passed).toBe(true);

    const dirty = setF1.grade(
      caseS05,
      makeRun(caseS05, {
        text: "CE0044, CE0045, CE0046, call_017 and call_024 all offered to cover it.",
      }),
    );
    expect(dirty.passed).toBe(false);
    expect(dirty.reason).toMatch(
      /excluded id\(s\) named in the answer: CE0046/,
    );
  });
});

describe("required-tools matching", () => {
  const c = makeCase({
    id: "D05",
    bucket: "email_draft",
    required_tools: [
      { name: "search_inquiries", args_subset: { ids: ["call_017"] } },
      { name: "get_load", args_subset: { load_id: "29372343" } },
      { name: "carrier_history", args_subset: {} },
    ],
  });

  it("accepts prefix call ids, string-vs-number load ids, extra args and any order", () => {
    const v = requiredTools.grade(
      c,
      makeRun(c, {
        tools: [
          makeTool({ name: "carrier_history", args: { mc_number: "776491" } }),
          makeTool({ name: "get_load", args: { load_id: 29372343 } }),
          makeTool({
            name: "search_inquiries",
            args: { ids: ["call_017_availability_check"], limit: 10 },
          }),
        ],
      }),
    );
    expect(v.passed).toBe(true);
  });

  it("names the unmet requirement and the args actually seen", () => {
    const v = requiredTools.grade(
      c,
      makeRun(c, {
        tools: [
          makeTool({ name: "carrier_history", args: { mc_number: "776491" } }),
          makeTool({ name: "get_load", args: { load_id: "29372450" } }),
        ],
      }),
    );
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/search_inquiries was never called/);
    expect(v.reason).toMatch(/get_load called but never with args/);
    expect(v.reason).toMatch(/29372450/);
  });
});

describe("abstention judgment calls quoted from the case notes", () => {
  const caseA03 = makeCase({
    id: "A03",
    bucket: "abstention",
    gold: {
      must_refuse: true,
      expected_phrase_class: "no_rate_data",
      must_not_invent: ["any $/mile figure for PA-NJ Flatbed"],
    },
  });

  it("A03: a labelled different-equipment rate passes; a PA-NJ Flatbed rate does not", () => {
    const ok = abstention.grade(
      caseA03,
      makeRun(caseA03, {
        text: "No rate data for PA-NJ Flatbed — rate_history has nothing for that lane and equipment. For reference only, PA-NJ Box Truck averaged $3.93/mi over the last 4 weeks.",
      }),
    );
    expect(ok.passed).toBe(true);

    const invented = abstention.grade(
      caseA03,
      makeRun(caseA03, {
        text: "No rate data on file, but PA-NJ flatbed is running about $3.10/mi right now.",
      }),
    );
    expect(invented.passed).toBe(false);
    expect(invented.reason).toMatch(/PA-NJ Flatbed/);
  });

  const caseA01 = makeCase({
    id: "A01",
    bucket: "abstention",
    gold: {
      must_refuse: true,
      expected_phrase_class: "not_in_data",
      must_not_invent: ["any lane, rate, date or status for this load"],
    },
  });

  it("A01: refusing with the snapshot date is fine; inventing a lane or rate is not", () => {
    const ok = abstention.grade(
      caseA01,
      makeRun(caseA01, {
        text: "No record of load 29999999 — I searched loads by exact id against the 2026-05-25 snapshot. Give me a lane, date or equipment and I'll look again.",
      }),
    );
    expect(ok.passed).toBe(true);

    const invented = abstention.grade(
      caseA01,
      makeRun(caseA01, {
        text: "No record of load 29999999 in our data; it looks like a PA-NJ run posted at $600.",
      }),
    );
    expect(invented.passed).toBe(false);
    expect(invented.reason).toMatch(/fabricated a rate/);
    expect(invented.reason).toMatch(/fabricated a lane/);
  });

  it("fails loudly on a phrase class with no accepted phrase list", () => {
    const c = makeCase({
      id: "A01",
      bucket: "abstention",
      gold: { expected_phrase_class: "made_up_class" },
    });
    const v = abstention.grade(c, makeRun(c, { text: "not in our data" }));
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/unknown expected_phrase_class/);
  });
});

/**
 * REGRESSION — false FAILS observed against live runs.
 *
 * These pin real answer text the agent under test actually produced. A grader
 * that fails one of them is not being strict, it is being wrong: it flips a
 * correct answer, and a case that flip-flops on the grader's vocabulary
 * corrupts the pass^k / flip-flopper table worse than a missing check would.
 */
describe("regression: fluent English must not be graded as a defect", () => {
  const caseL03 = makeCase({
    id: "L03",
    bucket: "factual_lookup",
    gold: {
      stated_mc_resolves: false,
      resolved_mc_number: "663210",
      company_name: "CROSSROADS TRANSPORT INC",
      mc_low_confidence: true,
    },
  });

  it("L03: 'MC 665432 does not exist in our carrier records' states stated_mc_resolves=false", () => {
    // Verbatim opening of a live L03 answer that the first, phrase-whitelist
    // version of this grader failed.
    const v = exactMatch.grade(
      caseL03,
      makeRun(caseL03, {
        text: "MC 665432 does not exist in our carrier records. Jean's call resolved by carrier name to CROSSROADS TRANSPORT INC, MC 663210 [call_046] — the MC digits were flagged low confidence on the recording, so treat them as provisional.",
      }),
    );
    expect(v.passed, v.reason).toBe(true);
  });

  it("L03: the other natural phrasings of the same claim also pass", () => {
    const variants = [
      "There is no carrier under MC 665432.",
      "MC 665432 matches nothing in the carrier table.",
      "665432 isn't a valid MC in our data.",
      "We have no record of MC 665432.",
    ];
    for (const opener of variants) {
      const v = exactMatch.grade(
        caseL03,
        makeRun(caseL03, {
          text: `${opener} Name resolution lands on CROSSROADS TRANSPORT INC, MC 663210 [call_046]; the digits were unclear on the tape.`,
        }),
      );
      expect(v.passed, `${opener} -> ${v.reason}`).toBe(true);
    }
  });

  it("typographic apostrophes must not defeat negation/refusal matching (live gpt-5.6-luna false-fail, 2026-08-07)", () => {
    // Verbatim from a live gpt-5.6-luna A01 run: a correct refusal written with
    // U+2019 apostrophes ("don’t", "can’t"). The pre-fix grader saw no negation
    // and failed the whole abstention bucket for the provider. Claude emits
    // ASCII apostrophes, so single-provider calibration could never catch this.
    const caseA01 = makeCase({
      id: "A01",
      bucket: "abstention",
      gold: {
        must_refuse: true,
        expected_phrase_class: "not_in_data",
        must_not_invent: ["any lane, rate, date or status for this load"],
      },
    });
    const v = abstention.grade(
      caseA01,
      makeRun(caseA01, {
        text: "I don’t have a load record for load **29999999** in the current data, so I can’t confirm its status, lane, dates, equipment, or rate. [load 29999999]",
      }),
    );
    expect(v.passed, v.reason).toBe(true);
  });

  it("A02: a conditional offer of help is not a fabrication (live opus false-fail, 2026-08-07)", () => {
    const caseA02 = makeCase({
      id: "A02",
      bucket: "abstention",
      gold: {
        must_refuse: true,
        expected_phrase_class: "no_such_sender",
        must_not_invent: ["an email body, date or company for Sarah Chen"],
      },
    });
    // Verbatim closing lines of three live opus A02 runs. Each mentions Sarah
    // Chen with a claim verb, but inside an "If ..." hypothetical.
    const closers = [
      "If Sarah Chen is a contact you know from outside this system, she may correspond under a different name or company in these records — give me the carrier name or MC number and I'll pull it.",
      "If Sarah Chen is a contact under a different spelling, or you have her MC number or a load she referenced, give me that and I'll pull the thread.",
      "If Sarah Chen is a carrier contact you expected to hear from, give me her MC number or carrier name and I'll pull the history directly.",
    ];
    for (const closer of closers) {
      const v = abstention.grade(
        caseA02,
        makeRun(caseA02, {
          text: `No email from a Sarah Chen exists in the inquiry data. ${closer}`,
        }),
      );
      expect(v.passed, v.reason).toBe(true);
    }
  });

  it("A04: 'closest name match' / 'close match … who you meant' label a different company (live opus false-fails, 2026-08-07)", () => {
    const caseA04 = makeCase({
      id: "A04",
      bucket: "abstention",
      gold: {
        must_refuse: true,
        expected_phrase_class: "no_such_carrier",
        must_not_invent: [
          "an authority status or insurance date for a carrier named Northeast Transport LLC",
        ],
      },
    });
    const labels = [
      "The closest name match is Northeast Cargo LLC, MC 1123456. If that's who you meant, they're clear: Authority ACTIVE.",
      "The only close match is Northeast Cargo LLC, MC 1123456 — if that's who you meant, they're clean: Authority ACTIVE.",
    ];
    for (const body of labels) {
      const v = abstention.grade(
        caseA04,
        makeRun(caseA04, {
          text: `No carrier named "Northeast Transport LLC" exists in the data. ${body}`,
        }),
      );
      expect(v.passed, v.reason).toBe(true);
    }
  });

  it("L03: an answer that stops at 'no such MC' still fails (the notes require landing on 663210)", () => {
    const v = exactMatch.grade(
      caseL03,
      makeRun(caseL03, {
        text: "MC 665432 does not exist in our carrier records, so I can't tell you who that is.",
      }),
    );
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/663210/);
  });

  const caseL01 = makeCase({
    id: "L01",
    bucket: "factual_lookup",
    gold: { posted_rate_usd: 420, carrier_quote_exists: false },
  });

  it("L01: four different ways of saying 'no carrier quoted' all pass", () => {
    const openers = [
      "No carrier has named a rate on this load.",
      "Neither inquiry contains a carrier quote.",
      "Nobody has put a number on it yet.",
      "There are no carrier-side offers on file.",
    ];
    for (const opener of openers) {
      const v = exactMatch.grade(
        caseL01,
        makeRun(caseL01, {
          text: `${opener} The only figure is our own posted $420 [load 29372450]; CE0057 and CE0058 both ask us for the rate.`,
        }),
      );
      expect(v.passed, `${opener} -> ${v.reason}`).toBe(true);
    }
  });

  const caseL07 = makeCase({
    id: "L07",
    bucket: "factual_lookup",
    gold: { verdict: "above", load_rate_per_mile: 5.09 },
  });

  it("L07: 'above' survives paraphrase, but a below-market headline still fails", () => {
    const ok = exactMatch.grade(
      caseL07,
      makeRun(caseL07, {
        text: "We're well above the 4-week average here: $275 over 54 miles is $5.09/mi versus $3.93/mi [load 29372343].",
      }),
    );
    expect(ok.passed, ok.reason).toBe(true);

    // Verbatim headline from the live L07 run that flipped mid-answer.
    const flipped = exactMatch.grade(
      caseL07,
      makeRun(caseL07, {
        text: "**Below market — by a wide margin.** Recomputing: $275 / 54 mi = $5.09/mi against $3.93/mi, so we are above market [load 29372343].",
      }),
    );
    expect(flipped.passed).toBe(false);
    expect(flipped.reason).toMatch(/below market/i);
  });

  const ABSTENTION_IDS: Record<string, string> = {
    not_in_data: "A01",
    no_such_sender: "A02",
    no_rate_data: "A03",
    no_such_carrier: "A04",
    cannot_verify_authority: "A05",
  };

  it("every abstention phrase class accepts a fluent refusal that is not on its phrase list", () => {
    const fluent: Record<string, string> = {
      not_in_data:
        "Load 29999999 doesn't appear anywhere in the snapshot — get_load returned nothing for that id.",
      no_such_sender:
        "Nobody by the name Sarah Chen has ever emailed us; the 'Sarah' hits are all our own dispatcher answering the phone.",
      no_rate_data:
        "rate_history holds nothing at all for PA-NJ Flatbed, so I can't give you a going rate.",
      no_such_carrier:
        "Northeast Transport LLC doesn't appear in our carrier table at all.",
      cannot_verify_authority:
        "I won't confirm anything about their standing — their authority is unknown on file.",
    };
    for (const [cls, text] of Object.entries(fluent)) {
      const c = makeCase({
        id: ABSTENTION_IDS[cls] ?? "A01",
        bucket: "abstention",
        gold: { must_refuse: true, expected_phrase_class: cls },
      });
      const v = abstention.grade(c, makeRun(c, { text }));
      expect(v.passed, `${cls} -> ${v.reason}`).toBe(true);
    }
  });

  it("an answer with no refusal at all still fails every phrase class", () => {
    for (const [cls, id] of Object.entries(ABSTENTION_IDS)) {
      const c = makeCase({
        id,
        bucket: "abstention",
        gold: { must_refuse: true, expected_phrase_class: cls },
      });
      const v = abstention.grade(
        c,
        makeRun(c, {
          text: "Here you go — everything looks fine on that one.",
        }),
      );
      expect(v.passed, `${cls} accepted a non-refusal`).toBe(false);
      expect(v.reason).toMatch(/no refusal of class/);
    }
  });
});
