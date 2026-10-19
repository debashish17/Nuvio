import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LimitService, limitExceeded, type CheckInput } from "../src/core/limits.js";
import { VERIFIED_TIER, type TierConfig } from "../src/core/policy.js";
import { getRecipient } from "../src/core/repo.js";
import { isRefusal } from "../src/core/refusal.js";
import { REFUSAL_CODES, type PayoutMethod, type Recipient } from "../src/core/types.js";
import type { Db } from "../src/db/connection.js";
import { USER_ID } from "../src/db/seed.js";
import { NOW, seededDb, testClock } from "./helpers.js";

let db: Db;
beforeEach(() => {
  db = seededDb();
});
afterEach(() => db.close());

const RATE = 25.994;
const aed = (n: number) => Math.round(n * 100);
const mum = () => getRecipient(db, USER_ID, "ben_01") as Recipient;

function input(sendAed: number, method: PayoutMethod = "bank_deposit", r = mum()): CheckInput {
  const sendMinor = aed(sendAed);
  return {
    recipient: r,
    sendMinor,
    method,
    rate: RATE,
    receiveMinor: Math.floor(sendMinor * RATE),
  };
}

let seq = 0;
function addTransfer(sendAed: number, at: Date, opts: { ben?: string; method?: string } = {}) {
  db.prepare(
    `INSERT INTO transfers (ref, user_id, beneficiary_id, send_amount_minor, send_currency,
      payout_method, status, created_at) VALUES (?, ?, ?, ?, 'AED', ?, 'PAID_OUT', ?)`,
  ).run(
    `T-${++seq}`,
    USER_ID,
    opts.ben ?? "ben_01",
    aed(sendAed),
    opts.method ?? "bank_deposit",
    at.toISOString(),
  );
}

/** A clean month: only transfers the test adds count. */
function cleanSlate() {
  db.prepare("DELETE FROM transfers").run();
}

/** Loose test tier where per-transaction and daily caps do not mask the rules under test. */
const OPEN_TIER: TierConfig = {
  ...VERIFIED_TIER,
  perTransactionMinor: aed(50_000),
  dailyMinor: aed(50_000),
  monthlyMinor: aed(100_000),
};

const code = (r: ReturnType<LimitService["check"]>) => (isRefusal(r) ? r.refused.code : "OK");

