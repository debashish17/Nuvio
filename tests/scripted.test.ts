import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createCore, type Core } from "../src/core/index.js";
import { MockCard } from "../src/core/ledger.js";
import { seed } from "../src/db/seed.js";
import { createApp } from "../src/server/app.js";
import { DailyBudget } from "../src/server/sim/guards.js";
import { decideMode } from "../src/server/sim/mode.js";
import { McpRelay } from "../src/server/sim/relay.js";
import {
  DEMO_BEATS,
  findCode,
  parseAmount,
  SCRIPTED_NOTICE,
  ScriptedChat,
} from "../src/server/sim/scripted.js";
import { liveFetch, seededDb, silentLogger, TEST_BEARER, testClock } from "./helpers.js";

const SIM = "sim-code-for-tests";

interface Rig {
  app: Express;
  server: Server;
  core: Core;
  card: MockCard;
}
let rig: Rig | undefined;
afterEach(() => {
  rig?.server.close();
  rig?.core.db.close();
  rig = undefined;
});

/** The real app on a real port; the relay makes genuine POST /mcp calls to it. */
async function start(): Promise<Rig> {
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
  const chat = new ScriptedChat(relay);
  const app = createApp({
    bearerToken: TEST_BEARER,
    core,
    sim: {
      chat,
      relay,
      budget: new DailyBudget(1),
      accessCode: SIM,
      mode: "scripted",
      llm: null,
      reseed: () => {
        seed(core.db);
        chat.clear();
      },
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
  rig = { app, server, core, card };
  return rig;
}

async function say(app: Express, text: string, conversation?: string) {
  const res = await request(app)
    .post("/sim/chat")
    .set("x-sim-code", SIM)
    .send({ text, ...(conversation ? { conversation_id: conversation } : {}) });
  expect(res.status).toBe(200);
  return res.body as {
    conversation_id: string;
    reply: string;
    tool_calls: { name: string; refused?: string }[];
    exchanges: { method: string; request: { params?: { name?: string } } }[];
    model: string;
    mode?: string;
    notice?: string;
  };
}

/** What the page's phone toast does: the code from the latest text, read out with spaces. */
async function readCode(app: Express): Promise<string> {
  const res = await request(app)
    .get(`/sim/state?since=${encodeURIComponent("2000-01-01T00:00:00Z")}`)
    .set("x-sim-code", SIM);
  const code = /\b(\d{6})\b/.exec(res.body.sms.at(-1)?.body ?? "")?.[1] ?? "";
  expect(code).toMatch(/^\d{6}$/);
  return `The code is ${code.split("").join(" ")}.`;
}

describe("scripted mode: Play demo through the real tools, no language model", () => {
  it("runs every demo beat end to end over POST /mcp", async () => {
    const { app, card } = await start();
    const tools = await request(app).get("/sim/tools").set("x-sim-code", SIM);
    expect(tools.body).toMatchObject({ mode: "scripted", llm: null, demo_beats: [...DEMO_BEATS] });

    const turns: Awaited<ReturnType<typeof say>>[] = [];
    let conversation: string | undefined;
    for (const beat of DEMO_BEATS) {
      const text = beat === "{code}" ? await readCode(app) : beat;
      const r = await say(app, text, conversation);
      conversation = r.conversation_id;
      expect(r.model).toBe("scripted");
      expect(r.notice, `"${beat}" fell outside the script`).toBeUndefined();
      // Every tool call is a real JSON-RPC round trip through POST /mcp.
      const calls = r.exchanges.filter((x) => x.method === "tools/call");
      expect(calls.map((x) => x.request.params?.name)).toEqual(r.tool_calls.map((c) => c.name));
      turns.push(r);
    }
    /** The turn for the n-th occurrence of a beat. */
    const at = (beat: string, nth = 0) => turns.filter((_, i) => DEMO_BEATS[i] === beat)[nth];
    const names = (beat: string) => at(beat)?.tool_calls.map((c) => c.name);

    expect(names("Hi, anything I should know?")).toEqual(["get_pending"]);
    expect(at("Hi, anything I should know?")?.reply).toMatch(
      /under review: upload updated Emirates ID/,
    );
    expect(at("What's the rupee at today?")?.reply).toMatch(
      /^One dirham buys 25\.99 rupees today\./,
    );
    expect(names("How much would Mum get for 2,000 dirhams?")).toEqual([
      "resolve_beneficiary",
      "quote_transfer",
    ]);
    expect(names("Send 2,000 dirhams to Mum.")).toEqual([
      "resolve_beneficiary",
      "quote_transfer",
      "prepare_transfer",
    ]);
    expect(at("Send 2,000 dirhams to Mum.")?.reply).toMatch(
      /^Send 2,000 dirhams to Mum, Sunita Nair .* Shall I go ahead\?$/,
    );
    expect(at("Yes.")?.tool_calls[0]).toMatchObject({
      name: "confirm_transfer",
      refused: "STEP_UP_REQUIRED",
    });
    expect(at("{code}")?.reply).toMatch(/^Done\. NUV-240121 is on its way to Mum/);
    expect(card.charges).toHaveLength(1);
    expect(at("Send her another three thousand.")?.tool_calls[0]).toMatchObject({
      refused: "MONTHLY_LIMIT",
    });
    expect(at("Send her another three thousand.")?.reply).toMatch(
      /^That would go over your monthly limit\. Send up to 1,500 dirhams/,
    );
    expect(at("Send 500 to Rahul.")?.reply).toBe(
      "Do you mean your brother Rahul Nair, or your friend Rahul Menon?",
    );
    expect(names("Where's Mum's money?")).toEqual([
      "resolve_beneficiary",
      "get_transfer_history",
      "track_transfer",
    ]);
    expect(at("And the one to my NRE account?")?.reply).toMatch(
      /^It's under review\. Please upload updated Emirates ID/,
    );
    expect(at("Cancel the one to my NRE account.")?.reply).toMatch(
      /^Cancel the 5,000 dirham transfer/,
    );
    expect(at("Yes.", 1)?.tool_calls[0]).toMatchObject({ name: "cancel_transfer" });
    expect(at("Yes.", 1)?.reply).toMatch(/^Cancelled\. 5,000 dirhams go back to your card/);
    expect(at("Tell me when the dirham hits 26.5.")?.tool_calls[0]).toMatchObject({
      name: "set_rate_alert",
    });
  });

  it("a paid-out transfer gives only the end of its bank reference aloud", async () => {
    const { app } = await start();
    const r = await say(app, "Where's Mum's money?");
    const track = r.exchanges.find((x) => x.request.params?.name === "track_transfer") as
      { response?: { result?: { structuredContent?: { utr?: string } } } } | undefined;
    const utr = track?.response?.result?.structuredContent?.utr ?? "";
    expect(utr).toMatch(/^HDFCR5\d{16}$/);
    expect(r.reply).toBe(
      `It has been paid out. The bank reference ends in ${utr.slice(-4)}; the full reference is in the Nuvio app.`,
    );
  });

  it("free text outside the script gets a clear notice and no tool calls", async () => {
    const { app } = await start();
    const r = await say(
      app,
      "Could you write me a poem about rupees and dirhams in the moonlight?",
    );
    expect(r.notice).toBe(SCRIPTED_NOTICE);
    expect(r.tool_calls).toEqual([]);
    expect(r.mode).toBe("scripted");
  });

  it("takes the code read as words, refuses a wrong one, and never moves money on a bare yes", async () => {
    const { app, card } = await start();
    let r = await say(app, "Send 500 dirhams to Mum.");
    const c = r.conversation_id;
    r = await say(app, "yes please", c);
    expect(r.reply).toMatch(/texted a code to your phone ending 4471/);
    r = await say(app, "yes", c); // another yes is not a code
    expect(r.reply).toBe("Please read me the 6-digit code from the text message.");
    r = await say(app, "the code is 1 2 3 4 5 6", c);
    expect(r.tool_calls[0]).toMatchObject({ refused: "OTP_INVALID" });
    expect(card.charges).toHaveLength(0);
    const spoken = (await readCode(app))
      .replace("The code is ", "")
      .replace(".", "")
      .split(" ")
      .map(
        (d) =>
          ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][
            Number(d)
          ],
      )
      .join(" ");
    r = await say(app, `it's ${spoken}`, c);
    expect(r.reply).toMatch(/^Done\./);
    expect(card.charges).toHaveLength(1);
  });

  it("'send the usual to Mum' comes from get_pending's history", async () => {
    const { app } = await start();
    const r = await say(app, "Send the usual to Mum.");
    expect(r.tool_calls.map((t) => t.name)).toEqual([
      "resolve_beneficiary",
      "get_pending",
      "quote_transfer",
      "prepare_transfer",
    ]);
    expect(r.reply).toMatch(/^Send 2,000 dirhams to Mum/);
  });

  it("the receipt's Cancel button and the suggestion chips are in the script", async () => {
    const { app } = await start();
    let r = await say(app, "Send 500 dirhams to Mum.");
    const c = r.conversation_id;
    await say(app, "Yes.", c);
    r = await say(app, await readCode(app), c);
    const ref = /NUV-\d+/.exec(r.reply)?.[0];
    r = await say(app, `Cancel transfer ${ref}.`, c);
    expect(r.reply).toMatch(/^Cancel the 500 dirham transfer/);
    for (const chip of [
      "Where's my latest transfer?",
      "What are my limits?",
      "Does the LRS limit apply to me?",
    ]) {
      expect((await say(app, chip)).notice, chip).toBeUndefined();
    }
  });
});

describe("mode decision", () => {
  it("defaults to scripted unless a model is usable, and SIM_MODE wins", () => {
    const base = { LLM_PROVIDER: "bedrock" as const };
    expect(decideMode(base, false)).toMatchObject({
      mode: "scripted",
      reason: "no AWS credentials found",
    });
    expect(decideMode(base, true)).toMatchObject({ mode: "bedrock" });
    expect(decideMode({ LLM_PROVIDER: "openai_compatible" }, true).mode).toBe("scripted");
    expect(decideMode({ LLM_PROVIDER: "openai_compatible", LLM_API_KEY: "k" }, false).mode).toBe(
      "bedrock",
    );
    expect(decideMode({ ...base, SIM_MODE: "scripted" }, true).mode).toBe("scripted");
    expect(decideMode({ ...base, SIM_MODE: "bedrock" }, false).mode).toBe("bedrock");
  });

  it("parses amounts and codes the way people say them", () => {
    expect(parseAmount("2,000")).toBe(2000);
    expect(parseAmount("three thousand")).toBe(3000);
    expect(parseAmount("one thousand five hundred")).toBe(1500);
    expect(parseAmount("five hundred")).toBe(500);
    expect(findCode("The code is 4 8 2 9 1 3.")).toBe("482913");
    expect(findCode("it's four eight two nine one three")).toBe("482913");
    expect(findCode("send 500 to mum")).toBeUndefined();
  });
});
