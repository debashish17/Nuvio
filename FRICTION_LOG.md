# Friction log

Append-only. One entry per surprise with any tool, SDK, CLI or AWS service used in this project. Submitted with the Devpost entry (up to +10% judging bonus).

Severity: **blocker** (stopped work), **major** (cost more than 30 min or needed a workaround), **minor** (annoying, cosmetic, docs gap).

---

## Template

### YYYY-MM-DD · <tool or service> · <short title>

- **Task:** what I was trying to do
- **Steps:** what I did, in order
- **Expected:** what should have happened
- **Actual:** what happened instead (paste the exact error if any)
- **Severity:** blocker | major | minor
- **Workaround:** what unblocked me, or "none yet"
- **Suggestion:** one concrete change that would have prevented this

---

## Entries


### 2026-10-01 · pnpm 12 · `pnpm-workspace.yaml` left with a placeholder value, native builds skipped silently

- **Task:** Install the pinned dependencies for the project scaffold.
- **Steps:** `pnpm add` the runtime and dev dependencies on a fresh project.
- **Expected:** Either a prompt to approve build scripts, or a clear failure listing which packages need approval.
- **Actual:** pnpm wrote `allowBuilds: esbuild: set this to true or false` into `pnpm-workspace.yaml` and carried on. `better-sqlite3` was not listed at all, and its native binding (`build/Release`) was never compiled, so it would only fail at runtime.
- **Severity:** minor
- **Workaround:** Set `allowBuilds` to `better-sqlite3: true` and `esbuild: true`, then `pnpm rebuild better-sqlite3`; smoke-tested with an in-memory query.
- **Suggestion:** Treat a placeholder `allowBuilds` value as an install error, and list every package whose build script was skipped at the end of `pnpm add`.

### 2026-10-01 · typescript-eslint 8 / TypeScript 7 · `latest` TypeScript is outside typescript-eslint's supported range

- **Task:** Set up lint and typecheck for the scaffold.
- **Steps:** `pnpm add -D typescript typescript-eslint` with no version ranges.
- **Expected:** The latest versions of both work together, or the install warns about the peer range.
- **Actual:** pnpm installed `typescript@7.0.2`, but `typescript-eslint@8.71.0` declares `typescript: ">=4.8.4 <6.1.0"`. No visible warning in the install output.
- **Severity:** minor
- **Workaround:** Pinned `typescript@~6.0.3`. Also pinned `@types/node@^22` to match the Node 22 LTS runtime (latest was 26).
- **Suggestion:** Show peer-range mismatches in the `pnpm add` summary by default.

### 2026-10-02 · npm `npx` / `devEngines` · `npx` refuses to run local binaries in a pnpm project

- **Task:** Type-check a probe file with the project's local `tsc` during Phase 1 setup.
- **Steps:** `npx tsc --noEmit ...` in a repo whose `package.json` has `devEngines.packageManager: { name: "pnpm", onFail: "download" }`.
- **Expected:** `npx` runs `node_modules/.bin/tsc`, maybe with a warning that the project prefers pnpm.
- **Actual:** `npm error code EBADDEVENGINES ... Invalid name "pnpm" does not match "npm" for "packageManager"` and exit 1. `onFail: "download"` does not apply to npx; nothing runs.
- **Severity:** minor
- **Workaround:** Use `pnpm exec <bin>` for every local binary.
- **Suggestion:** npm should not enforce `devEngines.packageManager` for `npx`/`npm exec` of an already-installed local binary, or should honour `onFail` by warning instead of failing.

### 2026-10-02 · pnpm 12 · `pnpm -s <script>` no longer accepted

