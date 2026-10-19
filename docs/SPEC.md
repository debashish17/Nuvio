# Nuvio Remit for Alexa+ — Build Spec & Hackathon Plan

Oct 1, 2026 · @Debashish · updated Oct 4, 2026 after the hackathon FAQ

## Locked decisions

Nuvio Remit is one remittance provider's own Alexa+ add-on: a self-hosted MCP server (spec 2025-11-25, Streamable HTTP) over a simulated ledger, entered in the Alexa+ track plus the AWS Builder and Open Source mini challenges. Its own web simulator, which stands in for Alexa+, is the demo, and the whole experience runs locally with nothing but Node.

| Decision | Choice | Why |
| --- | --- | --- |
| Framing | Single provider ("Nuvio Remit"), UAE–India corridor, AED to INR | Matches how every real Alexa+ add-on works; one board rate, one backend, no scraping |
| Rates | Live mid-market from Frankfurter (ECB), cached 15 min; ECB publishes no AED, so AED/INR is USD/INR divided by the CBUAE peg of 3.6725 AED per USD, plus a simulated Nuvio FX margin; seeded fallback table. Customer sees "our rate" plus the guaranteed receive amount, Wise-style mid shown only in `compare_options`. Every other currency ECB publishes, plus the dollar-pegged Gulf currencies (AED, SAR, QAR, OMR, BHD), can be quoted by `get_rate` as a mid-market rate for information; sending stays AED to INR. | Realistic pricing model, one dependency, demo never breaks |
| Payout methods | Bank deposit via IMPS (instant), UPI ID (instant), cash pickup (MTSS caps). No economy/express tiers | What UAE exchange houses actually offer; cash pickup brings a real regulatory cap into the demo |
| Competitor data | None live. `compare_options` shows the mid rate, Nuvio's rate, and a labelled illustrative typical-bank rate derived from the same mid | Honest, defensible, still reads well aloud |
| Funding | Saved debit card, charged at confirm; funds received instantly in the mock | Voice cannot take card details; matches per-transfer funding norms |
| Money movement | Simulated ledger only; every write labelled "no real funds move" | Expected for the event; the tool contract is production-shaped |
| User and KYC tier | One demo user (Priya, Dubai), tier "Verified" (Emirates ID done, no income proof), Bearer token auth | Tier explains the limits; account linking (OAuth 2.1 + PKCE) documented as the production path |
| Recipients | Resolved by nickname server-side via `resolve_beneficiary`; adding or editing recipients is out of scope | Adding payees by voice is a fraud surface; say so on purpose |
| Compliance | Purpose of remittance captured (family maintenance default); screening hold modelled as ON\_HOLD with an RFI the customer can act on; reason for a hit is never disclosed (tipping-off) | Shows real AML behaviour without inventing internals |
| State changes | Only `confirm_transfer` and `cancel_transfer` move money, both behind the same read-back-and-token gate; `set_rate_alert` writes alert state | The asymmetry is the headline safety claim |
| Step-up | Before money moves, `confirm_transfer` texts a 6-digit one-time code to the registered phone (simulated SMS) and charges the card only on a second call carrying it; 3 wrong tries void the confirmation. Cancels need no code (the refund goes to the same card) | Mirrors 3-D Secure on card payments; the code never appears in a tool result, so the model cannot approve a payment on its own |
| Demo path and judging | Our own web simulator is the demo. Amazon's Alexa+ CLI, MCP Toolkit and web simulator are not available to participants, hosting is not required, and judges run the repo locally without AWS credentials. So the simulator needs nothing but Node: scripted mode drives the real tools from the demo script with no language model; Amazon Bedrock (default) or any OpenAI-compatible model turns on free conversation | From the hackathon FAQ (Oct 4): a judge must see the whole flow on a clean clone with no account |
| Cross-session context | `get_pending` returns what is waiting since the last conversation (open quotes, transfers under review with their RFI, rate alerts that fired, the last transfer per recipient). The assistant calls it at the start of each conversation and resolves "send the usual to Mum" from it | Conversations aren't stored; the ledger is the memory, so context carries across sessions without keeping transcripts |
| Stack | TypeScript, Express, `@modelcontextprotocol/sdk`, SQLite (better-sqlite3); in the simulator Amazon Bedrock (Nova 2 Lite) or any OpenAI-compatible model, or scripted mode without one; Amazon Polly for the voice when AWS credentials exist; optional hosting on AWS App Runner us-east-1 | Lowest ops for a solo build; runs with no account; Bedrock and Polly satisfy AWS Builder |

Product name: Nuvio Remit, chosen Oct 19, 2026.

## Architecture

The MCP layer is a thin adapter; every rule about money lives in the core module, which has no idea MCP exists. That split is what lets the README say "swap `core/ledger` for the production API" and mean it.

&#91;embedded content: architecture · 5 layers, one external call\]

Requests flow top to bottom; the only outbound network call is the cached rate fetch, so every tool answers from local data well inside the 500 ms budget Alexa+ requires.

**A transfer, end to end ("Send 2,000 dirhams to Mum")**

1. Model calls `resolve_beneficiary("Mum")` → one match, `ben_01`, bank deposit, name verified.
2. Model calls `quote_transfer(2000, "AED", "ben_01", "bank_deposit", "family_maintenance")` → core reads the cached mid rate, applies the corridor FX margin, adds the flat fee, checks tier limits and velocity, writes a quote row (rate and fee locked 30 min), returns the guaranteed receive amount, ETA and `quote_id`.
3. Model reads the quote back. User: "Confirm."
4. Model calls `prepare_transfer(quote_id)` → core issues a single-use `confirmation_token` (5-min expiry) and returns the exact read-back sentence. Model says it again; this is the consent step.
5. User: "Yes." Model calls `confirm_transfer(token)` → the server texts a 6-digit code to the customer's phone and refuses `STEP_UP_REQUIRED`; nothing has moved. The user reads the code out, and the model calls `confirm_transfer(token, otp)` → core validates the token and the code, re-checks limits, charges the saved card (mock, instant), writes the transfer as `FUNDS_RECEIVED` then `SCREENING`, returns `transfer_ref`.
6. A background ticker moves it to `SENT_TO_PARTNER` after 15 s and `PAID_OUT` with a generated UTR after 30 s, so `track_transfer` changes during the video. One seeded past transfer sits in `RETURNED` and one in `ON_HOLD` with an RFI, so the model can explain those states too.

**Real vs simulated**

| Component | Real | Simulated |
| --- | --- | --- |
| MCP server, Streamable HTTP, spec 2025-11-25 | yes |  |
| Bearer auth, token lifecycle, limit enforcement | yes |  |
| The assistant: Amazon Bedrock or any OpenAI-compatible model | yes | scripted mode when none is configured (real tools, fixed script) |
| AWS App Runner deployment (optional) | yes |  |
| Mid-market exchange rates | yes, Frankfurter |  |
| Nuvio FX margin, fees, payout methods, KYC tier limits |  | yes |
| Card funding, ledger, screening, payout partner, UTRs |  | yes |
| SMS delivery of the step-up code (shown on a simulated phone) |  | yes |

## Tool contract

Twelve tools, one domain, two money-moving tools behind one gate. The `description` strings below are the product copy the model reads to pick a tool: ship them verbatim and tune only after watching the simulator mis-pick.

