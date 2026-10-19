import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Core } from "../../core/index.js";
import { aedAmount, safely, toMinor } from "../wire.js";
import { READ_ONLY } from "./common.js";
import { TOOL_DESCRIPTIONS } from "./descriptions.js";

const from = z.literal("AED").default("AED").describe("Send currency. Only AED is supported.");
const code = (dflt: string, what: string) =>
  z
    .string()
    .regex(/^[A-Za-z]{3}$/, "a 3-letter ISO 4217 code")
    .default(dflt)
    .describe(
      `${what} currency: ISO 4217 code such as AED, INR, USD, GBP or PHP. Default ${dflt}.`,
    );

const getRateOutput = {
  corridor: z.string().optional().describe("Send and receive country pair, e.g. AE-IN"),
  pair: z.string(),
  sendable: z.boolean().describe("True only for AED/INR, the pair Nuvio sends money in"),
  customer_rate: z
    .number()
    .optional()
    .describe("Nuvio's rate: rupees per dirham the recipient gets (AED/INR only)"),
  mid_rate: z.number().describe("Mid-market rate"),
  fx_margin_pct: z.number().optional(),
  customer_week_high: z
    .number()
    .optional()
    .describe("Highest Nuvio rate this week, rupees per dirham (AED/INR only)"),
  customer_week_low: z
    .number()
    .optional()
    .describe("Lowest Nuvio rate this week, rupees per dirham (AED/INR only)"),
  mid_week_high: z.number().describe("Highest mid-market rate this week"),
  mid_week_low: z.number().describe("Lowest mid-market rate this week"),
  trend: z.string(),
  as_of: z.string(),
  source: z.string(),
  note: z.string().optional(),
};

export function registerRateTools(server: McpServer, core: Core): void {
  server.registerTool(
    "get_rate",
    {
      title: "Get an exchange rate",
      description: TOOL_DESCRIPTIONS.get_rate,
      inputSchema: { from: code("AED", "From"), to: code("INR", "To") },
      outputSchema: getRateOutput,
      annotations: READ_ONLY,
    },
    safely(
      "get_rate",
      ({ from: f, to: t }: { from: string; to: string }) => core.rates.snapshot(f, t),
      { refusalIsError: true },
    ),
  );

  server.registerTool(
    "compare_options",
    {
      title: "Compare payout options",
      description: TOOL_DESCRIPTIONS.compare_options,
      inputSchema: {
        send_amount: aedAmount.describe("Amount to send, in dirhams (AED)."),
        send_currency: from,
      },
      annotations: READ_ONLY,
    },
    safely("compare_options", ({ send_amount }: { send_amount: number }) =>
      core.quotes.compare(toMinor(send_amount)),
    ),
  );
}
