import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCore, type Core } from "../src/core/index.js";
import { MockCard, type CardGateway } from "../src/core/ledger.js";
import { isRefusal } from "../src/core/refusal.js";
import type { Refusal } from "../src/core/types.js";
import { USER_ID } from "../src/db/seed.js";
import { liveFetch, seededDb, silentLogger, testClock } from "./helpers.js";

const CALLER = "usr_priya:caller-a";
const STEP = 15_000;

let clock: ReturnType<typeof testClock>;
let card: MockCard;
let core: Core;

function build(cardGateway: CardGateway = new MockCard()) {
  clock = testClock();
  core = createCore({
    db: seededDb(),
    ratesUrl: "https://rates.test/v1",
    fetch: liveFetch(),
    now: clock,
    logger: silentLogger,
    card: cardGateway,
    stepMs: STEP,
  });
}

beforeEach(() => {
  card = new MockCard();
  build(card);
});
afterEach(() => core.db.close());

const aed = (n: number) => Math.round(n * 100);

function ok<T>(r: T | Refusal): T {
  if (isRefusal(r))
    throw new Error(`unexpected refusal ${r.refused.code}: ${r.refused.resolution}`);
  return r;
}

/** quote -> prepare; returns the ct_ token. */
async function prepared(beneficiaryId: string, sendAed: number) {
  const q = ok(await core.quotes.create(USER_ID, { beneficiaryId, sendMinor: aed(sendAed) }));
  return {
    quoteId: q.quote_id,
    token: ok(core.quotes.prepare(USER_ID, q.quote_id, CALLER)).confirmation_token,
  };
}

const count = (sql: string, ...args: unknown[]) =>
  (core.db.prepare(sql).get(...args) as { n: number }).n;

