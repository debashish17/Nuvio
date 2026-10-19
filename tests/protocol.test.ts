import { readFileSync } from "node:fs";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Core } from "../src/core/index.js";
import { PROTOCOL, TEST_BEARER, testApp } from "./helpers.js";

let app: Express;
let core: Core;
beforeAll(async () => {
  ({ app, core } = await testApp());
});
afterAll(() => core.db.close());

const TOOLS = [
  "get_rate",
  "compare_options",
  "list_beneficiaries",
  "resolve_beneficiary",
  "quote_transfer",
  "prepare_transfer",
  "confirm_transfer",
  "track_transfer",
  "cancel_transfer",
  "get_transfer_history",
  "check_limits",
  "set_rate_alert",
  "get_help",
  "get_pending",
];

/** The `description` column for a tool in the docs/SPEC.md tool contract table. */
function specDescription(tool: string): string {
  const spec = readFileSync(new URL("../docs/SPEC.md", import.meta.url), "utf8");
  const row = spec.split("\n").find((l) => l.includes(`| \`${tool}\` |`));
  const cell = row?.split("|")[3]?.trim();
  if (!cell) throw new Error(`No SPEC.md row for ${tool}`);
  return cell.replaceAll("\\_", "_");
}

function rpc(method: string, params?: unknown, target: Express = app) {
  return request(target)
    .post("/mcp")
    .set("Authorization", `Bearer ${TEST_BEARER}`)
    .set("Accept", "application/json, text/event-stream")
    .set("MCP-Protocol-Version", PROTOCOL)
    .send({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) });
}

const call = (name: string, args: Record<string, unknown> = {}, target?: Express) =>
  rpc("tools/call", { name, arguments: args }, target);

const initParams = (protocolVersion: string) => ({
  protocolVersion,
  capabilities: {},
  clientInfo: { name: "protocol-test", version: "0.0.0" },
});

function keysDeep(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(keysDeep);
  if (v && typeof v === "object") {
    return Object.entries(v).flatMap(([k, x]) => [k, ...keysDeep(x)]);
  }
  return [];
}