- **Task:** Run `db:migrate` and `db:seed` quietly while verifying the Phase 1 seed.
- **Steps:** `pnpm -s db:migrate`.
- **Expected:** Runs the script with the script banner suppressed, as in pnpm 8–10 (`-s` = `--silent`).
- **Actual:** `error: unexpected argument '-s' found` and exit 2. `pnpm run --help` lists only `--loglevel silent`.
- **Severity:** minor
- **Workaround:** `pnpm db:migrate` (banner shown), or `pnpm --loglevel silent run <script>`.
- **Suggestion:** Keep `-s` as an alias, or name the replacement in the error message; this breaks copy-pasted scripts and CI snippets from older docs.

### 2026-10-02 · MCP TypeScript SDK 1.31.0 · Stateless Streamable HTTP example does not compile under `exactOptionalPropertyTypes`

- **Task:** Serve `POST /mcp` with `StreamableHTTPServerTransport` in stateless mode (Phase 1).
- **Steps:** Followed the JSDoc/README pattern `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` then `server.connect(transport)`, in a TypeScript strict project with `exactOptionalPropertyTypes: true`.
- **Expected:** The documented stateless idiom type-checks; the SDK's own transport is assignable to the SDK's own `Transport` interface.
- **Actual:** `TS2379 ... Types of property 'sessionIdGenerator' are incompatible. Type 'undefined' is not assignable to type '() => string'`, and on `connect`: `Types of property 'onclose' are incompatible. Type '(() => void) | undefined' is not assignable to type '() => void'`.
- **Severity:** minor
- **Workaround:** Omit `sessionIdGenerator` entirely (the runtime only checks for `undefined`), and cast `transport as Transport` at `connect()` with a comment.
- **Suggestion:** Declare optional options and `Transport` callbacks as `prop?: T | undefined` so the SDK compiles under `exactOptionalPropertyTypes`, and add that flag to the SDK's own type tests.

### 2026-10-02 · Frankfurter API · No AED quotes; `.app` host now redirects to `.dev/v1`

