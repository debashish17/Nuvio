// Verbatim from docs/SPEC.md "Tool contract" (generated; tests/protocol.test.ts checks every one).
// Change only after a simulator run shows a mis-pick, and say why in the commit (CLAUDE.md).

export const TOOL_DESCRIPTIONS = {
  get_rate:
    "Get today's exchange rate with the 7-day trend. For AED to INR it is Nuvio's rate for sending money to India; for any other pair of supported currencies it is the mid-market rate, for information only, because Nuvio sends money only from AED to INR. Use when the user asks about the rate, the rupee or another currency, or whether now is a good time to send.",
  compare_options:
    "Compare what the recipient would receive for a send amount across Nuvio's payout methods (bank deposit, UPI, cash pickup), including fee and arrival time, and show Nuvio's rate against the mid-market rate and a typical bank rate. Use when the user asks which option is best or how much will be received.",
  list_beneficiaries:
    "List the user's saved recipients: nickname, relationship, bank or UPI, payout method, and when they last received money. Use when the user asks who they can send to.",
  resolve_beneficiary:
    'Find one saved recipient from a name or nickname such as "Mum", "my brother" or "Sunita". Call this before quoting whenever the user names a person. Returns one match, or candidates to ask the user to choose from. Never invents a recipient; new recipients are added in the Nuvio app.',
  quote_transfer:
    "Price a transfer: fee, locked rate, guaranteed receive amount in rupees, arrival time, and any limit warnings or document requirements for the purpose. Does not move money. Returns a quote_id with rate and fee held for 30 minutes.",
  prepare_transfer:
    "Turn a quote into a confirmation request. Returns the exact sentence to read back to the user and a single-use confirmation_token valid for 5 minutes. Does not move money. Call confirm_transfer only after the user explicitly agrees to the read-back.",
  confirm_transfer:
    "Execute a prepared transfer in two calls, after the user agrees to the read-back. Called with the confirmation_token alone, it texts a 6-digit one-time code to the user's registered phone and returns STEP_UP_REQUIRED; nothing is sent yet. Ask the user to read the code out, then call again with the same confirmation_token and otp: that charges the saved debit card and submits the transfer. The code is never in a tool result, so never guess it. Fails if the token is unknown, expired or used, if the code is wrong or expired, or if limits changed since the quote.",
  track_transfer:
    "Get the status of a transfer by reference or the most recent one: current stage, timeline, UTR once paid out, whether it can still be cancelled, and any action the user must take if it is under review. Use when the user asks where their money is or whether it was credited.",
  cancel_transfer:
    "Cancel a transfer that has not yet been sent to the payout partner. Without a cancel_token it returns a preview (refund amount, timing) and a single-use cancel_token valid for 5 minutes; with the token it cancels and refunds send amount and fee to the card. Call with the token only after the user explicitly agrees to the preview. Fails once the transfer has been sent; recalls need the recipient's consent and are handled by support.",
  get_transfer_history:
    "List past transfers for the last N months or to one recipient, including cancelled, returned or refunded ones, with totals and how much of each limit has been used this month.",
  check_limits:
    "Show the user's KYC tier, remaining per-transaction, daily and monthly limits, cash-pickup caps, the reset date, and explain any refusal code in plain words with how to resolve it.",
  get_help:
    "Answer general questions about sending money with Nuvio from the UAE to India, from Nuvio's reviewed help content: documents, how sending works, recipients, payout methods, fees and rates, limits and tiers, tracking and receipts, cancellations and refunds, NRE and NRO accounts, the Liberalised Remittance Scheme (LRS), tax on money received in India, and staying safe. Use it instead of general knowledge for any rule, document or tax question; for the user's own numbers use check_limits or track_transfer.",
  get_pending:
    'Get what is waiting on the user since their last conversation: open quotes, transfers under review and what the user must do, rate alerts that fired recently, and the last transfer to each recipient. Call it once at the start of a conversation to mention anything that needs attention, and use last_by_recipient to resolve requests like "send the usual to Mum".',
  set_rate_alert:
    'Ask to be told when the AED to INR rate reaches a target. Use when the user says "tell me when" or "alert me if".',
} as const;

export type ToolName = keyof typeof TOOL_DESCRIPTIONS;
