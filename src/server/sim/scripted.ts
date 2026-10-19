import { randomUUID } from "node:crypto";
import type { ChatReply, ToolCallSummary } from "./chat.js";
import type { Exchange, McpRelay } from "./relay.js";
import { spokenDigits } from "../../core/spoken.js";

/**
 * Scripted mode: the simulator with no language model, for a clean clone with no AWS account or
 * API key. It recognises the demo lines (and the suggestion chips, the receipt's Cancel button,
 * a code read out as digits or words) and drives the real tools through the same relay, so every
 * step is a genuine POST /mcp JSON-RPC round trip. Replies are built from the tool results.
 * Anything else gets a clear notice that no model is configured.
 */

/** The demo, in order. "{code}" stands for "read out the code from the latest text". */
export const DEMO_BEATS = [
  "Hi, anything I should know?",
  "What's the rupee at today?",
  "How much would Mum get for 2,000 dirhams?",
  "Send 2,000 dirhams to Mum.",
  "Yes.",
  "{code}",
  "Send her another three thousand.",
  "Send 500 to Rahul.",
  "Where's Mum's money?",
  "And the one to my NRE account?",
  "Cancel the one to my NRE account.",
  "Yes.",
  "Tell me when the dirham hits 26.5.",
] as const;

export const SCRIPTED_NOTICE =
  'This demo is running without a language model (no AWS credentials or LLM key configured), so it can only follow the demo script. Use Play demo or the suggestions, or see README "Run it locally" to connect Bedrock or an OpenAI-compatible model.';

/** What an MCP Apps view reported with ui/update-model-context. */
export interface AppNote {
  text: string;
  structured?: Record<string, unknown> | undefined;
}

/** The interface ChatService and ScriptedChat share. */
export interface ChatEngine {
  send(conversationId: string | undefined, text: string): Promise<ChatReply>;
  clear(): void;
  /** Context from an MCP Apps view, for the next turn (SPEC "MCP Apps view"). */
  noteFromApp(conversationId: string, note: AppNote): void;
}

type Json = Record<string, unknown>;

interface Convo {
  updatedAt: number;
  /** A prepared transfer waiting for a yes, then for its code. */
  confirm?: { token: string; stepUp: boolean };
  /** A cancel preview waiting for a yes. */
  cancel?: { ref: string; token: string };
  /** Who "her" / "him" refers to. */
  recipient?: { id: string; nickname: string };
}

const SMALL: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9.,\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,!?]+$/, "");

/** A 6-digit code in the text, said as digits or words ("four eight two nine one three"). */
export function findCode(text: string): string | undefined {
  // The same reader as the server's step-up check; a longer run of digits gives its first six.
  const digits = spokenDigits(text);
  return digits.length === 6 ? digits : (/(\d{6})/.exec(digits)?.[1] ?? undefined);
}

/** "2,000", "500", "three thousand", "one thousand five hundred" -> a number. */
export function parseAmount(phrase: string): number | undefined {
  const p = phrase.replace(/,/g, "").trim();
  if (/^\d+(\.\d+)?$/.test(p)) return Number(p);
  let total = 0;
  let current = 0;
  let seen = false;
  for (const w of p.split(/\s+/)) {
    if (w === "and" || w === "a") continue;
    if (SMALL[w] !== undefined) {
      current += SMALL[w];
      seen = true;
    } else if (w === "hundred") current = (current || 1) * 100;
    else if (w === "thousand") {
      total += (current || 1) * 1000;
      current = 0;
    } else break;
  }
  return seen ? total + current : undefined;
}

const AMOUNT = String.raw`([\d,]+(?:\.\d+)?|(?:(?:one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|a|and|hundred|thousand)\s?)+)`;

