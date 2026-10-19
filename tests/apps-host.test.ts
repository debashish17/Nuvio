import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ConverseCommandInput, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type { Express } from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createCore, type Core } from "../src/core/index.js";
import { MockCard } from "../src/core/ledger.js";
import { DEMO_USER_ID } from "../src/core/policy.js";
import { seed } from "../src/db/seed.js";
import { TRANSFER_VIEW_URI } from "../src/server/apps.js";
import { createApp } from "../src/server/app.js";
import { ChatService, toBedrockTools, type ChatReply } from "../src/server/sim/chat.js";
import { FrameStore, viewCsp } from "../src/server/sim/frames.js";
import { DailyBudget } from "../src/server/sim/guards.js";
import { McpRelay } from "../src/server/sim/relay.js";
import { ScriptedChat, type ChatEngine } from "../src/server/sim/scripted.js";
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

/** The real app on a real port, so the relay's calls are genuine POST /mcp round trips. */
async function start(engine: (relay: McpRelay) => ChatEngine = (r) => new ScriptedChat(r)) {
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
  const chat = engine(relay);
  const app = createApp({
    bearerToken: TEST_BEARER,
    core,
    sim: {
      chat,
      relay,
      budget: new DailyBudget(100),
      accessCode: SIM,
      mode: "scripted",
      llm: null,
      reseed: () => seed(core.db),
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
  rig = { app, server, core, card };
  return rig;
}

const post = (app: Express, path: string, body: unknown) =>
  request(app)
    .post(path)
    .set("x-sim-code", SIM)
    .send(body as object);

async function say(app: Express, text: string, conversation?: string): Promise<ChatReply> {
  const res = await post(app, "/sim/chat", {
    text,
    ...(conversation ? { conversation_id: conversation } : {}),
  });
  expect(res.status).toBe(200);
  return res.body as ChatReply;
}

const latestCode = (core: Core) =>
  /\b(\d{6})\b/.exec(
    core.outbox.since(DEMO_USER_ID, "2000-01-01T00:00:00Z").at(-1)?.body ?? "",
  )?.[1] ?? "";

describe("the simulator as an MCP Apps host", () => {
  it("announces the extension, and the page learns which tools link the view", async () => {
    const { app } = await start();
    const res = await request(app).get("/sim/tools").set("x-sim-code", SIM);
    const init = res.body.exchanges.find((x: { method: string }) => x.method === "initialize");
    expect(init.request.params.capabilities).toEqual({
      extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
    });
    const linked = (res.body.tools as { name: string; _meta?: { ui?: { resourceUri?: string } } }[])
      .filter((t) => t._meta?.ui?.resourceUri === TRANSFER_VIEW_URI)
      .map((t) => t.name);
    expect(linked).toHaveLength(4);
  });

  it("reads the view with resources/read and serves it once, under the view's own CSP", async () => {
    const { app } = await start();
    const unknown = await post(app, "/sim/app-view", { uri: "ui://nuvio-remit/nope" });
    expect(unknown.status).toBe(404);

    const res = await post(app, "/sim/app-view", { uri: TRANSFER_VIEW_URI });
    expect(res.status).toBe(200);
    expect(res.body.frame_url).toMatch(/^\/sim\/app-frame\/[\w-]{24}$/);
    expect(res.body.prefers_border).toBe(true);
    // The protocol panel shows the real resources/read, with the HTML cut short.
    const read = res.body.exchanges.find((x: { method: string }) => x.method === "resources/read");
    expect(read.request.params).toEqual({ uri: TRANSFER_VIEW_URI });
    expect(read.response.result.contents[0].text).toMatch(/… \([\d,]+ characters\)$/);

    // No access-code header: an iframe can't send one. The id is the credential.
    const frame = await request(app).get(res.body.frame_url);
    expect(frame.status).toBe(200);
    expect(frame.headers["content-type"]).toMatch(/^text\/html/);
    expect(frame.text).toMatch(/^<!doctype html>/i);
    const csp = String(frame.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(frame.headers["cache-control"]).toBe("no-store");

    expect((await request(app).get(res.body.frame_url)).status).toBe(404); // single use
    expect((await request(app).get("/sim/app-frame/made-up-id")).status).toBe(404);
  });

  it("serves the page's host bridge (AppBridge) from the build output", async () => {
    const { app } = await start();
    const res = await request(app).get("/js/app-host.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.text).toContain("mountView");
  });

  it("the app view needs the access code to be requested", async () => {
    const { app } = await start();
    const res = await request(app).post("/sim/app-view").send({ uri: TRANSFER_VIEW_URI });
    expect(res.status).toBe(401);
  });

  it("lets a view call only tools linked to it", async () => {
    const { app } = await start();
    const rate = await post(app, "/sim/app-tool", {
      resource_uri: TRANSFER_VIEW_URI,
      name: "get_rate",
      arguments: {},
    });
    expect(rate.status).toBe(403);
    const wrongView = await post(app, "/sim/app-tool", {
      resource_uri: "ui://nuvio-remit/other",
      name: "track_transfer",
      arguments: { latest: true },
    });
    expect(wrongView.status).toBe(403);
    const ok = await post(app, "/sim/app-tool", {
      resource_uri: TRANSFER_VIEW_URI,
      name: "track_transfer",
      arguments: { latest: true },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.result.structuredContent.transfer_ref).toMatch(/^NUV-/);
    expect(ok.body.exchanges.map((x: { method: string }) => x.method)).toContain("tools/call");
  });

  it("a code typed in the view confirms through the host, never through the model", async () => {
    const { app, core, card } = await start();
    let r = await say(app, "Send 500 dirhams to Mum.");
    const c = r.conversation_id;
    // Each linked call carries what the view needs; the read-back's token is whole for the view.
    expect(r.tool_calls.filter((t) => t.app).map((t) => t.name)).toEqual([
      "quote_transfer",
      "prepare_transfer",
    ]);
    const prepared = r.tool_calls.find((t) => t.name === "prepare_transfer")?.app;
    expect(prepared?.resource_uri).toBe(TRANSFER_VIEW_URI);
    const token = String(prepared?.result.structuredContent?.confirmation_token);
    expect(token).toMatch(/^ct_[\w-]{43}$/);
    // The protocol panel still shows only its prefix.
    expect(JSON.stringify(r.exchanges)).not.toContain(token);
    expect(r.tool_calls.find((t) => t.name === "resolve_beneficiary")?.app).toBeUndefined();

    r = await say(app, "Yes.", c);
    expect(r.tool_calls[0]).toMatchObject({
      name: "confirm_transfer",
      refused: "STEP_UP_REQUIRED",
    });
    expect(r.tool_calls[0]?.app?.input).toEqual({ confirmation_token: token });

    const code = latestCode(core);
    const res = await post(app, "/sim/app-tool", {
      resource_uri: TRANSFER_VIEW_URI,
      name: "confirm_transfer",
      arguments: { confirmation_token: token, otp: code },
    });
    expect(res.status).toBe(200);
    expect(res.body.result.structuredContent).toMatchObject({
      transfer_ref: "NUV-240121",
      status: "SCREENING",
    });
    expect(card.charges).toHaveLength(1);
    const panel = JSON.stringify(res.body.exchanges);
    expect(panel).not.toContain(code);
    expect(panel).toContain(`"otp":"${code.slice(0, 2)}••••"`);

    // The view tells the assistant; the scripted engine stops waiting for a code.
    const note = await post(app, "/sim/app-context", {
      conversation_id: c,
      text: "The user entered the code in the transfer view: NUV-240121, Checking details.",
      structured: { event: "transfer_confirmed", transfer_ref: "NUV-240121" },
    });
    expect(note.status).toBe(200);
    r = await say(app, "Yes.", c);
    expect(r.reply).toBe("There's nothing waiting for a yes right now.");
    expect(card.charges).toHaveLength(1);
  });

  it("the live model gets the view's report with the next turn, marked as not the user's words", async () => {
    const seen: ConverseCommandInput[] = [];
    const reply = (text: string) =>
      ({
        output: { message: { role: "assistant", content: [{ text }] } },
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }) as unknown as ConverseCommandOutput;
    const { app } = await start(
      (relay) =>
        new ChatService({
          relay,
          converse: async (input) => {
            seen.push(structuredClone(input));
            return reply("Okay.");
          },
          modelId: "test-model",
          systemPrompt: "test",
          budget: new DailyBudget(100),
        }),
    );
    const first = await say(app, "Hello.");
    await post(app, "/sim/app-context", {
      conversation_id: first.conversation_id,
      text: "Transfer NUV-240121 confirmed in the view.",
    });
    await say(app, "Is it done?", first.conversation_id);
    const user = seen.at(-1)?.messages?.at(-1);
    expect(user?.role).toBe("user");
    expect(user?.content?.map((b) => b.text)).toEqual([
      "[From the transfer view on screen, not the user's words] Transfer NUV-240121 confirmed in the view.",
      "Is it done?",
    ]);
    // Used once.
    await say(app, "Thanks.", first.conversation_id);
    expect(seen.at(-1)?.messages?.at(-1)?.content).toHaveLength(1);
  });
});

describe("host pieces", () => {
  it("frames expire after a minute", () => {
    let now = 0;
    const store = new FrameStore(60_000, () => now);
    const id = store.put("<!doctype html>", "default-src 'none'");
    now = 60_000;
    expect(store.take(id)).toBeUndefined();
    const fresh = store.put("<!doctype html>", "default-src 'none'");
    now += 59_000;
    expect(store.take(fresh)).toEqual({ html: "<!doctype html>", csp: "default-src 'none'" });
  });

  it("builds the view CSP from declared domains, dropping anything that isn't an origin", () => {
    const csp = viewCsp({
      connectDomains: [
        "https://api.example.com",
        "javascript:alert(1)",
        "https://x.test; script-src *",
      ],
      resourceDomains: ["https://cdn.example.com"],
    });
    expect(csp).toContain("connect-src https://api.example.com;");
    expect(csp).toContain("script-src 'unsafe-inline' https://cdn.example.com;");
    expect(csp).not.toContain("javascript:");
    expect(csp).not.toContain("script-src *");
    expect(viewCsp({})).toContain("connect-src 'none'");
  });

  it("the model never sees tools only a view may call", () => {
    const tools = toBedrockTools([
      { name: "a", inputSchema: { type: "object" } },
      { name: "b", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["app"] } } },
      {
        name: "c",
        inputSchema: { type: "object" },
        _meta: { ui: { visibility: ["model", "app"] } },
      },
    ]);
    expect(tools.map((t) => t.toolSpec?.name)).toEqual(["a", "c"]);
  });
});
