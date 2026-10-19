---
name: acme-remit
description: Send money from the UAE to India safely through the Acme Remit MCP server, and check rates, recipients, transfer status, limits and pending items. Use when a user wants to send, quote, track or cancel a remittance with Acme Remit, or when building or testing an MCP client against this server. Teaches the consent flow the server enforces (resolve, quote, prepare, read back, wait for a yes, confirm with the texted code, track) so money never moves without the user.
license: MIT
metadata:
  server: acme-remit
  mcp-protocol: "2025-11-25"
  transport: streamable-http
---

# Acme Remit: the safe send flow

Acme Remit is an MCP server for one remittance provider (UAE to India, AED to INR, simulated ledger). Two tools move money, `confirm_transfer` and `cancel_transfer`, and both refuse unless the user has heard a read-back and agreed. Follow this flow exactly; the server enforces most of it, and the rest is your job.

## Connect

- Endpoint: `POST $MCP_URL` (default `http://127.0.0.1:3000/mcp`), Streamable HTTP, stateless (no session id).
- Headers: `Authorization: Bearer $MCP_BEARER_TOKEN`, `Content-Type: application/json`, `Accept: application/json, text/event-stream`, `MCP-Protocol-Version: 2025-11-25`.
- JSON-RPC methods: `initialize`, `tools/list`, `tools/call`. Results are in `result.structuredContent`.
- Helper: `node skills/acme-remit/scripts/mcp-call.mjs <tool> '<json arguments>'` prints the structured result. Run the server locally with `pnpm dev`; no AWS account is needed.

All 14 tools are listed in [references/tools.md](references/tools.md).

## At the start of a conversation

Call `get_pending` once. If its `summary` mentions something (a transfer under review and what to upload, a rate alert that fired, an open quote), tell the user in one sentence before answering. `last_by_recipient` answers "send the usual to Mum".

## Sending money

1. **Resolve the recipient.** `resolve_beneficiary { query }` with the user's words ("Mum", "my brother", "my NRE account").
   - `match`: use `match.id`.
   - `ambiguous` with `candidates`: ask which one, naming each by relationship and full name. Never pick.
   - `not_found`: say the recipient must be added in the Acme app. You cannot add or edit recipients.
2. **Quote.** `quote_transfer { beneficiary_id, send_amount }` (AED; the fee is taken out of it). Rate and receive amount are held 30 minutes. If the user only asked what it would cost, tell them the receive amount, fee and arrival time, mention any `warnings`, and ask whether to send.
3. **Prepare.** `prepare_transfer { quote_id }` returns `confirmation_token`, `expires_at` (5 minutes) and `read_back`.
4. **Read back, word for word.** Show or say `read_back` exactly as written, including its final question. Then **stop and wait** for the user's next message.
5. **Only on a clear yes** ("yes", "go ahead", "confirm") to that read-back, call `confirm_transfer { confirmation_token }`. If they ask a question, hesitate, change anything or say no, do not confirm; a change means quote and prepare again. A yes given before the read-back does not count.
6. **Step-up.** That call returns `refused.code: "STEP_UP_REQUIRED"` with `sent_to` ("phone ending 4471"). Nothing has moved. A 6-digit code was texted to the user. Ask them to read it out. The code is never in any tool result: never guess, invent or reuse one.
7. **Confirm with the code.** `confirm_transfer { confirmation_token, otp }` with the code as the user read it: digits or words both work. Success returns `transfer_ref`, `status` and `customer_label`.
   - `OTP_INVALID` (`attempts_left`): ask them to read the code again.
   - `OTP_EXPIRED`: offer to send a new code (call step 5 again).
   - `OTP_LOCKED`: nothing was sent; start again from step 2.
8. **Track.** `track_transfer { transfer_ref }` (or `{ latest: true }`). Describe progress with `customer_label`, never the raw `status`. Paid out includes a bank reference (`utr`). Under review includes `action_required`; say only that, never a reason.

## Cancelling

1. `cancel_transfer { transfer_ref }` without a token returns a `preview` and a `cancel_token`, or a refusal if it is too late (the server decides; don't guess).
2. Read `preview` word for word and wait.
3. Only after a clear yes: `cancel_transfer { transfer_ref, cancel_token }`. The refund always goes back to the sender's own card, which is why cancelling has no step-up code.

## Refusals

Every refusal is structured: `{ refused: { code, ...numbers, resolution } }`. Explain it to the user using `resolution`. Do not retry with a different amount unless they ask. `check_limits { refusal_code }` explains a limit refusal in plain words. Common codes: `MONTHLY_LIMIT`, `DAILY_LIMIT`, `PER_TRANSACTION_LIMIT`, `NEW_RECIPIENT_LIMIT`, `SOURCE_OF_FUNDS_REQUIRED`, `QUOTE_EXPIRED`, `TOKEN_EXPIRED`, `TOKEN_USED`, `STEP_UP_REQUIRED`, `OTP_INVALID`, `OTP_LOCKED`, `CANCEL_WINDOW_CLOSED`.

## Never

- Call `confirm_transfer` in the same turn as `prepare_transfer`, or `cancel_transfer` with a token in the same turn as its preview.
- Use a token for a different action, or after the user changed anything.
- Print or log a full token or a code; a prefix such as `ct_9b2eQ…` is enough.
- Answer rules, documents or tax from your own knowledge: use `get_help { topic }`.
- Mention tool names, tokens or JSON to an end user.

## Example

```text
user: Send 2,000 dirhams to Mum.
  tools/call resolve_beneficiary {"query":"Mum"}            -> match ben_01
  tools/call quote_transfer {"beneficiary_id":"ben_01","send_amount":2000}
  tools/call prepare_transfer {"quote_id":"q_..."}          -> read_back, ct_...
assistant: Send 2,000 dirhams to Mum, Sunita Nair at HDFC Bank ending 4421, ... Shall I go ahead?
user: Yes.
  tools/call confirm_transfer {"confirmation_token":"ct_..."} -> STEP_UP_REQUIRED, phone ending 4471
assistant: I've texted a code to your phone ending 4471. Please read it out.
user: 4 8 2 9 1 3
  tools/call confirm_transfer {"confirmation_token":"ct_...","otp":"482913"} -> NUV-240121
assistant: Done. NUV-240121 is on its way to Mum.
```

In the local simulator, the texted code appears on the simulated phone on the page (and in `GET /sim/state` as `sms`).
