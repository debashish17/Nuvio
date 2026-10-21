# nuvio-remit — working rules for Claude Code

Nuvio Remit is a self-hosted MCP server (spec 2025-11-25, Streamable HTTP) for the
Alexa+ track of the "Build, Ship, Shape: Amazon Developer Hackathon" (Devpost,
deadline 2026-10-23 12:00 PDT). It exposes a single remittance provider's
capabilities for the UAE→India corridor over a simulated ledger, plus a web
simulator that stands in for Alexa+.

`docs/SPEC.md` is the contract. Read it before any task. If a task conflicts
with it, stop and ask rather than improvise.

## Hard rules

1. **Layering.** `src/core/**` never imports `@modelcontextprotocol/sdk`,
   Express, or AWS SDKs. `src/server/**` is a thin adapter: parse input with
   zod, call one core service, shape the output. Business rules live in core.
2. **Money.** Every amount is an integer in minor units (fils, paise) inside
   core and the DB. Format at the edge only. Never use floats for amounts.
3. **State writers.** Only `confirm_transfer` and `cancel_transfer` move money,
   and only through `ConfirmationGate` tokens (single-use, 5-min TTL,
   bound to the authenticated caller). `set_rate_alert` is the only other writer. Nothing else
   mutates balances, transfers or limits.
4. **Refusals.** Every refusal is structured:
   `{ refused: { code, ...numbers, resolution } }`. Never a bare string error,
   never a thrown exception reaching the tool boundary.
5. **Compliance behaviour.** `ON_HOLD` reports `customer_label: "Under review"`
   and an RFI if one exists. Never emit or log a screening reason.
6. **Secrets and logs.** Never log full tokens (prefix only), card numbers,
   or the Bearer secret. No secrets in the repo; `.env.example` lists every
   variable with a dummy value.
7. **Transport.** Streamable HTTP on `POST /mcp` only. Do not serve legacy
   `GET /sse`. Stateless transport mode.
8. **No external calls in tool handlers** except the cached rates fetch
   (Frankfurter, 15-min cache, seeded fallback). p95 per tool must stay well
   under 500 ms.
9. **Tests first.** Each core service has a test file per `docs/SPEC.md`.
   A feature is not done until its listed cases pass and `pnpm test`,
   `pnpm lint`, and `pnpm typecheck` are green.
10. **Friction log.** Whenever a tool, SDK, CLI or AWS service behaves
    unexpectedly (bad docs, confusing error, surprising default), append an
    entry to `FRICTION_LOG.md` before working around it. Format:
    date · task · steps · expected vs actual · severity (blocker/major/minor)
    · workaround · suggestion.

## Toolchain (pinned; do not swap without asking)

- Node 22 LTS, pnpm, TypeScript strict, ESM
- Express 5, `@modelcontextprotocol/sdk` (latest 1.x), `zod`
- `better-sqlite3`, plain SQL migrations in `src/db/migrations/*.sql`
- `@aws-sdk/client-bedrock-runtime` Converse API; model id from
  `BEDROCK_MODEL_ID` (default `us.amazon.nova-2-lite-v1:0`, the US inference
  profile Nova 2 Lite needs in us-east-1; switchable to a
  Claude on Bedrock id)
- `@aws-sdk/client-polly` for the simulator's voice (`POLLY_VOICE`, default
  Kajal, neural, en-IN; `none` uses the browser's voice)
- Vitest + supertest; GitHub Actions on push (`test`, `lint`, `typecheck`)
- ESLint flat config + Prettier; `tsup` → `dist/`
- Multi-stage Dockerfile on `node:22-alpine`; deploy target AWS App Runner,
  us-east-1, min and max instances 1 (the SQLite ledger lives on the instance)
- Config via `dotenv`, validated with zod at startup:
  `PORT`, `MCP_BEARER_TOKEN`, `BEDROCK_MODEL_ID`, `AWS_REGION`, `RATES_URL`,
  `DB_PATH`, `TICKER_MS`, `SIM_ACCESS_CODE`, `DEV_CONTROLS_CODE`,
  `SIM_DAILY_BEDROCK_CALLS`, `SIM_AUTO_RESET_MINUTES`, `POLLY_VOICE`, `POLLY_ENGINE`, `SIM_DAILY_TTS_CHARS`,
  `SIM_MODE`, `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`

## Repo layout

```
src/
  server/        Express app, MCP transport, Bearer middleware, tool registrations, /sim/chat proxy, /dev/* controls
  core/          rates, beneficiaries, quotes, limits, confirm (gate), ledger, alerts
  db/            schema, migrate, seed
  simulator/     static web client (HTML/CSS/JS, no framework)
tests/
docs/SPEC.md     the contract
FRICTION_LOG.md  running log, append-only
FEEDBACK.md      per-tool product feedback for the Devpost form
```

## Conventions

- Consumer-facing wording in anything the model will speak: "recipient"
  not "beneficiary", "receive amount" not "payout", "under review" not
  "on hold". Internal identifiers may keep the formal terms.
- Tool `description` strings come verbatim from `docs/SPEC.md`; change them
  only when a simulator run shows a mis-pick, and note why in the commit.
- Commits: conventional, small, one concern each. Branch per phase
  (`phase-1-protocol`, `phase-2-core`, ...), PR into `main` with CI green.
- Ask before: adding a dependency, adding a tool, changing a tool's schema,
  changing any limit or fee value, or touching anything under `docs/`.

## Working style

- Work one phase of `docs/SPEC.md` per session. State the phase's milestone
  at the start, and stop when it is met; do not run ahead into the next phase.
- Prefer small verified steps: write the test, make it pass, run the full
  suite, commit.
- When blocked on an environment or account issue (AWS access, Alexa CLI
  region gating), log it in `FRICTION_LOG.md` and report it; do not fake the
  integration.
