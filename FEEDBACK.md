# Product feedback

One section per tool, API, SDK or service used, as the Devpost submission requires: what it was used for, what worked well, what needs work, how onboarding felt (zero to hello world), and whether we would build with it again, and why. The track's own platform and its two linked resources come first. Dated incidents with steps, workarounds and suggestions are in [`FRICTION_LOG.md`](FRICTION_LOG.md).

---

## Alexa+ (the track's platform)

- **Used for:** the target platform. Nuvio Remit is built as an Alexa+ add-on: a self-hosted MCP server (spec 2025-11-25, stateless Streamable HTTP, Bearer auth) that Alexa+ calls server to server. Everything the assistant says is written for voice: amounts in words, one exact read-back sentence before money moves, "recipient" rather than "beneficiary", "under review" rather than "on hold". We also used the track's two linked resources, MCP Apps and Agent Skills (next two sections).
- **Worked well:** building on open MCP rather than a proprietary interface meant the add-on could be built and tested without Amazon's toolchain. The same server answers MCP Inspector, the official MCP Apps reference host, and Bedrock or OpenAI-compatible models through our simulator, and nothing in it is specific to the simulator.
- **Needs work:**
  - The track links the Alexa+ CLI, the MCP Toolkit and the web simulator, but the FAQ says participants can't get them, so the add-on was never run on Alexa+ itself.
  - Add-on testing isn't available outside the US, so a developer in India can't try an add-on on a device either.
  - There is no platform step-up for consequential tools. Voice alone is weak authentication for moving money, so we built our own one-time code sent by SMS. An approval in the Alexa app, where nothing is spoken aloud, would be stronger and the same across add-ons.
- **Onboarding (zero to hello world):** we couldn't reach hello world on Alexa+ itself, because the toolchain the track links to isn't available to participants. Our hello world was a tool answering in MCP Inspector, then our own simulator standing in for Alexa+.
- **Would build with it again:** yes, once add-on testing is open to participants and outside the US. An add-on that is an MCP server is the right model: the server, its tests and its tool contract use no Alexa-specific API.

## MCP Apps SDK (`@modelcontextprotocol/ext-apps` 1.7.5)

- **Used for:** the `ui://nuvio-remit/transfer` view, on both the server and the host side.
  - **Server:** `registerAppResource` and `registerAppTool` link the four transfer tools to the view.
  - **View:** the `App` class handles tool input and results, `callServerTool` for the step-up code, `sendMessage`, `updateModelContext`, auto-resize and the host theme.
  - **Simulator:** `AppBridge` with `PostMessageTransport` makes the page an MCP Apps host.
- **Worked well:**
  - The protocol is small and does what we needed. The best part is a path for the step-up code that skips the model entirely: the view calls `confirm_transfer` through the host, so the code is never in the conversation.
  - The server helpers are thin wrappers that only set `_meta`, so adding the view changed no tool schema.
  - The `AppBridge` host side took about 100 lines to wire up, with a null client and our own routing.
- **Needs work:**
  - `latest` (2.x) needs the split MCP SDK v2, and pnpm installed it on SDK 1.31 without an error. We pinned 1.7.5.
  - The `.d.ts` files use extensionless relative imports, so the types silently disappear under `moduleResolution: "nodenext"`. The browser code got its own `bundler` tsconfig.
  - Bundled with zod 4, the view came to 525 KB, 260 KB of it zod's locales. A build plugin that keeps only English brought it to 268 KB.
  - A web host can't render the view with `srcdoc` or a blob URL without inheriting its own CSP. Our page has no inline scripts, so we serve each view from a single-use URL under the CSP built from `_meta.ui.csp`. The spec's sandbox-proxy pattern needs a second origin, which a single local server doesn't have.
  - The official reference host (`examples/basic-host`) can't send headers, so it can't reach a server that needs a Bearer token. We wrote a small local proxy (`scripts/host-proxy.mjs`) to test there.
- **Onboarding (zero to hello world):** good once past the version mismatch. The API reference and the spec agree.
- **Would build with it again:** yes. A view keeps a secret, the step-up code, out of the model's context while staying inside the conversation. Hosts without MCP Apps still see the same 14 tools.

## Agent Skills (`SKILL.md`)

