import { applyMargin, receiveMinor } from "../core/money.js";
import { DEMO_USER_ID, FX_MARGIN_BP, PAYOUT_POLICY, VERIFIED_TIER } from "../core/policy.js";
import { deriveAedInr } from "../core/rates.js";
import { startOfDubaiDay } from "../core/time.js";
import type { PayoutMethod } from "../core/types.js";
import { makeUtr } from "../core/utr.js";
import type { Db } from "./connection.js";

/**
 * Demo seed from docs/SPEC.md "Data model and seed data". Wipes every table and reloads,
 * so each demo take starts identical. Dates are anchored to the Dubai calendar month of `now`:
 * "this month" in the spec is the current month, "Jul/Aug/Sep" are the three months before it.
 * This month's transfers keep their SPEC days (2nd, 5th, 10th) when those are in the past;
 * otherwise they move to the latest earlier day this month, in order, so nothing is ever
 * future-dated and today's daily limit starts unused. (Seeded on the 1st, they land earlier today.)
 * All amounts are integer minor units (fils, paise).
 */

export const USER_ID = DEMO_USER_ID;

const TABLES = [
  "users",
  "beneficiaries",
  "rates_cache",
  "rates_history",
  "quotes",
  "confirmations",
  "transfers",
  "transfer_events",
  "alerts",
  "step_up_challenges",
  "sms_outbox",
] as const;

interface SeedBeneficiary {
  id: string;
  nickname: string;
  full_name: string;
  relationship: string;
  payout_method: PayoutMethod;
  bank_name: string | null;
  ifsc: string | null;
  account_last4: string | null;
  account_type: string | null;
  upi_id: string | null;
  city: string;
  state: string;
  default_purpose: string;
  aliases: string[];
}

const BENEFICIARIES: SeedBeneficiary[] = [
  {
    id: "ben_01",
    nickname: "Mum",
    full_name: "Sunita Nair",
    relationship: "mother",
    payout_method: "bank_deposit",
    bank_name: "HDFC Bank",
    ifsc: "HDFC0001234",
    account_last4: "4421",
    account_type: "savings",
    upi_id: null,
    city: "Chandigarh",
    state: "Punjab",
    default_purpose: "family_maintenance",
    aliases: ["mum", "mom", "mother", "amma", "sunita"],
  },
  {
    id: "ben_02",
    nickname: "Rahul",
    full_name: "Rahul Nair",
    relationship: "brother",
    payout_method: "upi",
    bank_name: null,
    ifsc: null,
    account_last4: null,
    account_type: null,
    upi_id: "rahul.nair@okhdfc",
    city: "Pune",
    state: "Maharashtra",
    default_purpose: "family_maintenance",
    aliases: ["rahul", "brother", "bhai"],
  },
  {
    id: "ben_03",
    nickname: "Rahul (college)",
    full_name: "Rahul Menon",
    relationship: "friend",
    payout_method: "bank_deposit",
    bank_name: "ICICI Bank",
    ifsc: null,
    account_last4: "3302",
    account_type: null,
    upi_id: null,
    city: "Kochi",
    state: "Kerala",
    default_purpose: "gift",
    aliases: ["rahul menon", "college rahul"],
  },
  {
    id: "ben_04",
    nickname: "My NRE account",
    full_name: "Priya Nair",
    relationship: "self",
    payout_method: "bank_deposit",
    bank_name: "SBI",
    ifsc: null,
    account_last4: "0917",
    account_type: "NRE",
    upi_id: null,
    city: "Chandigarh",
    state: "Chandigarh",
    default_purpose: "savings_own_account",
    aliases: ["my account", "nre", "savings", "myself"],
  },
];

