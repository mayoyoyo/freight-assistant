/**
 * draft_email's brain: pure functions, no I/O beyond the REFERENCE_DATE
 * constant. The tool in `tools.ts` fetches the rows; everything here is
 * deterministic validation + string assembly, so the whole surface unit-tests
 * without a database — and the email a broker sees is a template speaking,
 * never model prose. Editing the voice of Goodlane's outbound mail means
 * editing this file, not a prompt.
 *
 * Two prompt-level guarantees become code here:
 *  - every dollar figure must already exist in the data (`allowed_rates`), so
 *    an invented rate is a refusal, not a plausible sentence;
 *  - the compliance gate: a rate confirmation for a carrier with concerns is
 *    either rendered WITH a mandatory contingency paragraph (e.g. CONDITIONAL
 *    authority) or refused outright (expired insurance, revoked authority).
 */

import { REFERENCE_DATE } from "@/lib/config";

export const DRAFT_INTENTS = [
  "rate_confirm",
  "decline",
  "availability_reply",
  "info_request",
] as const;

export type DraftIntent = (typeof DRAFT_INTENTS)[number];

export type DraftLoad = {
  load_id: string;
  origin: string;
  destination: string;
  equipment_type: string;
  weight_lbs: number | null;
  pickup_date: string | null;
  pickup_window: string | null;
  delivery_date: string | null;
  offered_rate_usd: number | null;
};

export type DraftCompliance = {
  authority_status: string | null;
  insurance_expiry: string | null;
  insurance_expired: boolean | null;
  clear: boolean;
  concerns: string[];
};

export type DraftFacts = {
  intent: DraftIntent;
  recipient: {
    name: string | null;
    email: string | null;
    carrier_mc: string | null;
  };
  inquiry_id: string | null;
  load: DraftLoad | null;
  compliance: DraftCompliance | null;
  rate_usd: number | null;
  /** Every dollar figure the data actually contains for this thread. */
  allowed_rates: number[];
  pickup_date: string | null;
  missing_info: string[];
};

export type DraftResult =
  | {
      draft: {
        to_name: string | null;
        to_email: string | null;
        subject: string;
        body: string;
      };
      /** Non-null when a contingency paragraph was forced into the body. */
      compliance_caveat: string | null;
    }
  | { refused: true; reason: string };

/**
 * Authority states that block a booking draft entirely. The corpus only
 * contains ACTIVE / CONDITIONAL / null, but a revocation must never render.
 */
const BLOCKING_AUTHORITY = [
  "REVOKED",
  "INACTIVE",
  "SUSPENDED",
  "OUT_OF_SERVICE",
];

const refuse = (reason: string): DraftResult => ({ refused: true, reason });

const money = (n: number) => `$${n.toLocaleString("en-US")}`;

const firstName = (name: string | null) =>
  name?.trim().split(/\s+/)[0] ?? "there";

export function composeDraft(f: DraftFacts): DraftResult {
  // An email without an address is not a draft, it's a dead letter — even
  // when a contact name resolved (e.g. an undated call with no sender email).
  if (!f.recipient.email) {
    return refuse(
      "recipient has no email address on file — cannot address the draft",
    );
  }

  // A figure the data does not contain must never leave this function.
  if (f.rate_usd !== null && !f.allowed_rates.includes(f.rate_usd)) {
    const known = f.allowed_rates.length
      ? `rates on record: ${f.allowed_rates.map(money).join(", ")}`
      : "no rate is on record for this load or inquiry";
    return refuse(
      `rate ${money(f.rate_usd)} matches nothing in the data (${known})`,
    );
  }

  if (
    f.pickup_date &&
    f.load?.pickup_date &&
    f.pickup_date !== f.load.pickup_date
  ) {
    return refuse(
      `pickup_date ${f.pickup_date} contradicts the load record (${f.load.pickup_date})`,
    );
  }

  switch (f.intent) {
    case "rate_confirm":
      return rateConfirm(f);
    case "decline":
      return decline(f);
    case "availability_reply":
      return availabilityReply(f);
    case "info_request":
      return infoRequest(f);
  }
}

// ---------------------------------------------------------------------------
// Per-intent templates. Short, professional, no filler; signed by dispatch.
// ---------------------------------------------------------------------------

const SIGN_OFF = "Thanks,\nGoodlane Dispatch";

function laneLine(load: DraftLoad): string {
  const weight = load.weight_lbs
    ? `, ${load.weight_lbs.toLocaleString("en-US")} lbs`
    : "";
  return `${load.origin} to ${load.destination}, ${load.equipment_type}${weight}`;
}

/**
 * The load's schedule, or — when it predates REFERENCE_DATE — an explicit
 * stale flag. A template that renders "Pickup 2026-05-21" four days after the
 * fact would be committing the exact hallucinated-logistics failure the D01
 * gold names; a past date must be surfaced as past, never restated as live.
 */
