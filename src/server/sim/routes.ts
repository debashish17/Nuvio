import express, { type Router } from "express";
import { z } from "zod";
import type { Core } from "../../core/index.js";
import { DEMO_USER_ID } from "../../core/policy.js";
import { isRefusal } from "../../core/refusal.js";
import { toWire } from "../wire.js";
import type { ChatEngine } from "./scripted.js";
import { DEMO_BEATS } from "./scripted.js";
import {
  hasCode,
  RateLimiter,
  requireCode,
  type DailyBudget,
  type DemoFreshness,
} from "./guards.js";
import { FrameStore, viewCsp } from "./frames.js";
import { UI_MIME, viewOf, visibleTo, type Exchange, type McpRelay } from "./relay.js";
import type { TtsService } from "./tts.js";

/**
 * /sim/* serves the simulator page (behind SIM_ACCESS_CODE); /dev/* holds the recording controls
 * (behind DEV_CONTROLS_CODE, and 404 when that is unset). The page never sees the Bearer secret:
 * every tool call goes through the relay to POST /mcp.
 */

export interface SimDeps {
  core: Core;
  chat: ChatEngine;
  /** scripted: no language model; bedrock: the live model through LLM_PROVIDER. */
  mode?: "scripted" | "bedrock";
  llm?: { provider: string; model: string } | null;
  relay: McpRelay;
  budget: DailyBudget;
  accessCode?: string | undefined;
  devCode?: string | undefined;
  /** Wipes and reloads the demo seed. */
  reseed: () => void;
  /** Hosted demos: a page load after a quiet spell reloads the seed (SIM_AUTO_RESET_MINUTES). */
  freshness?: DemoFreshness | undefined;
  /** The assistant's Polly voice; omitted when POLLY_VOICE is "none" (the page uses the browser's). */
  tts?: TtsService | undefined;
  /** Single-use frames for MCP Apps views (SPEC "MCP Apps view"). */
  frames?: FrameStore;
}

const SpeakBody = z.object({ text: z.string().trim().min(1).max(1500) });

const AppViewBody = z.object({ uri: z.string().startsWith("ui://").max(200) });