- **Used for:** `skills/nuvio-remit/SKILL.md` teaches any agent the consent flow the server enforces: resolve, quote, prepare, read back, wait for a yes, confirm with the texted code, track. It comes with a reference for all 14 tools and a small script that calls a tool over Streamable HTTP.
- **Worked well:** it's plain Markdown with YAML front matter: no build step and no registry, and it's versioned with the code it describes. Progressive disclosure fits well: the main file holds the flow, and the 14-tool reference is a separate file an agent opens only when it needs it.
- **Needs work:** a skill has no standard way to declare the MCP server it needs. We put the server name, protocol version and transport in free-form `metadata`, which no agent is required to read, so connecting is left to the skill's "Connect" section.
- **Onboarding (zero to hello world):** the specification is short, and the first version was written straight from it.
- **Would build with it again:** yes. It is the cheapest way to ship a server's safety rules alongside the server.

## MCP TypeScript SDK (`@modelcontextprotocol/sdk` 1.32, Streamable HTTP)

- **Used for:**
  - The whole server: `POST /mcp` in stateless Streamable HTTP mode (spec 2025-11-25), 14 tools registered with zod input schemas, and an output schema on `get_rate`.
  - Tool annotations (`readOnlyHint`, `destructiveHint`) that mark the two money-moving tools.
  - The simulator's own client side: a relay that calls the server over real JSON-RPC.
- **Worked well:**
  - `registerTool` with zod schemas produces clean JSON Schema in `tools/list`, which both Bedrock's Converse API and OpenAI-compatible endpoints accepted as-is.
  - Stateless mode with JSON responses needed no session store and fits a single small instance.
  - Protocol-version negotiation worked first time with MCP Inspector, and output-schema validation caught a shape mismatch in our own code.
- **Needs work:**
  - The documented stateless idiom doesn't compile under `exactOptionalPropertyTypes`: `sessionIdGenerator: undefined` and the transport's optional callbacks fail to type-check, so we omitted the option and cast `transport as Transport`.
  - With an output schema, a structured refusal (an expected answer such as "currency not supported") fails validation unless the result is marked `isError: true`, which makes a refusal look like a failure. Alternative output shapes, or skipping validation for flagged refusals, would fix it.
- **Onboarding (zero to hello world):** quick. The README's Streamable HTTP example plus one `registerTool` answered `initialize`, `tools/list` and `tools/call` in MCP Inspector. Strict-TypeScript projects need the type fixes above.
- **Would build with it again:** yes. It is the reference implementation, and the same server works unchanged with MCP Inspector, Bedrock tool use, OpenAI-compatible models, the MCP Apps reference host and our simulator.

## Amazon Bedrock (Converse API, tool use, Nova 2 Lite)

- **Used for:** the simulator's live assistant, a Converse tool-use loop that calls our MCP server over real JSON-RPC. Also conversation evals that play whole remittance journeys and check what the model did and said.
- **Worked well:**
  - Converse is one tool-use interface across models, so switching models is a config value. The same loop now also runs on any OpenAI-compatible endpoint through a small adapter.
  - Nova 2 Lite is inexpensive ($0.33 per million input tokens and $2.75 per million output on the `us.` profile, from the AWS Price List API) and quick: about 0.7 s per call server-side, by CloudWatch.
  - It handled 14 tools and multi-step flows reliably after prompt tuning. A live session of the whole demo plus 12 unscripted turns passed 25 of 25.
  - Amazon models need no access request.
- **Needs work:**
  - The Nova 2 Lite model card gives a bare model id in its us-east-1 sample, but only the `us.` / `global.` inference profiles are invocable there.
  - Where Nova 2 Lite accepts an explicit `cachePoint` is found only by trying. On the system prompt and on a user text message it works. On the tool list, or inside a message holding a tool result, the request fails with `ValidationException ... extraneous key [cachePoint] is not permitted`.
    - Input tokens were 94.5% of our cost, because every call resends the instructions and 14 tool definitions.
    - Once the cache points were in the right places, the Bedrock cost of a full demo run fell 77%, from about $0.06 to about $0.014.
    - A per-model list of the fields that accept a cache point would have saved the trial and error.
  - Out of the box the model:
    - paraphrased confirmation read-backs
    - spoke raw status values ("screening")
    - once invented a compliance requirement from a history list
    - quoted the mid-market rate as "the rate" instead of the customer's rate

    Strict prompt rules and evals fixed all four. Guidance for consent-critical, verbatim tool output would help.
- **Onboarding (zero to hello world):** smooth once the right model id was known. Local credentials through `aws login` expire often, so a long session needs several sign-ins.
- **Would build with it again:** yes. One Converse loop covers any Bedrock model, and Nova 2 Lite with caching is cheap enough to run full conversation evals freely.

## AWS App Runner and CloudFormation (with GitHub Actions OIDC)

