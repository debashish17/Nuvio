import { randomUUID } from "node:crypto";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type Message,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import type { DailyBudget } from "./guards.js";
import { visibleTo, type Exchange, type McpRelay, type McpTool, type ViewCall } from "./relay.js";
import type { AppNote } from "./scripted.js";

/**
 * POST /sim/chat: the Bedrock Converse tool-use loop. Conversations live here, server-side and in
 * memory (tool calls included), so the page sends only the new turn. Each tool call is a real
 * round trip through McpRelay.
 */

export type ConverseFn = (input: ConverseCommandInput) => Promise<ConverseCommandOutput>;

export function bedrockConverse(region: string): ConverseFn {
  const client = new BedrockRuntimeClient({ region, maxAttempts: 2 });
  return (input) => client.send(new ConverseCommand(input));
}

export interface ChatOptions {
  relay: McpRelay;
  converse: ConverseFn;
  modelId: string;
  systemPrompt: string;
  budget: DailyBudget;
  maxToolRounds?: number;
  maxTokens?: number;
  ttlMs?: number;
  maxConversations?: number;
  maxMessages?: number;
  now?: () => number;
}

export interface ToolCallSummary {
  name: string;
  ms: number;
  refused?: string;
  error?: boolean;
  /** Stopped by the consent guard before reaching /mcp. */
  blocked?: boolean;
  /** For a tool that links an MCP Apps view: what the page's view needs (SPEC "MCP Apps view"). */
  app?: ViewCall;
}

export interface ChatReply {
  conversation_id: string;
  reply: string;
  tool_calls: ToolCallSummary[];
  exchanges: Exchange[];
  model: string;
  /** Tokens across the turn's model calls; cache fields appear when prompt caching applied. */
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
  error?: { code: string; message: string };
  /** "scripted" when no language model is configured (see scripted.ts). */
  mode?: "scripted" | "live";
  /** Shown to the user as a banner, e.g. that free text needs a language model. */
  notice?: string;
}

interface Conversation {
  messages: Message[];
  updatedAt: number;
  /** Counts user turns; a token may only be spent in a later turn than the one that issued it. */
  turn: number;
  /** Confirmation and cancel tokens issued in this conversation, by the turn that issued them. */
  issuedIn: Map<string, number>;
  /** What an MCP Apps view reported since the last turn (ui/update-model-context). */
  appNotes?: string[];
}

/**
 * Consent guard. The money-moving tools hand the model a token together with the sentence to read
 * back, so nothing on the server stops it from confirming in the same breath. In the simulator, a
 * token issued in this user turn cannot be spent until the user has replied: the call is answered
 * here, never reaches /mcp, and the model is told to read back and wait.
 */
const SPENDS_TOKEN: Record<string, string> = {
  confirm_transfer: "confirmation_token",
  cancel_transfer: "cancel_token",
};
const ISSUES_TOKEN: Record<string, string> = {
  prepare_transfer: "confirmation_token",
  cancel_transfer: "cancel_token",
};
const AWAITING_USER = {
  refused: {
    code: "AWAITING_USER_CONFIRMATION",
    resolution:
      "Nothing was done. Read the confirmation back to the user word for word, then wait for their reply. Use the token only after they clearly agree.",
  },
};

/**
 * Prompt caching. Every call resends the system prompt and the 14 tool specs (about 9k of the 13k
 * input tokens) plus the conversation so far. Cache points after the system prompt, after the tool
 * list and at the end of the conversation let Bedrock bill what it has seen in the last few minutes
 * at the cache-read price (Nova 2 Lite: a quarter of the input price; writes cost nothing). The
 * stored history never holds a cache point; they are added to each request.
 */
const CACHE_POINT = { cachePoint: { type: "default" as const } };

/** A Bedrock refusal of the cache points themselves (a model or field that doesn't support them). */
function isCacheRejection(err: unknown): boolean {
  return err instanceof Error && err.name === "ValidationException" && /cache/i.test(err.message);
}