describe("LedgerService.confirm", () => {
  it("writes the transfer in SCREENING with both events, consumes the quote, charges the card", async () => {
    const { quoteId, token } = await prepared("ben_01", 2000);
    const r = ok(core.ledger.confirm(USER_ID, token, CALLER));
    expect(r).toEqual({
      transfer_ref: "NUV-240121",
      status: "SCREENING",
      customer_label: "Checking details",
      recipient: "Mum",
      send_amount_minor: 200_000,
      charged_minor: 200_000,
      funding: "debit card ending 8812",
      receive_amount_minor: 5_159_809,
      eta: "within minutes",
      receipt: "Receipt and FIRA will be available in the Nuvio app once paid out.",
    });
    const events = core.db
      .prepare("SELECT status FROM transfer_events WHERE ref = ? ORDER BY at, rowid")
      .all(r.transfer_ref);
    expect(events).toEqual([{ status: "FUNDS_RECEIVED" }, { status: "SCREENING" }]);
    expect(core.quotes.get(USER_ID, quoteId)?.status).toBe("consumed");
    expect(card.charges).toEqual([{ userId: USER_ID, amountMinor: 200_000, ref: "NUV-240121" }]);
  });

  it("charges the card exactly once under two concurrent confirms (second refused)", async () => {
    const { token } = await prepared("ben_01", 2000);
    const results = await Promise.all([
      Promise.resolve().then(() => core.ledger.confirm(USER_ID, token, CALLER)),
      Promise.resolve().then(() => core.ledger.confirm(USER_ID, token, CALLER)),
    ]);
    expect(results.filter((r) => !isRefusal(r))).toHaveLength(1);
    expect(results.find(isRefusal)).toMatchObject({ refused: { code: "TOKEN_USED" } });
    expect(card.charges).toHaveLength(1);
    expect(count("SELECT COUNT(*) AS n FROM transfers WHERE quote_id IS NOT NULL")).toBe(1);
  });

  it("refuses a token from another caller", async () => {
    const { token } = await prepared("ben_01", 2000);
    expect(core.ledger.confirm(USER_ID, token, "usr_priya:caller-b")).toMatchObject({
      refused: { code: "TOKEN_UNKNOWN" },
    });
    expect(card.charges).toHaveLength(0);
  });

  it("re-checks limits: LIMIT_EXCEEDED, nothing written, token still usable", async () => {
    // Two 3,000 quotes both price with 3,500 left; only the first can be confirmed.
    const a = await prepared("ben_01", 3000);
    const b = await prepared("ben_01", 3000);
    ok(core.ledger.confirm(USER_ID, a.token, CALLER));
    const r = core.ledger.confirm(USER_ID, b.token, CALLER);
    expect(r).toMatchObject({
      refused: { code: "LIMIT_EXCEEDED", limit_code: "MONTHLY_LIMIT", used_minor: 1_950_000 },
    });
    expect(card.charges).toHaveLength(1);
    expect(core.quotes.get(USER_ID, b.quoteId)?.status).toBe("prepared");
    expect(silentLogger.warnings.at(-1)).toMatch(
      /ledger: rejected confirm ct_\S{5}… \(LIMIT_EXCEEDED\)/,
    );
  });

  it("a declined card rolls everything back, and the token can be retried", async () => {
    let decline = true;
    const flaky = new MockCard();
    build({
      charge: (u, a, ref) => (decline ? { ok: false } : flaky.charge(u, a, ref)),
      refund: () => undefined,
    });
    const { quoteId, token } = await prepared("ben_01", 2000);
    expect(core.ledger.confirm(USER_ID, token, CALLER)).toMatchObject({
      refused: { code: "CARD_DECLINED" },
    });
    expect(count("SELECT COUNT(*) AS n FROM transfers WHERE quote_id = ?", quoteId)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM transfer_events WHERE ref = 'NUV-240121'")).toBe(0);
    expect(core.quotes.get(USER_ID, quoteId)?.status).toBe("prepared");
    decline = false;
    expect(ok(core.ledger.confirm(USER_ID, token, CALLER)).transfer_ref).toBe("NUV-240121");
  });

  it("a superseded token cannot confirm", async () => {
    const { quoteId, token } = await prepared("ben_01", 2000);
    core.quotes.prepare(USER_ID, quoteId, CALLER);
    expect(core.ledger.confirm(USER_ID, token, CALLER)).toMatchObject({
      refused: { code: "TOKEN_EXPIRED" },
    });
  });
});

describe("LedgerService.tick", () => {
  it("advances SCREENING -> SENT_TO_PARTNER at 15 s and -> PAID_OUT with a UTR at 30 s", async () => {
    const { token } = await prepared("ben_01", 2000);
    const { transfer_ref: ref } = ok(core.ledger.confirm(USER_ID, token, CALLER));

    clock.advance(STEP - 1000);
    expect(core.ledger.tick()).toEqual([]);
    clock.advance(1000);
    expect(core.ledger.tick()).toEqual([{ ref, status: "SENT_TO_PARTNER" }]);
    expect(core.ledger.tick()).toEqual([]); // one step per interval
    clock.advance(STEP);
    expect(core.ledger.tick()).toEqual([{ ref, status: "PAID_OUT" }]);

    const t = ok(core.ledger.track(USER_ID, ref));
    expect(t.status).toBe("PAID_OUT");
    expect(t.utr).toMatch(/^HDFCR520261015\d{8}$/);
    expect(t.timeline.map((e) => e.status)).toEqual([
      "FUNDS_RECEIVED",
      "SCREENING",
      "SENT_TO_PARTNER",
      "PAID_OUT",
    ]);
  });

  it("gives UPI payouts a 12-digit reference", async () => {
    const { token } = await prepared("ben_02", 500);
    const { transfer_ref: ref } = ok(core.ledger.confirm(USER_ID, token, CALLER));
    clock.advance(STEP);
    core.ledger.tick();
    clock.advance(STEP);
    core.ledger.tick();
    expect(ok(core.ledger.track(USER_ID, ref)).utr).toMatch(/^261015\d{6}$/);
  });

  it("does not advance ON_HOLD (or any other terminal state)", () => {
    clock.advance(24 * 3_600_000);
    expect(core.ledger.tick()).toEqual([]);
    expect(ok(core.ledger.track(USER_ID, "NUV-240120")).status).toBe("ON_HOLD");
  });
});

describe("LedgerService.cancel", () => {
  it("cancel in ON_HOLD refunds the amount charged (fee included) and lowers monthly used: the SPEC beat", async () => {
    // 16,500 used; send 2,000 to Mum -> 18,500; cancel the 5,000 NRE transfer -> 13,500 used.
    ok(core.ledger.confirm(USER_ID, (await prepared("ben_01", 2000)).token, CALLER));
    expect(core.limits.remaining(USER_ID).monthly.used_minor).toBe(1_850_000);

    const preview = ok(core.ledger.cancelPreview(USER_ID, "NUV-240120", CALLER));
    expect(preview).toMatchObject({
      status: "ON_HOLD",
      customer_label: "Under review",
      cancellable: true,
      refund_minor: 500_000,
      expires_at: "2026-10-15T08:05:00.000Z",
    });
    expect(preview.cancel_token).toMatch(/^cx_/);
    expect(preview.preview).toBe(
      "Cancel the 5,000 dirham transfer to your NRE account. 5,000 dirhams, including the 15 dirham fee, go back to your card ending 8812 within 2 to 7 working days. Shall I cancel it?",
    );

    const done = ok(core.ledger.cancel(USER_ID, "NUV-240120", preview.cancel_token, CALLER));
    expect(done).toEqual({
      transfer_ref: "NUV-240120",
      status: "CANCELLED",
      customer_label: "Cancelled",
      refund: {
        amount_minor: 500_000,
        currency: "AED",
        to: "card ending 8812",
        eta: "2-7 working days",
      },
      limits_now: { monthly: { remaining_minor: 650_000 }, daily: { remaining_minor: 800_000 } },
    });
    expect(card.refunds).toEqual([{ userId: USER_ID, amountMinor: 500_000, ref: "NUV-240120" }]);
    expect(ok(core.ledger.track(USER_ID, "NUV-240120"))).toMatchObject({
      status: "CANCELLED",
      refund: { amount_minor: 500_000 },
    });
  });

  it("cancel in SCREENING works too", async () => {
    const { transfer_ref: ref } = ok(
      core.ledger.confirm(USER_ID, (await prepared("ben_01", 1000)).token, CALLER),
    );
    const { cancel_token } = ok(core.ledger.cancelPreview(USER_ID, ref, CALLER));
    expect(ok(core.ledger.cancel(USER_ID, ref, cancel_token, CALLER)).refund.amount_minor).toBe(
      100_000,
    );
    expect(core.limits.remaining(USER_ID).monthly.used_minor).toBe(1_650_000);
  });

  it("cancel after SENT_TO_PARTNER is refused CANCEL_WINDOW_CLOSED", async () => {
    const { transfer_ref: ref } = ok(
      core.ledger.confirm(USER_ID, (await prepared("ben_01", 1000)).token, CALLER),
    );
    clock.advance(STEP);
    core.ledger.tick();
    expect(core.ledger.cancelPreview(USER_ID, ref, CALLER)).toMatchObject({
      refused: { code: "CANCEL_WINDOW_CLOSED", status: "SENT_TO_PARTNER" },
    });
    expect(core.ledger.cancellable(ref)).toBe(false);
    expect(core.ledger.cancelPreview(USER_ID, "NUV-240119", CALLER)).toMatchObject({
      refused: { code: "CANCEL_WINDOW_CLOSED", status: "PAID_OUT" },
    });
  });

  it("refuses at execute time if the ticker sent it on after the preview", async () => {
    const { transfer_ref: ref } = ok(
      core.ledger.confirm(USER_ID, (await prepared("ben_01", 1000)).token, CALLER),
    );
    const { cancel_token } = ok(core.ledger.cancelPreview(USER_ID, ref, CALLER));
    clock.advance(STEP);
    core.ledger.tick();
    expect(core.ledger.cancel(USER_ID, ref, cancel_token, CALLER)).toMatchObject({
      refused: { code: "CANCEL_WINDOW_CLOSED", status: "SENT_TO_PARTNER" },
    });
    expect(card.refunds).toHaveLength(0);
  });

  it("cancel preview then execute consumes one cx_ token; reuse is refused", () => {
    const { cancel_token } = ok(core.ledger.cancelPreview(USER_ID, "NUV-240120", CALLER));
    ok(core.ledger.cancel(USER_ID, "NUV-240120", cancel_token, CALLER));
    expect(core.ledger.cancel(USER_ID, "NUV-240120", cancel_token, CALLER)).toMatchObject({
      refused: { code: "TOKEN_USED" },
    });
    expect(
      count(
        "SELECT COUNT(*) AS n FROM confirmations WHERE transfer_ref = 'NUV-240120' AND used_at IS NOT NULL",
      ),
    ).toBe(1);
    expect(card.refunds).toHaveLength(1);
  });

  it("a cancel token only cancels the transfer it was issued for", async () => {
    const { transfer_ref: other } = ok(
      core.ledger.confirm(USER_ID, (await prepared("ben_01", 1000)).token, CALLER),
    );
    const { cancel_token } = ok(core.ledger.cancelPreview(USER_ID, "NUV-240120", CALLER));
    expect(core.ledger.cancel(USER_ID, other, cancel_token, CALLER)).toMatchObject({
      refused: { code: "TOKEN_UNKNOWN" },
    });
    ok(core.ledger.cancel(USER_ID, "NUV-240120", cancel_token, CALLER));
  });

  it("a confirmation token cannot cancel, and another caller cannot use a cancel token", async () => {
    const { token } = await prepared("ben_01", 1000);
    expect(core.ledger.cancel(USER_ID, "NUV-240120", token, CALLER)).toMatchObject({
      refused: { code: "TOKEN_UNKNOWN" },
    });
    const { cancel_token } = ok(core.ledger.cancelPreview(USER_ID, "NUV-240120", CALLER));
    expect(
      core.ledger.cancel(USER_ID, "NUV-240120", cancel_token, "usr_priya:caller-b"),
    ).toMatchObject({ refused: { code: "TOKEN_UNKNOWN" } });
  });

  it("unknown and other users' transfers are not found", () => {
    expect(core.ledger.cancelPreview(USER_ID, "NUV-999999", CALLER)).toMatchObject({
      refused: { code: "TRANSFER_NOT_FOUND" },
    });
    expect(core.ledger.cancelPreview("usr_other", "NUV-240120", CALLER)).toMatchObject({
      refused: { code: "TRANSFER_NOT_FOUND" },
    });
  });
});

describe("LedgerService.track", () => {
  it("returns 'Under review' and the RFI for ON_HOLD, with no screening reason", () => {
    const t = ok(core.ledger.track(USER_ID, "NUV-240120"));
    expect(t).toMatchObject({
      status: "ON_HOLD",
      customer_label: "Under review",
      recipient: "My NRE account",
      cancellable: true,
      action_required: {
        type: "RFI",
        document: "updated Emirates ID",
        how: "upload in the Nuvio app",
        deadline: "2026-10-17",
      },
    });
    expect(Object.keys(t)).not.toContain("reason");
    expect(JSON.stringify(t)).not.toMatch(/screening reason|sanction|match/i);
  });

  it("returns the reason and refund details for RETURNED", () => {
    expect(ok(core.ledger.track(USER_ID, "NUV-240113"))).toMatchObject({
      status: "RETURNED",
      reason: "recipient bank reported a name mismatch",
      refund: {
        amount_minor: 47_500,
        currency: "AED",
        note: "refunded at the rate on the return date; fee not refunded",
        eta: "2-7 working days",
      },
      cancellable: false,
    });
  });

  it("returns the UTR for a seeded PAID_OUT transfer, and the latest when no ref is given", async () => {
    expect(ok(core.ledger.track(USER_ID, "nuv-240116"))).toMatchObject({
      status: "PAID_OUT",
      utr: "HDFCR52026100200240116",
    });
    expect(ok(core.ledger.track(USER_ID)).transfer_ref).toBe("NUV-240120");
    const { transfer_ref } = ok(
      core.ledger.confirm(USER_ID, (await prepared("ben_01", 500)).token, CALLER),
    );
    expect(ok(core.ledger.track(USER_ID)).transfer_ref).toBe(transfer_ref);
  });

  it("not found is a structured refusal", () => {
    expect(core.ledger.track(USER_ID, "NUV-1")).toMatchObject({
      refused: { code: "TRANSFER_NOT_FOUND", transfer_ref: "NUV-1" },
    });
    expect(core.ledger.track("usr_nobody")).toMatchObject({
      refused: { code: "TRANSFER_NOT_FOUND" },
    });
  });
});

describe("LedgerService.history", () => {
  it("totals and limits_used match the seeded rows (last 3 months)", () => {
    const h = core.ledger.history(USER_ID, { months: 3 });
    // Aug: Mum, friend (RETURNED); Sep: Mum, brother; Oct: Mum, brother, NRE x3 (the last ON_HOLD)
    expect(h.transfers.map((t) => t.transfer_ref)).toEqual([
      "NUV-240120",
      "NUV-240119",
      "NUV-240118",
      "NUV-240117",
      "NUV-240116",
      "NUV-240115",
      "NUV-240114",
      "NUV-240113",
      "NUV-240112",
    ]);
    expect(h.totals).toEqual({
      count: 9,
      send_amount_minor: 2_200_000, // the returned 500 is not counted as sent
      currency: "AED",
      returned: 1,
      cancelled: 0,
    });
    expect(h.limits_used).toEqual({
      monthly: { used_minor: 1_650_000, limit_minor: 2_000_000, resets_on: "2026-11-01" },
      daily: { used_minor: 0, limit_minor: 1_000_000 },
    });
    expect(h.transfers.find((t) => t.transfer_ref === "NUV-240113")).toMatchObject({
      status: "RETURNED",
      refund_minor: 47_500,
    });
  });

  it("filters to one recipient over all time, and defaults to 3 months", () => {
    const mum = core.ledger.history(USER_ID, { beneficiaryId: "ben_01" });
    expect(mum.totals.count).toBe(8);
    expect(mum.transfers.every((t) => t.recipient === "Mum")).toBe(true);
    expect(core.ledger.history(USER_ID).totals.count).toBe(9);
    expect(core.ledger.history(USER_ID, { months: 1 }).totals.count).toBe(5);
  });
});

describe("LedgerService dev controls", () => {
  it("releaseHold moves ON_HOLD back to SCREENING and the ticker carries it to PAID_OUT", () => {
    expect(core.ledger.releaseHold(USER_ID, "NUV-240120")).toEqual({
      ref: "NUV-240120",
      status: "SCREENING",
    });
    clock.advance(STEP);
    core.ledger.tick();
    clock.advance(STEP);
    core.ledger.tick();
    const t = ok(core.ledger.track(USER_ID, "NUV-240120"));
    expect(t.status).toBe("PAID_OUT");
    expect(t.utr).toMatch(/^SBINR5\d{16}$/);
  });

  it("releaseHold ignores transfers that are not on hold or not the user's", () => {
    expect(core.ledger.releaseHold(USER_ID, "NUV-240119")).toBeUndefined();
    expect(core.ledger.releaseHold("usr_other", "NUV-240120")).toBeUndefined();
  });

  it("tick({ force: true }) advances one step without waiting", async () => {
    const { transfer_ref: ref } = ok(
      core.ledger.confirm(USER_ID, (await prepared("ben_01", 500)).token, CALLER),
    );
    expect(core.ledger.tick()).toEqual([]);
    expect(core.ledger.tick({ force: true })).toEqual([{ ref, status: "SENT_TO_PARTNER" }]);
    expect(core.ledger.tick({ force: true })).toEqual([{ ref, status: "PAID_OUT" }]);
    expect(core.ledger.tick({ force: true })).toEqual([]);
  });
});
