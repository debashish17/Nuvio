import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Core } from "../src/core/index.js";
import type { MockCard } from "../src/core/ledger.js";
import { PROTOCOL, TEST_BEARER, testApp, type testClock } from "./helpers.js";

/**
 * The SPEC demo script, end to end over POST /mcp (real JSON-RPC, as Alexa+ or the simulator
 * would call it). One shared ledger, so each step builds on the one before.
 */

let app: Express;
let core: Core;
let clock: ReturnType<typeof testClock>;
let card: MockCard;
beforeAll(async () => {
  ({ app, core, clock, card } = await testApp());
});
afterAll(() => core.db.close());

async function tool(name: string, args: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/mcp")
    .set("Authorization", `Bearer ${TEST_BEARER}`)
    .set("Accept", "application/json, text/event-stream")
    .set("MCP-Protocol-Version", PROTOCOL)
    .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  expect(res.status).toBe(200);
  expect(res.body.result.isError, JSON.stringify(res.body.result)).toBeFalsy();
  return res.body.result.structuredContent as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** The code from the latest text on the simulated phone. */
function latestCode(): string {
  const body = core.outbox.since("usr_priya", "2000-01-01T00:00:00Z").at(-1)?.body ?? "";
  return /\b(\d{6})\b/.exec(body)?.[1] ?? "";
}

describe("demo script over MCP", () => {
  let token = "";

  it('"What\'s the rupee at today?"', async () => {
    const rate = await tool("get_rate");
    expect(rate).toMatchObject({ customer_rate: 25.994, trend: expect.stringMatching(/rupee/) });
  });

  it('"Send 2,000 dirhams to Mum": resolve, quote, read back', async () => {
    const who = await tool("resolve_beneficiary", { query: "Mum" });
    expect(who.match).toMatchObject({ id: "ben_01", full_name: "Sunita Nair" });

    const quote = await tool("quote_transfer", {
      send_amount: 2000,
      send_currency: "AED",
      beneficiary_id: who.match.id,
      payout_method: "bank_deposit",
      purpose: "family_maintenance",
    });
    expect(quote).toMatchObject({
      send_amount: 2000,
      fee: 15,
      locked_rate: 25.994,
      receive_amount: 51598.09,
      receive_currency: "INR",
      guaranteed: true,
      funding: "debit card ending 8812",
      warnings: [{ code: "NEAR_MONTHLY_LIMIT", remaining_after: 1500, resets_on: "2026-11-01" }],
    });

    const prep = await tool("prepare_transfer", { quote_id: quote.quote_id });
    expect(prep.read_back).toBe(
      "Send 2,000 dirhams to Mum, Sunita Nair at HDFC Bank ending 4421, for family maintenance. " +
        "The 15 dirham fee is included and the rate is 25.99; your card ending 8812 is charged 2,000 dirhams. " +
        "Mum receives 51,598 rupees, guaranteed, within minutes. Shall I go ahead?",
    );
    token = prep.confirmation_token;
  });

  it('"Yes", then the texted code: confirm once; a replay is refused', async () => {
    const step = await tool("confirm_transfer", { confirmation_token: token });
    expect(step).toMatchObject({
      refused: { code: "STEP_UP_REQUIRED", method: "sms_otp", sent_to: "phone ending 4471" },
    });
    expect(card.charges).toHaveLength(0);
    const otp = latestCode();
    const done = await tool("confirm_transfer", { confirmation_token: token, otp });
    expect(done).toMatchObject({
      transfer_ref: "NUV-240121",
      status: "SCREENING",
      receive_amount: 51598.09,
      charged: 2000,
    });
    const replay = await tool("confirm_transfer", { confirmation_token: token, otp });
    expect(replay).toMatchObject({ refused: { code: "TOKEN_USED" } });
    expect(card.charges).toHaveLength(1);
  });

  it('"Send her another three thousand": refused by the server with 1,500 left', async () => {
    const r = await tool("quote_transfer", { send_amount: 3000, beneficiary_id: "ben_01" });
    expect(r).toEqual({
      refused: {
        code: "MONTHLY_LIMIT",
        limit: 20000,
        used: 18500,
        requested: 3000,
        currency: "AED",
        resets_on: "2026-11-01",
        resolution:
          "Send up to 1,500 dirhams now, or raise your limit by adding salary proof in the Nuvio app.",
      },
    });
    const why = await tool("check_limits", { refusal_code: "MONTHLY_LIMIT" });
    expect(why.explanation).toMatch(/You have 1,500 dirhams left until 1 November/);
    expect(why.monthly).toEqual({
      limit: 20000,
      used: 18500,
      remaining: 1500,
      resets_on: "2026-11-01",
    });
  });

  it('"Send 500 to Rahul": which Rahul?', async () => {
    const r = await tool("resolve_beneficiary", { query: "Rahul" });
    expect(r).toEqual({
      ambiguous: true,
      candidates: [
        { id: "ben_02", nickname: "Rahul", full_name: "Rahul Nair", relationship: "brother" },
        {
          id: "ben_03",
          nickname: "Rahul (college)",
          full_name: "Rahul Menon",
          relationship: "friend",
        },
      ],
    });
  });

  it("\"Where's Mum's money?\": the ticker reaches PAID_OUT with a UTR", async () => {
    clock.advance(15_000);
    core.ledger.tick();
    clock.advance(15_000);
    core.ledger.tick();
    const t = await tool("track_transfer", { latest: true });
    expect(t).toMatchObject({ transfer_ref: "NUV-240121", status: "PAID_OUT", recipient: "Mum" });
    expect(t.utr).toMatch(/^HDFCR5\d{16}$/);
  });

  it('"And the one to my NRE account?": under review, with what to do, and no reason', async () => {
    const t = await tool("track_transfer", { transfer_ref: "NUV-240120" });
    expect(t).toMatchObject({
      status: "ON_HOLD",
      customer_label: "Under review",
      action_required: {
        type: "RFI",
        document: "updated Emirates ID",
        how: "upload in the Nuvio app",
      },
    });
    expect(t).not.toHaveProperty("reason");
  });

  it('"Cancel the one to my NRE account": preview, "Yes", cancelled, 6,500 free', async () => {
    const preview = await tool("cancel_transfer", { transfer_ref: "NUV-240120" });
    expect(preview.preview).toBe(
      "Cancel the 5,000 dirham transfer to your NRE account. 5,000 dirhams, including the 15 dirham fee, go back to your card ending 8812 within 2 to 7 working days. Shall I cancel it?",
    );
    expect(preview.refund).toBe(5000);

    const done = await tool("cancel_transfer", {
      transfer_ref: "NUV-240120",
      cancel_token: preview.cancel_token,
    });
    expect(done).toMatchObject({
      status: "CANCELLED",
      refund: { amount: 5000, currency: "AED", to: "card ending 8812" },
      limits_now: { monthly: { remaining: 6500 } },
    });
  });

  it('"Tell me when the dirham hits 26.5"', async () => {
    const a = await tool("set_rate_alert", { pair: "AED/INR", target: 26.5, direction: "above" });
    expect(a).toMatchObject({ alert_id: "al_01", channel: "push and email" });
    expect(a.message).toMatch(/^I'll let you know when a dirham buys more than 26\.50 rupees\./);
  });

  it("history reflects the session: one sent, one cancelled, one returned", async () => {
    const h = await tool("get_transfer_history", { months: 3 });
    expect(h.totals).toEqual({
      count: 10,
      send_amount: 19000, // 22,000 seeded + 2,000 sent - 5,000 cancelled
      currency: "AED",
      returned: 1,
      cancelled: 1,
    });
    expect(h.limits_used.monthly).toEqual({ used: 13500, limit: 20000, resets_on: "2026-11-01" });
  });
});