/**
 * The messages to send, with a cache point after the user's newest words: the newest user message
 * that has text. Never inside a tool result, which Nova rejects ("extraneous key [cachePoint]",
 * live 2026-10-19); later rounds of the same turn still reuse everything up to that point.
 */
function withCachePoint(messages: Message[]): Message[] {
  let i = messages.length - 1;
  while (i >= 0) {
    const m = messages[i];
    if (m?.role === "user" && m.content?.some((b) => b.text !== undefined)) break;
    i--;
  }
  const target = messages[i];
  if (!target) return messages;
  const marked = { ...target, content: [...(target.content ?? []), CACHE_POINT] };
  return [...messages.slice(0, i), marked, ...messages.slice(i + 1)];
}

const MSG = {
  budget: "The demo has used today's assistant allowance. Please try again tomorrow.",
  unavailable: "Sorry, the assistant is unavailable right now. Please try again in a moment.",
  rounds: "Sorry, I couldn't finish that. Could you say it again, a bit more simply?",
};

/**
 * Every Converse call resends the whole conversation, so tool results from older turns are cut
 * down before sending: long strings (read-backs, explanations), deep nesting and long lists go;
 * ids, tokens, refs, statuses and amounts stay, so the model can still refer back to them. The
 * last two user turns go in full: a "yes" needs the read-back turn before it intact. The stored
 * history is not changed.
 */
export function compactHistory(messages: Message[], fullTurns = 2): Message[] {
  const turnStarts = messages.flatMap((m, i) =>
    m.role === "user" && m.content?.some((b) => b.text !== undefined) ? [i] : [],
  );
  const keepFrom = turnStarts.at(-fullTurns) ?? 0;
  return messages.map((m, i) =>
    i >= keepFrom || m.role !== "user"
      ? m
      : {
          ...m,
          content: (m.content ?? []).map((b) =>
            b.toolResult
              ? {
                  toolResult: {
                    ...b.toolResult,
                    content: (b.toolResult.content ?? []).map((c) =>
                      c.json === undefined
                        ? c
                        : { json: compactResult(c.json) as Record<string, never> },
                    ),
                  },
                }
              : b,
          ),
        },
  );
}

