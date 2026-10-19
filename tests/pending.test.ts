import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCore, type Core } from "../src/core/index.js";
import { isRefusal } from "../src/core/refusal.js";
import { USER_ID } from "../src/db/seed.js";
import { toWire } from "../src/server/wire.js";
import { liveFetch, seededDb, silentLogger, testClock } from "./helpers.js";

let core: Core;
let clock: ReturnType<typeof testClock>;
beforeEach(() => {
  clock = testClock();
  core = createCore({
    db: seededDb(),
    ratesUrl: "https://rates.test/v1",
    fetch: liveFetch(),
    now: clock,
    logger: silentLogger,
  });
});
afterEach(() => core.db.close());

describe("PendingService", () => {
  it("surfaces the transfer under review with its RFI, in plain words", () => {
    const p = core.pending.pending(USER_ID);
    expect(p.under_review).toEqual([
      expect.objectContaining({
        transfer_ref: "NUV-240120",
        recipient: "My NRE account",
        send_amount_minor: 500_000,
        customer_label: "Under review",
        action_required: expect.objectContaining({ document: "updated Emirates ID" }),
      }),
    ]);
    expect(p.summary).toMatch(
      /^Your 5,000 dirham transfer to My NRE account is under review: upload updated Emirates ID in the Nuvio app by \d+ \w+\.$/,
    );
    expect(p.open_quotes).toEqual([]);
    expect(p.fired_alerts).toEqual([]);
  });

  it("gives the last transfer per recipient, skipping cancelled and returned ones", () => {
    const last = core.pending.pending(USER_ID).last_by_recipient;
    expect(last.map((l) => [l.recipient, l.transfer_ref, l.send_amount_minor])).toEqual([
      ["My NRE account", "NUV-240120", 500_000],
      ["Rahul", "NUV-240117", 150_000],
      ["Mum", "NUV-240116", 200_000],
    ]);
    // Rahul Menon's only transfer was returned, so there is no "usual" for him.
    expect(last.find((l) => l.beneficiary_id === "ben_03")).toBeUndefined();
    expect(last.find((l) => l.recipient === "Mum")).toMatchObject({
      payout_method: "bank_deposit",
      purpose: "family_maintenance",
      customer_label: "Paid out",
    });
  });

  it("lists open quotes until they are used or expire", async () => {
    const q = await core.quotes.create(USER_ID, { beneficiaryId: "ben_01", sendMinor: 50_000 });
    if (isRefusal(q)) throw new Error("quote refused");
    expect(core.pending.pending(USER_ID).open_quotes).toEqual([
      expect.objectContaining({ quote_id: q.quote_id, recipient: "Mum", status: "open" }),
    ]);
    expect(core.pending.pending(USER_ID).summary).toContain(
      "You have an open quote to send 500 dirhams to Mum.",
    );
    clock.advance(31 * 60_000); // past the 30-minute rate lock
    expect(core.pending.pending(USER_ID).open_quotes).toEqual([]);
  });

  it("includes rate alerts that fired in the last 7 days", async () => {
    await core.alerts.set(USER_ID, "AED/INR", 26.5, "above");
    core.alerts.fireNext(USER_ID);
    expect(core.pending.pending(USER_ID).fired_alerts).toEqual([
      expect.objectContaining({ target: 26.5, direction: "above" }),
    ]);
    expect(core.pending.pending(USER_ID).summary).toContain(
      "Your rate alert fired: the dirham went above 26.50 rupees",
    );
    clock.advance(8 * 86_400_000);
    expect(core.pending.pending(USER_ID).fired_alerts).toEqual([]);
  });

  it("says so when nothing needs attention", () => {
    core.db.prepare("UPDATE transfers SET status = 'PAID_OUT' WHERE status = 'ON_HOLD'").run();
    expect(core.pending.pending(USER_ID).summary).toBe("Nothing needs your attention.");
  });

  it("speaks major units on the wire", () => {
    const wire = toWire(core.pending.pending(USER_ID)) as {
      under_review: { send_amount: number }[];
    };
    expect(wire.under_review[0]?.send_amount).toBe(5000);
  });
});