| # | Tool | Description (what the model reads) | Writes state |
| --- | --- | --- | --- |
| 1 | `get_rate` | Get today's exchange rate with the 7-day trend. For AED to INR it is Nuvio's rate for sending money to India; for any other pair of supported currencies it is the mid-market rate, for information only, because Nuvio sends money only from AED to INR. Use when the user asks about the rate, the rupee or another currency, or whether now is a good time to send. | no |
| 2 | `compare_options` | Compare what the recipient would receive for a send amount across Nuvio's payout methods (bank deposit, UPI, cash pickup), including fee and arrival time, and show Nuvio's rate against the mid-market rate and a typical bank rate. Use when the user asks which option is best or how much will be received. | no |
| 3 | `list_beneficiaries` | List the user's saved recipients: nickname, relationship, bank or UPI, payout method, and when they last received money. Use when the user asks who they can send to. | no |
| 4 | `resolve_beneficiary` | Find one saved recipient from a name or nickname such as "Mum", "my brother" or "Sunita". Call this before quoting whenever the user names a person. Returns one match, or candidates to ask the user to choose from. Never invents a recipient; new recipients are added in the Nuvio app. | no |
| 5 | `quote_transfer` | Price a transfer: fee, locked rate, guaranteed receive amount in rupees, arrival time, and any limit warnings or document requirements for the purpose. Does not move money. Returns a quote\_id with rate and fee held for 30 minutes. | quote row |
| 6 | `prepare_transfer` | Turn a quote into a confirmation request. Returns the exact sentence to read back to the user and a single-use confirmation\_token valid for 5 minutes. Does not move money. Call confirm\_transfer only after the user explicitly agrees to the read-back. | token row |
| 7 | `confirm_transfer` | Execute a prepared transfer in two calls, after the user agrees to the read-back. Called with the confirmation\_token alone, it texts a 6-digit one-time code to the user's registered phone and returns STEP\_UP\_REQUIRED; nothing is sent yet. Ask the user to read the code out, then call again with the same confirmation\_token and otp: that charges the saved debit card and submits the transfer. The code is never in a tool result, so never guess it. Fails if the token is unknown, expired or used, if the code is wrong or expired, or if limits changed since the quote. | **transfer, card charge** |
| 8 | `track_transfer` | Get the status of a transfer by reference or the most recent one: current stage, timeline, UTR once paid out, whether it can still be cancelled, and any action the user must take if it is under review. Use when the user asks where their money is or whether it was credited. | no |
| 9 | `cancel_transfer` | Cancel a transfer that has not yet been sent to the payout partner. Without a cancel\_token it returns a preview (refund amount, timing) and a single-use cancel\_token valid for 5 minutes; with the token it cancels and refunds send amount and fee to the card. Call with the token only after the user explicitly agrees to the preview. Fails once the transfer has been sent; recalls need the recipient's consent and are handled by support. | **transfer, refund** |
| 10 | `get_transfer_history` | List past transfers for the last N months or to one recipient, including cancelled, returned or refunded ones, with totals and how much of each limit has been used this month. | no |
| 11 | `check_limits` | Show the user's KYC tier, remaining per-transaction, daily and monthly limits, cash-pickup caps, the reset date, and explain any refusal code in plain words with how to resolve it. | no |
| 12 | `set_rate_alert` | Ask to be told when the AED to INR rate reaches a target. Use when the user says "tell me when" or "alert me if". | alert row |
| 13 | `get_help` | Answer general questions about sending money with Nuvio from the UAE to India, from Nuvio's reviewed help content: documents, how sending works, recipients, payout methods, fees and rates, limits and tiers, tracking and receipts, cancellations and refunds, NRE and NRO accounts, the Liberalised Remittance Scheme (LRS), tax on money received in India, and staying safe. Use it instead of general knowledge for any rule, document or tax question; for the user's own numbers use check_limits or track_transfer. | no |
| 14 | `get_pending` | Get what is waiting on the user since their last conversation: open quotes, transfers under review and what the user must do, rate alerts that fired recently, and the last transfer to each recipient. Call it once at the start of a conversation to mention anything that needs attention, and use last_by_recipient to resolve requests like "send the usual to Mum". | no |

**Inputs and outputs**

