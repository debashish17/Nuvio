import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  ConverseCommandInput,
  ConverseCommandOutput,
  Message,
} from "@aws-sdk/client-bedrock-runtime";
import type { Express } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCore, type Core } from "../src/core/index.js";
import { MockCard } from "../src/core/ledger.js";
import { seed, USER_ID } from "../src/db/seed.js";
import { createApp } from "../src/server/app.js";
import {
  ChatService,
  compactHistory,
  compactResult,
  toBedrockTools,
  type ConverseFn,
} from "../src/server/sim/chat.js";
import { DailyBudget, DemoFreshness } from "../src/server/sim/guards.js";
import { SYSTEM_PROMPT } from "../src/server/sim/prompt.js";
import { McpRelay, redactTokens } from "../src/server/sim/relay.js";
import { liveFetch, seededDb, silentLogger, TEST_BEARER, testClock } from "./helpers.js";

const SIM = "sim-code-for-tests";
const DEV = "dev-code-for-tests";

type Step = ConverseCommandOutput | ((input: ConverseCommandInput) => ConverseCommandOutput);

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const toolUse = (name: string, input: unknown, id = `tu_${name}`): ConverseCommandOutput =>
  ({
    output: {
      message: { role: "assistant", content: [{ toolUse: { toolUseId: id, name, input } }] },
    },
    stopReason: "tool_use",
    usage,
  }) as unknown as ConverseCommandOutput;
const say = (text: string): ConverseCommandOutput =>
  ({
    output: { message: { role: "assistant", content: [{ text }] } },
    stopReason: "end_turn",
    usage,
  }) as unknown as ConverseCommandOutput;

/** The json of the most recent toolResult the model was given. */
function lastToolResult(input: ConverseCommandInput): Record<string, unknown> {
  for (const m of [...(input.messages ?? [])].reverse()) {
    for (const b of m.content ?? []) {
      const json = b.toolResult?.content?.[0]?.json;
      if (json) return json as Record<string, unknown>;
    }
  }
  throw new Error("no tool result yet");
}

/** The value of `key` in the most recent tool result that has it. */
function fromHistory(input: ConverseCommandInput, key: string): unknown {
  for (const m of [...(input.messages ?? [])].reverse()) {
    for (const b of m.content ?? []) {
      const json = b.toolResult?.content?.[0]?.json as Record<string, unknown> | undefined;
      if (json && key in json) return json[key];
    }
  }
  return undefined;
}

/** The latest text the user typed or said. */
function lastUserText(input: ConverseCommandInput): string {
  for (const m of [...(input.messages ?? [])].reverse()) {
    const text = m.role === "user" ? m.content?.find((b) => b.text !== undefined)?.text : undefined;
    if (text !== undefined) return text;
  }
  return "";
}

/** The code in the latest text on the simulated phone. */
const latestCode = (core: Core) =>
  /\b(\d{6})\b/.exec(core.outbox.since(USER_ID, "2000-01-01T00:00:00Z").at(-1)?.body ?? "")?.[1] ??
  "";

/** A scripted Bedrock: each call takes the next step and records a copy of what it was sent. */
function scripted(steps: Step[]) {
  const seen: ConverseCommandInput[] = [];
  const fn = vi.fn(async (input: ConverseCommandInput) => {
    seen.push(structuredClone(input));
    const step = steps.shift();
    if (!step) throw new Error("script exhausted");
    return typeof step === "function" ? step(input) : step;
  });
  return { fn: fn as unknown as ConverseFn & typeof fn, seen, steps };
}

interface Rig {
  app: Express;
  server: Server;
  core: Core;
  card: MockCard;
}
let rig: Rig | undefined;
afterEach(async () => {
  if (!rig) return;
  rig.server.close();
  rig.core.db.close();
  rig = undefined;
});