describe("LimitService.check", () => {
  it("per-transaction cap: 5,000 passes, 5,000.01 refused", () => {
    cleanSlate();
    const limits = new LimitService(db, testClock());
    expect(code(limits.check(USER_ID, input(5000)))).toBe("OK");
    const r = limits.check(USER_ID, input(5000.01));
    expect(r).toMatchObject({
      refused: {
        code: "PER_TRANSACTION_LIMIT",
        limit_minor: 500_000,
        requested_minor: 500_001,
        currency: "AED",
      },
    });
  });

  it("daily cap across two transfers today", () => {
    cleanSlate();
    const limits = new LimitService(db, testClock());
    addTransfer(4000, new Date(NOW.getTime() - 3_600_000));
    addTransfer(4000, new Date(NOW.getTime() - 1_800_000));
    expect(code(limits.check(USER_ID, input(2000)))).toBe("OK"); // exactly 10,000
    const r = limits.check(USER_ID, input(2000.01));
    expect(r).toMatchObject({
      refused: { code: "DAILY_LIMIT", limit_minor: 1_000_000, used_minor: 800_000 },
    });
    if (isRefusal(r)) expect(r.refused.resolution).toMatch(/up to 2,000 dirhams today/);
  });

  it("the daily limit follows Dubai midnight, not UTC", () => {
    cleanSlate();
    // 19:00 UTC on the 14th is 23:00 in Dubai; 21:00 UTC is 01:00 on the 15th.
    const clock = testClock(new Date("2026-10-14T21:00:00Z"));
    addTransfer(5000, new Date("2026-10-14T19:00:00Z"));
    addTransfer(5000, new Date("2026-10-14T19:30:00Z"));
    expect(code(new LimitService(db, clock).check(USER_ID, input(5000)))).toBe("OK");
  });

  it("monthly cap at exactly the limit, with the reset date in the refusal", () => {
    const limits = new LimitService(db, testClock()); // seeded: 16,500 used this month
    expect(code(limits.check(USER_ID, input(3500)))).toBe("OK");
    const r = limits.check(USER_ID, input(3500.01));
    expect(r).toMatchObject({
      refused: {
        code: "MONTHLY_LIMIT",
        limit_minor: 2_000_000,
        used_minor: 1_650_000,
        requested_minor: 350_001,
        currency: "AED",
        resets_on: "2026-11-01",
      },
    });
  });

  it("the SPEC demo beat: after 2,000 more, 3,000 is refused with 1,500 left", () => {
    addTransfer(2000, NOW);
    const r = new LimitService(db, testClock()).check(USER_ID, input(3000));
    expect(r).toEqual({
      refused: {
        code: "MONTHLY_LIMIT",
        limit_minor: 2_000_000,
        used_minor: 1_850_000,
        requested_minor: 300_000,
        currency: "AED",
        resets_on: "2026-11-01",
        resolution:
          "Send up to 1,500 dirhams now, or raise your limit by adding salary proof in the Nuvio app.",
      },
    });
  });

  it("cancelled and returned transfers do not count", () => {
    db.prepare("UPDATE transfers SET status = 'CANCELLED' WHERE ref = 'ACM-240120'").run();
    // 16,500 used this month, less the 5,000 under review now cancelled.
    expect(new LimitService(db, testClock()).remaining(USER_ID).monthly.used_minor).toBe(1_150_000);
  });

  it("new-recipient first-transfer cap applies for 24 hours", () => {
    cleanSlate();
    db.prepare("UPDATE beneficiaries SET added_at = ? WHERE id = 'ben_01'").run(
      new Date(NOW.getTime() - 3_600_000).toISOString(),
    );
    const clock = testClock();
    const limits = new LimitService(db, clock);
    expect(code(limits.check(USER_ID, input(2000)))).toBe("OK");
    expect(limits.check(USER_ID, input(2000.01))).toMatchObject({
      refused: { code: "NEW_RECIPIENT_LIMIT", limit_minor: 200_000 },
    });
    clock.advance(24 * 3_600_000);
    expect(code(limits.check(USER_ID, input(2000.01)))).toBe("OK");
  });

  it("source-of-funds threshold at 15,000 (test tier, unreachable on Verified)", () => {
    cleanSlate();
    const limits = new LimitService(db, testClock(), OPEN_TIER);
    expect(code(limits.check(USER_ID, input(14_999.99)))).toBe("OK");
    expect(limits.check(USER_ID, input(15_000))).toMatchObject({
      refused: { code: "SOURCE_OF_FUNDS_REQUIRED", threshold_minor: 1_500_000 },
    });
  });

  describe("cash pickup", () => {
    it("per-transaction cap of 9,180 AED (test tier)", () => {
      cleanSlate();
      const limits = new LimitService(db, testClock(), OPEN_TIER);
      const small = { ...input(9180.01, "cash_pickup"), receiveMinor: 1 };
      expect(limits.check(USER_ID, small)).toMatchObject({
        refused: { code: "CASH_PICKUP_LIMIT", cap: "per_transaction", limit_minor: 918_000 },
      });
    });

    it("30 pickups per recipient per calendar year", () => {
      cleanSlate();
      const limits = new LimitService(db, testClock());
      for (let i = 0; i < 29; i++) {
        addTransfer(100, new Date(`2026-0${(i % 9) + 1}-10T09:00:00Z`), { method: "cash_pickup" });
      }
      addTransfer(100, new Date("2025-12-20T09:00:00Z"), { method: "cash_pickup" }); // last year
      expect(code(limits.check(USER_ID, input(500, "cash_pickup")))).toBe("OK");
      addTransfer(100, new Date("2026-10-01T09:00:00Z"), { method: "cash_pickup" });
      expect(limits.check(USER_ID, input(500, "cash_pickup"))).toMatchObject({
        refused: { code: "CASH_PICKUP_LIMIT", cap: "per_recipient_per_year", used: 30 },
      });
    });

    it("50,000 INR cash cap, with the most that can be sent", () => {
      cleanSlate();
      const limits = new LimitService(db, testClock());
      const r = limits.check(USER_ID, { ...input(2000, "cash_pickup"), receiveMinor: 5_000_001 });
      expect(r).toMatchObject({
        refused: { code: "CASH_PICKUP_LIMIT", cap: "max_cash_inr", limit_inr_minor: 5_000_000 },
      });
      if (!isRefusal(r)) throw new Error("expected refusal");
      // 50,000 / 25.994 = 1,923.52 AED converted, plus the 20 AED fee
      expect(r.refused.max_send_minor).toBe(194_352);
      expect(r.refused.resolution).toMatch(/Send up to 1,943.52 dirhams for cash pickup/);
    });
  });

  it("NEAR_MONTHLY_LIMIT warning only when under 25% would remain", () => {
    const limits = new LimitService(db, testClock());
    expect(limits.check(USER_ID, input(2000))).toEqual({
      ok: true,
      warnings: [
        {
          code: "NEAR_MONTHLY_LIMIT",
          remaining_after_minor: 150_000,
          currency: "AED",
          resets_on: "2026-11-01",
        },
      ],
    });
    cleanSlate();
    expect(limits.check(USER_ID, input(2000))).toEqual({ ok: true, warnings: [] });
    // Earlier this month, so the daily cap does not apply.
    addTransfer(13_000, new Date("2026-10-03T09:00:00Z")); // 5,000 left after: exactly 25%
    expect(limits.check(USER_ID, input(2000))).toEqual({ ok: true, warnings: [] });
    addTransfer(1000, new Date("2026-10-04T09:00:00Z")); // 4,000 left after: 20% < 25%
    expect(limits.check(USER_ID, input(2000))).toMatchObject({
      warnings: [{ code: "NEAR_MONTHLY_LIMIT" }],
    });
  });

  it("limitExceeded keeps the inner code and numbers for confirm-time refusals", () => {
    const inner = new LimitService(db, testClock()).check(USER_ID, input(4000));
    if (!isRefusal(inner)) throw new Error("expected refusal");
    expect(limitExceeded(inner)).toMatchObject({
      refused: { code: "LIMIT_EXCEEDED", limit_code: "MONTHLY_LIMIT", used_minor: 1_650_000 },
    });
  });
});