```json
// 1 get_rate (from, to: ISO 4217 codes, default AED and INR)
in:  { "from": "AED", "to": "INR" }   // each week range is named for its rate, and includes today's
out: { "corridor": "AE-IN", "pair": "AED/INR", "sendable": true, "customer_rate": 23.21, "mid_rate": 23.42,
       "fx_margin_pct": 0.9, "customer_week_high": 23.338, "customer_week_low": 22.8921,
       "mid_week_high": 23.55, "mid_week_low": 23.10, "trend": "rupee weakened 0.6% this week",
       "as_of": "2026-10-01T09:15:00Z", "source": "ECB via Frankfurter, cached" }
in:  { "from": "AED", "to": "PHP" }       // any other pair: mid-market, information only
out: { "pair": "AED/PHP", "sendable": false, "mid_rate": 15.63, "mid_week_high": 15.70, "mid_week_low": 15.52,
       "trend": "Philippine Peso weakened 0.4% against the UAE Dirham this week", "as_of": "2026-10-01T09:15:00Z",
       "source": "ECB via Frankfurter, cached; AED at the US dollar peg",
       "note": "Mid-market rate for information only. Nuvio sends money from AED to INR only." }
refused: CURRENCY_NOT_SUPPORTED { currency, supported[] } · RATE_UNAVAILABLE { pair }

// 2 compare_options
in:  { "send_amount": 2000, "send_currency": "AED" }
out: { "mid_rate": 23.42, "customer_rate": 23.21,
       "payout_methods": [
         { "method": "bank_deposit", "rail": "IMPS", "fee": 15, "receive_amount": 46070, "eta": "within minutes, 24x7" },
         { "method": "upi", "rail": "UPI", "fee": 15, "receive_amount": 46070, "eta": "within minutes, 24x7" },
         { "method": "cash_pickup", "rail": "MTSS partner", "fee": 20, "receive_amount": 45954, "eta": "within 2 hours",
           "caps": { "per_transaction_aed": 9180, "per_recipient_per_year": 30, "max_cash_inr": 50000 } } ],
       "benchmark": { "name": "typical bank", "rate": 22.83, "fee": 25, "receive_amount": 45090, "illustrative": true },
       "note": "Benchmark is illustrative: derived from the mid rate with a typical published FX margin." }

// 3 list_beneficiaries
in:  {}
out: { "recipients": [ { "id": "ben_01", "nickname": "Mum", "full_name": "Sunita Nair", "relationship": "mother",
         "payout_method": "bank_deposit", "bank": "HDFC Bank", "account_last4": "4421", "name_verified": true,
         "default_purpose": "family_maintenance", "last_sent": { "date": "2026-10-02", "send_amount": 2000, "currency": "AED" } } ] }

// 4 resolve_beneficiary
in:  { "query": "Mum" }
out: { "match": { "id": "ben_01", "nickname": "Mum", "full_name": "Sunita Nair", "payout_method": "bank_deposit" } }
  or { "ambiguous": true, "candidates": [ { "id": "ben_02", "nickname": "Rahul", "relationship": "brother" }, { "id": "ben_03", "nickname": "Rahul (college)", "relationship": "friend" } ] }
  or { "not_found": true, "hint": "Recipients are added and name-verified in the Nuvio app." }

// 5 quote_transfer
in:  { "send_amount": 2000, "send_currency": "AED", "beneficiary_id": "ben_01", "payout_method": "bank_deposit", "purpose": "family_maintenance" }
out: { "quote_id": "q_7f3a", "rate_locked_until": "...+30m", "fee": 15, "locked_rate": 23.21, "send_amount": 2000,
       "receive_amount": 46070, "receive_currency": "INR", "guaranteed": true, "eta": "within minutes",
       "funding": "debit card ending 8812",
       "warnings": [ { "code": "NEAR_MONTHLY_LIMIT", "remaining_after": 1500, "currency": "AED", "resets_on": "2026-11-01" } ] }
  or { "refused": { "code": "MONTHLY_LIMIT", "limit": 20000, "used": 18500, "requested": 3000, "currency": "AED", "resets_on": "2026-11-01",
       "resolution": "Send up to 1,500 dirhams now, or raise your limit by adding salary proof in the Nuvio app." } }
  or { "refused": { "code": "PURPOSE_REQUIRES_DOCUMENTS", "purpose": "property_purchase",
       "resolution": "Property payments need a sale agreement uploaded in the Nuvio app before sending." } }

// 6 prepare_transfer
in:  { "quote_id": "q_7f3a" }
out: { "confirmation_token": "ct_9b2e...", "expires_at": "...+5m",
       "read_back": "Send 2,000 dirhams to Mum, Sunita Nair at HDFC Bank ending 4421, for family maintenance. Fee 15 dirhams, rate 23.21, charged to your card ending 8812. She receives 46,070 rupees, guaranteed, within minutes. Shall I go ahead?" }

// 7 confirm_transfer: two calls (step-up, like 3-D Secure)
in:  { "confirmation_token": "ct_9b2e..." }
out: { "refused": { "code": "STEP_UP_REQUIRED", "method": "sms_otp", "sent_to": "phone ending 4471",
       "expires_at": "...+5m", "attempts_left": 3, "resolution": "Nothing has been sent yet. A 6-digit code was texted ..." } }
     // SMS to the registered phone: "Nuvio: 482913 is your code to send 2,000 dirhams to Mum. ..."
in:  { "confirmation_token": "ct_9b2e...", "otp": "482913" }
out: { "transfer_ref": "NUV-240133", "status": "SCREENING", "receive_amount": 46070, "eta": "within minutes",
       "receipt": "Receipt and FIRA will be available in the Nuvio app once paid out." }
  or { "refused": { "code": "OTP_INVALID" (attempts_left) | "OTP_EXPIRED" | "OTP_LOCKED" | "TOKEN_EXPIRED" | "TOKEN_USED"
       | "TOKEN_UNKNOWN" | "LIMIT_EXCEEDED" | "CARD_DECLINED", "resolution": "..." } }

// 8 track_transfer
in:  { "transfer_ref": "NUV-240133" }   or   { "latest": true }
out: { "transfer_ref": "NUV-240133", "status": "PAID_OUT", "recipient": "Mum", "utr": "HDFCR52026100112345678",
       "timeline": [ { "status": "FUNDS_RECEIVED", "at": "..." }, { "status": "SCREENING", "at": "..." },
                     { "status": "SENT_TO_PARTNER", "at": "..." }, { "status": "PAID_OUT", "at": "..." } ] }
  or { "status": "ON_HOLD", "customer_label": "Under review",
       "action_required": { "type": "RFI", "document": "updated Emirates ID", "how": "upload in the Nuvio app", "deadline": "2026-10-05" } }
  or { "status": "RETURNED", "reason": "recipient bank reported a name mismatch", "refund": { "amount": 475, "currency": "AED",
       "note": "refunded at the rate on the return date; fee not refunded", "eta": "2-7 working days" } }

// 9 get_transfer_history
in:  { "months": 3 }   or   { "beneficiary_id": "ben_01" }
out: { "transfers": [ ... ], "totals": { "count": 5, "send_amount": 18500, "currency": "AED", "returned": 1 },
       "limits_used": { "monthly": { "used": 18500, "limit": 20000, "resets_on": "2026-11-01" }, "daily": { "used": 2000, "limit": 10000 } } }

// 10 check_limits
in:  { "refusal_code": "MONTHLY_LIMIT" }   (optional)
out: { "kyc_tier": "Verified (Emirates ID)", "next_tier": "Verified Plus: add salary proof to raise monthly limit to 60,000 AED",
       "per_transaction": { "limit": 5000, "currency": "AED", "funding": "debit card" }, "daily": { "remaining": 8000 },
       "monthly": { "remaining": 1500, "resets_on": "2026-11-01" },
       "cash_pickup": { "per_transaction_aed": 9180, "per_recipient_per_year": 30 },
       "new_recipient_first_transfer": { "limit": 2000 },
       "explanation": "On your current tier you can send 20,000 dirhams a month. You have 1,500 left until 1 November. ..." }

// 9 cancel_transfer (preview, then execute)
in:  { "transfer_ref": "NUV-240120" }
out: { "cancel_token": "cx_41d7...", "expires_at": "...+5m", "status": "ON_HOLD", "cancellable": true,
       "preview": "Cancel the 5,000 dirham transfer to your NRE account. 5,000 dirhams, including the 15 dirham fee, go back to your card ending 8812 within 2 to 7 working days. Shall I cancel it?" }
in:  { "transfer_ref": "NUV-240120", "cancel_token": "cx_41d7..." }
out: { "transfer_ref": "NUV-240120", "status": "CANCELLED", "refund": { "amount": 5000, "currency": "AED", "to": "card ending 8812", "eta": "2-7 working days" },
       "limits_now": { "monthly": { "remaining": 6500 } } }
  or { "refused": { "code": "CANCEL_WINDOW_CLOSED", "status": "SENT_TO_PARTNER",
       "resolution": "This transfer has already been sent. A recall needs the recipient's consent; Nuvio support can request one from the app." } }
  or { "refused": { "code": "TOKEN_EXPIRED" | "TOKEN_USED" | "TOKEN_UNKNOWN", "resolution": "..." } }

// 12 set_rate_alert
in:  { "pair": "AED/INR", "target": 23.5, "direction": "above" }
out: { "alert_id": "al_02", "channel": "push and email", "message": "I'll let you know when a dirham buys more than 23.50 rupees." }

// 13 get_help (topic: overview | documents | how_to_send | recipients | payout_methods | fees_and_rates |
//    limits_and_tiers | tracking_and_receipts | cancellations_and_refunds | nre_nro | lrs | tax | safety)
in:  { "topic": "lrs" }
out: { "topic": "lrs", "title": "The Liberalised Remittance Scheme (LRS)",
       "answer": "The Liberalised Remittance Scheme covers money that residents of India send out of India, up to 250,000 US dollars a financial year. It does not apply to you sending money into India from the UAE, ...",
       "points": ["LRS: outward remittances by resident Indians, USD 250,000 per financial year", "..."],
       "source": "Reserve Bank of India, Liberalised Remittance Scheme", "last_reviewed": null,
       "disclaimer": "General information, not legal or tax advice. ...", "related": ["nre_nro", "tax"] }

// 14 get_pending: cross-session context from the ledger (conversations themselves are not kept)
in:  {}
out: { "open_quotes": [ { "quote_id": "q_7f3a", "recipient": "Mum", "beneficiary_id": "ben_01", "send_amount": 2000,
         "receive_amount": 51598.09, "status": "open", "rate_locked_until": "..." } ],
       "under_review": [ { "transfer_ref": "NUV-240120", "recipient": "My NRE account", "send_amount": 5000,
         "sent_on": "2026-10-01", "customer_label": "Under review", "cancellable": true,
         "action_required": { "type": "document", "document": "updated Emirates ID", "how": "upload in the Nuvio app", "deadline": "2026-10-08" } } ],
       "fired_alerts": [ { "alert_id": "al_01", "pair": "AED/INR", "target": 26.5, "direction": "above", "fired_at": "..." } ],
       "last_by_recipient": [ { "beneficiary_id": "ben_01", "recipient": "Mum", "full_name": "Sunita Nair", "transfer_ref": "NUV-240116",
         "send_amount": 2000, "payout_method": "bank_deposit", "purpose": "family_maintenance", "date": "2026-10-01", "customer_label": "Paid out" } ],
       "summary": "Your 5,000 dirham transfer to My NRE account is under review: upload updated Emirates ID in the Nuvio app by 8 October." }
```

Every refusal is structured (`code`, numbers, `resolution`) so the model can explain it well. No tool ever returns a bare string error.

## Core module interface

Six small services behind plain TypeScript interfaces; the MCP handlers only parse input, call one of these, and shape the output. Nothing in `core/` imports the MCP SDK, so every rule is unit-testable with no transport.

```
src/
  server/            MCP adapter: Express app, Streamable HTTP transport, Bearer check, tool registrations
    sim/             the simulator's relay to /mcp, chat loop (Bedrock or OpenAI-compatible), scripted mode, Polly
  core/
    rates.ts         RatesService
    beneficiaries.ts BeneficiaryService
    quotes.ts        QuoteService  (pricing + delivery options)
    limits.ts        LimitService
    ledger.ts        LedgerService (confirm, transfers, status ticker)
    alerts.ts        AlertService
    confirm.ts       ConfirmationGate (token issue/validate; mcp-confirm-gate is a separate implementation of the pattern)
    stepup.ts        StepUpService (one-time code by SMS before confirm; simulated phone)
    pending.ts       PendingService (get_pending: cross-session context from the ledger)
    help.ts          get_help answers, built from the policy values
  db/                schema.sql, migrations/, migrate.ts, seed.ts
  simulator/         static web client
tests/
```

