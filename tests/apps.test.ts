import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Core } from "../src/core/index.js";
import { TRANSFER_VIEW_TOOLS, TRANSFER_VIEW_URI } from "../src/server/apps.js";
import {
  confirmedContext,
  digits,
  initialState,
  onToolInput,
  onToolResult,
  secondsLeft,
  steps,
  type ViewState,
} from "../src/ui/transfer/model.js";
import { PROTOCOL, TEST_BEARER, testApp } from "./helpers.js";

const MIME = "text/html;profile=mcp-app";

let app: Express;
let core: Core;
beforeAll(async () => {
  ({ app, core } = await testApp());
});
afterAll(() => core.db.close());

function rpc(method: string, params?: unknown) {
  return request(app)
    .post("/mcp")
    .set("Authorization", `Bearer ${TEST_BEARER}`)
    .set("Accept", "application/json, text/event-stream")
    .set("MCP-Protocol-Version", PROTOCOL)
    .send({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) });
}

describe("MCP Apps: the ui://acme-remit/transfer resource", () => {
  it("is listed with the MCP Apps mime type and its ui metadata", async () => {
    const res = await rpc("resources/list", {});
    expect(res.status).toBe(200);
    const listed = res.body.result.resources as {
      uri: string;
      mimeType: string;
      _meta?: unknown;
    }[];
    expect(listed).toEqual([
      expect.objectContaining({
        uri: TRANSFER_VIEW_URI,
        mimeType: MIME,
        _meta: { ui: { csp: {}, prefersBorder: true } },
      }),
    ]);
  });

  it("reads as one self-contained HTML document that loads nothing from outside", async () => {
    const res = await rpc("resources/read", { uri: TRANSFER_VIEW_URI });
    expect(res.status).toBe(200);
    const [content] = res.body.result.contents as {
      uri: string;
      mimeType: string;
      text: string;
      _meta?: unknown;
    }[];
    expect(content).toMatchObject({ uri: TRANSFER_VIEW_URI, mimeType: MIME });
    expect(content?._meta).toEqual({ ui: { csp: {}, prefersBorder: true } });
    const html = content?.text ?? "";
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("<script>");
    expect(html).not.toContain("{{"); // every placeholder filled
    // No external scripts, styles, images, frames or fonts.
    expect(html).not.toMatch(/<(script|link|img|iframe)[^>]+(src|href)=/i);
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
    expect(html).not.toMatch(/@import/i);
    // Script text never closes its own element early.
    expect(html.match(/<\/script>/gi)).toHaveLength(1);
  });

  it("links exactly the four transfer tools; the rest stay plain", async () => {
    const res = await rpc("tools/list", {});
    const tools = res.body.result.tools as { name: string; _meta?: Record<string, unknown> }[];
    const linked = tools.filter((t) => t._meta?.ui).map((t) => t.name);
    expect(linked.sort()).toEqual([...TRANSFER_VIEW_TOOLS].sort());
    for (const t of tools.filter((x) => linked.includes(x.name))) {
      expect(t._meta).toEqual({
        ui: { resourceUri: TRANSFER_VIEW_URI },
        "ui/resourceUri": TRANSFER_VIEW_URI,
      });
    }
  });

  it("an unknown ui:// resource is an error, not an empty document", async () => {
    const res = await rpc("resources/read", { uri: "ui://acme-remit/nope" });
    expect(res.body.error).toBeDefined();
  });
});

/* ---------- the view's state, from what a host sends (no DOM) ---------- */

const quote = {
  quote_id: "q_1",
  beneficiary_id: "ben_01",
  send_amount: 500,
  fee: 15,
  locked_rate: 25.994,
  receive_amount: 12607.09,
  rate_locked_until: "2026-10-15T08:30:00.000Z",
  eta: "within minutes, 24x7",
  funding: "debit card ending 8812",
};
const token = `ct_${"A".repeat(43)}`;
const result = (structuredContent: Record<string, unknown>) => ({
  content: [{ type: "text", text: JSON.stringify(structuredContent) }],
  structuredContent,
});
const feed = (s: ViewState, args: Record<string, unknown>, sc: Record<string, unknown>) =>
  onToolResult(onToolInput(s, args), result(sc));

