/**
 * Per-case assertion table for the `exact-match` grader (factual_lookup bucket).
 *
 * WHY A TABLE AND NOT A LOOP OVER `gold`
 * The eight factual cases have eight different gold field sets — L02 grades MC
 * digits only, L07 grades a verdict word plus arithmetic, L08 grades a number
 * that must NOT be a different number in the same answer. A generic "assert
 * every gold value appears" loop would be wrong on at least four of them. So the
 * mapping from gold field -> assertion is written out, one commented line each.
 *
 * THE RULE FOR WHAT GETS ASSERTED IN CODE (applied uniformly below)
 *   Assert iff the gold field is (a) a number / id / proper name that must
 *   literally appear in the answer, or (b) the subject of an explicit
 *   "GRADER NOTE:" / "JUDGMENT CALL:" / `must_state` clause in the case notes.
 *   Everything else — prose claims, tone, attribution ("is the $420 attributed
 *   to the load or to a carrier?") — is left to the judge and is marked
 *   `// -> judge` below. Nothing is silently dropped.
 *
 * PROXIES FOR PROSE CLAIMS ARE DELIBERATELY GENEROUS. A code grader's job here
 * is a near-zero false-FAIL rate: a false fail flips a correct answer and
 * poisons the headline pass rate. Open-ended claims ("no carrier quoted",
 * "that MC resolves to nothing") are therefore matched by token conjunction —
 * subject + negation inside one sentence — not by a whitelist of phrasings.
 * `one-of` survives only where the vocabulary really is small and closed.
 */

export type Assertion =
  /** A gold number must appear (tolerant of `$`, thousands, trailing zeros). */
  | { kind: "number"; label: string; value: number }
  /** A gold string must appear (case- and whitespace-insensitive). */
  | { kind: "string"; label: string; value: string }
  /** At least one of several accepted renderings must appear. */
  | { kind: "one-of"; label: string; values: string[] }
  /**
   * A pattern that MUST match. Used instead of `one-of` wherever the claim is
   * open-ended English ("MC 665432 does not exist in our carrier records"), so
   * the check is a token conjunction — subject + negation inside one sentence —
   * rather than a whitelist of phrasings the labeler happened to think of.
   * A phrase whitelist there produces false FAILS, which is the worst kind of
   * grader bug: it flips a correct answer and poisons the pass rate.
   */
  | { kind: "pattern"; label: string; pattern: RegExp }
  /** A pattern that must NOT match anywhere in the answer. */
  | { kind: "absent"; label: string; pattern: RegExp }
  /**
   * If `ifPresent` appears, then one of `thenOneOf` must appear too.
   * Exists for L08: naming the bad extraction 2800 is fine, asserting it as the
   * offer is not — so 2800 is admissible only when flagged.
   */
  | {
      kind: "conditional";
      label: string;
      ifPresent: string;
      thenOneOf: string[];
    };

export type GoldSpec = {
  /** One line on what this case is really testing. */
  about: string;
  assertions: Assertion[];
};

/**
 * OPEN-ENDED CLAIMS ARE MATCHED BY TOKEN CONJUNCTION, NOT BY PHRASE LISTS.
 *
 * Every pattern below is "the subject and a negation/verdict marker inside one
 * sentence". They replaced phrase whitelists after a live L03 run answered
 * "MC 665432 does not exist in our carrier records" — textbook correct — and
 * was failed because that exact wording was not on the list. Assume the model
 * writes fluent English; grade the claim, not the phrasing.
 */

const NEG = "no|not|n't|never|none|nothing|neither|nobody|no one|nor";
const NEG_VERB =
  "doesn'?t|does not|isn'?t|is not|aren'?t|are not|hasn'?t|has not|haven'?t|have not|can'?t|cannot|failed to|couldn'?t";

/** gold.carrier_quote_exists = false — "no carrier has put a number on the table". */
const NO_CARRIER_RATE = new RegExp(
  `\\b(?:${NEG})\\b[^.!?\\n]{0,70}\\b(carrier|carriers|quot\\w*|offer\\w*|counter\\w*|bid|rate|number)\\b` +
    `|\\b(carrier|carriers|they|both inquiries|neither)\\b[^.!?\\n]{0,70}\\b(?:${NEG_VERB})\\b[^.!?\\n]{0,40}\\b(quot\\w*|offer\\w*|nam\\w*|giv\\w*|state\\w*|propos\\w*)\\b` +
    `|\\basking (us|goodlane|the broker)\\b`,
  "i",
);