```ts
type PayoutMethod = 'bank_deposit' | 'upi' | 'cash_pickup';
type Purpose = 'family_maintenance' | 'savings_own_account' | 'education' | 'medical' | 'loan_repayment' | 'gift' | 'property_purchase' | 'business';
type TransferStatus = 'CREATED' | 'FUNDS_RECEIVED' | 'SCREENING' | 'SENT_TO_PARTNER' | 'PAID_OUT' | 'ON_HOLD' | 'CANCELLED' | 'RETURNED';

interface RatesService {
  getMid(from: string, to: string): Promise<{ rate: number; asOf: string; source: 'live' | 'fallback' }>;
  getCustomerRate(from: string, to: string): Promise<{ rate: number; fxMarginPct: number }>;   // one board rate per corridor
  getWeekRange(from: string, to: string): Promise<{ high: number; low: number; changePct: number }>;
}
// Fetches USD->INR from Frankfurter (https://api.frankfurter.dev/v1; it has no AED) and derives AED/INR = USD/INR / 3.6725 (peg),
// caches 15 min in SQLite rates_cache,
// falls back to the seeded 7-day table on any error. FX margin per corridor lives in config.

interface BeneficiaryService {
  list(userId: string): Recipient[];
  resolve(userId: string, query: string): { match: Recipient } | { ambiguous: true; candidates: Recipient[] } | { notFound: true };
}
// resolve: lowercase, strip punctuation, match nickname, first name, full name, relationship words
// ("mum", "mother", "amma" -> relationship=mother; "my account", "savings" -> ben_04). Equal scores -> ambiguous.

interface QuoteService {
  compare(userId: string, sendAmount: number): CompareResult;                 // all payout methods + benchmark
  create(userId: string, input: QuoteInput): Quote | Refusal;                   // purpose rules, limits, lock rate+fee 30 min
  get(quoteId: string): Quote | undefined;
}
// Purpose rules: business -> refused (retail app); property_purchase -> refused PURPOSE_REQUIRES_DOCUMENTS;
// gift from a non-relative -> warning GIFT_TAXABLE_IN_INDIA; everything else passes.

interface LimitService {
  check(userId: string, recipient: Recipient, sendAmount: number, method: PayoutMethod): { ok: true; warnings: Warning[] } | Refusal;
  remaining(userId: string): LimitsSnapshot;
  explain(code: RefusalCode): string;
}
// Tier "Verified": per transaction 5,000 AED (card), daily 10,000, monthly 20,000, first transfer to a recipient
// added < 24 h ago 2,000, single transfer >= 15,000 -> SOURCE_OF_FUNDS_REQUIRED (would become an RFI).
// Cash pickup: per transaction 9,180 AED (~USD 2,500), 30 per recipient per year, receive amount <= 50,000 INR.
// On Verified, the 5,000 card cap (and the 10,000 daily cap) bind before source of funds and the
// 9,180 cash-pickup cap, so those two refuse only on a tier with higher caps; limits.test.ts
// checks them on such a test tier. The other two cash-pickup caps refuse on Verified.

interface ConfirmationGate {
  issue(quoteId: string, callerId: string): { token: string; expiresAt: string };
  consume(token: string, callerId: string): { quoteId: string } | Refusal;     // single use, 5-min TTL, caller-bound
  // The same gate issues cancel tokens: issue({ kind: 'cancel', ref }, callerId) -> cx_ token; consume checks kind matches.
  // callerId is the authenticated principal from the Bearer check (the OAuth subject + client in production):
  // the transport is stateless, so there is no MCP session id to bind to.
}

interface LedgerService {
  confirm(userId: string, quoteId: string): Transfer | Refusal;   // re-checks limits, charges mock card, writes FUNDS_RECEIVED -> SCREENING
  cancel(userId: string, ref: string): Transfer | Refusal;        // allowed in CREATED, FUNDS_RECEIVED, SCREENING, ON_HOLD; refunds the amount charged (send amount, fee included); frees limits
  cancellable(ref: string): boolean;                               // false from SENT_TO_PARTNER onward
  track(userId: string, ref?: string): TransferView | undefined;  // includes utr, action_required (RFI) or refund details
  history(userId: string, filter: { months?: number; beneficiaryId?: string }): HistoryResult;
  startTicker(): void;   // every 15 s: SCREENING -> SENT_TO_PARTNER -> PAID_OUT (+ generated UTR); ON_HOLD stays until a dev control releases it
}

interface AlertService {
  set(userId: string, pair: string, target: number, direction: 'above' | 'below'): Alert;
  evaluate(): Alert[];   // called by the ticker; the simulator polls /dev/alerts to "fire" one on screen
}
```

All monetary values are integers in minor units internally (fils, paise) and formatted at the edge. The `Refusal` type is shared: `{ refused: { code, ...numbers, resolution } }`.

## Data model and seed data

One SQLite file, ten tables after migrations, reset to the seed on every `npm run seed` so each demo take starts identical.

```sql
CREATE TABLE users        (id TEXT PRIMARY KEY, name TEXT, country TEXT, kyc_tier TEXT, card_last4 TEXT);
CREATE TABLE beneficiaries(id TEXT PRIMARY KEY, user_id TEXT, nickname TEXT, full_name TEXT, relationship TEXT,
                           payout_method TEXT, bank_name TEXT, ifsc TEXT, account_last4 TEXT, account_type TEXT,
                           upi_id TEXT, city TEXT, state TEXT, mobile_last4 TEXT, default_purpose TEXT,
                           name_verified INTEGER, added_at TEXT, aliases TEXT /* json array */);
CREATE TABLE rates_cache  (pair TEXT PRIMARY KEY, mid REAL, fetched_at TEXT, source TEXT);
CREATE TABLE rates_history(pair TEXT, day TEXT, mid REAL, PRIMARY KEY (pair, day));   -- seeded 7 days, fallback
CREATE TABLE quotes       (id TEXT PRIMARY KEY, user_id TEXT, beneficiary_id TEXT, send_amount_minor INTEGER, send_currency TEXT,
                           payout_method TEXT, purpose TEXT, locked_rate REAL, fee_minor INTEGER, receive_amount_minor INTEGER,
                           created_at TEXT, rate_locked_until TEXT, status TEXT /* open|prepared|consumed|expired */);
CREATE TABLE confirmations(token TEXT PRIMARY KEY, quote_id TEXT, session_id TEXT, created_at TEXT, expires_at TEXT, used_at TEXT);
CREATE TABLE transfers    (ref TEXT PRIMARY KEY, user_id TEXT, beneficiary_id TEXT, quote_id TEXT, send_amount_minor INTEGER,
                           send_currency TEXT, receive_amount_minor INTEGER, fee_minor INTEGER, rate REAL, payout_method TEXT,
                           purpose TEXT, status TEXT, utr TEXT, created_at TEXT, paid_out_at TEXT, eta TEXT,
                           hold_rfi_json TEXT, return_reason TEXT, refund_minor INTEGER);
CREATE TABLE transfer_events(ref TEXT, status TEXT, at TEXT);          -- the timeline track_transfer returns
CREATE TABLE alerts       (id TEXT PRIMARY KEY, user_id TEXT, pair TEXT, target REAL, direction TEXT, created_at TEXT, fired_at TEXT);
```

The block above is migration 1 (`src/db/schema.sql`). Later changes are numbered files in `src/db/migrations/`, tracked in `PRAGMA user_version`:

```sql
-- 0002_cancel_token_target.sql
-- Cancel tokens (cx_) record the transfer they cancel; confirmation tokens (ct_) keep using quote_id.
-- The token kind is its prefix. session_id holds the caller binding key (stateless transport, no MCP session id).
ALTER TABLE confirmations ADD COLUMN transfer_ref TEXT;
CREATE INDEX confirmations_quote ON confirmations (quote_id);
CREATE INDEX transfers_user_created ON transfers (user_id, created_at);
CREATE INDEX transfer_events_ref ON transfer_events (ref, at);

-- 0003_step_up.sql
-- One-time codes before money moves (salted SHA-256, bound to the ct_ token hash and caller),
-- and the simulated phone that receives them.
ALTER TABLE users ADD COLUMN phone_last4 TEXT;
CREATE TABLE step_up_challenges (id TEXT PRIMARY KEY, token TEXT NOT NULL, session_id TEXT NOT NULL,
  code_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, verified_at TEXT);
CREATE TABLE sms_outbox (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, to_last4 TEXT NOT NULL,
  body TEXT NOT NULL, created_at TEXT NOT NULL);
```

**Seed**