// Real ECB reference rates, pulled once from Frankfurter on 2026-10-02 and hard-coded (SPEC "Rates
// history"). ECB has no AED: AED/INR is derived from USD/INR at the 3.6725 peg, as RatesService does.
// Live fetches add newer days on top; RatesService reads the newest 7.
const ECB_USD_7D: { day: string; inr: number; gbp: number }[] = [
  { day: "2026-09-23", inr: 95.74, gbp: 0.75322 },
  { day: "2026-09-24", inr: 95.96, gbp: 0.75645 },
  { day: "2026-09-25", inr: 95.82, gbp: 0.75458 },
  { day: "2026-09-28", inr: 95.98, gbp: 0.75396 },
  { day: "2026-09-29", inr: 95.98, gbp: 0.75489 },
  { day: "2026-09-30", inr: 95.83, gbp: 0.75265 },
  { day: "2026-10-01", inr: 96.33, gbp: 0.75565 },
];

// USD/INR from ECB on the first business day on or after the 2nd, March to October 2026, keyed by
// month offset from the seed month. Past transfers are priced at that month's board rate.
const ECB_USD_INR_BY_MONTH: Record<number, number> = {
  [-7]: 91.74,
  [-6]: 93.1,
  [-5]: 95.09,
  [-4]: 95.27,
  [-3]: 95.39,
  [-2]: 95.34,
  [-1]: 94.97,
  [0]: 96.33,
};

function boardRate(monthOffset: number): number | undefined {
  const usdInr = ECB_USD_INR_BY_MONTH[monthOffset];
  const marginBp = FX_MARGIN_BP["AED/INR"];
  return usdInr === undefined || marginBp === undefined
    ? undefined
    : applyMargin(deriveAedInr(usdInr), marginBp);
}

type SeedStatus = "PAID_OUT" | "RETURNED" | "ON_HOLD";

interface SeedTransfer {
  monthOffset: number;
  /** Day of the month, for earlier months. */
  day: number;
  /** This month only: days before today (see thisMonthDays). */
  daysAgo?: number;
  beneficiaryId: string;
  sendAed: number;
  purpose: string;
  status: SeedStatus;
}

// Chronological; refs are assigned in this order so the ON_HOLD one is NUV-240120 (SPEC example).
const TRANSFERS: SeedTransfer[] = [
  ...[-7, -6, -5, -4, -3].map((m) => mum(m)),
  ben02(-3),
  mum(-2),
  {
    monthOffset: -2,
    day: 15,
    beneficiaryId: "ben_03",
    sendAed: 500,
    purpose: "gift",
    status: "RETURNED",
  },
  mum(-1),
  ben02(-1),
  // This month: 2,000 + 1,500 + 5,000 + 3,000 + 5,000 = 16,500 of the 20,000 monthly limit. Every
  // transfer fits the limits it would be checked against today: 5,000 per card-funded transfer,
  // 10,000 a day (tests/db.test.ts checks this). Dated back from today, not on fixed days, so the
  // held transfer stays recent and its RFI deadline stays ahead whenever the demo runs. On the
  // 15th these are the 2nd, 5th, 6th, 8th and 10th.
  { ...mum(0), daysAgo: 13 },
  { ...ben02(0), daysAgo: 10 },
  nre(9, 5000, "PAID_OUT"),
  nre(7, 3000, "PAID_OUT"),
  nre(5, 5000, "ON_HOLD"),
];

/** Savings to the customer's own NRE account, this month, `daysAgo` days before today. */
function nre(daysAgo: number, sendAed: number, status: SeedStatus): SeedTransfer {
  return {
    monthOffset: 0,
    day: 0,
    daysAgo,
    beneficiaryId: "ben_04",
    sendAed,
    purpose: "savings_own_account",
    status,
  };
}

function mum(monthOffset: number): SeedTransfer {
  return {
    monthOffset,
    day: 2,
    beneficiaryId: "ben_01",
    sendAed: 2000,
    purpose: "family_maintenance",
    status: "PAID_OUT",
  };
}

function ben02(monthOffset: number): SeedTransfer {
  return {
    monthOffset,
    day: 5,
    beneficiaryId: "ben_02",
    sendAed: 1500,
    purpose: "family_maintenance",
    status: "PAID_OUT",
  };
}