describe("initialize", () => {
  it(`negotiates ${PROTOCOL}`, async () => {
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${TEST_BEARER}`)
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: initParams(PROTOCOL) });
    expect(res.status).toBe(200);
    expect(res.body.result.protocolVersion).toBe(PROTOCOL);
    expect(res.body.result.serverInfo.name).toBe("nuvio-remit");
    expect(res.body.result.capabilities.tools).toBeDefined();
  });

  it("is stateless: no Mcp-Session-Id is issued", async () => {
    const res = await rpc("initialize", initParams(PROTOCOL));
    expect(res.headers["mcp-session-id"]).toBeUndefined();
  });

  it(`answers an unknown client version with ${PROTOCOL}`, async () => {
    const res = await rpc("initialize", initParams("1999-01-01"));
    expect(res.body.result.protocolVersion).toBe(PROTOCOL);
  });
});

describe("tools/list", () => {
  it("returns the 14 contract tools, in order, with JSON schemas and SPEC descriptions", async () => {
    const res = await rpc("tools/list");
    expect(res.status).toBe(200);
    const tools = res.body.result.tools as Record<string, unknown>[];
    expect(tools.map((t) => t.name)).toEqual(TOOLS);
    for (const tool of tools) {
      const name = tool.name as string;
      expect(tool.description, name).toBe(specDescription(name));
      expect(tool.inputSchema, name).toMatchObject({ type: "object" });
      expect(tool.annotations, name).toMatchObject({ openWorldHint: false });
    }
  });

  it("marks only confirm_transfer and cancel_transfer as destructive", async () => {
    const tools = (await rpc("tools/list")).body.result.tools as {
      name: string;
      annotations: { destructiveHint?: boolean; readOnlyHint?: boolean };
    }[];
    expect(tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name)).toEqual([
      "confirm_transfer",
      "cancel_transfer",
    ]);
    expect(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual([
      "get_rate",
      "compare_options",
      "list_beneficiaries",
      "resolve_beneficiary",
      "track_transfer",
      "get_transfer_history",
      "check_limits",
      "get_help",
      "get_pending",
    ]);
  });

  it("describes inputs a model can fill: quote_transfer", async () => {
    const tools = (await rpc("tools/list")).body.result.tools as {
      name: string;
      inputSchema: { properties: Record<string, unknown>; required?: string[] };
    }[];
    const quote = tools.find((t) => t.name === "quote_transfer");
    expect(Object.keys(quote?.inputSchema.properties ?? {})).toEqual([
      "send_amount",
      "send_currency",
      "beneficiary_id",
      "payout_method",
      "purpose",
    ]);
    expect(quote?.inputSchema.required).toEqual(["send_amount", "beneficiary_id"]);
    expect(quote?.inputSchema.properties.payout_method).toMatchObject({
      enum: ["bank_deposit", "upi", "cash_pickup"],
    });
  });
});

describe("tools/call", () => {
  it.each<[string, Record<string, unknown>]>([
    ["get_rate", {}],
    ["compare_options", { send_amount: 2000 }],
    ["list_beneficiaries", {}],
    ["resolve_beneficiary", { query: "Mum" }],
    ["quote_transfer", { send_amount: 500, beneficiary_id: "ben_02" }],
    ["prepare_transfer", { quote_id: "q_unknown" }],
    ["confirm_transfer", { confirmation_token: "ct_unknown" }],
    ["track_transfer", { transfer_ref: "NUV-240120" }],
    ["cancel_transfer", { transfer_ref: "NUV-240119" }],
    ["get_transfer_history", { months: 3 }],
    ["check_limits", {}],
    ["set_rate_alert", { target: 26.5, direction: "above" }],
  ])("%s returns structured content in major units", async (name, args) => {
    const res = await call(name, args);
    expect(res.status).toBe(200);
    const result = res.body.result;
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    expect(result.structuredContent).toBeTypeOf("object");
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(keysDeep(result.structuredContent).filter((k) => k.endsWith("_minor"))).toEqual([]);
  });

  it("a code read out as words confirms over MCP, and junk gets a structured refusal", async () => {
    // Its own app: confirming a transfer would change "latest" for the tests that follow.
    const own = await testApp();
    const q = (
      await call("quote_transfer", { send_amount: 500, beneficiary_id: "ben_01" }, own.app)
    ).body.result.structuredContent;
    const token = (await call("prepare_transfer", { quote_id: q.quote_id }, own.app)).body.result
      .structuredContent.confirmation_token;
    await call("confirm_transfer", { confirmation_token: token }, own.app);
    const sms = own.core.outbox.since("usr_priya", "2000-01-01T00:00:00Z").at(-1)?.body ?? "";
    const code = /\b(\d{6})\b/.exec(sms)?.[1] ?? "";
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

    // Not a -32602 schema error: the model gets a refusal it can act on, and no try is used.
    const junk = (
      await call("confirm_transfer", { confirmation_token: token, otp: "banana." }, own.app)
    ).body.result;
    expect(junk.structuredContent).toMatchObject({
      refused: { code: "OTP_INVALID", attempts_left: 3 },
    });

    const spoken = `${code
      .split("")
      .map((d) => words[Number(d)])
      .join(" ")}.`;
    const done = (
      await call("confirm_transfer", { confirmation_token: token, otp: spoken }, own.app)
    ).body.result;
    expect(done.isError, JSON.stringify(done)).toBeFalsy();
    expect(done.structuredContent).toMatchObject({ status: "SCREENING" });
    own.core.db.close();
  });

  it("get_rate returns the live snapshot, derived at the peg", async () => {
    const res = await call("get_rate", { from: "AED", to: "INR" });
    expect(res.body.result.structuredContent).toMatchObject({
      corridor: "AE-IN",
      pair: "AED/INR",
      customer_rate: 25.994,
      mid_rate: 26.2301,
      fx_margin_pct: 0.9,
      source: "ECB via Frankfurter (USD/INR, AED at the 3.6725 peg), cached",
    });
  });

  it("converts amounts at the edge: send 2,000 dirhams, receive 51,598.09 rupees", async () => {
    const res = await call("compare_options", { send_amount: 2000, send_currency: "AED" });
    const bank = res.body.result.structuredContent.payout_methods[0];
    expect(bank).toMatchObject({
      method: "bank_deposit",
      fee: 15,
      receive_amount: 51598.09,
      available: true,
    });
  });

  it("refusals are structured results, not errors", async () => {
    const res = await call("cancel_transfer", { transfer_ref: "NUV-240119" });
    expect(res.body.result.isError).toBeFalsy();
    expect(res.body.result.structuredContent).toMatchObject({
      refused: { code: "CANCEL_WINDOW_CLOSED", status: "PAID_OUT" },
    });
    expect(res.body.result.structuredContent.refused.resolution).toMatch(/recall/);
  });

  it("rejects malformed input before any core code runs", async () => {
    for (const [name, args] of [
      ["get_rate", { from: "dollars" }],
      ["quote_transfer", { send_amount: 10.555, beneficiary_id: "ben_01" }],
      ["quote_transfer", { send_amount: -5, beneficiary_id: "ben_01" }],
      ["track_transfer", { transfer_ref: "'; DROP TABLE transfers;--" }],
    ] as const) {
      const res = await call(name, args);
      expect(res.body.result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
  });

  it("track_transfer with latest: true tracks the latest transfer even if a ref is sent too", async () => {
    const latest = await call("track_transfer", { latest: true, transfer_ref: "NUV-240119" });
    expect(latest.body.result.structuredContent).toMatchObject({ transfer_ref: "NUV-240120" });
    const byRef = await call("track_transfer", { transfer_ref: "NUV-240119" });
    expect(byRef.body.result.structuredContent).toMatchObject({ transfer_ref: "NUV-240119" });
  });

  it("get_pending returns cross-session context in major units", async () => {
    const res = await call("get_pending", {});
    expect(res.body.result.isError).toBeFalsy();
    expect(res.body.result.structuredContent).toMatchObject({
      under_review: [{ transfer_ref: "NUV-240120", send_amount: 5000 }],
      last_by_recipient: expect.arrayContaining([
        expect.objectContaining({ recipient: "Mum", send_amount: 2000 }),
      ]),
      summary: expect.stringContaining("under review"),
    });
  });

  it("serverInfo.version comes from package.json", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const init = await rpc("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    });
    expect(init.body.result.serverInfo).toEqual({ name: "nuvio-remit", version: pkg.version });
  });

  it("get_rate quotes other currencies for information and refuses unknown ones", async () => {
    const info = await call("get_rate", { from: "USD", to: "INR" });
    expect(info.body.result.isError).toBeFalsy();
    expect(info.body.result.structuredContent).toMatchObject({ pair: "USD/INR", sendable: false });
    const sending = await call("get_rate", {});
    expect(sending.body.result.structuredContent).toMatchObject({
      pair: "AED/INR",
      sendable: true,
    });
    const unknown = await call("get_rate", { from: "AED", to: "XYZ" });
    expect(unknown.body.result.isError).toBe(true);
    expect(unknown.body.result.structuredContent).toMatchObject({
      refused: { code: "CURRENCY_NOT_SUPPORTED", currency: "XYZ" },
    });
  });

  it("an unexpected failure becomes a structured INTERNAL_ERROR, never a crash", async () => {
    const broken = await testApp();
    broken.core.db.close();
    const res = await call("list_beneficiaries", {}, broken.app);
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.structuredContent).toMatchObject({
      refused: { code: "INTERNAL_ERROR" },
    });
  });
});

describe("auth and routes", () => {
  it("missing bearer returns 401 without WWW-Authenticate", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: initParams(PROTOCOL) });
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBeUndefined();
    expect(res.body.error.code).toBe(-32001);
  });

  it("wrong bearer returns 401", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", "Bearer not-the-token")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBeUndefined();
  });

  it("legacy GET /sse is not served", async () => {
    expect((await request(app).get("/sse")).status).toBe(404);
    expect(
      (await request(app).get("/sse").set("Authorization", `Bearer ${TEST_BEARER}`)).status,
    ).toBe(404);
  });

  it("GET /mcp returns 405 in stateless mode", async () => {
    const res = await request(app).get("/mcp").set("Authorization", `Bearer ${TEST_BEARER}`);
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("POST");
  });

  it("GET /health is open", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