| Entity | Values |
| --- | --- |
| User | `usr_priya`, Priya Nair, Dubai (AE), tier Verified (Emirates ID), debit card \*\*\*\*8812, phone \*\*\*\*4471 |
| `ben_01` | Mum, Sunita Nair, mother, bank deposit, HDFC Bank, IFSC HDFC0001234, acct \*\*\*\*4421, savings, Chandigarh, Punjab, name verified, purpose family\_maintenance, aliases `["mum","mom","mother","amma","sunita"]` |
| `ben_02` | Rahul, Rahul Nair, brother, UPI `rahul.nair@okhdfc`, Pune, Maharashtra, name verified, purpose family\_maintenance, aliases `["rahul","brother","bhai"]` |
| `ben_03` | Rahul (college), Rahul Menon, friend, bank deposit, ICICI Bank, acct \*\*\*\*3302, Kochi, Kerala, name verified, purpose gift, aliases `["rahul menon","college rahul"]` |
| `ben_04` | My NRE account, Priya Nair, self, bank deposit, SBI, acct \*\*\*\*0917, NRE, Chandigarh, purpose savings\_own\_account, aliases `["my account","nre","savings","myself"]` |
| Transfers, past | 7 months: 2,000 AED to Mum on the 2nd of each month, PAID\_OUT with UTRs. 1,500 AED to brother in Jul and Sep by UPI. 500 AED to friend in Aug: RETURNED (name mismatch), refund 475 AED (485 converted, about 10 lost to the rate on the return date), fee kept |
| Transfers, this month | Dated back from the day the seed runs, so the hold stays recent: Mum 2,000 (13 days ago, PAID\_OUT), brother 1,500 (10 days ago, PAID\_OUT), NRE account 5,000 (9 days ago, PAID\_OUT), 3,000 (7 days ago, PAID\_OUT) and 5,000 (5 days ago, ON\_HOLD, RFI: updated Emirates ID, due 7 days after the hold, so always ahead). Never before the 1st or on today; early in the month several share a day, within the daily cap. On the 15th these are the 2nd, 5th, 6th, 8th and 10th. Every seeded transfer fits today's limits (5,000 per card transfer, 10,000 a day). Monthly used 16,500 of 20,000, so one more 2,000 passes and the next 3,000 refuses on camera |
| Rates history | 7 days each for AED/INR, USD/INR, GBP/INR, pulled once from Frankfurter when writing the seed script and hard-coded; AED/INR derived from USD/INR at the 3.6725 peg |
| Limits config | Tier Verified: per transaction 5,000 AED, daily 10,000, monthly 20,000, new-recipient first transfer 2,000, source-of-funds threshold 15,000. Cash pickup 9,180 AED per transaction, 30 per recipient per year, 50,000 INR cash cap. Next tier Verified Plus (salary proof): monthly 60,000. On Verified, the 5,000 card cap binds first, so the source-of-funds threshold and the 9,180 cash-pickup cap apply on tiers with higher caps |
| FX margin | AED/INR 0.9%; USD/INR 0.8%; GBP/INR 1.0%; one board rate, no per-method rate difference |
| Fees | bank deposit 15 AED, UPI 15 AED, cash pickup 20 AED; flat per transfer, taken out of the send amount (the card is charged the send amount; receive = (send − fee) × rate) |
| Purpose rules | business refused; property\_purchase needs documents; gift to non-relative warns about Indian gift tax; others pass |

The two Rahuls exist on purpose: "send money to Rahul" triggers the disambiguation turn. The ON\_HOLD transfer to the NRE account gives the model a real RFI to explain, and the RETURNED one lets it explain a bounce, the FX loss on refund, and the kept fee.

## Transfer lifecycle and glossary

Five stages on the main path and three exits; the demo advances the main path on a timer, the user can reach Cancelled by voice before the transfer is sent, and the other two exits exist in seed data so the model can explain them.

&#91;embedded content: transfer lifecycle · 5 stages, 3 exits\]

Most transfers reach paid out in minutes; the slow tail comes from screening holds and funding delays, not the payout rail. On a hold the customer sees "Under review" and, only if something is needed from them, an RFI such as an updated Emirates ID or salary proof. The reason for a screening hit is never disclosed.

**Glossary used in tool outputs and the simulator**

| Term | Meaning | Where it appears |
| --- | --- | --- |
| Corridor | A send country and receive country pair, here UAE–India (AE-IN) | `get_rate` |
| Send amount / receive amount | What the sender pays in AED / what the recipient gets in INR | every pricing tool |
| FX margin | The difference between the mid-market rate and the customer rate; the provider's main revenue | `get_rate`, `compare_options` |
| Rate lock / guaranteed rate | Rate and fee held for a window so the receive amount is fixed | `quote_transfer` |
| Payout method | How the recipient gets the money: bank deposit (IMPS), UPI, cash pickup | `compare_options`, `quote_transfer` |
| Payout partner | The Indian bank or MTSS agent that credits the recipient | lifecycle, `track_transfer` |
| UTR | Unique Transaction Reference from the Indian banking system; what the recipient's bank asks for | `track_transfer` |
| FIRA | Foreign Inward Remittance Advice, the receipt used for tax and bank purposes in India | `confirm_transfer` receipt line |
| Purpose of remittance | Declared reason, mapped to CBUAE and RBI purpose codes behind the scenes | `quote_transfer` |
| Source of funds | Evidence of where large send amounts came from, requested above a threshold | `check_limits`, RFI |
| RFI | Request for information during a compliance hold | `track_transfer` |
| Returned / bounced | Payout failed at the recipient bank; money refunded to the sender, often with FX loss and fee kept | `track_transfer`, history |
| Recall | Asking for money back after it has landed; needs recipient consent, out of scope | README only |
| MTSS | India's Money Transfer Service Scheme governing cash pickup caps | `compare_options` caps |
| KYC tier | Verification level that sets the user's limits | `check_limits` |

Consumer-facing words win in anything the model speaks: recipient not beneficiary, sender not remitter, "under review" not "on hold".

## Quote and token lifecycle, and the tests to write

A transfer needs four calls in order (quote, prepare, confirm, confirm with the code), and each step can only be used once; the tests below are the evidence judges look for in the repo.

**Rules**

1. `quote_transfer` writes a quote with status `open`, rate and fee locked for 30 min, and the guaranteed receive amount. A quote is priced once; `confirm` never re-fetches the rate.
Tokens are bound to the authenticated caller (the principal from the Bearer check; the OAuth subject and client in production), never to an MCP session: the transport is stateless and has no session id. The `session_id` columns hold that caller key.

2. `prepare_transfer` requires an `open`, unexpired quote. It moves the quote to `prepared`, issues one random 32-byte token (base64url) bound to the quote and the authenticated caller (stateless transport, so no MCP session id), expiry now + 5 min. Calling prepare again on the same quote invalidates the previous token.
3. `confirm_transfer` requires a token that exists, is unused, unexpired, and was issued to the same authenticated caller. It re-runs the limit check, then in one SQLite transaction: marks the token used, marks the quote `consumed`, records the mock card charge, inserts the transfer as `FUNDS_RECEIVED` and immediately `SCREENING`, and writes both timeline events.
3a. Step-up. `confirm_transfer` with a valid token and no `otp` changes nothing in the ledger: it texts a 6-digit code to the user's registered phone, naming the amount and recipient, and refuses `STEP_UP_REQUIRED` with `sent_to`, `expires_at` and `attempts_left`. The code is stored as a salted SHA-256 hash bound to the token's hash and the caller, lasts 5 minutes and never outlives the token, and is never logged or returned by any tool. Only a second call with the same token and the right `otp` runs rule 3. The server reads `otp` as the user said it: digits or words, with spaces or punctuation ("four eight two nine one three."). Anything that isn't six digits refuses `OTP_INVALID` without using a try, never a schema error. A wrong code refuses `OTP_INVALID` with `attempts_left`; the third voids the token (`OTP_LOCKED`); an expired code refuses `OTP_EXPIRED`; at most 3 codes are sent per token. The simulator masks the code in the protocol panel to its first two digits.
4. The ticker advances `SCREENING` → `SENT_TO_PARTNER` → `PAID_OUT` and generates a UTR on payout. `ON_HOLD`, `RETURNED` and `CANCELLED` are set as follows: CANCELLED only by cancel\_transfer, and only while the transfer is in CREATED, FUNDS\_RECEIVED, SCREENING or ON\_HOLD, refunding the amount charged (the send amount, which includes the fee) to the card and releasing the amount from the monthly and daily counters; ON\_HOLD and RETURNED only by seed data or a dev control. No tool recalls.
5. Any rejected confirm is logged with the reason and the token prefix, never the full token.
6. A transfer in `ON_HOLD` reports `customer_label: "Under review"` and the RFI if one exists; it never reports a screening reason.

**Tests (Vitest), one file per service plus one protocol file**