// Two below 240108 since the NRE transfers were split, so the ON_HOLD one is still NUV-240120.
const FIRST_REF = 240106;
const RETURN_REASON = "recipient bank reported a name mismatch";
// 485 AED converted at the August board rate (25.7268) -> 12,477.49 INR; returned and bought back at
// the 17 Aug rate plus margin (26.2683) -> 475.00 AED: a 10 AED FX loss, and the 15 AED fee is kept.
const RETURNED_REFUND_MINOR = 47500;

const DUBAI_OFFSET_MS = 4 * 3_600_000;
const dubai = (now: Date) => new Date(now.getTime() + DUBAI_OFFSET_MS);

/** 09:00 UTC (13:00 in Dubai) on `day` of the Dubai month `monthOffset` months from now. */
function at(now: Date, monthOffset: number, day: number, minutes = 0): Date {
  const d = dubai(now);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + monthOffset, day, 9, 0) + minutes * 60_000,
  );
}

/**
 * The day of the month for each of this month's transfers: `daysAgo` before today, but never
 * before the 1st or on or after today, in order, and never past the daily cap on one day (early in
 * the month several share a day). On the 1st or 2nd there is no room to spread them, so they share
 * the only day there is.
 */
export function thisMonthDays(
  today: number,
  items: { daysAgo: number; sendAed: number }[],
  dailyCapAed: number,
): number[] {
  const last = Math.max(1, today - 1);
  const totals = new Map<number, number>();
  let floor = 1;
  return items.map((t) => {
    let day = Math.min(last, Math.max(floor, today - t.daysAgo));
    while (day < last && (totals.get(day) ?? 0) + t.sendAed > dailyCapAed) day++;
    totals.set(day, (totals.get(day) ?? 0) + t.sendAed);
    floor = day;
    return day;
  });
}

const iso = (d: Date) => d.toISOString();
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export interface SeedSummary {
  users: number;
  beneficiaries: number;
  ratesHistory: number;
  transfers: number;
  transferEvents: number;
}