/** gold.bookable = false — "do not put them on a load right now". */
const NOT_BOOKABLE = new RegExp(
  `(^|\\n)\\s*(\\*\\*)?\\s*no\\b` +
    `|\\b(?:${NEG}|don'?t|do not|can'?t|cannot|shouldn'?t|should not|wouldn'?t|would not|avoid|hold off)\\b[^.!?\\n]{0,70}\\b(book\\w*|dispatch\\w*|tender\\w*|assign\\w*|use them|put them on|clear to)\\b` +
    `|\\bnot (right now|until|without|clear|safe|advisable|good to)\\b` +
    `|\\bhold off\\b|\\bnot bookable\\b`,
  "i",
);

/**
 * gold.mc_low_confidence = true — the digits were unclear on the recording and
 * the system prompt requires saying so. Broad on purpose: this is a caveat
 * check, and a caveat written three different ways is still a caveat.
 */
const PROVISIONAL_MC = [
  "low confidence",
  "low-confidence",
  "low_confidence",
  "provisional",
  "unclear",
  "not clear",
  "wasn't clear",
  "garbled",
  "muffled",
  "misheard",
  "mishear",
  "couldn't make out",
  "could not make out",
  "hard to make out",
  "hard to hear",
  "uncertain",
  "not certain",
  "unreliable",
  "flagged",
  "verify",
  "confirm the mc",
  "confirm that mc",
  "double-check",
  "double check",
  "worth confirming",
  "should be confirmed",
  "treat it as",
];

/**
 * gold.stated_mc_resolves = false — "the MC the caller gave matches nothing".
 * The number and an absence marker, either order, inside one sentence.
 */
const MC_DOES_NOT_RESOLVE = (mc: string) =>
  new RegExp(
    `\\b${mc}\\b[^.!?\\n]{0,80}\\b(?:${NEG}|${NEG_VERB}|unrecognized|unknown|unmatched|invalid)\\b` +
      `|\\b(?:${NEG}|${NEG_VERB}|unrecognized|unknown|unmatched|invalid)\\b[^.!?\\n]{0,80}\\b${mc}\\b`,
    "i",
  );

/** gold.verdict = "above" — our rate sits above the market number. */
const ABOVE_MARKET = new RegExp(
  `\\babove\\b[^.!?\\n]{0,40}\\b(market|average|avg|4-week|four-week|benchmark|lane)\\b` +
    `|\\b(market|average|avg|benchmark)\\b[^.!?\\n]{0,40}\\b(is |sits |runs )?(below|under|less than|lower)\\b` +
    `|\\bwell over (the )?(market|average)\\b|\\bpremium to (the )?market\\b`,
  "i",
);

