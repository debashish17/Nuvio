# mcp-confirm-gate

[![npm](https://img.shields.io/npm/v/mcp-confirm-gate)](https://www.npmjs.com/package/mcp-confirm-gate) [![License: MIT](https://img.shields.io/npm/l/mcp-confirm-gate)](LICENSE)

```bash
npm install mcp-confirm-gate
```

Single-use, caller-bound confirmation tokens with an optional out-of-band step-up code, for [MCP](https://modelcontextprotocol.io) tools that move money or do anything else that is hard to undo.

An LLM agent should not be able to transfer money, delete data or send a message just because it decided to. This gate makes the human's consent something the server checks, not something the model promises.

## The pattern

1. A **prepare** tool does the checks, then returns the exact sentence to read back to the user and a **single-use token**.
2. The assistant reads the sentence back word for word and waits.
3. A **confirm** tool does the work only with that token: issued to the **same caller**, within its lifetime (5 minutes by default), **once**. A newer token for the same action replaces the older one.
4. Optionally, **step-up**: the first confirm call sends a one-time code out of band (SMS, push) and refuses `STEP_UP_REQUIRED`. Only a second call carrying the code the user read out does the work. The code is never in a tool result, so the model cannot approve on its own.

Expected outcomes are values, not exceptions: every call returns `{ ok: true, target }` or `{ ok: false, code, ... }`, ready to pass back to the model as a structured refusal.

## Install

```bash
npm install mcp-confirm-gate
```

Node 20 or later. No runtime dependencies (it uses `node:crypto`).

## Use it with the MCP TypeScript SDK

```ts
import { ConfirmGate } from "mcp-confirm-gate";

const gate = new ConfirmGate({
  stepUp: {
    // Put what is being approved in the message, so the code is bound to this one action.
    send: (code, { target }) => sms.send(user.phone, `${code} approves ${describe(target)}. Never share it.`),
  },
});

server.registerTool(
  "prepare_transfer",
  { description: "...", inputSchema: { quote_id: z.string() } },
  async ({ quote_id }, extra) => {
    const quote = await quotes.get(quote_id); // your checks
    const { token, expiresAt } = await gate.issue(`transfer:${quote_id}`, callerOf(extra), {
      notAfter: quote.rateLockedUntil, // never outlive the price lock
    });
    return json({ confirmation_token: token, expires_at: expiresAt, read_back: readBack(quote) });
  },
);

server.registerTool(
  "confirm_transfer",
  {
    description:
      "Call with confirmation_token alone after the user agrees to the read-back: a code is texted to them. " +
      "Then call again with otp set to the code they read out.",
    inputSchema: { confirmation_token: z.string(), otp: z.string().optional() },
    annotations: { destructiveHint: true },
  },
  async ({ confirmation_token, otp }, extra) => {
    const r = await gate.confirm(confirmation_token, callerOf(extra), otp);
    if (!r.ok) return json({ refused: r }); // STEP_UP_REQUIRED, OTP_INVALID, TOKEN_USED, ...
    return json(await ledger.execute(r.target)); // do the work exactly once
  },
);
```

`callerOf(extra)` should return a stable key for the authenticated caller, for example from `extra.authInfo`. Binding tokens to the caller works with the stateless Streamable HTTP transport, which has no session id.

Without `stepUp`, `gate.consume(token, caller)` is the whole confirmation.

## Results

| `code` | Meaning |
| --- | --- |
| `TOKEN_UNKNOWN` | Not a token of this gate, or issued to another caller (deliberately indistinguishable) |
| `TOKEN_EXPIRED` | Past its lifetime, replaced by a newer token, or voided after too many wrong codes |
| `TOKEN_USED` | Already spent, so nothing happened twice |
| `STEP_UP_REQUIRED` | A code was sent; `expiresAt` and `attemptsLeft` say for how long and how many tries |
| `OTP_INVALID` | Wrong code, or no code sent yet; `attemptsLeft` counts down |
| `OTP_EXPIRED` | The code is past its lifetime (5 minutes by default, never past the token) |
| `OTP_LOCKED` | Too many wrong codes (the token is now void) or too many codes sent |

## Storage

`MemoryStore` (the default) suits tests and a single process. For anything else, implement `TokenStore`.

Agents can call tools in parallel, so three methods must be atomic. Each protects a count that a read-then-write would let parallel calls share:

```sql
-- markUsed: of concurrent confirms, exactly one wins (succeed only if 1 row changed)
UPDATE confirm_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL;

-- claimSend: count the code against the cap and store it, in one step
UPDATE confirm_tokens SET code_hash = ?, salt = ?, code_expires_at = ?, attempts = 0, sends = sends + 1
 WHERE hash = ? AND sends < ? RETURNING sends;

-- claimAttempt: reserve a try at the current code before the code is checked
UPDATE confirm_tokens SET attempts = attempts + 1 WHERE hash = ? AND code_hash = ? RETURNING attempts;
```

The gate reserves a try before it compares the code, so however many guesses arrive at once, no more than `maxAttempts` are compared.

The store never holds a token, only its SHA-256, and a step-up code only as a salted hash. Codes are compared in constant time.

## What it does and doesn't protect against

- **It does:** a model that tries to confirm without the user's answer (it has no valid code), replays (single use), a token leaking to another caller (caller binding), stale approvals (short lifetimes, a newer token replaces the older), and brute-forcing a code (3 tries, then the token is void, including when guesses arrive in parallel; see the CHANGELOG for 0.1.0, where they did not).
- **A spoken code proves possession, not secrecy.** If the user reads the code aloud to a voice assistant, anyone nearby hears it. It still shows that whoever approves holds the phone right now. Where you can, prefer an approval push in your own app.
- **Consent within one turn is the client's job.** An assistant that prepares and then confirms in the same breath should be stopped by the client too. With step-up, the server is protected either way, because the model never sees the code.
- **It doesn't replace** your business checks (limits, fraud, sanctions). Run them in prepare, and again before executing.

## Origin

The pattern comes from [Nuvio Remit](https://github.com/debashish17/acme-remit), an Alexa+ add-on (MCP server) for sending money home from the UAE to India, built for the Amazon Developer Hackathon 2026, where prepare and confirm guard every transfer and cancellation. Nuvio Remit keeps its own SQLite-backed implementation and does not depend on this package; this package generalises the pattern with a pluggable store.

## License

MIT