const aed = (n: unknown) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
const inr = (n: unknown) => Math.floor(Number(n)).toLocaleString("en-US");
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const sayDate = (iso: unknown) => {
  const [, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
};

/** A few words saying why, before a refusal's resolution text. */
const REFUSAL_LEAD: Record<string, string> = {
  MONTHLY_LIMIT: "That would go over your monthly limit. ",
  DAILY_LIMIT: "That would go over today's limit. ",
  PER_TRANSACTION_LIMIT: "That's more than one transfer can carry. ",
  NEW_RECIPIENT_LIMIT: "This recipient is new, so the first transfer is capped. ",
  SOURCE_OF_FUNDS_REQUIRED: "A transfer that size needs proof of funds first. ",
};

export class ScriptedChat implements ChatEngine {
  private readonly convos = new Map<string, Convo>();

  constructor(
    private readonly relay: McpRelay,
    private readonly now: () => number = Date.now,
  ) {}

  clear(): void {
    this.convos.clear();
  }

  /** A transfer confirmed in the view: nothing is waiting for a yes or a code any more. */
  noteFromApp(conversationId: string, note: AppNote): void {
    const convo = this.convos.get(conversationId);
    if (convo && note.structured?.event === "transfer_confirmed") delete convo.confirm;
  }

  async send(conversationId: string | undefined, text: string): Promise<ChatReply> {
    for (const [k, c] of this.convos)
      if (this.now() - c.updatedAt > 30 * 60_000) this.convos.delete(k);
    const id = conversationId && this.convos.has(conversationId) ? conversationId : randomUUID();
    const convo: Convo = this.convos.get(id) ?? { updatedAt: this.now() };
    this.convos.set(id, convo);
    convo.updatedAt = this.now();

    const exchanges: Exchange[] = [];
    const calls: ToolCallSummary[] = [];
    const tool = async (name: string, args: Json = {}): Promise<Json> => {
      const before = exchanges.length;
      const out = await this.relay.callTool(name, args, exchanges);
      const refused = (out.structured.refused as { code?: string } | undefined)?.code;
      calls.push({
        name,
        ms: exchanges.slice(before).reduce((s, e) => s + e.ms, 0),
        ...(refused ? { refused } : {}),
        ...(out.isError && !refused ? { error: true } : {}),
        ...(out.view ? { app: out.view } : {}),
      });
      return out.structured;
    };
    const reply = (r: string, notice?: string): ChatReply => ({
      conversation_id: id,
      reply: r,
      tool_calls: calls,
      exchanges,
      model: "scripted",
      usage: { input_tokens: 0, output_tokens: 0 },
      mode: "scripted",
      ...(notice ? { notice } : {}),
    });

    try {
      await this.relay.listTools(exchanges); // the handshake, once per relay
      const r = await this.respond(norm(text), text, convo, tool);
      return r === null
        ? reply("Sorry, I can only follow the demo script here.", SCRIPTED_NOTICE)
        : reply(r);
    } catch (err) {
      console.error(
        `sim: scripted turn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        ...reply("Sorry, something went wrong reaching the tools. Please try again."),
        error: {
          code: "MCP_UNAVAILABLE",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  /** The reply for one line, or null when the line isn't part of the script. */
  private async respond(
    t: string,
    raw: string,
    convo: Convo,
    tool: (name: string, args?: Json) => Promise<Json>,
  ): Promise<string | null> {
    const refusal = (r: Json) => (r.refused as { resolution?: string } | undefined)?.resolution;

    // A code for the step-up.
    const code = convo.confirm?.stepUp ? findCode(raw) : undefined;
    if (code && convo.confirm) {
      const done = await tool("confirm_transfer", {
        confirmation_token: convo.confirm.token,
        otp: code,
      });
      const no = refusal(done);
      if (no) {
        if ((done.refused as Json).code !== "OTP_INVALID") delete convo.confirm;
        return no;
      }
      delete convo.confirm;
      return `Done. ${String(done.transfer_ref)} is on its way to ${String(done.recipient)}: ${String(done.customer_label).toLowerCase()}.`;
    }

    // Yes / no to whatever is waiting.
    if (/^(yes|yeah|yep|yup|sure|ok yes|okay yes|go ahead|confirm|do it)\b/.test(t)) {
      if (convo.cancel) {
        const c = convo.cancel;
        delete convo.cancel;
        const r = await tool("cancel_transfer", { transfer_ref: c.ref, cancel_token: c.token });
        const refund = r.refund as Json | undefined;
        return (
          refusal(r) ??
          `Cancelled. ${aed(refund?.amount)} dirhams go back to your ${String(refund?.to)} within ${String(refund?.eta)}.`
        );
      }
      if (convo.confirm?.stepUp) return "Please read me the 6-digit code from the text message.";
      if (convo.confirm && !convo.confirm.stepUp) {
        const r = await tool("confirm_transfer", { confirmation_token: convo.confirm.token });
        const refused = r.refused as Json | undefined;
        if (refused?.code === "STEP_UP_REQUIRED") {
          convo.confirm.stepUp = true;
          return `I've texted a code to your ${String(refused.sent_to)}. Please read it out.`;
        }
        delete convo.confirm;
        return refusal(r) ?? "Done.";
      }
      return "There's nothing waiting for a yes right now.";
    }
    if (/^(no|nope|dont|do not|keep it|stop)\b/.test(t) && (convo.cancel || convo.confirm)) {
      const wasCancel = Boolean(convo.cancel);
      delete convo.cancel;
      delete convo.confirm;
      return wasCancel ? "Okay, I'll leave that transfer as it is." : "Okay, nothing was sent.";
    }

    // What's pending since last time.
    if (
      /^(hi|hello|hey|good (morning|afternoon|evening))\b|anything i should know|whats (pending|new)/.test(
        t,
      )
    ) {
      const p = await tool("get_pending");
      return `Welcome back, Priya. ${String(p.summary)}`;
    }

    if (
      /\b(rupee|rate|exchange)\b/.test(t) &&
      !/\bsend\b/.test(t) &&
      !/tell me|alert|let me know/.test(t)
    ) {
      const r = await tool("get_rate");
      const trend = String(r.trend ?? "");
      return `One dirham buys ${Number(r.customer_rate).toFixed(2)} rupees today. The ${trend}.`;
    }

    let m = new RegExp(String.raw`how much (?:would|will) (.+?) get for ${AMOUNT}`).exec(t);
    if (m) {
      const who = await this.recipient(m[1] ?? "", convo, tool);
      if (typeof who === "string") return who;
      const q = await tool("quote_transfer", {
        beneficiary_id: who.id,
        send_amount: parseAmount(m[2] ?? ""),
      });
      return refusal(q) ?? quoteLine(who.nickname, q);
    }

    m = /send (?:her|him|them) another (.+)$/.exec(t);
    if (m && convo.recipient)
      return this.sendTo(
        convo.recipient,
        parseAmount((m[1] ?? "").replace(/dirhams?/, "")),
        convo,
        tool,
      );

    m = /send the usual to (.+)$/.exec(t);
    if (m) {
      const who = await this.recipient(m[1] ?? "", convo, tool);
      if (typeof who === "string") return who;
      const p = await tool("get_pending");
      const last = (p.last_by_recipient as Json[]).find((l) => l.beneficiary_id === who.id);
      if (!last)
        return `I don't have a previous transfer to ${who.nickname}. How much would you like to send?`;
      return this.sendTo(who, Number(last.send_amount), convo, tool);
    }

    m = new RegExp(String.raw`send ${AMOUNT}\s*(?:dirhams?|aed)?\s*to (.+)$`).exec(t);
    if (m) {
      const who = await this.recipient(m[2] ?? "", convo, tool);
      if (typeof who === "string") return who;
      return this.sendTo(who, parseAmount(m[1] ?? ""), convo, tool);
    }

    m = /cancel (?:transfer )?(nuv-\d+)/.exec(t);
    if (m) return this.preview((m[1] ?? "").toUpperCase(), convo, tool);
    m = /cancel (?:the one|the transfer|my transfer) to (.+)$/.exec(t);
    if (m) {
      const ref = await this.newestRef(m[1] ?? "", convo, tool);
      return ref.startsWith("NUV-") ? this.preview(ref, convo, tool) : ref;
    }

    m =
      /where(?:s| is) (.+?)s money/.exec(t) ?? /^(?:and )?(?:what about )?the one to (.+)$/.exec(t);
    if (m) {
      const ref = await this.newestRef(m[1] ?? "", convo, tool);
      return ref.startsWith("NUV-")
        ? statusLine(await tool("track_transfer", { transfer_ref: ref }))
        : ref;
    }
    if (/where(?:s| is) my (?:latest |last )?(?:transfer|money)/.test(t)) {
      return statusLine(await tool("track_transfer", { latest: true }));
    }

    m = /(?:tell me|alert me|let me know) (?:when|if) .*?(\d+(?:\.\d+)?)/.exec(t);
    if (m) {
      const direction = /drop|fall|below|under/.test(t) ? "below" : "above";
      const r = await tool("set_rate_alert", { target: Number(m[1]), direction });
      return refusal(r) ?? String(r.message);
    }

    const topic = /\blrs\b|liberali[sz]ed/.test(t)
      ? "lrs"
      : /\bnre\b|\bnro\b/.test(t)
        ? "nre_nro"
        : /\btax\b/.test(t)
          ? "tax"
          : /document/.test(t)
            ? "documents"
            : /steps|how do i send|how does (it|sending) work/.test(t)
              ? "how_to_send"
              : undefined;
    if (topic) return String((await tool("get_help", { topic })).answer);

    if (/\blimits?\b/.test(t)) {
      const l = await tool("check_limits");
      const mo = l.monthly as Json;
      const d = l.daily as Json;
      return `You have ${aed(mo.remaining)} dirhams left this month and ${aed(d.remaining)} today.`;
    }

    return null;
  }

  /** Resolve a name; a string is the reply to give instead (ambiguous or not saved). */
  private async recipient(
    who: string,
    convo: Convo,
    tool: (name: string, args?: Json) => Promise<Json>,
  ): Promise<{ id: string; nickname: string } | string> {
    const query = who
      .replace(/^(my|to)\s+/, "")
      .replace(/[.?!]$/, "")
      .trim();
    const r = await tool("resolve_beneficiary", { query });
    if (r.match) {
      const match = r.match as Json;
      convo.recipient = { id: String(match.id), nickname: String(match.nickname) };
      return convo.recipient;
    }
    if (r.candidates) {
      const names = (r.candidates as Json[]).map(
        (c) => `your ${String(c.relationship)} ${String(c.full_name)}`,
      );
      return `Do you mean ${names.slice(0, -1).join(", ")}, or ${names.at(-1)}?`;
    }
    return `${query[0]?.toUpperCase() ?? ""}${query.slice(1)} isn't a saved recipient. ${String(r.hint ?? "")}`.trim();
  }

  /** Quote, then prepare and read back. */
  private async sendTo(
    who: { id: string; nickname: string },
    amount: number | undefined,
    convo: Convo,
    tool: (name: string, args?: Json) => Promise<Json>,
  ): Promise<string> {
    if (!amount) return "How much would you like to send?";
    convo.recipient = who;
    const q = await tool("quote_transfer", { beneficiary_id: who.id, send_amount: amount });
    const refused = q.refused as { code?: string; resolution?: string } | undefined;
    if (refused) return `${REFUSAL_LEAD[refused.code ?? ""] ?? ""}${refused.resolution ?? ""}`;
    const p = await tool("prepare_transfer", { quote_id: q.quote_id });
    const pno = (p.refused as { resolution?: string } | undefined)?.resolution;
    if (pno) return pno;
    convo.confirm = { token: String(p.confirmation_token), stepUp: false };
    delete convo.cancel;
    return String(p.read_back);
  }

  private async preview(
    ref: string,
    convo: Convo,
    tool: (name: string, args?: Json) => Promise<Json>,
  ) {
    const r = await tool("cancel_transfer", { transfer_ref: ref });
    const no = (r.refused as { resolution?: string } | undefined)?.resolution;
    if (no) return no;
    convo.cancel = { ref, token: String(r.cancel_token) };
    delete convo.confirm;
    return String(r.preview);
  }

  /** The newest transfer to a recipient, or a reply to give instead. */
  private async newestRef(
    who: string,
    convo: Convo,
    tool: (name: string, args?: Json) => Promise<Json>,
  ) {
    const r = await this.recipient(who, convo, tool);
    if (typeof r === "string") return r;
    const h = await tool("get_transfer_history", { beneficiary_id: r.id });
    const ref = (h.transfers as Json[] | undefined)?.[0]?.transfer_ref;
    return ref ? String(ref) : `There are no transfers to ${r.nickname} yet.`;
  }
}