describe("transfer view state", () => {
  it("walks quote, read-back, code entry and receipt from tool results alone", () => {
    let s = feed(initialState, { send_amount: 500, beneficiary_id: "ben_01" }, quote);
    expect(s.phase).toMatchObject({ kind: "quote", quote: { receive_amount: 12607.09 } });

    s = feed(
      s,
      { quote_id: "q_1" },
      {
        quote_id: "q_1",
        confirmation_token: token,
        expires_at: "2026-10-15T08:05:00.000Z",
        read_back: "Send 500 dirhams to Mum, Sunita Nair. Shall I go ahead?",
      },
    );
    // The read-back keeps the figures of its own quote.
    expect(s.phase).toMatchObject({ kind: "readback", token, quote: { quote_id: "q_1" } });

    s = feed(
      s,
      { confirmation_token: token },
      {
        refused: {
          code: "STEP_UP_REQUIRED",
          sent_to: "phone ending 4471",
          expires_at: "2026-10-15T08:05:00.000Z",
          attempts_left: 3,
          resolution: "Ask the user to read it out.",
        },
      },
    );
    expect(s.phase).toMatchObject({
      kind: "code",
      token,
      sentTo: "phone ending 4471",
      attemptsLeft: 3,
    });

    s = feed(
      s,
      { confirmation_token: token, otp: "000000" },
      { refused: { code: "OTP_INVALID", attempts_left: 2, resolution: "Ask the user again." } },
    );
    expect(s.phase).toMatchObject({ kind: "code", attemptsLeft: 2 });
    expect(s.phase.kind === "code" && s.phase.error).toBe(
      "That code didn't match and nothing was sent. 2 tries left.",
    );

    s = feed(
      s,
      { confirmation_token: token, otp: "482913" },
      {
        transfer_ref: "ACM-240121",
        status: "SCREENING",
        customer_label: "Checking details",
        recipient: "Mum",
        charged: 500,
        receive_amount: 12607.09,
      },
    );
    expect(s.phase).toMatchObject({ kind: "receipt", transfer: { transfer_ref: "ACM-240121" } });

    // A later track result for the same transfer merges in.
    s = feed(
      s,
      { transfer_ref: "ACM-240121" },
      { transfer_ref: "ACM-240121", status: "PAID_OUT", utr: "HDFC1234", timeline: [] },
    );
    expect(s.phase).toMatchObject({
      kind: "receipt",
      transfer: { status: "PAID_OUT", charged: 500, utr: "HDFC1234" },
    });
  });

  it("opens straight on code entry when its first result is the step-up (one view per call)", () => {
    const s = feed(
      initialState,
      { confirmation_token: token },
      { refused: { code: "STEP_UP_REQUIRED", sent_to: "phone ending 4471", attempts_left: 3 } },
    );
    expect(s.phase).toMatchObject({ kind: "code", token });
  });

  it("speaks to the user, not the model, on refusals", () => {
    const s = feed(
      initialState,
      { confirmation_token: token, otp: "1" },
      {
        refused: {
          code: "OTP_LOCKED",
          resolution: "Tell the user the confirmation was voided; call prepare_transfer again.",
        },
      },
    );
    expect(s.phase).toMatchObject({ kind: "refused", code: "OTP_LOCKED" });
    expect(s.phase.kind === "refused" && s.phase.message).not.toMatch(/prepare_transfer|call /);
    const limit = feed(
      initialState,
      {},
      {
        refused: { code: "MONTHLY_LIMIT", resolution: "That would go over your monthly limit." },
      },
    );
    expect(limit.phase).toMatchObject({ message: "That would go over your monthly limit." });
  });

  it("under review shows the label and the RFI, and there is no reason field to show", () => {
    const s = feed(
      initialState,
      { transfer_ref: "ACM-240120" },
      {
        transfer_ref: "ACM-240120",
        status: "ON_HOLD",
        customer_label: "Under review",
        action_required: {
          type: "RFI",
          document: "updated Emirates ID",
          how: "upload in the Nuvio app",
        },
        timeline: [{ status: "FUNDS_RECEIVED" }, { status: "SCREENING" }, { status: "ON_HOLD" }],
      },
    );
    expect(s.phase).toMatchObject({
      kind: "receipt",
      transfer: {
        customer_label: "Under review",
        action_required: { document: "updated Emirates ID" },
      },
    });
    const labels = steps("ON_HOLD", [{ status: "FUNDS_RECEIVED" }, { status: "SCREENING" }]);
    expect(labels.map((x) => `${x.label}:${x.state}`)).toEqual([
      "Payment received:done",
      "Checking details:done",
      "Under review:end",
      "Paid out:todo",
    ]);
  });

  it("tells the assistant the reference and status, never the code", () => {
    const note = confirmedContext({
      transfer_ref: "ACM-240121",
      status: "SCREENING",
      customer_label: "Checking details",
      recipient: "Mum",
    });
    expect(note.text).toMatch(/ACM-240121 to Mum, Checking details/);
    expect(note.structured).toEqual({
      event: "transfer_confirmed",
      transfer_ref: "ACM-240121",
      status: "SCREENING",
      customer_label: "Checking details",
    });
    expect(JSON.stringify(note)).not.toMatch(/(?<![-\d])\d{6}(?!\d)/); // a code, not ACM-240121
  });

  it("keeps six digits of what was typed, and counts down safely", () => {
    expect(digits("48 29-13")).toBe("482913");
    expect(digits("4829135")).toBe("482913");
    expect(secondsLeft("2026-10-15T08:05:00Z", Date.parse("2026-10-15T08:04:00Z"))).toBe(60);
    expect(secondsLeft("2026-10-15T08:05:00Z", Date.parse("2026-10-15T09:00:00Z"))).toBe(0);
    expect(secondsLeft("not a date", 0)).toBe(0);
  });
});