- **Task:** Confirm the rates endpoint in SPEC.md (`https://api.frankfurter.app/latest?from=AED&to=INR`) before building `RatesService` in Phase 2.
- **Steps:** `curl -L` the SPEC URL, the same for `from=USD`, and `/currencies`.
- **Expected:** An AED→INR mid-market rate.
- **Actual:** `from=AED` returns HTTP 404 `{"message":"not found"}`. AED is not in `/currencies` (the ECB reference set has no dirham), so the SPEC fetch could never succeed and would always fall back to the seeded table. Every request to `api.frankfurter.app` also gets a redirect to `https://api.frankfurter.dev/v1/...`; the first call took 0.83 s against 0.17 s without the extra hop. Live USD→INR on 2026-10-01 was 96.33, so AED→INR ≈ 26.23, far from the 23.42 used in the SPEC examples and the placeholder seed.
- **Severity:** major (the design's only live dependency did not cover the corridor)
- **Workaround:** Pending a decision; candidate is USD→INR from Frankfurter divided by the CBUAE peg of 3.6725 AED/USD, with `RATES_URL` pointed straight at `https://api.frankfurter.dev/v1`.
- **Suggestion:** Return a 400 naming the unsupported currency and listing `/currencies` instead of a bare "not found", and document the `.app` → `.dev/v1` move on the landing page.

### 2026-10-02 · Amazon Bedrock docs · Nova 2 Lite model card contradicts itself on the model id

- **Task:** Confirm the Bedrock model id for the simulator before the first Converse call (Phase 3).
- **Steps:** Read the Nova 2 Lite model card (docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-2-lite.html).
- **Expected:** One id that works in us-east-1.
- **Actual:** The Regional availability table marks us-east-1 **In-Region: no**, Geo and Global: yes, so only the inference profiles `us.amazon.nova-2-lite-v1:0` / `global.amazon.nova-2-lite-v1:0` work there. The sample code on the same page calls `modelId='amazon.nova-2-lite-v1:0'` with `region_name='us-east-1'`. A third-party catalogue reports the bare id returns a validation error. Our SPEC default was the bare id.
- **Severity:** minor (caught before the first call)
- **Workaround:** Default `BEDROCK_MODEL_ID` to `us.amazon.nova-2-lite-v1:0`; the App Runner role must allow the inference profile and the foundation model in its destination Regions (us-east-1, us-east-2, us-west-2).
- **Suggestion:** Make the sample code use the inference-profile id wherever In-Region is unavailable, and name the profile in the error message when a bare id is not invocable.

### 2026-10-02 · AWS CLI 2.37.8 (Agent Toolkit) · `list-available-skills` crashes on the Windows console code page

- **Task:** Verify the AWS Agent Toolkit install (setup step 6) on Windows 11, PowerShell 5.1.
- **Steps:** `aws agent-toolkit list-available-skills --region us-east-1 --profile acme-remit --output json`.
- **Expected:** The JSON catalog of skills.
- **Actual:** The service call succeeds and output starts streaming, then the CLI aborts with exit code 255: `aws: [ERROR]: 'charmap' codec can't encode character '→' in position 878: character maps to <undefined>`. A skill description contains `→`, which the default Windows console encoding (cp1252) cannot represent; the bundled Python writes with that encoding instead of UTF-8.
- **Severity:** minor
- **Workaround:** Set `PYTHONUTF8=1` (or `PYTHONIOENCODING=utf-8`) before running the command, then the full catalog (114 skills) prints and the exit code is 0.
- **Suggestion:** Have the CLI write UTF-8 (or fall back to escaped characters) regardless of the console code page, and keep non-ASCII punctuation out of skill descriptions until then.

### 2026-10-02 · AWS CLI 2.37.8 `aws login` · Switching a profile's identity needs an interactive y/n, and `aws logout` doesn't clear it

- **Task:** Move the `acme-remit` profile from the root user to a new IAM user (`debashish`) after creating that user.
- **Steps:** `aws login --region us-east-1 --profile acme-remit` from a non-interactive agent shell; then the same with `"y" |` piped in (Windows PowerShell 5.1); then `aws logout --profile acme-remit` and `aws login` again.
- **Expected:** A flag to accept the switch non-interactively, or `aws logout` returning the profile to a clean state.
- **Actual:** After a successful browser sign-in, the CLI asks `Profile acme-remit is already configured to use session arn:aws:iam::…:root. Do you want to overwrite it …? (y/n):` and with no stdin fails with `aws: [ERROR]: EOF when reading a line` (exit 255). Piping `y` from PowerShell 5.1 sends `y\r\n` and is rejected as `Invalid response`. `aws logout` clears the cached token but leaves `login_session = arn:…:root` in `~/.aws/config`, so the prompt returns. Each failed attempt costs the user another browser sign-in.
- **Severity:** minor
- **Workaround:** `aws logout --profile <name>`, delete the `login_session` line from `~/.aws/config`, then `aws login` — no prompt.
- **Suggestion:** Add `--yes`/`--overwrite` to `aws login`, ask before opening the browser rather than after, trim `\r` from the answer, and have `aws logout` remove `login_session` too.

### 2026-10-02 · Amazon Bedrock prompt caching docs · Nova 2 Lite's explicit caching support is not stated

- **Task:** Cut voice-turn latency in `/sim/chat`. Every Converse call resends about 6,000 tokens of system prompt and tool specs, and a turn makes 2 to 4 calls (5 to 15 s per turn from India).
- **Steps:** Read the Bedrock user guide "Prompt caching for faster model inference" and the Nova model cards, looking for `cachePoint` support for `us.amazon.nova-2-lite-v1:0`.
- **Expected:** Nova 2 Lite in the "Supported models, Regions, and explicit caching limits" table, with its minimum tokens and the fields that accept checkpoints, as the Nova Lite (v1) card lists them (`system` and `messages`, 1K minimum, 5 minutes).
- **Actual:** The table lists only Claude and GPT models. The page says Nova offers implicit caching for all text prompts, and that Nova models "shown as supporting Explicit Prompt Caching in their model cards" also take checkpoints. The Nova 2 Lite pages found by search don't say either way, and the Converse response fields we read (`inputTokens`, `outputTokens`) don't show whether implicit caching hit.
- **Severity:** minor
- **Workaround:** None added. We rely on implicit caching and keep the system prompt and tool list byte-identical between calls, so the prefix can match.
- **Suggestion:** Put every Nova model, including Nova 2, in the explicit-caching table (or say "implicit only"), and document whether `cacheReadInputTokens` reports implicit hits in Converse.

### 2026-10-03 · pnpm 12.8.1 (via corepack) on Windows 11 · the native pnpm binary stopped launching mid-session

- **Task:** Add `@aws-sdk/client-polly` for the simulator's Polly voice; earlier, run `pnpm test` / `pnpm lint`.
- **Steps:** `pnpm add @aws-sdk/client-polly@^3.1143.0` (and earlier `pnpm exec prettier ...`) from Git Bash; then running `%LOCALAPPDATA%\node\corepack\v1\pnpm\12.8.1\pnpm-native.exe --version` directly.
- **Expected:** pnpm runs, as it had all session.
- **Actual:** `Could not run the pnpm binary at ...\pnpm-native.exe: spawnSync ... UNKNOWN`; running the exe directly gives `Permission denied`. The first failure came while the machine was at 0.7 GB of free RAM; it persisted at 2 GB free. pnpm 12 under corepack is a 55 MB native exe downloaded into the user profile on first use (`bin/pnpm.mjs` explains this), which is the kind of file endpoint protection or Smart App Control can start blocking. Cause not confirmed.
- **Severity:** major (blocks adding a dependency; `pnpm-lock.yaml` must change for CI's `--frozen-lockfile`)
- **Workaround:** Run tools through Node directly (`node node_modules/vitest/vitest.mjs run`, `node node_modules/typescript/bin/tsc --noEmit`, `node node_modules/eslint/bin/eslint.js .`, `node node_modules/tsup/dist/cli-default.js`). Adding a dependency is left to the user (check Windows Security > Protection history, then `pnpm add` in their own terminal).
- **Suggestion:** pnpm: fall back to the JS implementation when the native binary can't be spawned, and say why (the UNKNOWN errno hides an access-denied). Corepack: show where the downloaded binary lives and how to re-verify it.

### 2026-10-04 · Devpost / Alexa+ track resources · The linked Alexa+ toolchain isn't available to participants

- **Task:** Plan the Alexa+ integration (SPEC Phase 4: `alexa-ai configure`, `alexa-ai new mcp` against our server, `addon.json`, icons, `alexa-ai deploy`, test in Amazon's web simulator).
- **Steps:** Read the Alexa+ track page and its linked resources, then the hackathon FAQ.
- **Expected:** Participants can install the Alexa+ CLI and MCP Toolkit and test an add-on in Amazon's web simulator, as the track resources suggest.
- **Actual:** The FAQ says participants cannot get the Alexa+ CLI, the MCP Toolkit or the web simulator. Hosting is not required either: judges clone the repo and run it locally, without AWS credentials or Bedrock access. Our plan had a whole phase built around the CLI, and our simulator assumed Bedrock.
- **Severity:** major (it changed the demo path and the run requirements three weeks before the deadline)
- **Workaround:** Our own web simulator is the demo path. A scripted mode runs the whole demo through the real MCP tools with no language model and no AWS account; Bedrock or any OpenAI-compatible key turns on the live model.
- **Suggestion:** State on the track page from day one which Amazon tools participants can and can't use, and offer a sandbox for add-on testing.

### 2026-10-03 · @modelcontextprotocol/ext-apps (MCP Apps SDK) · `latest` needs the v2 MCP SDK, and pnpm installed it anyway

- **Task:** Add the official MCP Apps SDK for the transfer view (`ui://acme-remit/transfer`).
- **Steps:** `pnpm add @modelcontextprotocol/ext-apps`, then read the installed package's `peerDependencies`.
- **Expected:** The `latest` tag works with `@modelcontextprotocol/sdk` 1.x, which is the stable SDK and what the MCP Apps docs use in their examples (`McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`).
- **Actual:** `latest` is 2.0.3. Its peers are `@modelcontextprotocol/server`, `client` and `core` ^2.0.0, the split packages of MCP SDK v2. We are on `@modelcontextprotocol/sdk` 1.31 (CLAUDE.md pins 1.x). pnpm added 2.0.3 with no error, so the mismatch only showed when we read the peer list. The 1.x line (1.7.5) peers on `@modelcontextprotocol/sdk` ^1.29.0 and has the same `registerAppTool`, `registerAppResource`, `App` and `AppBridge` APIs.
- **Severity:** minor (caught before any code; easy to miss)
- **Workaround:** Pin `@modelcontextprotocol/ext-apps@^1.7.5`.
- **Suggestion:** ext-apps: say on the README which major goes with which MCP SDK, or keep `latest` on the line that matches the stable SDK until v2 is the default. pnpm: fail (or warn loudly) on an unmet non-optional peer by default.

### 2026-10-03 · @modelcontextprotocol/ext-apps 1.7.5 + zod 4 · A one-card view bundles to 525 KB, half of it zod's translations

- **Task:** Bundle the transfer view (`App` class plus about 300 lines of our code) into the single HTML file an MCP Apps resource must be.
- **Steps:** esbuild (through tsup) with `platform: "browser"`, minified, all dependencies bundled; then an esbuild metafile to see where the bytes went.
- **Expected:** Something near the SDK's own prebuilt `app-with-deps.js` (330 KB), or less with tree shaking.
- **Actual:** 525 KB. 260 KB is `zod/v4/locales`: zod 4 classic re-exports every locale from its namespace (`export * as locales`), and the MCP SDK's schemas use that namespace, so no bundler can drop the ~50 languages. Another 144 KB is zod core. The simulator's host bundle (`AppBridge`) had the same shape.
- **Severity:** minor (works; a heavy resource for every host to fetch and every iframe to parse)
- **Workaround:** A 15-line esbuild plugin in `scripts/build-ui.ts` swaps `locales/index.js` for one that exports only `en` (English is zod's default; nothing picks a locale). 268 KB for the view, 247 KB for the host bridge.
- **Suggestion:** ext-apps: build the browser entry points on `zod/mini`, or ship a size budget for `App`. zod: keep locales out of the classic namespace (opt in with `z.config(z.locales.xx())` from a separate entry).

### 2026-10-03 · @modelcontextprotocol/ext-apps 1.7.5 type declarations · Types go missing under `moduleResolution: "nodenext"`

- **Task:** Typecheck the view and host code that imports `McpUiHostContext` and `AppBridge` from the SDK.
- **Steps:** `tsc --noEmit` with our root settings (`module`/`moduleResolution` `nodenext`, as the server uses).
- **Expected:** The types resolve, as the server-side entry (`/server`) does.
- **Actual:** `error TS2460: Module '"@modelcontextprotocol/ext-apps"' declares 'McpUiHostContext' locally, but it is exported as 'ProtocolWithEvents'`, `Property 'close' does not exist on type 'AppBridge'`, and implicit `any`s in handler parameters. The package's `.d.ts` files use extensionless relative imports (`from "./types"`), which `nodenext` cannot follow, so the re-exports silently become nothing.
- **Severity:** minor (confusing message that points at the wrong export)
- **Workaround:** The browser code has its own `src/ui/tsconfig.json` with `module: esnext` and `moduleResolution: bundler` (it is bundled by esbuild anyway). Root typecheck excludes `src/ui`; `pnpm typecheck` runs both.
- **Suggestion:** ext-apps: emit declarations with `.js` extensions (or run `attw` / `publint` in CI) so the package types work under every resolution mode it advertises.

### 2026-10-03 · Express 5 `res.sendFile` · 404 for an absolute path inside a dot-directory

- **Task:** Serve the simulator's MCP Apps host bundle, built to `.generated/ui/app-host.js`, at `/js/app-host.js`.
- **Steps:** `res.sendFile(absolutePath)`, where the path comes from the server, not from the request; then load the page.
- **Expected:** The file is sent: the app chose an absolute path, so there is no traversal to guard against.
- **Actual:** `NotFoundError: Not Found`. `send` treats any path segment that starts with a dot as a dotfile and ignores it by default (`dotfiles: "ignore"`), even for the parent directory of an absolute path the app passed in. The error does not say why, so it looked like a wrong path.
- **Severity:** minor
- **Workaround:** `res.sendFile(path, { dotfiles: "allow" })` for that one route (the path is fixed; nothing from the request reaches it).
- **Suggestion:** Express: apply the dotfiles rule only to the part of the path below `root` (or to request-derived segments), and say "dotfile ignored" in the error.

### 2026-10-04 · MCPJam Inspector (`@mcpjam/inspector@latest`) and the ext-apps reference host · Testing the MCP Apps view in a third-party host

- **Task:** Check that `ui://acme-remit/transfer` works in a third-party MCP Apps host, not only in our simulator, with no paid model calls.
- **Steps:** `npx @mcpjam/inspector@latest --url http://127.0.0.1:3000/mcp --bearer <token> --no-open`, then open the printed link. Then the official reference host: `ext-apps/examples/basic-host` with `SERVERS='["http://localhost:3001/mcp"]' npm run start`.
- **Expected:** MCPJam, documented as a local tool for testing MCP Apps, opens on the tools tab without an account. The reference host connects with a header, as Streamable HTTP clients usually can.
- **Actual:**
  - MCPJam redirects the local inspector to `login.mcpjam.com` (email, Google or GitHub), with no way past it without an account.
  - `--help` isn't a flag: it starts the inspector and opens the default browser.
  - The signed link's `#token=` fragment is lost if the URL goes through Chrome's `/json/new?` endpoint.
  - The reference host builds `new StreamableHTTPClientTransport(serverUrl)` with no headers and calls the server from the browser. A server that needs a Bearer token and sends no CORS headers (ours, because Alexa+ calls it server to server) is unreachable from it.
- **Severity:** minor (the view itself worked; the hosts needed workarounds)
- **Workaround:** `scripts/host-proxy.mjs`, a local proxy that adds the Bearer header and CORS. Through it the reference host ran the whole flow: quote, read-back (Confirm arrived as `ui/message`), the step-up code typed into the view, confirm through the host's `AppBridge`, the live receipt to Paid out, and `ui/update-model-context`. MCPJam is left at its sign-in screen.
- **Suggestion:** MCPJam: keep a no-account mode for local servers, and support `--help`. ext-apps basic-host: accept headers per server in `SERVERS` (e.g. `{ "url": ..., "headers": {...} }`) so it can test authenticated servers.

### 2026-10-04 · npm CLI publish (`npm publish`, registry.npmjs.org) · A first publish fails with a 403 that blames dependencies

- **Task:** Publish `packages/mcp-confirm-gate` 0.1.0 for the Open Source mini challenge.
- **Steps:** `npm login`, then `npm publish` from the package folder; `prepublishOnly` built it and the tarball was assembled (9 files, 7.0 kB).
- **Expected:** The package is published, or a clear message saying the account needs two-factor authentication first.
- **Actual:** `E403 403 Forbidden - PUT https://registry.npmjs.org/mcp-confirm-gate - Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.` The next lines say "In most cases, you or one of your dependencies are requesting a package version that is forbidden by your security policy, or on a server you do not have access to", which doesn't apply to a publish and sends you looking at dependencies. `npm login` had succeeded without mentioning that publishing needs 2FA.
- **Severity:** minor (blocks publishing until 2FA is set up; about 5 minutes)
- **Workaround:** Turned on 2FA on the npm account, then ran `npm publish` again. It printed an `npmjs.com/auth/cli/...` link, opened the browser to confirm, and published 0.1.0. We did not use a bypass-2FA token.
- **Suggestion:** npm CLI: on this 403, drop the generic dependency text and link the 2FA settings page; have `npm login` warn when the account cannot publish. Registry: say whether the policy applies to all publishes or only new packages.

### 2026-10-05 · npm CLI 10.9.8 publish (`mcp-confirm-gate` 0.2.0) · An expired login looks like a missing package, 2FA needs a terminal, and a publish isn't listed straight away

- **Task:** Publish the 0.2.0 security fix and deprecate 0.1.0.
- **Steps:**
  - `npm publish` from a shell whose saved token was two days old.
  - Then `npm login`, and `npm publish` again from a non-interactive shell.
  - Then `npm publish` from PowerShell, with browser approval.
- **Expected:**
  - An expired login says to log in again.
  - The 2FA step works wherever `npm publish` runs.
  - A successful publish is listed at once.
- **Actual:**
  1. With the expired token, `npm whoami` was a 401, but `npm publish` failed with `E404 ... 'mcp-confirm-gate@0.2.0' is not in this registry`, which looks like a wrong package name.
  2. From a non-interactive shell, the publish failed with `EOTP` ("requires a one-time password from your authenticator"), even though the account confirms 2FA in the browser. The browser step ("Authenticate your account at …") appears only in a TTY.
  3. After approval, the upload returned `PUT 202` with "Your package is being processed and may take a few minutes to become available". For about 4 minutes the registry listed only 0.1.0, while the deprecation of 0.1.0 made at the same time was already visible.
- **Severity:** minor (about 20 minutes, mostly in working out the first error)
- **Workaround:**
  - `npm whoami` first: a 401 means log in again (`npm login`).
  - Publish from an interactive terminal.
  - Check the registry directly (`curl https://registry.npmjs.org/<name>`) and wait for processing.
- **Suggestion:** npm CLI:
  - report "not logged in or token expired" on a PUT 404 when `whoami` would 401
  - say that web 2FA needs an interactive terminal, and offer the URL anyway
  - print the "being processed" notice in the terminal output (it is in the debug log), with an expected wait

### 2026-10-19 · GitHub repository rename and Actions OIDC · A renamed repository silently switches to the immutable subject claim format

- **Task:** Point the CloudFormation OIDC trust (`infra/nuvio-remit.yaml`, `GitHubDeployRole`) at the repository after renaming it from `acme-remit` to `Nuvio`.
- **Steps:**
  - Renamed the repository in GitHub settings.
  - Planned to change the `GitHubRepo` parameter to `Nuvio`, so the trust condition reads `repo:debashish17/Nuvio:ref:refs/heads/main`.
  - Checked the claim first: `gh api repos/debashish17/Nuvio/actions/oidc/customization/sub`.
- **Expected:** After a rename, only the repository name in the `sub` claim changes.
- **Actual:** The API returned `"use_immutable_subject": true` and `"sub_claim_prefix": "repo:debashish17@135945553/Nuvio@1400521880"`. GitHub's changelog of 2026-04-23 says renames and transfers after July 15, 2026 adopt the immutable format. The rename dialog doesn't mention this. A trust condition built from the plain new name would refuse every token, and the error would be a generic `Not authorized to perform sts:AssumeRoleWithWebIdentity`.
- **Severity:** minor (caught before the first deploy; the stack has never been created). On a live deploy it would have been major.
- **Workaround:** Set the template's `GitHubOwner` and `GitHubRepo` defaults to the `name@id` parts of `sub_claim_prefix` (`debashish17@135945553`, `Nuvio@1400521880`). This changes no other part of the template.
- **Suggestion:** GitHub: say in the rename and transfer dialogs that OIDC subject claims will change format, show the new prefix there, and link the customization endpoint. AWS: mention the immutable `name@id` format in the IAM guide for GitHub OIDC trust policies.