function quoteLine(nickname: string, q: Json): string {
  const warn = (q.warnings as Json[] | undefined)?.find((w) => w.code === "NEAR_MONTHLY_LIMIT");
  return (
    `${nickname} would receive ${inr(q.receive_amount)} rupees for ${aed(q.send_amount)} dirhams, after the ${aed(q.fee)} dirham fee, ${String(q.eta).split(",")[0]}.` +
    (warn ? ` That would leave ${aed(warn.remaining_after)} dirhams of this month's limit.` : "") +
    " Shall I send it?"
  );
}

function statusLine(t: Json): string {
  if (t.refused) return String((t.refused as Json).resolution);
  if (t.status === "PAID_OUT")
    return `It has been paid out. The bank reference is ${String(t.utr)}.`;
  if (t.status === "ON_HOLD") {
    const a = t.action_required as Json | undefined;
    return a
      ? `It's under review. Please upload ${String(a.document)} in the Nuvio app by ${sayDate(a.deadline)}.`
      : "It's under review. Nothing is needed from you right now.";
  }
  if (t.status === "CANCELLED") return "That transfer was cancelled and refunded.";
  if (t.status === "RETURNED") return `It was returned: ${String(t.reason)}.`;
  return `It's ${String(t.customer_label).toLowerCase()} and should arrive ${String(t.eta)}.`;
}