- **Used for:** a deployable setup written as code, which we never created as a stack: the hackathon doesn't require hosting (judges run the project locally) and our budget is small. It has two parts:
  - one CloudFormation template: an ECR repository, generated secrets, an App Runner service with a single instance, IAM roles with managed policies, and a budget alarm
  - a GitHub Actions deploy through OIDC with no stored AWS keys, plus a per-tool latency check from a US runner
- **Worked well:**
  - `RuntimeEnvironmentSecrets` keeps secrets out of the image and the template.
  - A single-instance auto-scaling configuration fits a SQLite demo.
  - cfn-lint and cfn-guard (Well-Architected Security Pillar) ran clean and caught an inline-policy issue early.
  - GitHub OIDC needed no long-lived keys.
- **Needs work:**
  - A service can't be created before its image exists in ECR, so the template needs a two-pass bootstrap: `CreateService=false`, push an image, then `true`.
  - A minimum of one provisioned instance bills for idle memory around the clock (about $2.50–5 a month at the smallest sizes). That is noticeable on a hobby or hackathon budget, and a scale-to-zero option would help.
- **Onboarding (zero to hello world):** the template reference is thorough, but the bootstrap order took some working out. We validated the template but never created the stack, so we never reached a deployed hello world.
- **Would build with it again:** yes, for small containerised services. Secrets, scaling and keyless deploys fit in one template.

## AWS CLI (and the Agent Toolkit for AWS)

- **Used for:**
  - local setup: an IAM user through `aws login`
  - the AWS Price List API for exact Bedrock, Polly and App Runner prices
  - CloudWatch and Cost Explorer for actual spend
  - the Agent Toolkit's skills and MCP server for AWS guidance
- **Worked well:** the Price List API gave authoritative prices for every estimate we made, and CloudWatch's Bedrock token metrics matched the Cost Explorer bill to the cent.
- **Needs work:**
  - `aws agent-toolkit list-available-skills` crashes on the Windows console code page (cp1252) when a description contains "→".
  - `aws login` asks an interactive y/n when switching a profile's identity, and rejects a piped answer on PowerShell 5.1.
  - `aws logout` doesn't clear the old identity.
- **Onboarding (zero to hello world):** good once the profile was set up. The Windows issues cost about an hour.
- **Would build with it again:** yes. The Price List API alone made every cost estimate in this project exact.

## Amazon Polly (neural voice, speech marks)

- **Used for:** the simulator's optional voice (Kajal, neural, Indian English), with word speech marks that highlight the read-back as it is spoken. It is switched on only when AWS credentials are available; otherwise the browser's voice is used.
- **Worked well:** a natural Indian English voice, about 1.2 s to synthesise a reply from India, and speech marks that lined up exactly with the text.
- **Needs work:**
  - Audio and speech marks are two separate requests, both billed per character, so every highlighted reply costs twice. In our measured demo run, Polly was $0.054 of the $0.114 total.
  - Speech marks use UTF-8 byte offsets, which JavaScript has to convert for text with "₹" or emoji.
- **Onboarding (zero to hello world):** one `SynthesizeSpeech` call, with no setup and no access request.
- **Would build with it again:** yes. An Indian English neural voice with exact speech marks made the read-back easy to follow on screen.

## GitHub Actions (CI, Dependabot, OIDC)

- **Used for:**
  - CI on every push and pull request: tests, lint, typecheck, and a Playwright run of the whole demo in Chrome
  - branch protection on `main` that requires that check
  - Dependabot for grouped weekly updates
  - a deploy workflow that assumes an AWS role through OIDC with no stored keys
- **Worked well:** OIDC removed long-lived AWS keys entirely, and with a required check on `main`, nothing merged without a green run.
- **Needs work:** renaming the repository silently switched its OIDC subject claim to the immutable `name@id` format. A trust policy written with the new plain name would have refused every token, with a generic `Not authorized to perform sts:AssumeRoleWithWebIdentity`, and the rename dialog doesn't mention it.
- **Onboarding (zero to hello world):** CI went green on the first pull request.
- **Would build with it again:** yes. CI, dependency updates and keyless deploys live in one place, free for a public repository.

## npm (registry and CLI)

