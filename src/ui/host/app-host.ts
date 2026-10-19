/**
 * The simulator page as an MCP Apps host (SPEC "MCP Apps view"): mounts a view in a sandboxed
 * iframe and speaks the host side of the protocol with the official SDK's AppBridge over
 * postMessage. The page (src/simulator/js/app.js) supplies the callbacks: tools/call goes to
 * POST /sim/app-tool, so the browser never holds the Bearer secret; ui/message becomes a chat
 * turn; ui/update-model-context goes to POST /sim/app-context.
 *
 * Bundled to .generated/ui/app-host.js by scripts/build-ui.ts and served at /js/app-host.js.
 */

import {
  AppBridge,
  PostMessageTransport,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface MountOptions {
  /** Where the iframe goes. */
  parent: HTMLElement;
  /** The single-use frame URL from POST /sim/app-view. */
  frameUrl: string;
  title: string;
  hostContext: McpUiHostContext;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  /** A ui/message from the view: the page sends it as the user's next turn. */
  sendMessage(text: string): Promise<void>;
  updateContext(text: string, structured: Record<string, unknown> | undefined): Promise<void>;
  onSize?(height: number): void;
}

export interface MountedView {
  readonly iframe: HTMLIFrameElement;
  /** tool-input then tool-result for one linked call; queued until the view has initialized. */
  deliver(args: Record<string, unknown>, result: CallToolResult): Promise<void>;
  setContext(ctx: McpUiHostContext): void;
  /** ui/resource-teardown, then disconnect. The iframe stays, frozen on its last state. */
  teardown(): Promise<void>;
}

const HOST_INFO = { name: "nuvio-remit-simulator", version: "1.0.0" };
const MAX_HEIGHT = 720;

export function mountView(opts: MountOptions): MountedView {
  const iframe = document.createElement("iframe");
  // allow-scripts only: an opaque origin, so the view can't reach the page, its storage or /sim.
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("title", opts.title);
  iframe.referrerPolicy = "no-referrer";
  iframe.className = "appframe";
  opts.parent.append(iframe);
  const win = iframe.contentWindow;
  if (!win) throw new Error("the view iframe has no window");

  const bridge = new AppBridge(
    null,
    HOST_INFO,
    {
      serverTools: {},
      message: { text: {} },
      updateModelContext: { text: {}, structuredContent: {} },
      logging: {},
      sandbox: { csp: {} },
    },
    { hostContext: opts.hostContext },
  );

  let initialized = false;
  const ready = new Promise<void>((resolve) => {
    bridge.oninitialized = () => {
      initialized = true;
      resolve();
    };
  });

  bridge.oncalltool = (params) => opts.callTool(params.name, params.arguments ?? {});
  bridge.onmessage = async (params) => {
    const text = params.content
      .flatMap((c) => (c.type === "text" ? [c.text] : []))
      .join(" ")
      .trim();
    if (!text) return { isError: true };
    try {
      await opts.sendMessage(text);
      return {};
    } catch {
      return { isError: true };
    }
  };
  bridge.onupdatemodelcontext = async (params) => {
    const text = (params.content ?? [])
      .flatMap((c) => (c.type === "text" ? [c.text] : []))
      .join(" ")
      .trim();
    await opts.updateContext(text, params.structuredContent);
    return {};
  };
  bridge.onsizechange = ({ height }) => {
    if (typeof height !== "number") return;
    const h = Math.min(MAX_HEIGHT, Math.max(40, Math.ceil(height)));
    iframe.style.height = `${h}px`;
    opts.onSize?.(h);
  };
  bridge.onloggingmessage = (p) => console.debug("app view:", p.level, p.data);

  // Listen before the frame loads, so the view's ui/initialize is never missed.
  const connected = bridge.connect(new PostMessageTransport(win, win));
  iframe.src = opts.frameUrl;

  let queue = Promise.resolve();
  return {
    iframe,
    deliver(args, result) {
      queue = queue
        .then(() => connected)
        .then(() => ready)
        .then(() => bridge.sendToolInput({ arguments: args }))
        .then(() => bridge.sendToolResult(result))
        .catch((err: unknown) => console.warn("app view: delivery failed", err));
      return queue;
    },
    setContext(ctx) {
      bridge.setHostContext(ctx);
    },
    async teardown() {
      if (initialized) {
        await Promise.race([
          bridge.teardownResource({}).catch(() => undefined),
          new Promise((r) => setTimeout(r, 1000)),
        ]);
      }
      await bridge.close().catch(() => undefined);
    },
  };
}