export function seed(db: Db, now: Date = new Date()): SeedSummary {
  const run = db.transaction((): SeedSummary => {
    for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();

    db.prepare(
      "INSERT INTO users (id, name, country, kyc_tier, card_last4, phone_last4) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(USER_ID, "Priya Nair", "AE", "Verified", "8812", "4471");

    const addedAt = iso(at(now, -12, 1));
    const insBen = db.prepare(`INSERT INTO beneficiaries
      (id, user_id, nickname, full_name, relationship, payout_method, bank_name, ifsc, account_last4,
       account_type, upi_id, city, state, mobile_last4, default_purpose, name_verified, added_at, aliases)
      VALUES (@id, @user_id, @nickname, @full_name, @relationship, @payout_method, @bank_name, @ifsc,
       @account_last4, @account_type, @upi_id, @city, @state, NULL, @default_purpose, 1, @added_at, @aliases)`);
    for (const b of BENEFICIARIES) {
      insBen.run({ ...b, user_id: USER_ID, added_at: addedAt, aliases: JSON.stringify(b.aliases) });
    }

    const insRate = db.prepare("INSERT INTO rates_history (pair, day, mid) VALUES (?, ?, ?)");
    const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
    for (const { day, inr, gbp } of ECB_USD_7D) {
      insRate.run("AED/INR", day, deriveAedInr(inr));
      insRate.run("USD/INR", day, round4(inr));
      insRate.run("GBP/INR", day, round4(inr / gbp));
    }

    const insTransfer = db.prepare(`INSERT INTO transfers
      (ref, user_id, beneficiary_id, quote_id, send_amount_minor, send_currency, receive_amount_minor,
       fee_minor, rate, payout_method, purpose, status, utr, created_at, paid_out_at, eta,
       hold_rfi_json, return_reason, refund_minor)
      VALUES (@ref, @user_id, @beneficiary_id, NULL, @send_amount_minor, 'AED', @receive_amount_minor,
       @fee_minor, @rate, @payout_method, @purpose, @status, @utr, @created_at, @paid_out_at, @eta,
       @hold_rfi_json, @return_reason, @refund_minor)`);
    const insEvent = db.prepare("INSERT INTO transfer_events (ref, status, at) VALUES (?, ?, ?)");

    let events = 0;
    const today = dubai(now).getUTCDate();
    const current = TRANSFERS.filter((t) => t.monthOffset === 0);
    const days = thisMonthDays(
      today,
      current.map((t) => ({ daysAgo: t.daysAgo ?? 0, sendAed: t.sendAed })),
      VERIFIED_TIER.dailyMinor / 100,
    );
    let thisMonthIndex = 0;
    TRANSFERS.forEach((t, i) => {
      const k = t.monthOffset === 0 ? thisMonthIndex++ : -1;
      const day = k >= 0 ? (days[k] ?? 1) : t.day;
      // Transfers that share a day keep their order, ten minutes apart.
      const sameDayBefore = k >= 0 ? days.slice(0, k).filter((d) => d === day).length : 0;
      // On the 1st there is no earlier day this month: start at Dubai midnight, steps in seconds.
      const firstOfMonth = k >= 0 && today === 1;
      const start = firstOfMonth
        ? new Date(startOfDubaiDay(now).getTime() + k * 10_000)
        : at(now, t.monthOffset, day, sameDayBefore * 10);
      const unit = firstOfMonth ? 1000 : 60_000;
      const when = (dayDelta = 0, minutes = 0) =>
        new Date(start.getTime() + dayDelta * 86_400_000 + minutes * unit);
      const ben = BENEFICIARIES.find((b) => b.id === t.beneficiaryId);
      const rate = boardRate(t.monthOffset);
      if (!ben || rate === undefined) throw new Error(`Bad seed row ${i}`);
      const ref = `NUV-${FIRST_REF + i}`;
      const feeMinor = PAYOUT_POLICY[ben.payout_method].feeMinor;
      const sendMinor = t.sendAed * 100;
      const created = when();

      const timeline: [string, Date][] = [
        ["FUNDS_RECEIVED", created],
        ["SCREENING", when(0, 1)],
      ];
      let paidOut: Date | null = null;
      if (t.status === "PAID_OUT") {
        paidOut = when(0, 3);
        timeline.push(["SENT_TO_PARTNER", when(0, 2)], ["PAID_OUT", paidOut]);
      } else if (t.status === "RETURNED") {
        timeline.push(["SENT_TO_PARTNER", when(0, 2)], ["RETURNED", when(2)]);
      } else {
        timeline.push(["ON_HOLD", when(0, 2)]);
      }

      // Customer-facing RFI only; a screening reason is never stored or emitted (CLAUDE.md rule 5).
      const rfi =
        t.status === "ON_HOLD"
          ? JSON.stringify({
              type: "RFI",
              document: "updated Emirates ID",
              how: "upload in the Nuvio app",
              deadline: ymd(when(7)),
            })
          : null;

      insTransfer.run({
        ref,
        user_id: USER_ID,
        beneficiary_id: ben.id,
        send_amount_minor: sendMinor,
        receive_amount_minor: receiveMinor(sendMinor, feeMinor, rate),
        fee_minor: feeMinor,
        rate,
        payout_method: ben.payout_method,
        purpose: t.purpose,
        status: t.status,
        utr: paidOut
          ? makeUtr(
              ben.payout_method,
              ben.bank_name,
              paidOut,
              String(FIRST_REF + i).padStart(8, "0"),
            )
          : null,
        created_at: iso(created),
        paid_out_at: paidOut ? iso(paidOut) : null,
        eta: "within minutes",
        hold_rfi_json: rfi,
        return_reason: t.status === "RETURNED" ? RETURN_REASON : null,
        refund_minor: t.status === "RETURNED" ? RETURNED_REFUND_MINOR : null,
      });
      for (const [status, when] of timeline) {
        insEvent.run(ref, status, iso(when));
        events++;
      }
    });

    return {
      users: 1,
      beneficiaries: BENEFICIARIES.length,
      ratesHistory: ECB_USD_7D.length * 3,
      transfers: TRANSFERS.length,
      transferEvents: events,
    };
  });
  return run();
}