function scheduleInfo(load: DraftLoad): { line: string; stale: boolean } {
  const pickupPast =
    load.pickup_date !== null && load.pickup_date < REFERENCE_DATE;
  const deliveryPast =
    load.pickup_date === null &&
    load.delivery_date !== null &&
    load.delivery_date < REFERENCE_DATE;
  if (pickupPast || deliveryPast) {
    const which = pickupPast ? "pickup" : "delivery";
    const date = pickupPast ? load.pickup_date : load.delivery_date;
    return {
      line: `The posted ${which} date (${date}) has passed — please confirm updated timing.`,
      stale: true,
    };
  }
  const parts: string[] = [];
  if (load.pickup_date) {
    const window = load.pickup_window ? ` (${load.pickup_window})` : "";
    parts.push(`Pickup ${load.pickup_date}${window}`);
  }
  if (load.delivery_date) parts.push(`delivery ${load.delivery_date}`);
  return { line: parts.join("; "), stale: false };
}

function rateConfirm(f: DraftFacts): DraftResult {
  if (!f.load)
    return refuse(
      "rate_confirm needs a load_id — a booking must name its load",
    );
  if (f.rate_usd === null) {
    return refuse(
      "rate_confirm needs rate_usd — a booking must state its rate",
    );
  }
  if (!f.compliance) {
    return refuse(
      "carrier compliance is unknown (no carrier record) — a booking draft cannot render without it",
    );
  }
  if (
    f.compliance.insurance_expired === true ||
    BLOCKING_AUTHORITY.includes(f.compliance.authority_status ?? "")
  ) {
    return refuse(
      `compliance gate: ${f.compliance.concerns.join("; ")} — cannot render a booking draft for this carrier`,
    );
  }

  // Non-blocking concerns (CONDITIONAL authority, unknown expiry) render, but
  // the contingency paragraph is not optional and not removable.
  const caveat = f.compliance.clear
    ? null
    : `One thing before dispatch: our records show ${f.compliance.concerns.join(" and ")}. This confirmation is contingent on getting that cleared — please send updated documentation.`;

  const schedule = scheduleInfo(f.load);
  const body = [
    `Hi ${firstName(f.recipient.name)},`,
    `Confirming load ${f.load.load_id} — ${laneLine(f.load)} — at ${money(f.rate_usd)}.${!schedule.stale && schedule.line ? ` ${schedule.line}.` : ""}`,
    // A past schedule is its own paragraph: flagged, never restated as live.
    ...(schedule.stale ? [schedule.line] : []),
    ...(caveat ? [caveat] : []),
    "Please reply to confirm and we'll send over the rate confirmation.",
    SIGN_OFF,
  ].join("\n\n");

  return {
    draft: {
      to_name: f.recipient.name,
      to_email: f.recipient.email,
      subject: `Rate confirmation — load ${f.load.load_id} at ${money(f.rate_usd)}`,
      body,
    },
    compliance_caveat: caveat,
  };
}

function decline(f: DraftFacts): DraftResult {
  const about = f.load
    ? `your offer on load ${f.load.load_id}${f.rate_usd !== null ? ` at ${money(f.rate_usd)}` : ""}`
    : "your message";
  const body = [
    `Hi ${firstName(f.recipient.name)},`,
    `Thanks for ${about}. We're going to pass on this one, but please keep us posted on your availability.`,
    SIGN_OFF,
  ].join("\n\n");

  return {
    draft: {
      to_name: f.recipient.name,
      to_email: f.recipient.email,
      subject: f.load ? `Re: load ${f.load.load_id}` : "Re: your message",
      body,
    },
    compliance_caveat: null,
  };
}

function availabilityReply(f: DraftFacts): DraftResult {
  if (f.load) {
    const rate =
      f.rate_usd !== null
        ? `, posted at ${money(f.rate_usd)}`
        : f.load.offered_rate_usd !== null
          ? `, posted at ${money(f.load.offered_rate_usd)}`
          : "";
    const schedule = scheduleInfo(f.load);
    const body = [
      `Hi ${firstName(f.recipient.name)},`,
      `Thanks for the availability update. We have load ${f.load.load_id} that may fit: ${laneLine(f.load)}${rate}.${!schedule.stale && schedule.line ? ` ${schedule.line}.` : ""} Interested?`,
      ...(schedule.stale ? [schedule.line] : []),
      SIGN_OFF,
    ].join("\n\n");
    return {
      draft: {
        to_name: f.recipient.name,
        to_email: f.recipient.email,
        subject: `Load ${f.load.load_id} — ${f.load.origin} to ${f.load.destination}`,
        body,
      },
      compliance_caveat: null,
    };
  }

  const body = [
    `Hi ${firstName(f.recipient.name)},`,
    "Thanks for the availability update — nothing on the board fits right now, but we've noted it and will reach out when a matching load posts.",
    SIGN_OFF,
  ].join("\n\n");
  return {
    draft: {
      to_name: f.recipient.name,
      to_email: f.recipient.email,
      subject: "Re: your availability",
      body,
    },
    compliance_caveat: null,
  };
}

function infoRequest(f: DraftFacts): DraftResult {
  if (f.missing_info.length === 0) {
    return refuse("info_request needs missing_info — say what to ask for");
  }
  const about = f.load ? ` on load ${f.load.load_id}` : "";
  const body = [
    `Hi ${firstName(f.recipient.name)},`,
    `Quick question${about} — could you send over:`,
    f.missing_info.map((item) => `- ${item}`).join("\n"),
    SIGN_OFF,
  ].join("\n\n");

  return {
    draft: {
      to_name: f.recipient.name,
      to_email: f.recipient.email,
      subject: f.load
        ? `Load ${f.load.load_id} — quick question`
        : "Quick question",
      body,
    },
    compliance_caveat: null,
  };
}
