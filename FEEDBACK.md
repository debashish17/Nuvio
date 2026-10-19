# Product feedback

One section per tool, API, SDK or service used, as the Devpost submission requires: what it was used for, what worked well, what needs work, how onboarding felt, and whether we would build with it again. Dated incidents with steps, workarounds and suggestions are in [`FRICTION_LOG.md`](FRICTION_LOG.md).

---

## MCP TypeScript SDK (`@modelcontextprotocol/sdk` 1.31, Streamable HTTP)

- **Used for:** the whole server: `POST /mcp` in stateless Streamable HTTP mode (spec 2025-11-25), 14 tools registered with zod input schemas, an output schema on `get_rate`, and tool annotations (`readOnlyHint`, `destructiveHint`) that mark the two money-moving tools. Also the simulator's own client side, a relay that calls the server over real JSON-RPC.
- **Worked well:** `registerTool` with zod schemas produces clean JSON Schema in `tools/list`, which both Bedrock's Converse API and OpenAI-compatible endpoints accepted as-is. Stateless mode with JSON responses needed no session store and fits a single small instance. Protocol-version negotiation worked first time with MCP Inspector, and output-schema validation caught a shape mismatch in our own code.
- **Needs work:**
  - The documented stateless idiom doesn't compile under `exactOptionalPropertyTypes`: `sessionIdGenerator: undefined` and the transport's optional callbacks fail to type-check, so we omitted the option and cast `transport as Transport`.
  - With an output schema, a structured refusal (an expected answer such as "currency not supported") fails validation unless the result is marked `isError: true`, which makes a refusal look like a failure. Alternative output shapes, or skipping validation for flagged refusals, would fix it.
- **Onboarding:** quick with the README examples. Strict-TypeScript projects need the type fixes above.
- **Would use again:** yes.

## MCP Apps SDK (`@modelcontextprotocol/ext-apps` 1.7.5)

- **Used for:** the `ui://nuvio-remit/transfer` view, server and host side. On the server: `registerAppResource` and `registerAppTool` link the four transfer tools to the view. In the view: the `App` class (tool input and result handlers, `callServerTool` for the step-up code, `sendMessage`, `updateModelContext`, auto-resize, host theme). In the simulator: `AppBridge` with `PostMessageTransport`, which makes the page an MCP Apps host.
- **Worked well:** The protocol is small and does what we needed. The best part is a path for the step-up code that skips the model entirely: the view calls `confirm_transfer` through the host, so the code is never in the conversation. The server helpers are thin wrappers that only set `_meta`, so adding the view changed no tool schema. The `AppBridge` host side took about 100 lines to wire up, with a null client and our own routing.
- **Needs work:**
  - `latest` (2.x) needs the split MCP SDK v2, and pnpm installed it on SDK 1.31 without an error. We pinned 1.7.5.
  - The `.d.ts` files use extensionless relative imports, so the types silently disappear under `moduleResolution: "nodenext"`. The browser code got its own `bundler` tsconfig.
  - Bundled with zod 4, the view came to 525 KB, 260 KB of it zod's locales. A build plugin that keeps only English brought it to 268 KB.
  - A web host can't render the view with `srcdoc` or a blob URL without inheriting its own CSP. Our page has no inline scripts, so we serve each view from a single-use URL under the CSP built from `_meta.ui.csp`. The spec's sandbox-proxy pattern needs a second origin, which a single local server doesn't have.
- **Onboarding:** good once past the version mismatch; the API reference and the spec agree.
- **Would use again:** yes.

## Amazon Bedrock (Converse API, tool use, Nova 2 Lite)

- **Used for:** the simulator's live assistant: a Converse tool-use loop that calls our MCP server over real JSON-RPC, and conversation evals that play whole remittance journeys and check what the model did and said.
- **Worked well:** Converse is one tool-use interface across models, so switching models is a config value; the same loop now also runs on any OpenAI-compatible endpoint through a small adapter. Nova 2 Lite is inexpensive ($0.33 per million input tokens and $2.75 per million output on the `us.` profile, from the AWS Price List API) and quick, about 0.7 s per call server-side by CloudWatch. It handled 14 tools and multi-step flows reliably after prompt tuning. Amazon models need no access request.
- **Needs work:**
  - The Nova 2 Lite model card gives a bare model id in its us-east-1 sample, but only the `us.` / `global.` inference profiles are invocable there.
  - The prompt-caching docs don't say whether Nova 2 Lite supports explicit cache points, and neither the Converse usage fields nor CloudWatch show whether implicit caching hit. In a tool-use loop every call resends about 3,800 tokens of instructions and tool definitions, which is most of the cost.
  - Out of the box the model paraphrased confirmation read-backs, spoke raw status values ("screening"), and once invented a compliance requirement from a history list. Strict prompt rules and evals fixed all three; guidance for consent-critical, verbatim tool output would help.
- **Onboarding:** smooth once the right model id was known. Local credentials through `aws login` expire often, so a long session needs several sign-ins.
- **Would use again:** yes.

