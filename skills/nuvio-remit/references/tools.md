# Nuvio Remit tools

Amounts are in major units (AED, INR). Every tool can return `{ refused: { code, ...numbers, resolution } }` instead of its result.

| Tool | Arguments | Returns | Moves money |
| --- | --- | --- | --- |
| `get_rate` | `from`, `to` (ISO codes, default AED, INR) | Nuvio's rate (`customer_rate`) for AED/INR, mid-market rate, week range, trend; any other pair is mid-market for information (`sendable: false`) | no |
| `compare_options` | `send_amount` | Receive amount by bank deposit, UPI and cash pickup, against a typical bank | no |
| `list_beneficiaries` | none | Saved recipients with their payout details and last transfer | no |
| `resolve_beneficiary` | `query` | `match`, or `ambiguous` with `candidates`, or `not_found` with `hint` | no |
| `quote_transfer` | `beneficiary_id`, `send_amount`, optional `payout_method`, `purpose` | `quote_id`, fee, locked rate, guaranteed `receive_amount`, `eta`, `warnings` (held 30 min) | no |
| `prepare_transfer` | `quote_id` | `confirmation_token` (5 min, single use, bound to you), `read_back` | no |
| `confirm_transfer` | `confirmation_token`, then also `otp` | First call: `STEP_UP_REQUIRED` (a code is texted). With the code: `transfer_ref`, `status`, `customer_label`, receipt | **yes** |
| `track_transfer` | `transfer_ref` or `latest: true` | Status, `customer_label`, timeline, `utr` once paid out, `action_required` if under review, `cancellable` | no |
| `cancel_transfer` | `transfer_ref`, then also `cancel_token` | Preview with `cancel_token`, then the refund to the sender's card | **yes** |
| `get_transfer_history` | optional `months`, `beneficiary_id` | Transfers (newest first) with totals and limits used | no |
| `check_limits` | optional `refusal_code` | Tier, remaining daily and monthly limits, plain-words explanation | no |
| `set_rate_alert` | `target`, `direction` (`above` or `below`) | Alert set, with today's rate | alert only |
| `get_help` | `topic` | Nuvio's own answer (demo text, pending compliance review): documents, steps, recipients, NRE/NRO, LRS, tax, refunds, safety | no |
| `get_pending` | none | Open quotes, transfers under review with their RFI, fired alerts, last transfer per recipient, `summary` | no |
