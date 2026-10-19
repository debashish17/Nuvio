import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createCore, type Core } from "../src/core/index.js";
import { createApp } from "../src/server/app.js";
import { ChatService } from "../src/server/sim/chat.js";
import { DailyBudget } from "../src/server/sim/guards.js";
import { McpRelay } from "../src/server/sim/relay.js";
import { CSP, simulatorDir } from "../src/server/web.js";
import { liveFetch, seededDb, silentLogger, TEST_BEARER, testClock } from "./helpers.js";

let core: Core | undefined;
afterEach(() => {
  core?.db.close();
  core = undefined;
});

function app(withSim = true) {
  core = createCore({
    db: seededDb(),
    ratesUrl: "https://rates.test/v1",
    fetch: liveFetch(),
    now: testClock(),
    logger: silentLogger,
  });
  const relay = new McpRelay({ url: "http://127.0.0.1:1/mcp", bearer: TEST_BEARER });
  const budget = new DailyBudget(10);
  const chat = new ChatService({
    relay,
    converse: async () => {
      throw new Error("not used");
    },
    modelId: "test-model",
    systemPrompt: "",
    budget,
  });
  return createApp({
    bearerToken: TEST_BEARER,
    core,
    ...(withSim
      ? { sim: { chat, relay, budget, accessCode: "code-123", reseed: () => undefined } }
      : {}),
  });
}

describe("simulator page", () => {
  it("is served at / with the disclaimer banner and a strict CSP", async () => {
    const res = await request(app()).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain(
      "Simulated ledger: no real funds move. Mid-market rates are live; Nuvio pricing is simulated.",
    );
    expect(res.headers["content-security-policy"]).toBe(CSP);
    expect(CSP).not.toContain("unsafe-inline");
    expect(CSP).toContain("frame-ancestors 'none'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["permissions-policy"]).toContain("microphone=(self)");
  });

  it("sends HSTS only on HTTPS (behind App Runner's TLS), never on plain local HTTP", async () => {
    const a = app();
    const local = await request(a).get("/health");
    expect(local.headers["strict-transport-security"]).toBeUndefined();
    const hosted = await request(a).get("/health").set("X-Forwarded-Proto", "https");
    expect(hosted.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  });

  it("serves its modules, stylesheet and fonts with the right types", async () => {
    const a = app();
    const js = await request(a).get("/js/app.js");
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toMatch(/javascript/);
    expect((await request(a).get("/styles.css")).headers["content-type"]).toMatch(/text\/css/);
    const font = await request(a).get("/fonts/Geist-Variable.woff2");
    expect(font.status).toBe(200);
    expect(font.headers["content-type"]).toBe("font/woff2");
    expect(font.headers["cache-control"]).toContain("max-age");
  });

  it("does not shadow the API, and unknown paths stay JSON 404s", async () => {
    const a = app();
    expect((await request(a).get("/health")).body).toEqual({ status: "ok" });
    expect((await request(a).get("/sim/tools")).status).toBe(401); // no access code sent
    const missing = await request(a).get("/nope.html");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "not_found" });
  });

  it("is not served by a pure MCP app, which still sends the security headers", async () => {
    const res = await request(app(false)).get("/");
    expect(res.status).toBe(404);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("simulator source stays CSP-clean", () => {
  const dir = simulatorDir();
  const files = (sub: string) =>
    readdirSync(join(dir ?? "", sub)).map((f) => readFileSync(join(dir ?? "", sub, f), "utf8"));

  it("has no inline script, style element or style attribute in the page", () => {
    expect(dir).toBeDefined();
    const html = readFileSync(join(dir ?? "", "index.html"), "utf8");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i); // inline event handlers
  });

  it("builds no markup with style attributes or inline handlers in its scripts", () => {
    for (const src of files("js")) {
      expect(src).not.toMatch(/style\s*=\s*\\?["'`]/);
      expect(src).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
      expect(src).not.toMatch(/\beval\(|new Function\(/);
    }
  });

  it("loads nothing from another origin", () => {
    const html = readFileSync(join(dir ?? "", "index.html"), "utf8");
    const css = readFileSync(join(dir ?? "", "styles.css"), "utf8");
    for (const src of [html, css, ...files("js")]) {
      expect(src).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
      expect(src).not.toMatch(/url\(\s*["']?https?:/i);
      expect(src).not.toMatch(/fetch\(\s*["'`]https?:/i);
    }
  });
});
