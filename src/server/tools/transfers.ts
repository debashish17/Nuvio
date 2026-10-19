import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Core } from "../../core/index.js";
import { PAYOUT_METHODS, PURPOSES, type PayoutMethod, type Purpose } from "../../core/types.js";
import { TRANSFER_VIEW_META } from "../apps.js";
import { principalOf } from "../auth.js";
import { aedAmount, safely, toMinor } from "../wire.js";
import { MOVES_MONEY, READ_ONLY, WRITES_STATE, type Extra } from "./common.js";
import { TOOL_DESCRIPTIONS } from "./descriptions.js";

const ref = z
  .string()
  .regex(/^NUV-\d{1,10}$/i, "a transfer reference like NUV-240120")
  .describe("Transfer reference, e.g. NUV-240120.");

export function registerTransferTools(server: McpServer, core: Core): void {
  registerAppTool(
    server,
    "quote_transfer",
    {
      title: "Quote a transfer",
      description: TOOL_DESCRIPTIONS.quote_transfer,
      inputSchema: {
        send_amount: aedAmount.describe("Amount to send, in dirhams (AED). The fee is included."),
        send_currency: z.literal("AED").default("AED"),
        beneficiary_id: z.string().min(1).describe("Recipient id from resolve_beneficiary."),
        payout_method: z
          .enum(PAYOUT_METHODS)
          .optional()
          .describe("Defaults to the recipient's saved payout method."),
        purpose: z
          .enum(PURPOSES)
          .optional()
          .describe("Purpose of the transfer. Defaults to the recipient's usual purpose."),
      },
      annotations: WRITES_STATE,
      _meta: TRANSFER_VIEW_META,
    },
    safely(
      "quote_transfer",
      (
        a: {
          send_amount: number;
          beneficiary_id: string;
          payout_method?: PayoutMethod | undefined;
          purpose?: Purpose | undefined;
        },
        extra: Extra,
      ) =>
        core.quotes.create(principalOf(extra.authInfo).userId, {
          beneficiaryId: a.beneficiary_id,
          sendMinor: toMinor(a.send_amount),
          payoutMethod: a.payout_method,
          purpose: a.purpose,
        }),
    ),
  );

  registerAppTool(
    server,
    "prepare_transfer",
    {
      title: "Prepare a transfer for confirmation",
      description: TOOL_DESCRIPTIONS.prepare_transfer,
      inputSchema: { quote_id: z.string().min(1).describe("quote_id from quote_transfer.") },
      annotations: WRITES_STATE,
      _meta: TRANSFER_VIEW_META,
    },
    safely("prepare_transfer", ({ quote_id }: { quote_id: string }, extra: Extra) => {
      const { userId, callerId } = principalOf(extra.authInfo);
      return core.quotes.prepare(userId, quote_id, callerId);
    }),
  );

  registerAppTool(
    server,
    "confirm_transfer",
    {
      title: "Confirm and send a transfer",
      description: TOOL_DESCRIPTIONS.confirm_transfer,
      inputSchema: {
        confirmation_token: z
          .string()
          .min(1)
          .max(200)
          .describe("The confirmation_token from prepare_transfer."),
        // Any short text: the server reads digits or words (core/spoken.ts), and anything that
        // isn't six digits is a structured OTP_INVALID rather than a schema error.
        otp: z
          .string()
          .max(100)
          .optional()
          .describe(
            'The 6-digit code from the text message, as the user read it out: digits or words, such as "482913" or "four eight two nine one three". Omit on the first call.',
          ),
      },
      annotations: MOVES_MONEY,
      _meta: TRANSFER_VIEW_META,
    },
    safely(
      "confirm_transfer",
      (
        { confirmation_token, otp }: { confirmation_token: string; otp?: string | undefined },
        extra: Extra,
      ) => {
        const { userId, callerId } = principalOf(extra.authInfo);
        return core.stepUp.confirm(userId, confirmation_token, callerId, otp);
      },
    ),
  );

  registerAppTool(
    server,
    "track_transfer",
    {
      title: "Track a transfer",
      description: TOOL_DESCRIPTIONS.track_transfer,
      inputSchema: {
        transfer_ref: ref.optional(),
        latest: z.boolean().optional().describe("Track the most recent transfer instead."),
      },
      annotations: READ_ONLY,
      _meta: TRANSFER_VIEW_META,
    },
    safely(
      "track_transfer",
      (
        {
          transfer_ref,
          latest,
        }: { transfer_ref?: string | undefined; latest?: boolean | undefined },
        extra: Extra,
      ) =>
        // `latest: true` means the most recent transfer "instead" of a reference, as its
        // description says, even if the model also sends a (possibly stale) transfer_ref.
        core.ledger.track(principalOf(extra.authInfo).userId, latest ? undefined : transfer_ref),
    ),
  );

  server.registerTool(
    "cancel_transfer",
    {
      title: "Cancel a transfer",
      description: TOOL_DESCRIPTIONS.cancel_transfer,
      inputSchema: {
        transfer_ref: ref,
        cancel_token: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Omit for a preview; pass the cancel_token from the preview to cancel."),
      },
      annotations: MOVES_MONEY,
    },
    safely(
      "cancel_transfer",
      (
        { transfer_ref, cancel_token }: { transfer_ref: string; cancel_token?: string | undefined },
        extra: Extra,
      ) => {
        const { userId, callerId } = principalOf(extra.authInfo);
        const normalised = transfer_ref.toUpperCase();
        return cancel_token
          ? core.ledger.cancel(userId, normalised, cancel_token, callerId)
          : core.ledger.cancelPreview(userId, normalised, callerId);
      },
    ),
  );

  server.registerTool(
    "get_transfer_history",
    {
      title: "Transfer history",
      description: TOOL_DESCRIPTIONS.get_transfer_history,
      inputSchema: {
        months: z
          .number()
          .int()
          .min(1)
          .max(24)
          .optional()
          .describe("Calendar months to include, counting this one. Defaults to 3."),
        beneficiary_id: z.string().min(1).optional().describe("Only transfers to this recipient."),
      },
      annotations: READ_ONLY,
    },
    safely(
      "get_transfer_history",
      (a: { months?: number | undefined; beneficiary_id?: string | undefined }, extra: Extra) =>
        core.ledger.history(principalOf(extra.authInfo).userId, {
          ...(a.months !== undefined ? { months: a.months } : {}),
          ...(a.beneficiary_id ? { beneficiaryId: a.beneficiary_id } : {}),
        }),
    ),
  );
}