| File | Cases |
| --- | --- |
| `confirm.test.ts` | unknown token refused · expired token refused · reused token refused · token from another caller refused · second prepare invalidates first token · happy path consumes exactly once |
| `stepup.test.ts` | first call texts a code naming amount and recipient and moves no money · the code is in no tool result · the right code (spaced, as spoken) confirms once, a replay is refused · wrong codes count down and the third voids the token · a new code replaces the old, capped at the token's expiry · at most 3 codes per token · expired code refused · code before any was sent, another caller's token, another payment's code refused · the code is never logged or stored in the clear |
| `limits.test.ts` | per-transaction cap · daily cap across two quotes · monthly cap at exactly the limit with reset date in the refusal · new-recipient first-transfer cap · source-of-funds threshold · cash pickup per-transaction, per-year count and 50,000 INR caps · NEAR\_MONTHLY\_LIMIT warning below 25% remaining · explanation text per code |
| `quotes.test.ts` | locked rate equals rate at quote time even after cache refresh · fee by payout method · receive\_amount = (send\_amount − fee) × rate, rounded down to the paisa · expired quote cannot be prepared · business purpose refused · property purpose refused with document resolution · gift to non-relative warns |
| `beneficiaries.test.ts` | "Mum", "mother", "amma" resolve to ben\_01 · "my account" resolves to ben\_04 · "Rahul" is ambiguous with two candidates · unknown name returns not\_found with the app hint · never creates a record |
| `ledger.test.ts` | confirm charges the card exactly once under two concurrent confirms (second refused) · ticker advances SCREENING → SENT\_TO\_PARTNER → PAID\_OUT and sets a UTR · ON\_HOLD is not advanced by the ticker · cancel in SCREENING or ON\_HOLD refunds the amount charged (fee included) and lowers monthly used · cancel after SENT\_TO\_PARTNER refused CANCEL\_WINDOW\_CLOSED · cancel preview then execute consumes one cx\_ token, reuse refused · track returns RFI for ON\_HOLD and refund details for RETURNED · history totals and limits\_used match seeded rows |
| `rates.test.ts` | live fetch populates cache · second call within 15 min does not hit the network (mocked fetch) · network failure falls back to seeded history with source=fallback |
| `help.test.ts` | every topic has a spoken answer under 75 words, points, a source and a review date · numbers come from the enforced policy and follow the tier · LRS is said not to apply to inward remittances · NRE/NRO, LRS and tax carry the general-information disclaimer · recipients are never added by voice |
| `pending.test.ts` | under-review transfer with its RFI and a plain-words summary · last transfer per recipient skips cancelled and returned · open quotes until used or expired · alerts fired in the last 7 days · "nothing needs your attention" · major units on the wire |
| `scripted.test.ts` | every demo beat end to end over `POST /mcp` with no model, including the step-up code · free text outside the script gets a notice · a code read as words · "send the usual to Mum" from `get_pending` · the mode decision |
| `openai.test.ts` | Converse ⇄ chat-completions translation · the tool loop through `/mcp` on an OpenAI-compatible endpoint · provider errors never leak the key |
| `skill.test.ts` | `skills/nuvio-remit/SKILL.md` follows the Agent Skills format · the safe flow stays in order · every tool is referenced |
| `protocol.test.ts` | `initialize` negotiates `2025-11-25` · `tools/list` returns 14 tools with JSON schemas · `tools/call` on each tool returns structured content · missing Bearer returns 401 · legacy GET /sse is not served |

Run `npm test` in CI (GitHub Actions on every push) so the green badge is in the README on submission day.

## Simulated Alexa+ client

The simulator stands in for Alexa+ and is the official demo path: Amazon's Alexa+ CLI, MCP Toolkit and web simulator are not available to hackathon participants (and Alexa+ isn't available in India). Its server-side relay talks to the MCP server over the same HTTP endpoint Alexa+ would, so nothing in the MCP server is simulator-specific; the browser never holds the Bearer secret.