export const GOLD_SPECS: Record<string, GoldSpec> = {
  // -------------------------------------------------------------------------
  L01: {
    about:
      "Best OFFER on load 29372450 — no carrier has quoted; the only figure is our own posted $420.",
    assertions: [
      // gold.posted_rate_usd = 420 — the only real figure on this load.
      { kind: "number", label: "posted_rate_usd", value: 420 },
      // gold.referencing_inquiry_ids = [CE0057, CE0058] (also required_source_ids).
      { kind: "string", label: "referencing_inquiry_ids[0]", value: "CE0057" },
      { kind: "string", label: "referencing_inquiry_ids[1]", value: "CE0058" },
      // gold.carrier_quote_exists = false. Token conjunction (negation + a
      // quote/carrier/rate word in one sentence) — the loosest assertion in
      // this table, kept because "no carrier named a rate" IS the answer.
      {
        kind: "pattern",
        label: "carrier_quote_exists=false",
        pattern: NO_CARRIER_RATE,
      },
      // gold.best_carrier_offer_usd = null -> no positive form to assert; the
      // pattern above carries it, and `dollar-figures-subset` catches invention.
      // gold.expected_claim (prose) -> judge: "is $420 attributed to the load
      // and not to a carrier?" is an attribution question, not a string match.
    ],
  },

  // -------------------------------------------------------------------------
  L02: {
    about:
      "Garbled/self-corrected MC on call_006 — the broker wrote 345878, the caller said 345678.",
    assertions: [
      // gold.correct_mc_number = "345678". Notes: "Grading the MC digits only."
      { kind: "string", label: "correct_mc_number", value: "345678" },
      // gold.broker_stated_mc_is_wrong = true -> implied by the digits above;
      // no reliable lexical form for "you wrote it down wrong". -> judge.
      // company_name / source_call_id were never asserted here, per the notes'
      // "Grading the MC digits only." They have since been moved out of `gold`
      // and into L02's notes, so `gold` holds only what is actually contracted;
      // the call id stays enforceable via required_source_ids + groundedness.
      // gold.mc_low_confidence = false -> the notes forbid requiring a
      // provisional caveat here (the DB says the digits were NOT unclear), so
      // this case deliberately has no PROVISIONAL_MC assertion. Contrast L06.
    ],
  },

  // -------------------------------------------------------------------------
  L03: {
    about:
      "Planted wrong MC 665432 on call_046; name-fuzzy resolution recovers 663210 / CROSSROADS TRANSPORT INC.",
    assertions: [
      // gold.resolved_mc_number = "663210" — notes: must "land on 663210".
      { kind: "string", label: "resolved_mc_number", value: "663210" },
      // gold.company_name = "CROSSROADS TRANSPORT INC". Asserted without the
      // "INC" so "Crossroads Transport, Inc." and the bare name both pass.
      { kind: "string", label: "company_name", value: "Crossroads Transport" },
      // gold.stated_mc_resolves = false — notes: "Must state that 665432
      // matches no carrier". Two parts: the number, and a no-match phrase.
      { kind: "string", label: "stated_mc (the bad one)", value: "665432" },
      {
        kind: "pattern",
        label: "stated_mc_resolves=false",
        pattern: MC_DOES_NOT_RESOLVE("665432"),
      },
      // gold.mc_low_confidence = true -> the digits were unclear on the tape.
      {
        kind: "one-of",
        label: "mc_low_confidence=true",
        values: PROVISIONAL_MC,
      },
      // gold.resolution_method = "name_fuzzy" -> internal pipeline detail, not
      // something a broker-facing answer must name. -> judge (nice-to-have).
      // gold.source_call_id -> groundedness.
    ],
  },

  // -------------------------------------------------------------------------
  L04: {
    about:
      "Compliance trap: MC 712843 authority is ACTIVE, INSURANCE is what expired (2026-05-15).",
    assertions: [
      // gold.company_name = "Blue Ridge Transport LLC" (asserted without LLC).
      { kind: "string", label: "company_name", value: "Blue Ridge Transport" },
      // gold.bookable = false.
      { kind: "pattern", label: "bookable=false", pattern: NOT_BOOKABLE },
      // gold.authority_status = "ACTIVE". Notes: an answer that blocks on
      // authority "is wrong for the right reason and fails the gold field
      // check" — so asserting an authority defect is a hard fail here. The
      // tempered `(?!insurance)` stops "authority is ACTIVE, insurance expired"
      // from matching.
      {
        kind: "absent",
        label: "authority_status=ACTIVE (no authority defect claim)",
        pattern:
          /\bauthority\b(?:(?!insurance)[^.!?\n]){0,25}\b(not active|inactive|revoked|suspended|conditional|lapsed|expired|not in good standing)\b/i,
      },
      {
        kind: "absent",
        label: "authority_status=ACTIVE (reverse word order)",
        pattern:
          /\b(revoked|suspended|inactive|conditional|lapsed)\b(?:(?!insurance)[^.!?\n]){0,15}\bauthority\b/i,
      },
      // gold.insurance_expiry = "2026-05-15", gold.insurance_expired = true,
      // gold.reference_date = "2026-05-25" -> all three are carried by
      // `compliance-surfacing` (compliance_must_surface = ["insurance expired
      // 2026-05-15 (before 2026-05-25)"]). Not duplicated here.
    ],
  },

  // -------------------------------------------------------------------------
  L05: {
    about:
      "Regression (equipment blind): highest carrier quote on a BOX TRUCK LOAD is $890 [CE0099], not $540.",
    assertions: [
      // gold.highest_rate_usd = 890.
      { kind: "number", label: "highest_rate_usd", value: 890 },
      // gold.inquiry_id = "CE0099".
      { kind: "string", label: "inquiry_id", value: "CE0099" },
      // gold.from_name = "Nkechi Adeyemi" / gold.carrier_mc = "109876" — the
      // answer must identify WHO quoted, by either handle.
      {
        kind: "one-of",
        label: "from_name | carrier_mc",
        values: ["Nkechi", "109876"],
      },
      // gold.load_reference = "29000138" -> supporting detail; a correct answer
      // need not name the load. -> judge.
      // gold.runner_up_rate_usd / runner_up_inquiry_id -> context for the
      // labeler, not a requirement on the answer. -> not asserted.
    ],
  },

  // -------------------------------------------------------------------------
  L06: {
    about:
      "Regression (ASR-name echo): call_002's carrier of record is CHAHAL TRUCKING INC, not the transcript's 'Chapel Trucking'.",
    assertions: [
      // gold.company_name = "CHAHAL TRUCKING INC" — notes: "giving only 'Chapel
      // Trucking' fails". Asserted without INC.
      { kind: "string", label: "company_name", value: "Chahal Trucking" },
      // gold.mc_number = "538772".
      { kind: "string", label: "mc_number", value: "538772" },
      // gold.mc_low_confidence = true -> system prompt: "treat that MC number
      // as provisional and say so". (Opposite of L02, where the flag is false.)
      {
        kind: "one-of",
        label: "mc_low_confidence=true",
        values: PROVISIONAL_MC,
      },
      // gold.transcript_renders_name_as = "Chapel Trucking Incorporated" ->
      // notes: naming the variant "IS allowed and useful", so it is neither
      // required nor forbidden. Not asserted.
    ],
  },

  // -------------------------------------------------------------------------
  L07: {
    about:
      "Regression (verdict flip): 29372343 at $275/54mi = $5.09/mi vs a $3.925/mi 4-week market — ABOVE.",
    assertions: [
      // gold.verdict = "above".
      { kind: "pattern", label: "verdict=above", pattern: ABOVE_MARKET },
      // GRADER NOTE (case notes): "this case must check that no sentence in the
      // answer asserts 'below market' — a mid-answer self-correction still
      // fails, because the skimmable headline is the deliverable."
      // Negated forms ("not below market") and a restatement of the broker's
      // own "above or below market" phrasing are excluded by the lookbehinds.
      {
        kind: "absent",
        label: "GRADER NOTE: no 'below market' assertion anywhere",
        pattern:
          /(?<!not )(?<!n't )(?<!or )\b(below|under)\b[^.!?\n]{0,30}\bmarket\b/i,
      },
      // gold.load_rate_per_mile = 5.09 — the arithmetic the verdict rests on.
      { kind: "number", label: "load_rate_per_mile", value: 5.09 },
      // gold.market_avg_rate_per_mile_4wk = 3.925 — the comparison basis.
      // Accepts 3.925 / 3.93 / 3.92 (see numberForms).
      { kind: "number", label: "market_avg_rate_per_mile_4wk", value: 3.925 },
      // gold.offered_rate_usd = 275 — given in the query, still cheap to check.
      { kind: "number", label: "offered_rate_usd", value: 275 },
      // gold.distance_miles = 54 -> an input to 5.09; asserting it too would
      // add no discriminating power and one more false-fail surface.
      // gold.weeks_with_data = 2 / gold.window_weeks = 4 -> scope detail a good
      // answer mentions; not required. -> judge.
    ],
  },

  // -------------------------------------------------------------------------
  L08: {
    about:
      "CE0027: the body says $280, extracted_rate_usd says 2800 (a real 10x extraction bug).",
    assertions: [
      // gold.rate_offered_usd = 280 — the BODY figure is the answer.
      { kind: "number", label: "rate_offered_usd", value: 280 },
      // gold.extracted_rate_usd = 2800 + gold.extraction_is_wrong = true:
      // notes say "Reporting 2800 as the offer is a fail; the strongest answers
      // report 280 AND flag the 2800 extraction as wrong." So 2800 is
      // admissible only when accompanied by a flagging word.
      {
        kind: "conditional",
        label:
          "extracted_rate_usd=2800 must be flagged, not reported as the offer",
        ifPresent: "2800",
        thenOneOf: [
          "extraction",
          "extracted",
          "discrepancy",
          "incorrect",
          "wrong",
          "10x",
          "10×",
          "error",
          "mis-extract",
          "misextract",
          "flag",
          "bug",
          "off by",
          "should be",
        ],
      },
      // gold.discrepancy_flags = ["rate_found_but_stated_null"] -> the flag name
      // itself need not be quoted; the conditional above covers the substance.
      // gold.from_name = "Carlos Mendez" -> named in the query. Not asserted.
    ],
  },
};
