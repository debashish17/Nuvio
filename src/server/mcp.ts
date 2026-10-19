import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RequestHandler } from "express";
import pkg from "../../package.json" with { type: "json" };
import type { Core } from "../core/index.js";
import { registerAppResources } from "./apps.js";
import { registerTools } from "./tools/index.js";

export const SERVER_NAME = "nuvio-remit";
/** From package.json at build time (the bundler inlines it), so the two cannot drift. */
export const SERVER_VERSION: string = pkg.version;

export function createMcpServer(core: Core): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );
  registerTools(server, core);
  // The MCP Apps view the transfer tools link to (SPEC "MCP Apps view").
  registerAppResources(server);
  return server;
}

/**
 * POST /mcp in stateless mode: a fresh server and transport per request, no Mcp-Session-Id.
 * JSON responses (not SSE) since no tool streams progress.
 */
export const mcpPostHandler =
  (core: Core): RequestHandler =>
  async (req, res) => {
    const server = createMcpServer(core);
    // Omitting sessionIdGenerator selects stateless mode. The SDK docs write `sessionIdGenerator:
    // undefined`, which does not compile under exactOptionalPropertyTypes (see FRICTION_LOG.md).
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      // Cast: the SDK transport's `onclose` getter is typed `| undefined`, which the SDK's own
      // Transport interface rejects under exactOptionalPropertyTypes. Runtime shape is identical.
      await server.connect(transport as Transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("mcp: request failed", err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

/** Stateless mode has no standalone SSE stream (GET) or session to delete (DELETE). */
export const methodNotAllowed: RequestHandler = (_req, res) => {
  res
    .status(405)
    .set("Allow", "POST")
    .json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST /mcp." },
      id: null,
    });
};