const AppToolBody = z.object({
  resource_uri: z.string().startsWith("ui://").max(200),
  name: z.string().min(1).max(64),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

const AppContextBody = z.object({
  conversation_id: z.string().min(1).max(64),
  text: z.string().trim().max(1000).default(""),
  structured: z.record(z.string(), z.unknown()).optional(),
});

const ChatBody = z.object({
  conversation_id: z.string().max(64).optional(),
  text: z.string().trim().min(1).max(500),
});

export function simRouter(deps: SimDeps): Router {
  const { core, chat, relay, budget } = deps;
  const frames = deps.frames ?? new FrameStore();
  const router = express.Router();

  // An MCP Apps view's document, served once under the CSP its resource declared. This sits before
  // the access-code check: an iframe's navigation can't send the header, so the single-use,
  // one-minute id from POST /sim/app-view is the credential.
  router.get("/app-frame/:id", new RateLimiter(120, 10 * 60_000).middleware(), (req, res) => {
    const frame = frames.take(String(req.params.id));
    if (!frame) {
      res.status(404).type("text/plain").send("This view has expired. Ask again to see it.");
      return;
    }
    res.setHeader("Content-Security-Policy", frame.csp);
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(frame.html);
  });

  router.use(
    requireCode(deps.accessCode, "x-sim-code", {
      status: 503,
      message: "The simulator is disabled on this server (SIM_ACCESS_CODE is not set).",
    }),
  );
  router.use(express.json({ limit: "16kb" }));
  // Every POST is a visitor acting; the state poll of an idle tab is not.
  router.use((req, _res, next) => {
    if (req.method === "POST") deps.freshness?.touch();
    next();
  });

  // Page load: a fresh initialize + tools/list so the protocol panel shows the real handshake.
  router.get("/tools", new RateLimiter(60, 10 * 60_000).middleware(), async (_req, res) => {
    const exchanges: Exchange[] = [];
    try {
      const freshDemo = deps.freshness?.refresh() ?? false;
      relay.reset();
      const tools = await relay.listTools(exchanges);
      res.json({
        protocol_version: relay.protocolVersion,
        tools,
        exchanges,
        tts: deps.tts ? deps.tts.voice : null,
        mode: deps.mode ?? "bedrock",
        llm: deps.llm ?? null,
        demo_beats: DEMO_BEATS,
        fresh_demo: freshDemo,
      });
    } catch (err) {
      res.status(502).json({ error: "mcp_unavailable", message: String(err), exchanges });
    }
  });

  // Holders of the dev-controls code (recording, evals) skip the per-IP limit; the daily Bedrock
  // cap still applies to them.
  const devCaller = hasCode(deps.devCode, "x-dev-code");
  router.post("/chat", new RateLimiter(30, 10 * 60_000).middleware(devCaller), async (req, res) => {
    const body = ChatBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Send { text } of 1-500 characters." });
      return;
    }
    res.json(await chat.send(body.data.conversation_id, body.data.text));
  });

  // The assistant's voice: Polly audio plus word timings. 503 means "use the browser's voice".
  router.post(
    "/speak",
    new RateLimiter(120, 10 * 60_000).middleware(devCaller),
    async (req, res) => {
      if (!deps.tts) {
        res.status(503).json({ error: "tts_disabled", message: "Polly is off on this server." });
        return;
      }
      const body = SpeakBody.safeParse(req.body);
      if (!body.success) {
        res
          .status(400)
          .json({ error: "bad_request", message: "Send { text } of 1-1500 characters." });
        return;
      }
      try {
        const speech = await deps.tts.speak(body.data.text);
        if (!speech) {
          res
            .status(429)
            .json({ error: "tts_budget", message: "Today's voice allowance is used." });
          return;
        }
        res.json(speech);
      } catch (err) {
        console.error(`sim: Polly failed: ${err instanceof Error ? err.message : String(err)}`);
        res.status(502).json({ error: "tts_failed", message: "The voice service is unavailable." });
      }
    },
  );

  // MCP Apps host, step 1: read a linked view with resources/read and park it for its iframe.
  router.post("/app-view", new RateLimiter(60, 10 * 60_000).middleware(), async (req, res) => {
    const body = AppViewBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Send { uri } of a ui:// resource." });
      return;
    }
    const exchanges: Exchange[] = [];
    try {
      const tools = await relay.listTools(exchanges);
      if (!tools.some((t) => viewOf(t) === body.data.uri)) {
        res.status(404).json({ error: "unknown_view", message: "No tool links that view." });
        return;
      }
      const content = await relay.readResource(body.data.uri, exchanges);
      if (!content?.text || content.mimeType !== UI_MIME) {
        res.status(502).json({ error: "bad_view", message: "Not an MCP Apps view.", exchanges });
        return;
      }
      const ui = (content._meta?.ui ?? {}) as { csp?: unknown; prefersBorder?: unknown };
      const id = frames.put(content.text, viewCsp(ui.csp));
      res.json({
        frame_url: `/sim/app-frame/${id}`,
        prefers_border: ui.prefersBorder !== false,
        exchanges,
      });
    } catch (err) {
      res.status(502).json({ error: "mcp_unavailable", message: String(err), exchanges });
    }
  });

  // MCP Apps host, step 2: a view's tools/call, through the relay so the page never holds the
  // Bearer secret. Only tools visible to apps, and (stricter than the spec) linked to that view.
  router.post("/app-tool", new RateLimiter(300, 10 * 60_000).middleware(), async (req, res) => {
    const body = AppToolBody.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json({ error: "bad_request", message: "Send { resource_uri, name, arguments }." });
      return;
    }
    const { resource_uri, name } = body.data;
    const exchanges: Exchange[] = [];
    try {
      await relay.listTools(exchanges);
      const tool = relay.tool(name);
      if (!tool || !visibleTo(tool, "app") || viewOf(tool) !== resource_uri) {
        res.status(403).json({
          error: "tool_not_allowed",
          message: `The view ${resource_uri} may not call ${name}.`,
        });
        return;
      }
      const out = await relay.callTool(name, body.data.arguments, exchanges);
      res.json({
        result: out.view?.result ?? { structuredContent: out.structured, isError: out.isError },
        exchanges,
      });
    } catch (err) {
      res.status(502).json({ error: "mcp_unavailable", message: String(err), exchanges });
    }
  });

  // MCP Apps host, step 3: ui/update-model-context, for the assistant's next turn.
  router.post("/app-context", new RateLimiter(60, 10 * 60_000).middleware(), (req, res) => {
    const body = AppContextBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request", message: "Send { conversation_id, text }." });
      return;
    }
    chat.noteFromApp(body.data.conversation_id, {
      text: body.data.text,
      structured: body.data.structured,
    });
    res.json({ ok: true });
  });

  // The ledger strip polls this; `since` returns alerts fired after that time, for toasts.
  router.get("/state", new RateLimiter(600, 10 * 60_000).middleware(), async (req, res) => {
    const since = typeof req.query.since === "string" ? req.query.since : new Date().toISOString();
    // On failure the strip shows a dash; get_rate reports the problem when asked.
    const rate = await todaysRate(core).catch(() => null);
    const latest = core.ledger.track(DEMO_USER_ID);
    const quote = core.quotes.latestOpen(DEMO_USER_ID);
    res.json(
      toWire({
        server_time: new Date().toISOString(),
        latest_transfer: isRefusal(latest) ? null : latest,
        open_quote: quote
          ? {
              quote_id: quote.id,
              beneficiary_id: quote.beneficiaryId,
              send_amount_minor: quote.sendMinor,
              receive_amount_minor: quote.receiveMinor,
              status: quote.status,
              rate_locked_until: quote.rateLockedUntil,
            }
          : null,
        limits: core.limits.remaining(DEMO_USER_ID),
        rate,
        alerts: core.alerts.firedSince(DEMO_USER_ID, since),
        // The demo customer's phone: step-up codes arrive here, as an SMS would.
        sms: core.outbox.since(DEMO_USER_ID, since),
        assistant_calls_left_today: budget.remaining,
      }),
    );
  });

  return router;
}

