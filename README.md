# Acme Remit for Alexa+

[![CI](https://github.com/debashish17/acme-remit/actions/workflows/ci.yml/badge.svg)](https://github.com/debashish17/acme-remit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/debashish17/acme-remit)](LICENSE)

> **Simulated ledger — no real funds move.** Mid-market exchange rates are live (ECB via Frankfurter, cached; AED/INR derived from USD/INR at the 3.6725 AED/USD peg); Acme pricing, limits, card funding, screening and payout are simulated.

A self-hosted [MCP](https://modelcontextprotocol.io) server (spec 2025-11-25, Streamable HTTP) that lets Alexa+ handle UAE→India remittances safely, plus a web simulator that stands in for Alexa+.

Built for the **Alexa+ track** of [Build, Ship, Shape: Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/) (Devpost), with the AWS Builder and Open Source mini challenges.

> **The simulator is the demo.** Amazon's Alexa+ toolchain (the Alexa+ CLI, MCP Toolkit and web simulator) is not available to hackathon participants, so this repo ships its own web simulator that stands in for Alexa+ and calls the MCP server exactly as Alexa+ would. Judges can run everything locally with **nothing but Node**: no AWS account, no API key (see [Run it locally with no AWS account](#run-it-locally-with-no-aws-account)).

## What it does

One remittance provider's own Alexa+ add-on. A customer in Dubai can ask for today's rate, compare payout methods, send money to a saved recipient, track it to the UTR, cancel before payout, check limits, and set a rate alert — by voice.

Four safety properties hold for every money movement:

1. **Read-back before action.** `prepare_transfer` returns the exact sentence to read back; nothing moves until the user agrees.
2. **Single-use, expiring tokens.** `confirm_transfer` and `cancel_transfer` only execute with a 5-minute, single-use token bound to the authenticated caller.
3. **Server-side limits.** KYC-tier, daily, monthly and cash-pickup caps are enforced in core, not by the model.
4. **Step-up code.** Confirming texts a one-time code to the customer's phone; money moves only when the user reads it back, or types it into the transfer view, where it goes to the server without passing through the model. The code never appears in a tool result, so the model cannot approve on its own.

## Spec

`docs/SPEC.md` is the build contract: decisions, architecture, the 14-tool contract with JSON schemas, core module interfaces, data model and seed, token lifecycle and tests, simulator design, and the phase plan. The architecture, transfer-lifecycle and timeline diagrams live in the source doc and are not in the Markdown export.

## Status

Phase 4b (MCP Apps view), on top of Phases 1–4. All 14 tools work over `POST /mcp` with server-enforced refusals, including a step-up code before money moves and `get_pending`, which carries context across conversations. The transfer tools show an [MCP Apps](#mcp-apps-view) view. The simulator runs the whole demo with no language model (scripted mode), or live with Amazon Bedrock or any OpenAI-compatible model. See the phase plan in `docs/SPEC.md`.

| Tool | Does | Moves money |
| --- | --- | --- |
| `get_rate` | Acme's AED→INR rate, mid-market rate, 7-day trend; any other ECB or dollar-pegged pair for information | |
| `compare_options` | Receive amount by bank deposit, UPI and cash pickup, against a typical bank | |
| `list_beneficiaries` / `resolve_beneficiary` | Saved recipients; find one by name, nickname or relationship | |
| `quote_transfer` | Fee, locked rate, guaranteed receive amount, limit and purpose checks; held 30 min | |
| `prepare_transfer` | The exact read-back sentence and a single-use 5-minute token | |
| `confirm_transfer` | Texts a one-time code to the phone; with that code, charges the card and submits, once | **yes** |
| `track_transfer` / `get_transfer_history` | Status, timeline, UTR, RFI when under review; history with totals | |
| `cancel_transfer` | Preview with a cancel token, then cancel and refund before payout | **yes** |
| `check_limits` | Tier, remaining limits, plain-words explanation of any refusal | |
| `set_rate_alert` | Tell the user when the rate reaches a target | |
| `get_help` | Acme's own answers (demo text, pending compliance review): documents, steps, recipients, NRE/NRO, LRS, tax, refunds, safety | |
| `get_pending` | What's waiting since last time: open quotes, transfers under review with their RFI, fired alerts, and the last transfer per recipient ("the usual") | |

## Run

### Run it locally with no AWS account

You need Node 22 and pnpm (`corepack enable` gives you pnpm). Nothing else: no AWS account, no API key, no Docker.

```bash
git clone https://github.com/debashish17/acme-remit.git
cd acme-remit
pnpm install
# a .env with just two lines (any values; the token must be at least 16 characters)
printf 'MCP_BEARER_TOKEN=local-demo-token-1234567890\nSIM_ACCESS_CODE=demo-code\n' > .env
pnpm db:seed
pnpm dev
```

Open http://localhost:3000, enter the access code (`demo-code` above), click **Play demo**, then **Play all**. The server log says `simulator mode: scripted (no AWS credentials found)`: with no model configured, the simulator follows the demo script and drives the real tools, so every step in the protocol panel is a genuine JSON-RPC call to `POST /mcp`. The step-up code arrives on the simulated phone; the assistant speaks with your browser's voice. Typing your own sentences needs a model (below); the page says so.

On Windows PowerShell, create the `.env` with `Set-Content .env "MCP_BEARER_TOKEN=local-demo-token-1234567890`nSIM_ACCESS_CODE=demo-code"`.

### Connect a live model (optional)

| Model | How |
| --- | --- |
| Amazon Bedrock (default) | Have AWS credentials available (environment, `AWS_PROFILE`, or `aws login`) with access to Nova 2 Lite in us-east-1. The server detects them at startup and switches to the live model; the Polly voice also turns on. |
| Any OpenAI-compatible endpoint | Add `LLM_PROVIDER=openai_compatible` and `LLM_API_KEY=...` to `.env`; optionally `LLM_BASE_URL` (default `https://api.openai.com/v1`; OpenRouter, Groq or a local Ollama work too) and `LLM_MODEL` (default `gpt-4o-mini`). |

`SIM_MODE=scripted` or `SIM_MODE=bedrock` forces a mode (`bedrock` means "the live model through `LLM_PROVIDER`"). The model only ever reaches the MCP server through the same relay and tools, so the safety properties above hold in every mode.

### Development

```bash
cp .env.example .env
pnpm db:migrate && pnpm db:seed
pnpm dev
# MCP endpoint: POST http://127.0.0.1:3000/mcp  (Bearer token from .env)
```

`pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm e2e` (Playwright, using your installed Chrome; scripted mode, so no model or AWS calls) are what CI runs. `pnpm db:seed` wipes and reloads the demo data, so every run starts identical; the server also loads it on first start if the database is empty. `pnpm build && pnpm start` runs the bundled server from `dist/`.

### The simulator

Open `http://127.0.0.1:3000/` and enter `SIM_ACCESS_CODE` from your `.env`. **Play demo** shows the demo lines one at a time; **Play all** runs them in a row, each after the last reply has been spoken. With a live model you can also talk with the orb, the mic button or Space (Chrome or Edge: hold while you speak, or tap once and it listens until you pause) or type anything. The panel on the right shows each real JSON-RPC exchange with `POST /mcp`; click a row to see the request and response, with tokens and codes masked. The page talks only to `/sim/*`, and the server-side relay holds the Bearer secret.

The voice is the browser's own, or, when AWS credentials are available, Amazon Polly's Indian English neural voice (Kajal) through `POST /sim/speak`; the voice picker switches between them, and the page falls back to the browser's voice if Polly fails (`POLLY_VOICE=none` turns Polly off).

For recording, `/?dev=1` adds dev controls (advance the ticker, release the held transfer, fire a rate alert, reset the demo data). They need `DEV_CONTROLS_CODE`, and `/dev/*` answers 404 when it is unset. With the dev code entered, chat turns skip the per-IP limit (the daily Bedrock cap still applies). Press H to hide the panels.

### Conversation evals

```bash
node --env-file=.env scripts/eval.mjs --runs 3   # or --only script,spoken,safety, --verbose
```

This plays whole conversations through `/sim/chat` against a running server: real Bedrock, real `/mcp` round trips, a fresh seed for each. There are three: the demo script word for word, the same journey as speech recognition delivers it ("mom", numbers in words, a question and a change mid-confirmation), and consent edge cases. Each turn is checked for the tools called and not called, refusals, word-for-word read-backs and cancel previews, and words that must not be spoken ("screening", "beneficiary", ids, lists, ISO dates). It uses about 65 Bedrock calls per pass of all three. It resets the demo data, so don't run it while someone is using the simulator.

### Run with Docker

```bash
docker build -t nuvio-remit .
docker run -p 8080:8080 -e MCP_BEARER_TOKEN=<long-random-string> -e SIM_ACCESS_CODE=<code> nuvio-remit
# MCP endpoint: POST http://127.0.0.1:8080/mcp · health: GET /health
```

The image is multi-stage on `node:22-alpine`, runs as the non-root `node` user, migrates and loads the demo seed into an empty database on start, and reads all configuration from the environment (see `.env.example`). Bedrock calls from `/sim/chat` need AWS credentials in the environment or an instance role.

### Check the protocol with curl

```bash
export MCP_BEARER_TOKEN=change-me-to-a-long-random-string   # the value in your .env
curl -s http://127.0.0.1:3000/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

Expected: `"protocolVersion":"2025-11-25"` and `"serverInfo":{"name":"nuvio-remit",...}`. Without the `Authorization` header the server answers `401`. Legacy `GET /sse` is not served.

### Try the send flow with MCP Inspector

Run these from outside the repo folder (`npx` refuses to run inside a pnpm project; see `FRICTION_LOG.md`). Each call is a separate connection; tokens are bound to the authenticated caller, not a session.

```bash
I="npx -y @modelcontextprotocol/inspector@latest --cli http://127.0.0.1:3000/mcp --transport http --header 'Authorization: Bearer $MCP_BEARER_TOKEN'"
eval $I --method tools/list
eval $I --method tools/call --tool-name quote_transfer --tool-arg send_amount=2000 --tool-arg beneficiary_id=ben_01
eval $I --method tools/call --tool-name prepare_transfer --tool-arg quote_id=<quote_id>
eval $I --method tools/call --tool-name confirm_transfer --tool-arg confirmation_token=<confirmation_token>
# -> STEP_UP_REQUIRED: a code was texted to the simulated phone; read it from /sim/state, then:
curl -s "http://127.0.0.1:3000/sim/state?since=2000-01-01T00:00:00Z" -H "x-sim-code: $SIM_ACCESS_CODE" | grep -o 'Nuvio: [0-9]*'
eval $I --method tools/call --tool-name confirm_transfer --tool-arg confirmation_token=<confirmation_token> --tool-arg otp=<code>
eval $I --method tools/call --tool-name quote_transfer --tool-arg send_amount=3000 --tool-arg beneficiary_id=ben_01   # refused: MONTHLY_LIMIT
```

## Deploy to AWS App Runner (optional)

Hosting isn't needed to judge or run this project; this is for a public URL. Everything is in `infra/acme-remit.yaml` (CloudFormation) and `.github/workflows/deploy.yml` (GitHub OIDC, no stored AWS keys). Region `us-east-1`.

1. **Create the stack** (console: CloudFormation → Create stack → upload `infra/acme-remit.yaml`), name `acme-remit`, `CreateService=false`, optionally `BudgetEmail`. It creates the ECR repo, generated secrets (`acme-remit/mcp-bearer-token`, `/sim-access-code`, `/dev-controls-code`), the App Runner roles and the GitHub deploy role.
2. **Set the repository variable** `AWS_DEPLOY_ROLE_ARN` (GitHub → Settings → Secrets and variables → Actions → Variables) to the stack output `GitHubDeployRoleArn`.
3. **Push the first image**: run the *Deploy* workflow (Actions → Deploy → Run workflow). With no service yet it pushes `<sha>` and `live` to ECR and stops.
4. **Create the service**: update the stack with `CreateService=true`. The output `ServiceUrl` is the public URL; the MCP endpoint is `<ServiceUrl>/mcp`.
5. From then on every push to `main` that passes CI builds, pushes, starts an App Runner deployment, waits for it, and records per-tool p50/p95 latency from the (US-hosted) runner in the job summary, failing if any p95 exceeds 500 ms.

The service runs exactly one instance (min = max = 1) because the SQLite ledger lives on it; each deploy starts from the demo seed. Its role may call only the configured Bedrock model. The simulator access code and dev-controls code are in Secrets Manager.

## Real vs simulated

| Component | Real | Simulated |
| --- | --- | --- |
| MCP server, Streamable HTTP, spec 2025-11-25 | yes | |
| Bearer auth, token lifecycle, limit enforcement | yes | |
| The assistant: Amazon Bedrock or any OpenAI-compatible model | yes | scripted mode when none is configured (real tools, fixed script) |
| AWS App Runner deployment (optional) | yes | |
| Mid-market exchange rates | yes (Frankfurter) | |
| Acme FX margin, fees, payout methods, KYC tier limits | | yes |
| Card funding, ledger, screening, payout partner, UTRs | | yes |
| SMS delivery of the step-up code (shown on a simulated phone) | | yes |

## Agent Skill

[`skills/acme-remit/SKILL.md`](skills/acme-remit/SKILL.md) is an [Agent Skill](https://agentskills.io) that teaches a coding agent to use this server safely: start with `get_pending`, resolve the recipient, quote, prepare, read back word for word, wait for the user's yes, confirm, ask for the texted code, confirm with it, track. It includes a reference for all 14 tools and a small script that calls a tool over Streamable HTTP.

## MCP Apps view

[MCP Apps](https://github.com/modelcontextprotocol/ext-apps) is the official MCP extension that lets a tool show an interactive view next to the conversation. This server ships one, `ui://acme-remit/transfer`, linked from `quote_transfer`, `prepare_transfer`, `confirm_transfer` and `track_transfer` through `_meta.ui.resourceUri`. Hosts without MCP Apps ignore the link and see the same 14 tools. The view moves through four stages:

1. **Quote:** what the recipient receives, the fee and the rate-lock countdown.
2. **Read-back:** the token's 5-minute countdown. **Confirm** and **Not now** send "Yes." or "No." into the conversation, so consent stays with the assistant.
3. **Code entry:** the code texted to the phone goes from the view to `confirm_transfer` through the host, never through the model.
4. **Receipt:** it polls `track_transfer` until the money is paid out. Under review shows the RFI, never a reason.

**In the simulator** (nothing to install): the page is an MCP Apps host. Send money and the view appears in the conversation. The protocol panel shows its `resources/read` and its own `tools/call` rows, marked "App view", with the code masked. Type the code from the phone toast into the view, or read it out as before.

How the simulator hosts it:

* The view runs in an iframe sandboxed to `allow-scripts` (an opaque origin), served once from a one-minute URL under a CSP with no network access.
* It talks to the page only through the official SDK's `AppBridge` over `postMessage`.
* Its tool calls go through the server-side relay. The browser never holds the Bearer secret, and a view may call only tools linked to it.

**In another MCP Apps host:** run the server locally (`pnpm dev`) and connect the host to `http://127.0.0.1:3000/mcp` over Streamable HTTP with the header `Authorization: Bearer <MCP_BEARER_TOKEN>`. Then call `quote_transfer`, `prepare_transfer`, `confirm_transfer` (with the token, then type the code into the view) or `track_transfer` (`{"latest": true}`).

* **The official reference host** (verified on 2026-10-04: quote, read-back, code typed into the view, live receipt to Paid out). It connects from the browser, so it can't send the Bearer header and needs CORS headers. `scripts/host-proxy.mjs` adds both, for local testing only. The reference host runs on [Bun](https://bun.sh):

  ```bash
  MCP_BEARER_TOKEN=<from .env> node scripts/host-proxy.mjs        # :3001 -> :3000
  git clone https://github.com/modelcontextprotocol/ext-apps && cd ext-apps/examples/basic-host
  npm install && SERVERS='["http://localhost:3001/mcp"]' npm run start   # open http://localhost:8080
  ```

* **MCPJam Inspector:** `npx @mcpjam/inspector@latest --url http://127.0.0.1:3000/mcp --bearer <MCP_BEARER_TOKEN>` (run it outside this folder). Its local inspector now asks you to sign in with a free account before it opens; we did not test past that screen.
* **VS Code** with GitHub Copilot agent mode (not tested here), through `.vscode/mcp.json`:

```json
{
  "inputs": [{ "id": "acme-token", "type": "promptString", "description": "MCP_BEARER_TOKEN from .env", "password": true }],
  "servers": {
    "acme-remit": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer ${input:acme-token}" }
    }
  }
}
```

CI tests the view's state logic, the resource, the tool links and the simulator's host routes, and a Playwright test in Chrome runs Play all and types a code into the view through to Paid out (`pnpm e2e`). The view was also checked by hand in the official reference host on 2026-10-04. Hosts that connect only to remote servers, such as claude.ai, need a hosted copy over HTTPS.

The view's source is `src/ui/transfer/`. `pnpm build:ui` bundles it into one HTML file (`pnpm dev`, `pnpm build` and the tests run that step first), and the server serves it with `resources/read`. The contract is the "MCP Apps view" section of `docs/SPEC.md`.

## Open source: `mcp-confirm-gate`

The confirmation pattern behind every transfer here, as a small, dependency-free package for any MCP server: single-use tokens bound to the caller, a read-back before confirming, and an optional step-up code sent out of band that the model never sees. It is published on npm as [`mcp-confirm-gate`](https://www.npmjs.com/package/mcp-confirm-gate) (`npm install mcp-confirm-gate`, MIT, no runtime dependencies). The source and its 16 tests, run in CI with the rest, are in [`packages/mcp-confirm-gate`](packages/mcp-confirm-gate). Use 0.2.0 or later: in 0.1.0, parallel wrong codes were not counted (see its [CHANGELOG](packages/mcp-confirm-gate/CHANGELOG.md)). The server here keeps its own SQLite implementation of the same pattern, whose checks run synchronously, so it was not affected. It does not import the package.

## Threat model

To report a vulnerability, see [SECURITY.md](SECURITY.md).

- **The step-up code proves possession of the phone, not secrecy from bystanders.** It is texted to the registered phone and read aloud, so anyone nearby hears it. It still shows that whoever approves holds the customer's phone right now. It is single-use, lasts 5 minutes, names the amount and recipient, and three wrong tries void the confirmation. A production add-on should prefer an approval push in the provider's app.
- **The transfer view holds the confirmation token, as the model does.** An MCP Apps view receives each linked tool's result, including the token it needs to send the code. Without the code from the phone, the token cannot move money. Typing the code into the view also keeps it out of the conversation, and away from anyone who would hear it read aloud.
- **In the simulator, the access code is the demo customer's phone.** The simulated phone shows each step-up code, and `GET /sim/state` returns it, behind `SIM_ACCESS_CODE`. So on a hosted copy, whoever holds the access code can approve transfers on the demo ledger, as the customer can with their real phone. Nothing real moves; treat that code as the demo customer's credentials. Gating the phone behind another code would stop judges from finishing a transfer.
- **The consent guard is the simulator's, not Alexa+'s.** The simulator refuses to spend a token in the turn that issued it. Real Alexa+ has no such guard, so there the server-side code is the defence against a model that prepares and confirms in one breath: the code is never in any tool result, so the model cannot supply it.
- **`cancel_transfer` has no step-up, by design.** It still needs a read-back preview and its own single-use token, but it can only refund the full amount to the sender's own card, before payout. It cannot send money anywhere new.
- **Everything else is enforced server-side for every client:** quotes lock the rate, tokens are single-use, expire in 5 minutes and are bound to the authenticated caller (never a session), limits are re-checked at confirm, and refusals are structured. One demo customer sits behind one Bearer token; production would use account linking (OAuth 2.1 with PKCE). The public simulator is metered (access code, per-IP limits, daily model and voice caps). Logs show token prefixes only, and codes are stored only as salted hashes.
- **Out of scope:** voice biometrics, device signals, fraud scoring and real sanctions screening (modelled as "under review", with no reason ever given).

## Before this moves real money

The ledger is simulated, and these are deliberate shortcuts that a production version must replace:

- **Card charges and the ledger.** The mock card is charged inside the SQLite transaction, so a decline rolls back every write. A real card processor's call is asynchronous and can fail or time out after the money is taken, so it can't run inside that transaction. Confirm needs an idempotency key per confirmation, a pending state, and reconciliation through an outbox and the processor's webhooks.
- **References.** `NUV-` references are sequential (`MAX + 1`). Every lookup is scoped to the user, so this leaks nothing here, but production references should be random or keyed.
- **One server per request.** Stateless Streamable HTTP builds a new `McpServer`, with its 14 tools and one resource, for each `POST /mcp`. That is fine at demo traffic; at scale, build it once per process.
- **Quotes don't reserve limit.** Confirm re-checks limits, so a second quote that no longer fits is refused safely, but `get_pending` can still list it as open. Production should re-check open quotes, or reserve limit for them.
- **Everything the simulation stands in for:** account linking (OAuth 2.1 with PKCE) instead of one Bearer token, Postgres instead of SQLite on one instance, a real SMS or push provider (preferably an in-app approval push), real sanctions screening, and a compliance review of every spoken string.

## License

MIT — see `LICENSE`.