- **Used for:** publishing the open-source package [`mcp-confirm-gate`](https://www.npmjs.com/package/mcp-confirm-gate): 0.1.0, then the 0.2.0 security fix, and deprecating 0.1.0.
- **Worked well:** a publish is approved in the browser with 2FA, and `npm deprecate` took effect at once.
- **Needs work:**
  - The first publish failed with a 403 whose generic text blames dependencies. The real cause was that the account had no 2FA, which `npm login` never mentioned.
  - With an expired login, `npm publish` reports `E404 ... is not in this registry`, which reads like a wrong package name.
  - Web 2FA appears only in an interactive terminal; anywhere else the publish fails with `EOTP`.
  - After a `202` ("being processed") the new version wasn't listed for about 4 minutes, and the CLI didn't say so.
- **Onboarding (zero to hello world):** about 5 minutes lost to the 2FA requirement on the first publish, and about 20 on the second, mostly decoding the E404.
- **Would build with it again:** yes. It is where TypeScript developers look for a package.

## pnpm 12 (package manager, workspace)

- **Used for:** dependencies and a workspace for `packages/mcp-confirm-gate`, with a frozen lockfile in CI.
- **Worked well:** fast installs, and `corepack enable` is the whole setup.
- **Needs work:**
  - A placeholder `allowBuilds` value in `pnpm-workspace.yaml` silently skipped the native build of `better-sqlite3`, which would only have failed at runtime.
  - `pnpm -s <script>` was dropped without naming its replacement.
  - On Windows, the native binary that corepack downloads stopped launching mid-session (`spawnSync ... UNKNOWN`).
  - It installed `@modelcontextprotocol/ext-apps` 2.x on an incompatible MCP SDK without an error.
- **Onboarding (zero to hello world):** minutes.
- **Would build with it again:** yes, though we'd want the native-binary fallback on Windows first.

## Frankfurter (ECB reference rates)

- **Used for:** live mid-market rates. One request covers a range of days for every currency against USD, cached for 15 minutes with a seeded offline fallback. AED/INR is derived from USD/INR at the CBUAE peg.
- **Worked well:** free, no key, fast, and the time-series endpoint gives a week's trend in one call.
- **Needs work:**
  - ECB publishes no AED, nor the other Gulf currencies, so our spec's original `from=AED` request could never have worked. It returns a bare "not found" instead of naming the unsupported currency.
  - The `.app` host now redirects to `.dev/v1`, an extra hop on every call that isn't announced on the landing page.
- **Onboarding (zero to hello world):** minutes.
- **Would build with it again:** yes, with the peg derivation. Free, keyless and fast is exactly what a demo needs.

## Devpost (rules, FAQ, submission)

- **Used for:** the hackathon rules, track descriptions, FAQ, updates and the submission.
- **Worked well:** the FAQ settled the questions that shaped the project: hosting is not required, judges run the code locally, and a simulated Alexa+ experience is acceptable. The judging criteria are clear and weighted equally.
- **Needs work:** the Alexa+ track links to Amazon's Alexa+ CLI, MCP Toolkit and web simulator, but the FAQ later made clear that participants can't get them. We had planned a phase around the CLI before finding that out. Saying it on the track page from day one would save every team that time.
- **Onboarding (zero to hello world):** registration and team setup were straightforward.
- **Would build with it again:** yes. The FAQ and updates answered the questions that mattered.

## Other tools

| Tool | Used for | Notes |
| --- | --- | --- |
| Vitest and supertest | 347 tests over the core services and the HTTP routes | No issues worth reporting |
| Playwright (Chrome) | End-to-end tests in CI: Play all with the transfer views, and a code typed into the view | No issues worth reporting |
| Express 5 | The HTTP server | `res.sendFile` returns 404 for a path inside a dot-directory unless `dotfiles: "allow"` is set |
| TypeScript and typescript-eslint | Strict ESM throughout | `latest` TypeScript was outside typescript-eslint's supported range |
| MCP Inspector, MCPJam | Testing the server and the view in other clients | MCP Inspector worked first time; MCPJam's local inspector needs an account sign-in |

---

## Feature requests

| Request | Why it matters | Urgency |
| --- | --- | --- |
| Step-up authorisation (an approval push or one-time code) before consequential MCP tools, provided by Alexa+ | Voice alone is weak authentication for moving money. We built a server-side code by SMS as a workaround; a platform-level approval in the Alexa app, where nothing is spoken aloud, would be stronger and consistent across add-ons | critical |
| Alexa+ add-on testing available outside the US | Developers in India cannot test an add-on on a device or in the web simulator | important |
| Participants need a sandbox for Alexa+ add-on testing | The track points at the Alexa+ CLI, MCP Toolkit and web simulator, but participants can't get them, so every entry has to build its own stand-in instead of testing the real add-on path | important |
| Per-tool latency and error metrics in the developer console | The 500 ms budget is hard to verify without instrumentation | nice-to-have |