export function devRouter(deps: SimDeps): Router {
  const { core } = deps;
  const router = express.Router();
  router.use(requireCode(deps.devCode, "x-dev-code", { status: 404, message: "Not found." }));
  router.use(express.json({ limit: "4kb" }));
  router.use(new RateLimiter(120, 10 * 60_000).middleware());
  router.use((_req, _res, next) => {
    deps.freshness?.touch();
    next();
  });

  router.post("/tick", (_req, res) => {
    res.json({ advanced: core.ledger.tick({ force: true }) });
  });

  router.post("/release", (req, res) => {
    const ref = typeof req.body?.ref === "string" ? req.body.ref : undefined;
    const released = core.ledger.releaseHold(DEMO_USER_ID, ref);
    res.status(released ? 200 : 404).json(released ?? { error: "no transfer under review" });
  });

  router.post("/alert", (_req, res) => {
    const fired = core.alerts.fireNext(DEMO_USER_ID);
    res.status(fired ? 200 : 404).json(fired ?? { error: "no pending alert" });
  });

  router.post("/reset", (_req, res) => {
    deps.reseed();
    res.json({ reset: true });
  });

  return router;
}

async function todaysRate(core: Core) {
  const mid = await core.rates.getMid("AED", "INR");
  const customer = await core.rates.getCustomerRate("AED", "INR");
  return { customer_rate: customer.rate, mid_rate: mid.rate, as_of: mid.asOf };
}