**Modes.** `SIM_MODE=scripted|bedrock`, decided at startup and logged. Unset, it is `bedrock` (the live model through `LLM_PROVIDER`) when a model is usable (AWS credentials resolve, or `LLM_API_KEY` is set) and `scripted` otherwise. Scripted mode follows the demo beats (plus the suggestion chips, the receipt's Cancel button, a code read as digits or words, and "the usual") and drives the real tools through the same relay, so every step is still a genuine `POST /mcp` round trip; free text outside the script gets a notice that no model is configured. `LLM_PROVIDER=bedrock|openai_compatible` (with `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`) picks the live model; an adapter translates Converse to `/chat/completions`, so the loop, the consent guard and the relay are the same either way.

**How it works**

1. On load, the page calls `GET /sim/tools`. The relay, which holds the Bearer secret, calls the server's own `POST /mcp` with `initialize` then `tools/list` and returns the 14 tool schemas, the negotiated `protocolVersion` and the raw JSON-RPC exchange for the protocol panel.
2. The user speaks (Web Speech API, `webkitSpeechRecognition`) or types. The transcript is appended to a message history.
3. The page sends the new turn to `POST /sim/chat`. The relay keeps the conversation server-side (tool calls included, in memory, 30-minute expiry) and forwards it with the tool schemas to the live model: Amazon Bedrock (Nova 2 Lite, or Claude on Bedrock) via the Converse API with tool use, or an OpenAI-compatible endpoint. In scripted mode, the scripted engine answers instead, with no model. Keeping the model behind the server avoids shipping keys to the browser; Bedrock is the documented AWS Builder integration.
4. When the model returns a tool call, the relay executes it against its own `/mcp` endpoint (a real JSON-RPC round trip, not an in-process shortcut), feeds the result back, and loops until the model returns text. It returns the reply together with each JSON-RPC request and response and its latency in ms; tokens are shown by prefix only.
5. The reply is rendered as a chat bubble and spoken. With AWS credentials it uses Amazon Polly (`POST /sim/speak`: neural voice Kajal, Indian English, with word timings that drive the read-back highlight), cached per line and capped per day by `SIM_DAILY_TTS_CHARS`; without them, or if Polly fails, the browser's `speechSynthesis`.

**The system prompt given to the model** is the one place you emulate Alexa+ behaviour: call `get_pending` at the start of a conversation and mention anything pending in one sentence, be brief, speak amounts in words, always read back a prepared transfer and wait for an explicit yes before calling `confirm_transfer`, then ask the user to read the texted code and never guess it, ask the user to choose when a recipient is ambiguous, resolve "the usual" from `get_pending`, say "recipient" and "receive amount" rather than "beneficiary" or "payout", never speculate about why a transfer is under review, answer rules, documents and tax only from `get_help`, and explain refusals using the `resolution` text.

**On screen**

| Element | Purpose |
| --- | --- |
| Conversation column | Chat bubbles with a mic button; the Alexa-style blue light bar while listening (no Amazon logos or wordmarks) |
| Protocol panel (collapsible, right) | Live JSON-RPC: each request and response, the negotiated `protocolVersion`, latency per call in ms |
| Ledger strip (top) | Balance, open quote, latest transfer status; updates live so the ticker is visible |
| Phone (text messages) | The customer's simulated phone: step-up codes arrive as an SMS toast, which the user reads out |
| Demo player | Play demo shows the demo beats one at a time (from `/sim/tools`, the same list scripted mode follows); Play all runs them in a row, each after the last reply is spoken |
| Mode banner | In scripted mode, says no language model is configured and how to add one; flashes when a line falls outside the script |
| Banner | "Simulated ledger: no real funds move. Mid-market rates are live; Nuvio pricing is simulated." always visible |
| Dev controls (hidden behind `?dev=1`) | Fire alert, advance ticker, release the held transfer, reset seed: used only while recording |

Serve the simulator as static files from the same Express app at `/`, so `pnpm dev` (or one App Runner service, if hosted) serves both.

**Access.** Locally and on a public URL alike, `/sim/*` requires `SIM_ACCESS_CODE` (a local `.env` sets it; for a hosted copy it goes to judges in the Devpost text) and is rate-limited per IP, with caps on tool rounds and tokens per turn and a daily ceiling on Bedrock calls. `/dev/*` is off unless `DEV_CONTROLS_CODE` is set. The page sends the code in a header. Because the ledger is SQLite on the instance, App Runner runs exactly one instance (min 1, max 1), and every deploy starts from the seed.

## MCP Apps view

MCP Apps (the official MCP extension `io.modelcontextprotocol/ui`, stable spec 2026-01-26) lets a tool name an interactive HTML view that the host renders in a sandboxed iframe next to the conversation. It is one of the Alexa+ track's linked resources, with Agent Skills. Nuvio Remit ships one view, `ui://nuvio-remit/transfer`: a screen for the transfer the assistant is talking through, with one job the voice channel does badly, which is taking the step-up code.

**Resource.** `ui://nuvio-remit/transfer`, mimeType `text/html;profile=mcp-app`, one self-contained HTML document (script and styles inline) built from `src/ui/transfer/` with the official SDK's `App` class (`@modelcontextprotocol/ext-apps` 1.x). `_meta.ui`: an empty `csp` (the view makes no network requests; it talks only to its host over `postMessage`), no extra permissions, `prefersBorder: true`. It follows the host's theme and style variables when the host sends them.

**Linked tools.** `quote_transfer`, `prepare_transfer`, `confirm_transfer` and `track_transfer` carry `_meta.ui.resourceUri: "ui://nuvio-remit/transfer"`, with the default visibility (model and app). Their descriptions, input schemas and results do not change, and a host without MCP Apps ignores `_meta`, so every other client sees the same 14 tools. The transport is stateless, so `tools/list` never sees the client's capabilities; the server always declares the link.

| Tool result the view receives | The view shows | What the view can do |
| --- | --- | --- |
| `quote_transfer` | Quote: send amount, fee, our rate, the guaranteed receive amount, the rate-lock countdown, warnings | Nothing; quoting is the assistant's job |
| `prepare_transfer` | The read-back: recipient, bank, purpose, card charged, receive amount, and the token's 5-minute countdown | **Confirm** and **Not now** send "Yes." or "No." into the conversation (`ui/message`), so consent stays with the assistant and the consent guard |
| `confirm_transfer` refused `STEP_UP_REQUIRED` | Code entry: six digit boxes, the phone it went to, tries left, the code's countdown | Sends the code with `tools/call` `confirm_transfer {confirmation_token, otp}` straight through the host. **The code never passes through the model.** `OTP_INVALID` keeps the boxes open with the tries left |
| `confirm_transfer` success, or `track_transfer` | Live receipt: reference, receive amount, ETA and the status steps | Polls `track_transfer` through the host every few seconds until a final status (10 minutes at most). Under review shows `customer_label` "Under review" and the RFI, never a reason |
| Any refusal | The refusal's `resolution` and its numbers | Nothing |

After a confirm from the view, the view tells the assistant with `ui/update-model-context` (reference and status, never the code), so the next turn knows the money has gone.

**Security.** The view receives the tool result as the model does, so it holds the confirmation token; without the code from the phone the token cannot move money. The rules a host must keep, and the simulator does:

* Render the view in an iframe sandboxed with `allow-scripts` only (an opaque origin), under a CSP built from `_meta.ui.csp`; with ours empty, the view can make no requests.
* Let the view call only tools whose visibility includes "app". The simulator is stricter: only tools linked to the same view.
* Never give the view the Bearer secret. In the simulator, view calls go through the relay like the model's, are rate-limited, and appear in the protocol panel marked "app view", with the code masked.

**The simulator as a host.** The simulator page is an MCP Apps host, so the view runs with nothing but Node:

1. It reads each tool's `_meta.ui.resourceUri` from `tools/list`, and its relay announces the extension in `initialize` (`capabilities.extensions["io.modelcontextprotocol/ui"]`).
2. When a linked tool runs, the page asks `POST /sim/app-view`. The relay fetches the view with `resources/read` (a real MCP call, shown in the protocol panel) and the server returns a single-use frame URL (60 seconds) that serves that HTML under the CSP built from the resource's `_meta.ui`.
3. The page connects to the view with the SDK's `AppBridge` over `postMessage` and sends it `tool-input` and `tool-result` for each linked call. One view follows one transfer and updates in place; a new transfer gets a new view.
4. View tool calls go to `POST /sim/app-tool` and context updates to `POST /sim/app-context`. The live model sees the context in its next turn; scripted mode clears the confirmation it was waiting on.
5. When the view can't load, the page falls back to its own cards.

Any other MCP Apps host renders the same view from the same server, for example MCPJam or VS Code; the README shows how.

**Tests.**

* `resources/list` and `resources/read` return the view with mimeType `text/html;profile=mcp-app`, and the HTML loads nothing from outside.
* `tools/list` links exactly the four tools; descriptions and schemas are unchanged.
* `/sim/app-tool` refuses tools not linked to the view and takes a code entered in the view through to a confirmed transfer, with the code masked in the panel.
* `/sim/app-context` reaches the next turn.
* The frame URL works once, expires, and carries the view's CSP.

## Hackathon step-by-step plan

Submit by Oct 22, 2026; the Devpost deadline is Oct 23, 2026 at 12:00 PDT (00:30 IST on Oct 24). Judging runs Nov 9–20, 2026 (12:00 PT to 12:00 PT), and the project must stay available to judges, free and unrestricted, until it ends; winners are announced on or around Dec 3, 2026. Per the FAQ, judges clone the repo and run it locally, without AWS credentials, so "available" means a public repo whose `README` run steps work on a clean clone; hosting is optional.

&#91;embedded content: build plan · 6 phases, submit Oct 22\]

Each phase ends with a checkable milestone; if a phase slips, cut from phase 4 first, never from phase 5.

**Phase 0 · Oct 1–2 · Setup, zero code**

- [ ] Register on Devpost and join the hackathon; create an Amazon developer account
- [ ] Request the $150 AWS credits via the hackathon form; enable Bedrock model access in us-east-1
- [ ] Create the GitHub repo (public, MIT license), add `FRICTION_LOG.md` and `FEEDBACK.md`, log from the first command
- [ ] Install Node 22, pnpm, Alexa AI CLI; run `alexa-ai configure` and note what happens from India

* Milestone: repo exists, first friction entry written
* Status: done, except the Alexa AI CLI, which participants can't get (FAQ)

**Phase 1 · Oct 3–6 · Protocol skeleton**

- [ ] Express app, `StreamableHTTPServerTransport` stateless mode on `POST /mcp`, Bearer middleware, `GET /health`
- [ ] One trivial tool (`get_rate` returning a constant); verify with MCP Inspector: initialize → tools/list → tools/call
- [ ] SQLite schema + migrate + seed scripts; Vitest + GitHub Actions workflow
- [ ] `protocol.test.ts` green

* Milestone: `curl` initialize negotiates `2025-11-25`; CI badge green
* Status: done (PR #1)

**Phase 2 · Oct 7–11 · Core and 11 tools**

- [ ] `rates.ts` with Frankfurter fetch, cache, fallback; `beneficiaries.ts` resolve
- [ ] `limits.ts`, `quotes.ts` (compare + create), `confirm.ts` gate, `ledger.ts` with ticker, `alerts.ts`
- [ ] Register all 11 tools with JSON schemas and the descriptions from the contract
- [ ] All six service test files green

* Milestone: full send flow works through MCP Inspector with the refusal path visible
* Status: done (PR #2)

**Phase 3 · Oct 12–15 · Deploy and simulator**

- [ ] Dockerfile; deploy to App Runner us-east-1; measure p95 latency per tool from a US region (<500 ms)
- [ ] Simulator page: tools/list on load, mic + TTS, chat loop via `/sim/chat` → Bedrock Converse tool use
- [ ] Protocol panel, ledger strip, disclaimer banner, `?dev=1` controls
- [ ] Tune tool descriptions and the Bedrock system prompt until the six demo beats run clean three times in a row

* Milestone: public URL runs the whole demo script
* Status: done (PR #3), except the public deploy: the Dockerfile, CloudFormation template and OIDC deploy workflow are ready, but hosting turned out to be optional (FAQ), so the stack was not created and Phase 4's local milestone replaced this one

**Phase 4 · Oct 4–5 · Polish: runs with nothing but Node**

The planned Alexa+ CLI attempt was dropped: the FAQ says participants can't get Amazon's Alexa+ CLI, MCP Toolkit or web simulator.

- [x] Scripted mode (`SIM_MODE`): the demo runs through the real tools with no language model and no AWS account
- [x] Pluggable live model (`LLM_PROVIDER=bedrock|openai_compatible`)
- [x] Cross-session context: `get_pending` (tool 14), with the prompt opening each conversation from it
- [x] Agent Skill `skills/nuvio-remit/SKILL.md`; README run-locally section and threat model; `FEEDBACK.md` filled
- [x] `mcp-confirm-gate` package for the Open Source mini challenge, published to npm as 0.1.0 on Oct 3, 2026 by the owner

* Milestone: on a clean clone with a `.env` of only `MCP_BEARER_TOKEN` and `SIM_ACCESS_CODE` and no AWS credentials, `pnpm install && pnpm db:seed && pnpm dev` starts, the simulator opens, and Play demo runs every beat end to end through real `POST /mcp` calls
* Status: done (PR #4)

**Phase 4b · Oct 3–8 · MCP Apps view**

- [x] `ui://nuvio-remit/transfer` resource and the `_meta.ui` link on the four transfer tools (see "MCP Apps view")
- [x] The view: quote, read-back with countdown, code entry, live receipt, built with the official `App` class into one HTML file
- [x] The simulator as an MCP Apps host: `resources/read` through the relay, sandboxed frame, `AppBridge`, `/sim/app-tool` and `/sim/app-context`
- [x] README: the view, and how to open it in another MCP Apps host

* Milestone: in the simulator, with nothing but Node, sending money shows `ui://nuvio-remit/transfer` moving from quote to read-back with countdown to code entry to live receipt; a code typed in the view reaches the server through the host's `tools/call`, never through the model; `pnpm test`, `pnpm lint` and `pnpm typecheck` are green
* Status: done. CI covers the view's state logic, the resource, the tool links and the simulator's host routes, and a Playwright test in Chrome (`e2e/`) runs Play all and the code typed into the view through to Paid out. The browser flow was also checked by hand in the official reference host: read-back, Confirm, code entry with a wrong code then the right one, the live receipt reaching Paid out, and the assistant told

**Phase 5 · Oct 19–21 · Video and write-ups**

- [ ] Record the 2:45 video (script in the submission checklist); upload to YouTube, public, English
- [ ] README: what it does, architecture, real-vs-simulated table, run steps that need no AWS account, test badge, threat model
- [ ] `FEEDBACK.md` per tool used (MCP SDK, Bedrock, App Runner and CloudFormation, AWS CLI, Frankfurter, Devpost, Polly); feature requests with severity; friction log finalised

* Milestone: a stranger can clone, seed, run tests and play the whole demo in 10 minutes, with no AWS account

**Oct 22 · Submit**

- [ ] Fill every Devpost field; select Alexa+ track plus AWS Builder and Open Source mini challenges (a project can win at most one mini challenge)
- [ ] Repo is public, so no reviewer invites needed; double-check the license file is at the root and visible at the top (README license badge)
- [ ] Keep Oct 23 free for fixes only
- [ ] Keep the repo public and its run steps working through Nov 20, 2026 (end of judging). If a hosted copy is also offered, keep the App Runner service, its access code and the Bedrock model available that long. Check the model's end-of-life date covers it: Nova 2 Lite no sooner than Dec 2, 2026; Claude Haiku 4.5 could retire before judging, so a Claude fallback should be Sonnet 5.5

## Submission checklist

Everything Devpost asks for, mapped to where it lives in the repo, plus the video script.

| Devpost field | What we submit | Lives in |
| --- | --- | --- |
| Text description | What it does, how it works, the four safety properties (read-back, single-use token, server-side limits, step-up code), cross-session context, what is simulated, and that it runs locally with no AWS account | `README.md` top section |
| GitHub repo | Public, MIT license at root, run steps that need nothing but Node, test badge, Agent Skill | repo root |
| Demo video | Under 3 min, YouTube public, English, no third-party music or logos | link in README |
| Product feedback | One entry per tool: MCP TypeScript SDK, Bedrock Converse, App Runner and CloudFormation, AWS CLI, Frankfurter, Devpost, Polly; what it was used for, what worked, what did not, onboarding feel, would use again | `FEEDBACK.md` |
| Tracks | Alexa+ primary (simulator as the demo path, Agent Skill); AWS Builder (Bedrock and Polly in the simulator, App Runner infrastructure as code); Open Source (`mcp-confirm-gate` package) | form |
| Pre-existing project | Not applicable: everything built in the window; say so | form |
| Feature requests (optional) | Step-up auth before consequential tools (critical); India availability for add-on testing (important); a sandbox for participants to test Alexa+ add-ons (important); per-tool latency metrics in the developer console (nice-to-have) | `FEEDBACK.md` |
| Friction log (optional, up to +10%) | Dated entries: task, steps, expected vs actual, severity, workaround, suggestion | `FRICTION_LOG.md` |

**Video script, 2:45**

Built around the step-up moment, the strongest 15 seconds we have: the assistant texts a code, the simulated phone shows it, the user reads it back, and only then does money move.

| Time | Beat | On screen |
| --- | --- | --- |
| 0:00–0:12 | "Voice is the weakest way to approve a payment. Nuvio Remit is an Alexa+ add-on, a self-hosted MCP server, that makes it safe enough to send money home from the UAE to India." | The simulator, with the banner "Simulated ledger: no real funds move" in view |
| 0:12–0:22 | "Hi, anything I should know?" → "Welcome back. Your 5,000 dirham transfer to your NRE account is under review: upload an updated Emirates ID by" a date two days ahead. Context from the ledger, across sessions | Protocol panel shows `get_pending` |
| 0:22–0:30 | "What's the rupee at today?" → Nuvio's rate and the weekly trend | Rate card; protocol panel shows `get_rate` |
| 0:30–1:14 | **The send.** "Send 2,000 dirhams to Mum." → the read-back with recipient, bank, purpose, fee, card and guaranteed rupees, then "Shall I go ahead?" → "Yes." → "I've texted a code to your phone ending 4471." → the simulated phone shows the SMS (code, amount, recipient) → the user reads "four eight two nine one three" → confirmed, the orb gathers into a check mark, the receipt appears. Voice-over: "The code never reaches the model. Only someone holding the phone can approve, and the code works for this one payment." | Read-back card with its 5-minute countdown, then the "Check your phone" card and the phone toast; protocol panel: `prepare_transfer` (token masked), `confirm_transfer` "code texted · nothing sent yet", `confirm_transfer` with the masked code "moves money"; ledger strip updates |
| 1:14–1:24 | "Send her another three thousand." → refused: monthly limit, 1,500 left until 1 November, add salary proof to raise it | Refusal card and JSON in the panel: the server enforced it, not the model |
| 1:24–1:32 | "Send 500 to Rahul." → "Do you mean your brother Rahul Nair, or your friend Rahul Menon?" | Choose card from `resolve_beneficiary` |
| 1:32–1:48 | "Where's Mum's money?" → paid out, with the bank reference (UTR). "And the one to my NRE account?" → under review, upload an updated Emirates ID in the app, and no reason given | Receipt steps reach Paid out (dev control "Advance ticker" before the take); status card with the action needed |
| 1:48–2:04 | "Cancel the one to my NRE account." → the preview: 5,000 dirhams back to the card → "Yes." → cancelled, 6,500 of the monthly limit free again | Cancel card, then the cancelled card; `cancel_transfer` twice in the panel; ledger strip updates |
| 2:04–2:12 | "Does the LRS limit apply to me?" → no, it covers money sent out of India, from Nuvio's own help content, not the model's memory | Help card from `get_help`, with its source and disclaimer |
| 2:12–2:20 | "Tell me when the dirham hits 26.5." → alert set, then fired | Alert card, then the toast (dev control "Fire rate alert") |
| 2:20–2:38 | How it's built: 14 MCP tools over Streamable HTTP, the step-up and token tests passing, the conversation evals, CI green, runs with nothing but Node (scripted mode), Bedrock (Nova 2 Lite) or any OpenAI-compatible model for the live assistant, Polly for the voice, and the Agent Skill | Editor, terminal and the README's threat model |
| 2:38–2:45 | "The ledger module is the only thing between this and a licensed exchange house's backend." | README real-vs-simulated table |

Record each beat separately against a local run (`pnpm dev`) and stitch them; scripted mode follows exactly these lines, and a live model makes the same tool calls. Reset the demo data before each take (`pnpm db:seed`, or the dev control). If you record a hosted copy instead, never record during a deploy (the SQLite ledger resets on every deploy). Judges aren't required to watch past three minutes, so nothing important lands after 2:40.
