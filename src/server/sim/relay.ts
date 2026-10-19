/**
 * The simulator's MCP client: real JSON-RPC over HTTP to this server's own POST /mcp, exactly as
 * Alexa+ would call it (SPEC "Simulated Alexa+ client"). Every request and response is recorded
 * for the protocol panel, where tokens are cut to a prefix and codes masked. The model gets the
 * full result, or it could not confirm; so does the MCP Apps view a linked tool shows (SPEC "MCP
 * Apps view"), which needs the token to send the code. The relay announces the MCP Apps extension
 * in initialize, since the simulator page is an MCP Apps host.
 */

export interface Exchange {
  id: number;
  method: string;
  at: string;
  ms: number;
  status: number;
  request: unknown;
  response: unknown;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/** A tools/call result as the server sent it. */
export interface CallToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [k: string]: unknown;
}

/** What an MCP Apps view needs for one linked call: its arguments (code masked) and result. */
export interface ViewCall {
  resource_uri: string;
  input: Record<string, unknown>;
  result: CallToolResult;
}

export interface ToolOutcome {
  structured: Record<string, unknown>;
  isError: boolean;
  /** Set when the tool links an MCP Apps view (`_meta.ui.resourceUri`). */
  view?: ViewCall;
}

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  _meta?: Record<string, unknown>;
}

export const UI_EXTENSION = "io.modelcontextprotocol/ui";
export const UI_MIME = "text/html;profile=mcp-app";

/** The MCP Apps view a tool links to, if any. */
export function viewOf(tool: McpTool | undefined): string | undefined {
  const ui = tool?._meta?.ui as { resourceUri?: unknown } | undefined;
  const uri = ui?.resourceUri ?? tool?._meta?.["ui/resourceUri"];
  return typeof uri === "string" && uri.startsWith("ui://") ? uri : undefined;
}

/** MCP Apps visibility; a tool with none set is visible to both the model and views. */
export function visibleTo(tool: McpTool, who: "model" | "app"): boolean {
  const v = (tool._meta?.ui as { visibility?: unknown } | undefined)?.visibility;
  return !Array.isArray(v) || v.includes(who);
}

export interface RelayOptions {
  url: string | (() => string);
  bearer: string;
  protocolVersion?: string;
  fetch?: typeof fetch;
}

const TOKEN = /\b(c[tx]_)([A-Za-z0-9_-]{5})[A-Za-z0-9_-]{20,}/g;

/** A step-up code in tool arguments: shown as its first two digits, e.g. "48••••". */
const OTP_ARG = /("otp":")([^"]*)(")/g;

/** Masks step-up codes only (a view gets tokens, never codes). */
export function maskCodes<T>(value: T): T {
  const json = JSON.stringify(value).replace(
    OTP_ARG,
    (_m, open: string, code: string, close: string) => {
      return `${open}${code.replace(/D/g, "").slice(0, 2)}••••${close}`;
    },
  );
  return JSON.parse(json) as T;
}

const LONG = 2000;

/** Cuts strings longer than 2,000 characters (a view's HTML) for the protocol panel. */
function abbreviate(value: unknown): unknown {
  if (typeof value === "string" && value.length > LONG) {
    return `${value.slice(0, 160)}… (${value.length.toLocaleString("en-US")} characters)`;
  }
  if (Array.isArray(value)) return value.map(abbreviate);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, abbreviate(v)]));
  }
  return value;
}

/** Replaces every confirmation or cancel token with its prefix, e.g. "ct_9b2eQ…", and masks codes. */
export function redactTokens<T>(value: T): T {
  const json = JSON.stringify(value)
    .replace(TOKEN, "$1$2…")
    .replace(OTP_ARG, (_m, open: string, code: string, close: string) => {
      return `${open}${code.replace(/\D/g, "").slice(0, 2)}••••${close}`;
    });
  return JSON.parse(json) as T;
}

export class McpRelay {
  private nextId = 1;
  private tools: McpTool[] | undefined;
  private negotiated: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly version: string;

  constructor(private readonly opts: RelayOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.version = opts.protocolVersion ?? "2025-11-25";
  }

  get protocolVersion(): string | undefined {
    return this.negotiated;
  }

  /** initialize then tools/list, once; later calls return the cached list. */
  async listTools(log: Exchange[]): Promise<McpTool[]> {
    if (this.tools) return this.tools;
    const init = (await this.rpc(
      "initialize",
      {
        protocolVersion: this.version,
        // The page renders MCP Apps views (SPEC "MCP Apps view").
        capabilities: { extensions: { [UI_EXTENSION]: { mimeTypes: [UI_MIME] } } },
        clientInfo: { name: "nuvio-remit-simulator", version: "1.0.0" },
      },
      log,
    )) as { protocolVersion?: string };
    this.negotiated = init.protocolVersion;
    const list = (await this.rpc("tools/list", {}, log)) as { tools?: McpTool[] };
    this.tools = list.tools ?? [];
    return this.tools;
  }

  /** The cached tools/list entry for a tool (after listTools). */
  tool(name: string): McpTool | undefined {
    return this.tools?.find((t) => t.name === name);
  }

  async callTool(name: string, args: unknown, log: Exchange[]): Promise<ToolOutcome> {
    const result = (await this.rpc("tools/call", { name, arguments: args }, log)) as CallToolResult;
    const text = result.content?.find((c) => c.type === "text")?.text;
    const uri = viewOf(this.tool(name));
    return {
      structured: result.structuredContent ?? { text: text ?? "" },
      isError: result.isError === true,
      ...(uri
        ? {
            view: {
              resource_uri: uri,
              input: maskCodes((args ?? {}) as Record<string, unknown>),
              result,
            },
          }
        : {}),
    };
  }

  /** resources/read: the first content item, e.g. an MCP Apps view's HTML. */
  async readResource(uri: string, log: Exchange[]): Promise<ResourceContent | undefined> {
    const result = (await this.rpc("resources/read", { uri }, log)) as {
      contents?: ResourceContent[];
    };
    return result.contents?.find((c) => c.uri === uri) ?? result.contents?.[0];
  }

  /** Forget cached tools (after a reset or redeploy). */
  reset(): void {
    this.tools = undefined;
  }

  private async rpc(method: string, params: unknown, log: Exchange[]): Promise<unknown> {
    const body = { jsonrpc: "2.0", id: this.nextId++, method, params };
    const url = typeof this.opts.url === "function" ? this.opts.url() : this.opts.url;
    const started = performance.now();
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.opts.bearer}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": this.version,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      result?: unknown;
      error?: { code: number; message: string };
    };
    log.push({
      id: body.id,
      method,
      at: new Date().toISOString(),
      ms: Math.round((performance.now() - started) * 10) / 10,
      status: res.status,
      request: redactTokens(body),
      response: abbreviate(redactTokens(json)),
    });
    if (!res.ok || json.error) {
      throw new Error(`MCP ${method} failed: ${json.error?.message ?? `HTTP ${res.status}`}`);
    }
    return json.result;
  }
}