## AWS App Runner and CloudFormation (with GitHub Actions OIDC)

- **Used for:** a deployable setup written as code: one CloudFormation template (ECR repository, generated secrets, App Runner service with a single instance, IAM roles with managed policies, a budget alarm) and a GitHub Actions deploy through OIDC with no stored AWS keys, plus a per-tool latency check from a US runner. We did not create the stack: the hackathon doesn't require hosting (judges run the project locally) and our budget is small.
- **Worked well:** `RuntimeEnvironmentSecrets` keeps secrets out of the image and the template. A single-instance auto-scaling configuration fits a SQLite demo. cfn-lint and cfn-guard (Well-Architected Security Pillar) ran clean and caught an inline-policy issue early. GitHub OIDC needed no long-lived keys.
- **Needs work:** a service can't be created before its image exists in ECR, so the template needs a two-pass bootstrap (`CreateService=false`, push an image, then `true`). A minimum of one provisioned instance bills for idle memory around the clock (about $2.50–5 a month at the smallest sizes), noticeable for a hobby or hackathon budget; a scale-to-zero option would help.
- **Onboarding:** the template reference is thorough; the bootstrap order took some working out.
- **Would use again:** yes, for small containerised services.

## AWS CLI (and the Agent Toolkit for AWS)

- **Used for:** local setup (an IAM user through `aws login`), the AWS Price List API for exact Bedrock, Polly and App Runner prices, CloudWatch and Cost Explorer for actual spend, and the Agent Toolkit's skills and MCP server for AWS guidance.
- **Worked well:** the Price List API gave authoritative prices for every estimate we made, and CloudWatch's Bedrock token metrics matched the Cost Explorer bill to the cent.
- **Needs work:** `aws agent-toolkit list-available-skills` crashes on the Windows console code page (cp1252) when a description contains "→". `aws login` asks an interactive y/n when switching a profile's identity, rejects a piped answer on PowerShell 5.1, and `aws logout` doesn't clear the old identity.
- **Onboarding:** good once the profile was set up; the Windows issues cost about an hour.
- **Would use again:** yes.

## Frankfurter (ECB reference rates)

- **Used for:** live mid-market rates: one request a day-range for every currency against USD, cached for 15 minutes with a seeded offline fallback. AED/INR is derived from USD/INR at the CBUAE peg.
- **Worked well:** free, no key, fast, and the time-series endpoint gives a week's trend in one call.
- **Needs work:** ECB publishes no AED (nor the other Gulf currencies), so our spec's original `from=AED` request could never have worked; it returns a bare "not found" instead of naming the unsupported currency. The `.app` host now redirects to `.dev/v1`, an extra hop on every call that isn't announced on the landing page.
- **Onboarding:** minutes.
- **Would use again:** yes, with the peg derivation.

## Devpost (rules, FAQ, submission)

- **Used for:** the hackathon rules, track descriptions, FAQ, updates and the submission.
- **Worked well:** the FAQ settled the questions that shaped the project: hosting is not required, judges run the code locally, and a simulated Alexa+ experience is acceptable. The judging criteria are clear and weighted equally.
- **Needs work:** the Alexa+ track links to Amazon's Alexa+ CLI, MCP Toolkit and web simulator, but the FAQ later made clear that participants can't get them. We had planned a phase around the CLI before finding that out. Saying it on the track page from day one would save every team that time.
- **Onboarding:** registration and team setup were straightforward.
- **Would use again:** yes.

## Amazon Polly (neural voice, speech marks)

- **Used for:** the simulator's optional voice (Kajal, neural, Indian English), with word speech marks to highlight the read-back as it is spoken. It is switched on only when AWS credentials are available; otherwise the browser's voice is used.
- **Worked well:** a natural Indian English voice, about 1.2 s to synthesise a reply from India, and speech marks that lined up exactly with the text.
- **Needs work:** audio and speech marks are two separate requests, both billed per character, so every highlighted reply costs twice. Speech marks use UTF-8 byte offsets, which JavaScript has to convert for text with "₹" or emoji.
- **Onboarding:** one SDK call, no setup.
- **Would use again:** yes.

---

## Feature requests

| Request | Why it matters | Urgency |
| --- | --- | --- |
| Step-up authorisation (an approval push or one-time code) before consequential MCP tools, provided by Alexa+ | Voice alone is weak authentication for moving money. We built a server-side code by SMS as a workaround; a platform-level approval in the Alexa app, where nothing is spoken aloud, would be stronger and consistent across add-ons | critical |
| Alexa+ add-on testing available outside the US | Developers in India cannot test an add-on on a device or in the web simulator | important |
| Participants need a sandbox for Alexa+ add-on testing | The track points at the Alexa+ CLI, MCP Toolkit and web simulator, but participants can't get them, so every entry has to build its own stand-in instead of testing the real add-on path | important |
| Per-tool latency and error metrics in the developer console | The 500 ms budget is hard to verify without instrumentation | nice-to-have |