async function start(
  opts: {
    converse?: ConverseFn;
    accessCode?: string | undefined;
    devCode?: string | undefined;
    budget?: number;
    modelId?: string;
    /** SIM_AUTO_RESET_MINUTES, on its own clock. */
    freshMinutes?: number;
    clock?: () => Date;
  } = {},
) {
  const card = new MockCard();
  const core = createCore({
    db: seededDb(),
    ratesUrl: "https://rates.test/v1",
    fetch: liveFetch(),
    now: testClock(),
    logger: silentLogger,
    card,
  });
  let port = 0;
  const relay = new McpRelay({ url: () => `http://127.0.0.1:${port}/mcp`, bearer: TEST_BEARER });
  const budget = new DailyBudget(opts.budget ?? 1000);
  const chat = new ChatService({
    relay,
    converse: opts.converse ?? scripted([]).fn,
    modelId: opts.modelId ?? "test-model",
    systemPrompt: SYSTEM_PROMPT,
    budget,
  });
  const reseed = () => {
    seed(core.db);
    chat.clear();
    relay.reset();
  };
  const app = createApp({
    bearerToken: TEST_BEARER,
    core,
    sim: {
      chat,
      relay,
      budget,
      accessCode: "accessCode" in opts ? opts.accessCode : SIM,
      devCode: "devCode" in opts ? opts.devCode : DEV,
      reseed,
      freshness: opts.freshMinutes
        ? new DemoFreshness(opts.freshMinutes * 60_000, reseed, opts.clock)
        : undefined,
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
  rig = { app, server, core, card };
  return rig;
}

const devTurn = (app: Express, i: number, code: string) =>
  request(app)
    .post("/sim/chat")
    .set("x-sim-code", SIM)
    .set("x-dev-code", code)
    .send({ text: `hi ${i}` });

const sim = (app: Express) => ({
  get: (path: string) => request(app).get(path).set("x-sim-code", SIM),
  chat: (text: string, conversation_id?: string) =>
    request(app)
      .post("/sim/chat")
      .set("x-sim-code", SIM)
      .send({ text, ...(conversation_id ? { conversation_id } : {}) }),
  dev: (path: string, body: object = {}) =>
    request(app).post(path).set("x-dev-code", DEV).send(body),
});

describe("access", () => {
  it("/sim is 503 and /dev is 404 when their codes are not configured", async () => {
    const { app } = await start({ accessCode: undefined, devCode: undefined });
    expect((await request(app).get("/sim/tools").set("x-sim-code", SIM)).status).toBe(503);
    expect((await request(app).post("/dev/tick").set("x-dev-code", DEV)).status).toBe(404);
  });

  it("a missing or wrong code is 401", async () => {
    const { app } = await start();
    expect((await request(app).get("/sim/tools")).status).toBe(401);
    expect((await request(app).get("/sim/tools").set("x-sim-code", "nope-nope")).status).toBe(401);
    expect((await request(app).post("/dev/tick").set("x-dev-code", SIM)).status).toBe(401);
  });

  it("the page never needs the Bearer secret, and /mcp still requires it", async () => {
    const { app } = await start();
    const res = await sim(app).get("/sim/tools");
    expect(JSON.stringify(res.body)).not.toContain(TEST_BEARER);
    expect((await request(app).post("/mcp").send({})).status).toBe(401);
  });
});

describe("GET /sim/tools", () => {
  it("does a real initialize + tools/list over /mcp and returns the exchange", async () => {
    const { app } = await start();
    const res = await sim(app).get("/sim/tools");
    expect(res.status).toBe(200);
    expect(res.body.protocol_version).toBe("2025-11-25");
    expect(res.body.tools).toHaveLength(14);
    expect(res.body.exchanges.map((e: { method: string }) => e.method)).toEqual([
      "initialize",
      "tools/list",
    ]);
    for (const e of res.body.exchanges) {
      expect(e.status).toBe(200);
      expect(e.ms).toBeGreaterThan(0);
    }
  });
});

describe("POST /sim/chat", () => {
  it("runs the send beat: resolve, quote, prepare, read back; then confirm on 'Yes'", async () => {
    const bedrock = scripted([
      toolUse("resolve_beneficiary", { query: "Mum" }),
      toolUse("quote_transfer", { send_amount: 2000, beneficiary_id: "ben_01" }),
      (input) => toolUse("prepare_transfer", { quote_id: lastToolResult(input).quote_id }),
      (input) => say(String(lastToolResult(input).read_back)),
      (input) => {
        const prepared = input.messages
          ?.flatMap((m) => m.content ?? [])
          .map((b) => b.toolResult?.content?.[0]?.json as Record<string, unknown> | undefined)
          .find((j) => j && "confirmation_token" in j);
        return toolUse("confirm_transfer", {
          confirmation_token: prepared?.confirmation_token,
        });
      },
      (input) => {
        const r = lastToolResult(input).refused as { sent_to?: string } | undefined;
        return say(`I've texted a code to your ${String(r?.sent_to)}. Please read it out.`);
      },
      (input) =>
        toolUse("confirm_transfer", {
          confirmation_token: fromHistory(input, "confirmation_token"),
          otp: lastUserText(input),
        }),
      (input) => say(`Done. Reference ${String(lastToolResult(input).transfer_ref)}.`),
    ]);
    const { app, core, card } = await start({ converse: bedrock.fn });

    const first = await sim(app).chat("Send 2,000 dirhams to Mum");
    expect(first.status).toBe(200);
    expect(first.body.reply).toMatch(/^Send 2,000 dirhams to Mum, Sunita Nair at HDFC Bank/);
    expect(first.body.tool_calls.map((t: { name: string }) => t.name)).toEqual([
      "resolve_beneficiary",
      "quote_transfer",
      "prepare_transfer",
    ]);
    // The model received the full token; the protocol panel gets only its prefix.
    const prepareResult = bedrock.seen[3] && lastToolResult(bedrock.seen[3]);
    expect(String(prepareResult?.confirmation_token)).toMatch(/^ct_[A-Za-z0-9_-]{43}$/);
    const panel = JSON.stringify(first.body.exchanges);
    expect(panel).toMatch(/ct_[A-Za-z0-9_-]{5}…/);
    expect(panel).not.toContain(String(prepareResult?.confirmation_token));
    expect(bedrock.seen[0]?.system?.[0]).toEqual({ text: SYSTEM_PROMPT });
    // 14 tool specs, then the prompt-cache point.
    expect(bedrock.seen[0]?.toolConfig?.tools?.filter((t) => t.toolSpec)).toHaveLength(14);
    expect(card.charges).toHaveLength(0);

    const second = await sim(app).chat("Yes", first.body.conversation_id);
    expect(second.body.conversation_id).toBe(first.body.conversation_id);
    expect(second.body.reply).toBe(
      "I've texted a code to your phone ending 4471. Please read it out.",
    );
    expect(second.body.tool_calls).toEqual([
      expect.objectContaining({ name: "confirm_transfer", refused: "STEP_UP_REQUIRED" }),
    ]);
    expect(card.charges).toHaveLength(0);
    // The code went to the phone, not to the model.
    const code = latestCode(core);
    expect(code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(bedrock.seen)).not.toContain(code);

    const third = await sim(app).chat(code.split("").join(" "), first.body.conversation_id);
    expect(third.body.reply).toBe("Done. Reference NUV-240121.");
    expect(card.charges).toHaveLength(1);
    // The protocol panel shows only the start of the code.
    expect(JSON.stringify(third.body.exchanges)).not.toContain(code.split("").join(" "));
    expect(core.ledger.track(USER_ID, "NUV-240121")).toMatchObject({ status: "SCREENING" });
    // Turn two carried the whole first turn, tool calls included.
    expect(bedrock.seen[4]?.messages?.length).toBe(9);
  });

  it("reports refusals in tool_calls so the panel can show them", async () => {
    const bedrock = scripted([
      toolUse("quote_transfer", { send_amount: 4000, beneficiary_id: "ben_01" }),
      (input) => say(String((lastToolResult(input).refused as { resolution: string }).resolution)),
    ]);
    const { app } = await start({ converse: bedrock.fn });
    const res = await sim(app).chat("Send 4,000 to Mum");
    expect(res.body.tool_calls).toEqual([
      expect.objectContaining({ name: "quote_transfer", refused: "MONTHLY_LIMIT" }),
    ]);
    expect(res.body.reply).toMatch(/^Send up to 3,500 dirhams now/);
  });

  it("stops at the daily Bedrock budget and drops the unfinished turn", async () => {
    const bedrock = scripted([toolUse("get_rate", {}), say("unused")]);
    const { app } = await start({ converse: bedrock.fn, budget: 1 });
    const res = await sim(app).chat("What's the rate?");
    expect(res.body.error).toMatchObject({ code: "DAILY_BUDGET" });
    expect(res.body.reply).toMatch(/today's assistant allowance/);
    expect(bedrock.fn).toHaveBeenCalledTimes(1);
  });

  it("turns a Bedrock failure into a spoken apology and keeps the history valid", async () => {
    const denied = Object.assign(new Error("You don't have access to the model"), {
      name: "AccessDeniedException",
    });
    const bedrock = scripted([
      () => {
        throw denied;
      },
      say("Hello again."),
    ]);
    const { app } = await start({ converse: bedrock.fn });
    const first = await sim(app).chat("Hi");
    expect(first.body).toMatchObject({
      reply: expect.stringMatching(/unavailable right now/),
      error: { code: "AccessDeniedException" },
    });
    const second = await sim(app).chat("Hi", first.body.conversation_id);
    expect(second.body.reply).toBe("Hello again.");
    // The failed turn was dropped: only the new user message was sent.
    expect(bedrock.seen[1]?.messages).toHaveLength(1);
  });

  it("gives up after 6 tool rounds", async () => {
    const bedrock = scripted(Array.from({ length: 10 }, () => toolUse("get_rate", {})));
    const { app } = await start({ converse: bedrock.fn });
    const res = await sim(app).chat("Loop forever");
    expect(res.body.error).toMatchObject({ code: "TOOL_ROUNDS" });
    expect(bedrock.fn).toHaveBeenCalledTimes(6);
  });

  it("rejects an empty or oversized turn", async () => {
    const { app } = await start();
    expect((await sim(app).chat("")).status).toBe(400);
    expect((await sim(app).chat("x".repeat(501))).status).toBe(400);
  });

  it("rate-limits chat per client: 30 per 10 minutes", async () => {
    const bedrock = scripted(Array.from({ length: 40 }, () => say("ok")));
    const { app } = await start({ converse: bedrock.fn });
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await sim(app).chat(`hi ${i}`)).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it("lets the dev-controls code past the chat limit, but not past the daily budget", async () => {
    const bedrock = scripted(Array.from({ length: 40 }, () => say("ok")));
    const { app } = await start({ converse: bedrock.fn, budget: 32 });
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await devTurn(app, i, DEV)).status);
    expect(statuses.every((s) => s === 200)).toBe(true);
    const capped = await devTurn(app, 32, DEV);
    expect(capped.body.error).toMatchObject({ code: "DAILY_BUDGET" });
  });

  it("limits a wrong dev-controls code like any other caller", async () => {
    const bedrock = scripted(Array.from({ length: 40 }, () => say("ok")));
    const { app } = await start({ converse: bedrock.fn });
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await devTurn(app, i, "wrong-dev-code")).status);
    expect(statuses[29]).toBe(200);
    expect(statuses[30]).toBe(429);
  });
});

describe("GET /sim/state", () => {
  it("feeds the ledger strip in major units, and toasts alerts fired since a time", async () => {
    const { app, core } = await start();
    const before = new Date(Date.now() - 1000).toISOString();
    let res = await sim(app).get(`/sim/state?since=${encodeURIComponent(before)}`);
    expect(res.body.latest_transfer).toMatchObject({
      transfer_ref: "NUV-240120",
      customer_label: "Under review",
      send_amount: 5000,
    });
    expect(res.body.limits.monthly).toMatchObject({ remaining: 3500, resets_on: "2026-11-01" });
    expect(res.body.open_quote).toBeNull();
    expect(res.body.alerts).toEqual([]);
    expect(res.body.rate).toMatchObject({
      customer_rate: expect.any(Number),
      mid_rate: expect.any(Number),
    });
    expect(res.body.rate.customer_rate).toBeLessThan(res.body.rate.mid_rate);

    await core.alerts.set(USER_ID, "AED/INR", 26.5, "above");
    await sim(app).dev("/dev/alert");
    res = await sim(app).get(`/sim/state?since=${encodeURIComponent("2026-01-01T00:00:00Z")}`);
    expect(res.body.alerts).toEqual([expect.objectContaining({ alert_id: "al_01" })]);

    // The simulated phone shows step-up texts.
    const q = await core.quotes.create(USER_ID, { beneficiaryId: "ben_01", sendMinor: 50_000 });
    if ("refused" in q) throw new Error("quote refused");
    const prep = core.quotes.prepare(USER_ID, q.quote_id, "usr_priya:c");
    if ("refused" in prep) throw new Error("prepare refused");
    core.stepUp.confirm(USER_ID, prep.confirmation_token, "usr_priya:c");
    res = await sim(app).get(`/sim/state?since=${encodeURIComponent("2026-01-01T00:00:00Z")}`);
    expect(res.body.sms).toEqual([
      expect.objectContaining({
        to: "4471",
        body: expect.stringMatching(/^Nuvio: \d{6} is your code/),
      }),
    ]);
  });
});

describe("/dev controls", () => {
  it("advance, release, fire and reset", async () => {
    const { app, core } = await start();
    expect((await sim(app).dev("/dev/release")).body).toEqual({
      ref: "NUV-240120",
      status: "SCREENING",
    });
    expect((await sim(app).dev("/dev/tick")).body.advanced).toEqual([
      { ref: "NUV-240120", status: "SENT_TO_PARTNER" },
    ]);
    expect((await sim(app).dev("/dev/alert")).status).toBe(404); // nothing pending
    await core.alerts.set(USER_ID, "AED/INR", 26.5, "above");
    expect((await sim(app).dev("/dev/alert")).body).toMatchObject({ simulated: true });

    expect((await sim(app).dev("/dev/reset")).body).toEqual({ reset: true });
    expect(core.ledger.track(USER_ID, "NUV-240120")).toMatchObject({ status: "ON_HOLD" });
    expect(core.alerts.list(USER_ID)).toEqual([]);
  });
});

describe("fresh demo data for each visitor", () => {
  it("reloads on the first page load, after a quiet spell and on a new day in Dubai", () => {
    const clock = testClock(new Date("2026-11-10T10:00:00Z"));
    const reseed = vi.fn();
    const fresh = new DemoFreshness(30 * 60_000, reseed, clock);
    expect(fresh.refresh()).toBe(true); // the first visitor
    clock.advance(20 * 60_000);
    expect(fresh.refresh()).toBe(false); // 20 quiet minutes
    clock.advance(15 * 60_000);
    expect(fresh.refresh()).toBe(true); // 35 quiet minutes
    clock.advance(25 * 60_000);
    fresh.touch();
    clock.advance(25 * 60_000);
    expect(fresh.refresh()).toBe(false); // active 25 minutes ago
    clock.set(new Date("2026-11-10T19:59:00Z"));
    fresh.touch();
    clock.set(new Date("2026-11-10T20:00:00Z")); // midnight in Dubai
    expect(fresh.refresh()).toBe(true);
    expect(reseed).toHaveBeenCalledTimes(3);
  });

  it("never reloads at 0 minutes, the default", async () => {
    const reseed = vi.fn();
    expect(new DemoFreshness(0, reseed).refresh()).toBe(false);
    expect(reseed).not.toHaveBeenCalled();
    const { app } = await start();
    expect((await sim(app).get("/sim/tools")).body.fresh_demo).toBe(false);
  });

  it("a page load after a quiet spell gives the next visitor the seed again", async () => {
    const clock = testClock();
    const { app, core } = await start({ freshMinutes: 30, clock });
    expect((await sim(app).get("/sim/tools")).body.fresh_demo).toBe(true);
    await sim(app).dev("/dev/release"); // the first visitor acts
    clock.advance(10 * 60_000);
    expect((await sim(app).get("/sim/tools")).body.fresh_demo).toBe(false);
    expect(core.ledger.track(USER_ID, "NUV-240120")).toMatchObject({ status: "SCREENING" });

    clock.advance(31 * 60_000);
    expect((await sim(app).get("/sim/state")).status).toBe(200); // an idle tab polling
    expect((await sim(app).get("/sim/tools")).body.fresh_demo).toBe(true);
    expect(core.ledger.track(USER_ID, "NUV-240120")).toMatchObject({ status: "ON_HOLD" });
  });
});

describe("helpers", () => {
  it("toBedrockTools strips $schema and keeps name, description and schema", () => {
    expect(
      toBedrockTools([
        {
          name: "get_rate",
          description: "d",
          inputSchema: { $schema: "x", type: "object", properties: {} },
        },
      ]),
    ).toEqual([
      {
        toolSpec: {
          name: "get_rate",
          description: "d",
          inputSchema: { json: { type: "object", properties: {} } },
        },
      },
    ]);
  });

  it("redactTokens keeps an 8-character prefix of ct_ and cx_ tokens", () => {
    const t = `ct_${"A".repeat(43)}`;
    expect(redactTokens({ a: t, b: [`cx_${"b".repeat(43)}`], c: "ct_short" })).toEqual({
      a: "ct_AAAAA…",
      b: ["cx_bbbbb…"],
      c: "ct_short",
    });
  });
});

describe("consent guard", () => {
  it("blocks confirm_transfer in the same turn as prepare_transfer; the next turn's yes goes through", async () => {
    const bedrock = scripted([
      toolUse("quote_transfer", { send_amount: 2000, beneficiary_id: "ben_01" }),
      (input) => toolUse("prepare_transfer", { quote_id: lastToolResult(input).quote_id }),
      // An over-eager model tries to confirm before the user has answered.
      (input) =>
        toolUse("confirm_transfer", {
          confirmation_token: fromHistory(input, "confirmation_token"),
        }),
      (input) => say(String(fromHistory(input, "read_back"))),
      // Turn two, after the user says yes: a code goes to the phone.
      (input) =>
        toolUse("confirm_transfer", {
          confirmation_token: fromHistory(input, "confirmation_token"),
        }),
      () => say("Please read the code."),
      // Turn three, the user reads the code.
      (input) =>
        toolUse("confirm_transfer", {
          confirmation_token: fromHistory(input, "confirmation_token"),
          otp: lastUserText(input),
        }),
      (input) => say(`Done: ${String(lastToolResult(input).transfer_ref)}.`),
    ]);
    const { app, card, core } = await start({ converse: bedrock.fn });

    const first = await sim(app).chat("Send 2,000 dirhams to Mum");
    expect(first.body.tool_calls).toEqual([
      expect.objectContaining({ name: "quote_transfer" }),
      expect.objectContaining({ name: "prepare_transfer" }),
      { name: "confirm_transfer", ms: 0, refused: "AWAITING_USER_CONFIRMATION", blocked: true },
    ]);
    expect(card.charges).toHaveLength(0);
    // The blocked call never reached the MCP server.
    const calls = first.body.exchanges.map(
      (e: { request: { params?: { name?: string } } }) => e.request.params?.name,
    );
    expect(calls).not.toContain("confirm_transfer");
    // The model was told to read back and wait.
    expect(lastToolResult(bedrock.seen[3] as ConverseCommandInput)).toMatchObject({
      refused: { code: "AWAITING_USER_CONFIRMATION" },
    });
    expect(first.body.reply).toMatch(/^Send 2,000 dirhams to Mum/);

    const second = await sim(app).chat("Yes, go ahead", first.body.conversation_id);
    expect(second.body.tool_calls).toEqual([
      expect.objectContaining({ refused: "STEP_UP_REQUIRED", name: "confirm_transfer" }),
    ]);
    expect(card.charges).toHaveLength(0);
    const third = await sim(app).chat(latestCode(core), first.body.conversation_id);
    expect(third.body.reply).toBe("Done: NUV-240121.");
    expect(third.body.tool_calls).toEqual([expect.not.objectContaining({ blocked: true })]);
    expect(card.charges).toHaveLength(1);
  });

  it("blocks a cancel executed in the same turn as its preview", async () => {
    const bedrock = scripted([
      toolUse("cancel_transfer", { transfer_ref: "NUV-240120" }),
      (input) =>
        toolUse("cancel_transfer", {
          transfer_ref: "NUV-240120",
          cancel_token: fromHistory(input, "cancel_token"),
        }),
      (input) => say(String(fromHistory(input, "preview"))),
      (input) =>
        toolUse("cancel_transfer", {
          transfer_ref: "NUV-240120",
          cancel_token: fromHistory(input, "cancel_token"),
        }),
      () => say("Cancelled."),
    ]);
    const { app, core, card } = await start({ converse: bedrock.fn });

    const first = await sim(app).chat("Cancel the one to my NRE account");
    expect(first.body.tool_calls[1]).toMatchObject({ name: "cancel_transfer", blocked: true });
    expect(core.ledger.track(USER_ID, "NUV-240120")).toMatchObject({ status: "ON_HOLD" });
    expect(first.body.reply).toMatch(/^Cancel the 5,000 dirham transfer/);

    await sim(app).chat("Yes", first.body.conversation_id);
    expect(core.ledger.track(USER_ID, "NUV-240120")).toMatchObject({ status: "CANCELLED" });
    expect(card.refunds).toHaveLength(1);
  });
});

describe("prompt caching", () => {
  // Every Converse call resends about 13k tokens, mostly the system prompt and the 14 tool specs.
  // Cache points let Bedrock bill that stable prefix at the cache-read price.
  const isMarker = (b: unknown) =>
    typeof b === "object" && b !== null && "cachePoint" in b && b.cachePoint !== undefined;

  it("marks the system prompt, the tool list and the conversation so far; history stays clean", async () => {
    const bedrock = scripted([
      toolUse("get_rate", {}),
      say("About 25.99."),
      say("You're welcome."),
    ]);
    const { app } = await start({ converse: bedrock.fn });
    const first = await sim(app).chat("What's the rate?");
    await sim(app).chat("Thanks", first.body.conversation_id);

    for (const sent of bedrock.seen) {
      expect(sent.system?.at(-1), "system").toEqual({ cachePoint: { type: "default" } });
      expect(sent.toolConfig?.tools?.at(-1), "tools").toEqual({ cachePoint: { type: "default" } });
      // One marker in the conversation, after the user's newest words. Never inside a tool
      // result: Nova rejects that (live, 2026-10-19).
      const messages = sent.messages ?? [];
      const marked = messages.filter((m) => (m.content ?? []).some(isMarker));
      expect(marked).toHaveLength(1);
      const userText = messages.filter((m) => m.role === "user" && m.content?.some((b) => b.text));
      expect(marked[0]).toBe(userText.at(-1));
      expect(isMarker(marked[0]?.content?.at(-1))).toBe(true);
      expect(marked[0]?.content?.some((b) => b.toolResult)).toBe(false);
    }
  });

  it("Nova: cache points on the system prompt and the conversation, none on the tool list", async () => {
    // Nova 2 Lite rejects one on the tools (live, 2026-10-19): "extraneous key [cachePoint]".
    const bedrock = scripted([say("Hi.")]);
    const { app } = await start({ converse: bedrock.fn, modelId: "us.amazon.nova-2-lite-v1:0" });
    await sim(app).chat("Hi");
    const sent = bedrock.seen[0];
    expect(sent?.system?.at(-1)).toEqual({ cachePoint: { type: "default" } });
    expect(sent?.toolConfig?.tools?.some(isMarker)).toBe(false);
    expect(isMarker(sent?.messages?.at(-1)?.content?.at(-1))).toBe(true);
  });

  it("if Bedrock rejects the conversation cache point, drops only that one", async () => {
    const rejected = Object.assign(
      new Error(
        "The model returned the following errors: Malformed input request: #/messages/2/content/0: extraneous key [cachePoint] is not permitted",
      ),
      { name: "ValidationException" },
    );
    const bedrock = scripted([
      () => {
        throw rejected;
      },
      say("Hello."),
    ]);
    const { app } = await start({ converse: bedrock.fn, modelId: "us.amazon.nova-2-lite-v1:0" });
    expect((await sim(app).chat("Hi")).body.reply).toBe("Hello.");
    const retry = bedrock.seen[1];
    expect(retry?.system?.some(isMarker)).toBe(true);
    expect((retry?.messages ?? []).flatMap((m) => m.content ?? []).some(isMarker)).toBe(false);
  });

  it("if Bedrock rejects the tool-list cache point, drops only that one", async () => {
    const rejected = Object.assign(
      new Error(
        "The model returned the following errors: Malformed input request: #/toolConfig/tools/13: extraneous key [cachePoint] is not permitted",
      ),
      { name: "ValidationException" },
    );
    const bedrock = scripted([
      () => {
        throw rejected;
      },
      say("Hello."),
      say("Hello again."),
    ]);
    const { app } = await start({ converse: bedrock.fn });
    const first = await sim(app).chat("Hi");
    expect(first.body.reply).toBe("Hello.");
    await sim(app).chat("Hi", first.body.conversation_id);
    for (const sent of bedrock.seen.slice(1)) {
      expect(sent.toolConfig?.tools?.some(isMarker)).toBe(false);
      expect(sent.system?.some(isMarker)).toBe(true);
      expect(isMarker(sent.messages?.at(-1)?.content?.at(-1))).toBe(true);
    }
  });

  it("if the model rejects cache points altogether, retries without them and stops sending them", async () => {
    const rejected = Object.assign(
      new Error("This model does not support prompt caching (cachePoint)."),
      {
        name: "ValidationException",
      },
    );
    const bedrock = scripted([
      () => {
        throw rejected;
      },
      say("Hello."),
      say("Hello again."),
    ]);
    const { app } = await start({ converse: bedrock.fn });
    const first = await sim(app).chat("Hi");
    expect(first.body.reply).toBe("Hello.");
    expect(first.body.error).toBeUndefined();
    await sim(app).chat("Hi", first.body.conversation_id);
    for (const sent of bedrock.seen.slice(1)) {
      expect(sent.system?.some(isMarker)).toBe(false);
      expect(sent.toolConfig?.tools?.some(isMarker)).toBe(false);
      expect((sent.messages ?? []).flatMap((m) => m.content ?? []).some(isMarker)).toBe(false);
    }
  });

  it("reports cache reads and writes in the turn's usage", async () => {
    const cached = {
      ...say("Hi."),
      usage: {
        inputTokens: 120,
        outputTokens: 5,
        totalTokens: 9325,
        cacheReadInputTokens: 9000,
        cacheWriteInputTokens: 200,
      },
    } as ConverseCommandOutput;
    const { app } = await start({ converse: scripted([cached]).fn });
    const res = await sim(app).chat("Hi");
    expect(res.body.usage).toEqual({
      input_tokens: 120,
      output_tokens: 5,
      cache_read_tokens: 9000,
      cache_write_tokens: 200,
    });
  });
});

describe("history compaction", () => {
  const long = "x".repeat(200);
  const result = (json: Record<string, unknown>) => ({
    role: "user" as const,
    content: [{ toolResult: { toolUseId: "t", content: [{ json }], status: "success" as const } }],
  });
  const userText = (text: string) => ({ role: "user" as const, content: [{ text }] });
  const assistant = { role: "assistant" as const, content: [{ text: "ok" }] };

  it("keeps ids, tokens and amounts; drops long text, deep nesting and long lists", () => {
    expect(
      compactResult({
        confirmation_token: "ct_" + "a".repeat(43),
        quote_id: "q_1",
        send_amount: 2000,
        read_back: long,
        timeline: [1, 2, 3, 4, 5, 6, 7],
        deep: { a: { b: { c: 1 } } },
      }),
    ).toEqual({
      confirmation_token: "ct_" + "a".repeat(43),
      quote_id: "q_1",
      send_amount: 2000,
      timeline: [1, 2, 3, 4, 5],
      deep: { a: {} },
    });
  });

  it("sends the last two user turns in full and compacts older tool results", () => {
    const messages = [
      userText("turn 1"),
      result({ read_back: long, ref: "NUV-1" }),
      assistant,
      userText("turn 2"),
      result({ read_back: long }),
      assistant,
      userText("turn 3"),
      result({ read_back: long }),
    ] as unknown as Message[];
    const out = compactHistory(messages);
    const json = (i: number) => out[i]?.content?.[0]?.toolResult?.content?.[0]?.json;
    expect(json(1)).toEqual({ ref: "NUV-1" });
    expect(json(4)).toEqual({ read_back: long });
    expect(json(7)).toEqual({ read_back: long });
    expect(messages[1]?.content?.[0]?.toolResult?.content?.[0]?.json).toEqual({
      read_back: long,
      ref: "NUV-1",
    }); // stored history untouched
  });
});