describe("LimitService.explain and describe", () => {
  it("has plain-words text for every refusal code", () => {
    const limits = new LimitService(db, testClock());
    for (const c of REFUSAL_CODES) {
      const text = limits.explain(c, USER_ID);
      expect(text.length, c).toBeGreaterThan(20);
      expect(text, c).not.toMatch(/undefined|NaN/);
    }
    expect(limits.explain("MONTHLY_LIMIT", USER_ID)).toBe(
      "On your current tier you can send 20,000 dirhams a month. You have 3,500 dirhams left until 1 November. Adding salary proof in the Nuvio app moves you to Verified Plus, with 60,000 dirhams a month.",
    );
    expect(limits.explain("CASH_PICKUP_LIMIT", USER_ID)).toMatch(
      /9,180 dirhams per transfer, 30 pickups per recipient a year, and 50,000 rupees in cash/,
    );
  });

  it("describe returns the check_limits view", () => {
    const view = new LimitService(db, testClock()).describe(USER_ID);
    expect(view).toMatchObject({
      kyc_tier: "Verified (Emirates ID)",
      per_transaction: { limit_minor: 500_000, currency: "AED", funding: "debit card" },
      daily: { remaining_minor: 1_000_000 },
      monthly: { remaining_minor: 350_000, resets_on: "2026-11-01" },
      cash_pickup: { per_transaction_aed_minor: 918_000, per_recipient_per_year: 30 },
      new_recipient_first_transfer: { limit_minor: 200_000 },
    });
  });
});
