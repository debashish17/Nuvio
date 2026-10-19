import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * MCP Apps (SPEC "MCP Apps view"): the ui://acme-remit/transfer resource, and the `_meta` that
 * links the four transfer tools to it. Hosts without the extension ignore `_meta`, so every other
 * client sees the same tools. The transport is stateless, so tools/list never sees the client's
 * capabilities and the link is always declared.
 */

export const TRANSFER_VIEW_URI = "ui://acme-remit/transfer";

export const TRANSFER_VIEW_TOOLS = [
  "quote_transfer",
  "prepare_transfer",
  "confirm_transfer",
  "track_transfer",
] as const;

/** `_meta` for a tool that shows the transfer view; registerAppTool also adds the pre-release flat key. */
export const TRANSFER_VIEW_META = { ui: { resourceUri: TRANSFER_VIEW_URI } };

/** No network for the view (an empty CSP); the host draws a border around it. */
export const TRANSFER_VIEW_UI_META = { csp: {}, prefersBorder: true } as const;

/** The built view (scripts/build-ui.ts), from the source tree or next to the bundle. */
export function uiDir(): string | undefined {
  for (const rel of ["../../.generated/ui/", "./ui/"]) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(`${dir}transfer.html`)) return dir;
  }
  return undefined;
}

let cached: string | undefined;

/** The view's HTML, read once. Throws when the UI has not been built. */
export function transferViewHtml(): string {
  if (cached) return cached;
  const dir = uiDir();
  if (!dir) {
    throw new Error(
      "The transfer view is not built. Run `pnpm build:ui` (pnpm dev does it first).",
    );
  }
  cached = readFileSync(`${dir}transfer.html`, "utf8");
  return cached;
}

export function registerAppResources(server: McpServer): void {
  registerAppResource(
    server,
    "Transfer view",
    TRANSFER_VIEW_URI,
    {
      title: "Nuvio Remit transfer",
      description:
        "Shows the transfer being discussed: the quote, the read-back with its countdown, the box for the code texted to the customer's phone, and the live receipt.",
      mimeType: RESOURCE_MIME_TYPE,
      _meta: { ui: TRANSFER_VIEW_UI_META },
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: RESOURCE_MIME_TYPE,
          text: transferViewHtml(),
          _meta: { ui: TRANSFER_VIEW_UI_META },
        },
      ],
    }),
  );
}
