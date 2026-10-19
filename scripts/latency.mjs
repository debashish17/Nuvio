/* global process, fetch, console, performance, URL */
/**
 * Per-tool latency over the public endpoint (SPEC Phase 3: p95 per tool well under 500 ms).
 * Usage: MCP_URL=https://<service>/mcp MCP_BEARER_TOKEN=... node scripts/latency.mjs
 * Prints a Markdown table (for $GITHUB_STEP_SUMMARY) and exits 1 if any tool's p95 > BUDGET_MS.
 * Arguments are chosen so nothing durable changes: write tools hit refusal paths.
 */

const url = process.env.MCP_URL;
const token = process.env.MCP_BEARER_TOKEN;
const runs = Number(process.env.RUNS ?? 20);
const budgetMs = Number(process.env.BUDGET_MS ?? 500);
if (!url || !token) {
  console.error("Set MCP_URL and MCP_BEARER_TOKEN.");
  process.exit(2);
}

const CALLS = [
  ["get_rate", {}],
  ["compare_options", { send_amount: 2000 }],
  ["list_beneficiaries", {}],
  ["resolve_beneficiary", { query: "Mum" }],
  ["quote_transfer", { send_amount: 100, beneficiary_id: "ben_01" }], // writes an expiring quote row only
  ["prepare_transfer", { quote_id: "q_latency_check" }], // QUOTE_UNKNOWN
  ["confirm_transfer", { confirmation_token: "ct_latency_check" }], // TOKEN_UNKNOWN
  ["track_transfer", { latest: true }],
  ["cancel_transfer", { transfer_ref: "NUV-240119" }], // CANCEL_WINDOW_CLOSED (paid out)
  ["get_transfer_history", { months: 3 }],
  ["check_limits", {}],
  ["set_rate_alert", { target: 0, direction: "above" }], // ALERT_TARGET_INVALID
];

let id = 0;
async function rpc(method, params) {
  const started = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const body = await res.json();
  const ms = performance.now() - started;
  if (!res.ok || body.error)
    throw new Error(`${method}: HTTP ${res.status} ${JSON.stringify(body.error ?? {})}`);
  return { ms, body };
}

const pct = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const fmt = (n) => n.toFixed(0);

const init = await rpc("initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "latency-check", version: "1.0.0" },
});
const rows = [];
let failed = false;
for (const [name, args] of CALLS) {
  await rpc("tools/call", { name, arguments: args }); // warm-up, not counted
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const { ms, body } = await rpc("tools/call", { name, arguments: args });
    if (body.result?.isError)
      throw new Error(`${name} returned isError: ${JSON.stringify(body.result)}`);
    samples.push(ms);
  }
  samples.sort((a, b) => a - b);
  const p95 = pct(samples, 95);
  const ok = p95 <= budgetMs;
  failed ||= !ok;
  rows.push(
    `| ${name} | ${fmt(pct(samples, 50))} | ${fmt(p95)} | ${fmt(samples[samples.length - 1])} | ${ok ? "ok" : "OVER"} |`,
  );
}

console.log(
  `### MCP latency from this runner (${runs} calls per tool, budget p95 <= ${budgetMs} ms)`,
);
console.log("");
console.log(
  `Endpoint: \`${new URL(url).host}\` · protocol ${init.body.result?.protocolVersion} · initialize ${fmt(init.ms)} ms`,
);
console.log("");
console.log("| Tool | p50 ms | p95 ms | max ms | |");
console.log("| --- | ---: | ---: | ---: | --- |");
for (const r of rows) console.log(r);
process.exit(failed ? 1 : 0);