/** Primitive fields, strings up to 120 characters, two levels deep, lists of at most 5. */
export function compactResult(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.slice(0, 5).map((v) => compactResult(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string" && v.length > 120) continue;
      if (v && typeof v === "object" && depth >= 2) continue;
      out[k] = compactResult(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Bedrock tool specs from the MCP tools/list result; tools only views may call are left out. */
export function toBedrockTools(tools: McpTool[]): Tool[] {
  return tools
    .filter((t) => visibleTo(t, "model"))
    .map((t) => {
      // Bedrock wants the bare JSON Schema object, without the draft marker.
      const schema: Record<string, unknown> = { ...t.inputSchema };
      delete schema.$schema;
      return {
        toolSpec: {
          name: t.name,
          description: t.description ?? t.name,
          inputSchema: { json: schema as Record<string, never> },
        },
      };
    });
}

export class ChatService {
  private readonly conversations = new Map<string, Conversation>();
  private readonly maxToolRounds: number;
  private readonly maxTokens: number;
  private readonly ttlMs: number;
  private readonly maxConversations: number;
  private readonly maxMessages: number;
  private readonly now: () => number;
  /** Off for good once Bedrock rejects cache points, so a turn never fails because of caching. */
  private promptCache = true;
  /**
   * A cache point after the tool list. Nova rejects it ("extraneous key [cachePoint]", live
   * 2026-10-19; AWS documents Nova caching for system and messages only), so it starts off there.
   */
  private cacheTools: boolean;
  /** A cache point in the conversation; dropped alone if Bedrock rejects it. */
  private cacheMessages = true;

  constructor(private readonly opts: ChatOptions) {
    this.cacheTools = !/nova/i.test(opts.modelId);
    this.maxToolRounds = opts.maxToolRounds ?? 6;
    this.maxTokens = opts.maxTokens ?? 600;
    this.ttlMs = opts.ttlMs ?? 30 * 60_000;
    this.maxConversations = opts.maxConversations ?? 200;
    this.maxMessages = opts.maxMessages ?? 40;
    this.now = opts.now ?? Date.now;
  }

  clear(): void {
    this.conversations.clear();
  }

  /**
   * Context from an MCP Apps view (e.g. a transfer confirmed with a code typed in it), given to
   * the model with the user's next turn. It is data the view reported, so it is labelled as such.
   */
  noteFromApp(conversationId: string, note: AppNote): void {
    const convo = this.conversations.get(conversationId);
    if (!convo || !note.text) return;
    convo.appNotes = [...(convo.appNotes ?? []), note.text.slice(0, 600)].slice(-3);
  }

  async send(conversationId: string | undefined, text: string): Promise<ChatReply> {
    this.expire();
    const id =
      conversationId && this.conversations.has(conversationId) ? conversationId : randomUUID();
    const convo: Conversation = this.conversations.get(id) ?? {
      messages: [],
      updatedAt: this.now(),
      turn: 0,
      issuedIn: new Map(),
    };
    this.conversations.set(id, convo);
    const turn = ++convo.turn;
    const turnStart = convo.messages.length;
    const notes = convo.appNotes ?? [];
    delete convo.appNotes;
    convo.messages.push({
      role: "user",
      content: [
        ...notes.map((n) => ({
          text: `[From the transfer view on screen, not the user's words] ${n}`,
        })),
        { text },
      ],
    });
    // An aborted turn is dropped whole, so the stored history keeps alternating user/assistant.
    const abort = (r: string, error: NonNullable<ChatReply["error"]>) => {
      convo.messages.length = turnStart;
      return reply(r, error);
    };

    const exchanges: Exchange[] = [];
    const toolCalls: ToolCallSummary[] = [];
    const usage: ChatReply["usage"] = { input_tokens: 0, output_tokens: 0 };
    const reply = (r: string, error?: ChatReply["error"]): ChatReply => {
      convo.updatedAt = this.now();
      this.trim(convo);
      return {
        conversation_id: id,
        reply: r,
        tool_calls: toolCalls,
        exchanges,
        model: this.opts.modelId,
        usage,
        ...(error ? { error } : {}),
      };
    };

    let tools: Tool[];
    try {
      tools = toBedrockTools(await this.opts.relay.listTools(exchanges));
    } catch (err) {
      console.error(`sim: tools/list failed: ${errMessage(err)}`);
      return abort(MSG.unavailable, { code: "MCP_UNAVAILABLE", message: errMessage(err) });
    }

    for (let round = 0; round < this.maxToolRounds; round++) {
      if (!this.opts.budget.take()) {
        return abort(MSG.budget, {
          code: "DAILY_BUDGET",
          message: "Daily Bedrock call limit reached.",
        });
      }
      const history = compactHistory(convo.messages);
      const request = (cache: boolean): ConverseCommandInput => ({
        modelId: this.opts.modelId,
        system: cache
          ? [{ text: this.opts.systemPrompt }, CACHE_POINT]
          : [{ text: this.opts.systemPrompt }],
        messages: cache && this.cacheMessages ? withCachePoint(history) : history,
        toolConfig: { tools: cache && this.cacheTools ? [...tools, CACHE_POINT] : tools },
        inferenceConfig: { maxTokens: this.maxTokens, temperature: 0.2 },
      });
      let out: ConverseCommandOutput;
      try {
        try {
          out = await this.opts.converse(request(this.promptCache));
        } catch (err) {
          if (!this.promptCache || !isCacheRejection(err)) throw err;
          // Drop only what Bedrock objected to: the tool-list point, or all of them.
          const where = errMessage(err);
          if (this.cacheTools && /toolConfig/i.test(where)) this.cacheTools = false;
          else if (this.cacheMessages && /#\/messages/i.test(where)) this.cacheMessages = false;
          else this.promptCache = false;
          console.warn(
            `sim: Bedrock rejected prompt cache points (${errMessage(err)}); sending without them`,
          );
          out = await this.opts.converse(request(this.promptCache));
        }
      } catch (err) {
        const code = err instanceof Error ? err.name : "BedrockError";
        console.error(`sim: Bedrock ${code}: ${errMessage(err)}`);
        return abort(MSG.unavailable, { code, message: errMessage(err) });
      }
      usage.input_tokens += out.usage?.inputTokens ?? 0;
      usage.output_tokens += out.usage?.outputTokens ?? 0;
      const read = out.usage?.cacheReadInputTokens ?? 0;
      const write = out.usage?.cacheWriteInputTokens ?? 0;
      if (read) usage.cache_read_tokens = (usage.cache_read_tokens ?? 0) + read;
      if (write) usage.cache_write_tokens = (usage.cache_write_tokens ?? 0) + write;

      const message = out.output && "message" in out.output ? out.output.message : undefined;
      const content: ContentBlock[] = message?.content ?? [];
      convo.messages.push({ role: "assistant", content });

      const uses = content.flatMap((b) => (b.toolUse ? [b.toolUse] : []));
      if (out.stopReason !== "tool_use" || uses.length === 0) {
        const textOut = content
          .flatMap((b) => (b.text ? [b.text] : []))
          .join(" ")
          .trim();
        return reply(textOut || MSG.rounds);
      }

      const results: ContentBlock[] = [];
      for (const use of uses) {
        const before = exchanges.length;
        const name = use.name ?? "";
        const input = (use.input ?? {}) as Record<string, unknown>;
        const spent = SPENDS_TOKEN[name] ? input[SPENDS_TOKEN[name]] : undefined;
        if (typeof spent === "string" && convo.issuedIn.get(spent) === turn) {
          toolCalls.push({ name, ms: 0, refused: AWAITING_USER.refused.code, blocked: true });
          results.push({
            toolResult: {
              toolUseId: use.toolUseId,
              content: [{ json: AWAITING_USER as unknown as Record<string, never> }],
              status: "error",
            },
          });
          continue;
        }
        try {
          const outcome = await this.opts.relay.callTool(
            use.name ?? "",
            use.input ?? {},
            exchanges,
          );
          const refused = (outcome.structured.refused as { code?: string } | undefined)?.code;
          const issued = ISSUES_TOKEN[name] ? outcome.structured[ISSUES_TOKEN[name]] : undefined;
          if (typeof issued === "string") convo.issuedIn.set(issued, turn);
          toolCalls.push({
            name: use.name ?? "",
            ms: exchanges.slice(before).reduce((sum, e) => sum + e.ms, 0),
            ...(refused ? { refused } : {}),
            ...(outcome.isError ? { error: true } : {}),
            ...(outcome.view ? { app: outcome.view } : {}),
          });
          results.push({
            toolResult: {
              toolUseId: use.toolUseId,
              content: [{ json: outcome.structured as Record<string, never> }],
              status: outcome.isError ? "error" : "success",
            },
          });
        } catch (err) {
          toolCalls.push({ name: use.name ?? "", ms: 0, error: true });
          results.push({
            toolResult: {
              toolUseId: use.toolUseId,
              content: [{ text: `The tool could not be reached: ${errMessage(err)}` }],
              status: "error",
            },
          });
        }
      }
      convo.messages.push({ role: "user", content: results });
    }
    return abort(MSG.rounds, {
      code: "TOOL_ROUNDS",
      message: `Stopped after ${this.maxToolRounds} tool rounds.`,
    });
  }

  /** Keeps the last maxMessages, cutting only before a user text turn so tool pairs stay whole. */
  private trim(convo: Conversation): void {
    if (convo.messages.length <= this.maxMessages) return;
    let start = convo.messages.length - this.maxMessages;
    while (start < convo.messages.length) {
      const m = convo.messages[start];
      if (m?.role === "user" && m.content?.some((b) => b.text !== undefined)) break;
      start++;
    }
    convo.messages.splice(0, start);
  }

  private expire(): void {
    const t = this.now();
    for (const [id, c] of this.conversations) {
      if (t - c.updatedAt > this.ttlMs) this.conversations.delete(id);
    }
    while (this.conversations.size >= this.maxConversations) {
      const oldest = this.conversations.keys().next().value;
      if (oldest === undefined) break;
      this.conversations.delete(oldest);
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
