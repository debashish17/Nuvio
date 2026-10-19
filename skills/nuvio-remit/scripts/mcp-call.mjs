#!/usr/bin/env node
/* global process, fetch, console */
/**
 * Calls one Nuvio Remit tool over Streamable HTTP and prints its structured result.
 * Usage: MCP_BEARER_TOKEN=... node skills/nuvio-remit/scripts/mcp-call.mjs <tool> '<json arguments>'
 * Env:   MCP_URL (default http://127.0.0.1:3000/mcp), MCP_BEARER_TOKEN (required)
 */

const [tool, rawArgs = "{}"] = process.argv.slice(2);
const url = process.env.MCP_URL ?? "http://127.0.0.1:3000/mcp";
const token = process.env.MCP_BEARER_TOKEN;
if (!tool || !token) {
  console.error("Usage: MCP_BEARER_TOKEN=... node mcp-call.mjs <tool> '<json arguments>'");
  process.exit(2);
}

let args;
try {
  args = JSON.parse(rawArgs);
} catch {
  console.error('The arguments must be JSON, for example \'{"query":"Mum"}\'.');
  process.exit(2);
}

const res = await fetch(url, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-11-25",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: tool, arguments: args },
  }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok || body.error) {
  console.error(`HTTP ${res.status}: ${body.error?.message ?? "request failed"}`);
  process.exit(1);
}
console.log(JSON.stringify(body.result?.structuredContent ?? body.result, null, 2));
