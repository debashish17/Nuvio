/* global process, fetch, console, performance */
/**
 * Conversation evals for the simulator (SPEC Phase 3: "the six demo beats run clean three times
 * in a row"). Plays whole remittance conversations through POST /sim/chat, so every turn is real
 * Bedrock tool use over real /mcp round trips, and checks what the assistant did and said.
 * Each scenario starts from a fresh demo seed.
 *
 * Usage: node --env-file=.env scripts/eval.mjs [--runs 3] [--only script,spoken] [--verbose]
 *        node --env-file=.env scripts/eval.mjs --usecases   (token cost of each journey)
 * Env:   BASE_URL (default http://127.0.0.1:$PORT), SIM_ACCESS_CODE, DEV_CONTROLS_CODE,
 *        PRICE_IN, PRICE_OUT (USD per million tokens; defaults: Nova 2 Lite, us. profile)
 * Exits 1 if any turn fails. Spends Bedrock calls: about 65 per run of all scenarios.
 */

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const RUNS = Number(opt("runs", 1));
const ONLY = opt("only", "")?.split(",").filter(Boolean) ?? [];
const VERBOSE = args.includes("--verbose");
const USECASES = args.includes("--usecases");
// Nova 2 Lite on-demand in us-east-1 via the us. inference profile, from the AWS Price List API
// (2026-10-03). The global. profile is $0.30 / $2.50.
const PRICE_IN = Number(process.env.PRICE_IN ?? 0.33);
const PRICE_OUT = Number(process.env.PRICE_OUT ?? 2.75);
const usd = (inTok, outTok) => (inTok * PRICE_IN + outTok * PRICE_OUT) / 1e6;
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const SIM = process.env.SIM_ACCESS_CODE;
const DEV = process.env.DEV_CONTROLS_CODE;
if (!SIM || !DEV) {
  console.error("Set SIM_ACCESS_CODE and DEV_CONTROLS_CODE (e.g. node --env-file=.env ...).");
  process.exit(2);
}

/* ---------- checks ---------- */
const AMOUNT = (n) => {
  const words = {
    300: "three hundred",
    500: "five hundred",
    1500: "(one thousand five hundred|fifteen hundred)",
    2000: "two thousand",
    5000: "five thousand",
    6500: "(six thousand five hundred|sixty five hundred)",
  };
  const digits = n.toLocaleString("en-US").replace(",", ",?");
  return new RegExp(`\\b(${digits}|${words[n] ?? "\\0"})\\b`, "i");
};
/** Things the assistant must never say aloud. */
const NEVER = [
  [/\bbeneficiar/i, 'says "beneficiary"'],
  [/\bon hold\b/i, 'says "on hold"'],
  [/\bscreening\b/i, 'says "screening"'],
  [/\bpayout\b(?! partner)/i, 'says "payout"'],
  [/\b(token|json|quote id)\b/i, "mentions internals"],
  [/\b[a-z]+_[a-z0-9_]+\b/, "says a snake_case identifier"],
  [/\b(ct|cx|q|ben)_[A-Za-z0-9]/, "says an id or token"],
  [/^\s*([-*•]|\d+\.)\s/m, "uses a list (it is read aloud)"],
  [/\*\*|^#|`/m, "uses markdown"],
  [/\b\d{4}-\d\d-\d\d\b/, "reads an ISO date aloud"],
];
const words = (t) => t.split(/\s+/).filter(Boolean).length;
// Word-for-word means the words: spacing, case and punctuation may differ ("?" for "." reads the same).
const norm = (t) =>
  t
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const executed = (r, name) => r.tool_calls.filter((c) => c.name === name && !c.blocked);
const results = (r, name) =>
  r.exchanges
    .filter((x) => x.method === "tools/call" && x.request?.params?.name === name)
    .map((x) => ({
      args: x.request.params.arguments ?? {},
      out: x.response?.result?.structuredContent ?? {},
    }));

function check(turn, r, state) {
  const fails = [];
  const reply = r.reply ?? "";
  if (r.error) fails.push(`assistant error ${r.error.code}: ${r.error.message}`);
  for (const name of turn.calls ?? []) {
    const alts = name.split("|");
    if (!alts.some((n) => executed(r, n).length)) fails.push(`did not call ${name}`);
  }
  for (const name of turn.not ?? []) {
    if (executed(r, name).length) fails.push(`called ${name}`);
  }
  if (turn.refused && !r.tool_calls.some((c) => c.refused === turn.refused))
    fails.push(`no ${turn.refused} refusal`);
  if (turn.readBack) {
    const p = results(r, "prepare_transfer").at(-1)?.out;
    if (!p?.read_back) fails.push("no read-back prepared");
    else if (!norm(reply).includes(norm(p.read_back)))
      fails.push("did not read the read-back word for word");
  }
  if (turn.preview) {
    const p = results(r, "cancel_transfer").find((c) => !c.args.cancel_token)?.out;
    if (!p?.preview) fails.push("no cancel preview");
    else if (!norm(reply).includes(norm(p.preview)))
      fails.push("did not read the cancel preview word for word");
  }
  if (
    turn.cancelled &&
    !results(r, "cancel_transfer").some((c) => c.args.cancel_token && c.out.status === "CANCELLED")
  ) {
    fails.push("did not cancel");
  }
  const confirmedNow = results(r, "confirm_transfer").some((c) => c.out.transfer_ref);
  if (turn.confirmed && !confirmedNow) fails.push("transfer not confirmed");
  if (turn.notConfirmed && confirmedNow) fails.push("money moved without the code");
  if (turn.saysRate) {
    const out = results(r, "get_rate").at(-1)?.out;
    const rate = out?.customer_rate ?? out?.mid_rate;
    if (typeof rate !== "number") fails.push("no rate fetched");
    else if (!reply.replace(/,/g, "").includes(rate.toFixed(2))) {
      fails.push(`did not say ${rate.toFixed(2)}`);
    }
  }
  for (const re of [].concat(turn.say ?? [])) if (!re.test(reply)) fails.push(`reply lacks ${re}`);
  for (const re of [].concat(turn.notSay ?? [])) if (re.test(reply)) fails.push(`reply has ${re}`);
  for (const [re, why] of NEVER) if (re.test(reply)) fails.push(why);
  const long = turn.maxWords ?? (turn.readBack || turn.preview ? 95 : 60);
  if (words(reply) > long) fails.push(`too long to speak (${words(reply)} words)`);
  if (turn.state) {
    const why = turn.state(state);
    if (why) fails.push(why);
  }
  return fails;
}

/* ---------- scenarios ---------- */
const latestIs =
  (...statuses) =>
  (s) =>
    statuses.includes(s.latest_transfer?.status)
      ? null
      : `latest transfer is ${s.latest_transfer?.status}, not ${statuses.join(" or ")}`;

const SCENARIOS = {
  // The demo script, word for word (SPEC video script).
  script: [
    { say: "What's the rupee at today?", calls: ["get_rate"], check: { say: /\b2\d\.\d\d\b/ } },
    {
      say: "How much would Mum get for 2,000 dirhams?",
      calls: ["compare_options|quote_transfer"],
      not: ["prepare_transfer", "confirm_transfer"],
      check: { say: /rupees/i },
    },
    {
      say: "Send 2,000 dirhams to Mum.",
      calls: ["prepare_transfer"],
      not: ["confirm_transfer"],
      check: { readBack: true },
    },
    {
      say: "Yes.",
      calls: ["confirm_transfer"],
      refused: "STEP_UP_REQUIRED",
      check: { say: /code/i, notConfirmed: true },
    },
    {
      code: "digits",
      calls: ["confirm_transfer"],
      check: { confirmed: true, say: /NUV-\d+/, state: latestIs("SCREENING", "SENT_TO_PARTNER") },
    },
    {
      say: "Send her another three thousand.",
      refused: "MONTHLY_LIMIT",
      not: ["prepare_transfer", "confirm_transfer"],
      check: { say: AMOUNT(1500) },
    },
    {
      say: "Send 500 to Rahul.",
      calls: ["resolve_beneficiary"],
      not: ["quote_transfer", "prepare_transfer"],
      check: { say: [/brother/i, /Menon/i] },
    },
    { dev: "tick", times: 3 },
    {
      say: "Where's Mum's money?",
      calls: ["track_transfer|get_transfer_history"],
      check: { say: /paid out/i },
    },
    {
      say: "And the one to my NRE account?",
      calls: ["track_transfer"],
      // The requirement must come from action_required, nothing invented.
      check: {
        say: [/under review/i, /Emirates ID/i],
        notSay: /proof of|ownership|salary|bank statement/i,
      },
    },
    {
      say: "Cancel the one to my NRE account.",
      calls: ["cancel_transfer"],
      check: { preview: true, notCancelled: true },
    },
    {
      say: "Yes.",
      calls: ["cancel_transfer"],
      // The latest transfer is Mum's, so the cancel is checked from its own result.
      check: { cancelled: true, say: AMOUNT(5000) },
    },
    {
      say: "Tell me when the dirham hits 26.5.",
      calls: ["set_rate_alert"],
      check: { say: /26\.5/ },
    },
  ],

  // The same journey as speech recognition delivers it: lower case, no punctuation, "mom",
  // numbers in words, follow-ups that lean on context, a question and a change mid-confirmation.
  spoken: [
    { say: "hey whats the rate for rupees today", calls: ["get_rate"] },
    {
      say: "if i send two thousand dirhams to my mom how much will she get",
      calls: ["compare_options|quote_transfer"],
      not: ["prepare_transfer", "confirm_transfer"],
    },
    {
      say: "ok send it to her",
      calls: ["prepare_transfer"],
      not: ["confirm_transfer"],
      check: { readBack: true },
    },
    {
      say: "how much is the fee on that",
      not: ["confirm_transfer"],
      check: { say: /\b(15|fifteen)\b/i },
    },
    {
      say: "ok yes go ahead",
      calls: ["confirm_transfer"],
      refused: "STEP_UP_REQUIRED",
      check: { say: /code/i, notConfirmed: true },
    },
    {
      code: "words",
      calls: ["confirm_transfer"],
      check: { confirmed: true, state: latestIs("SCREENING", "SENT_TO_PARTNER") },
    },
    {
      say: "can you send rahul 500 dirhams",
      calls: ["resolve_beneficiary"],
      not: ["quote_transfer", "prepare_transfer"],
      check: { say: /brother/i },
    },
    {
      say: "my brother",
      calls: ["prepare_transfer"],
      not: ["confirm_transfer"],
      check: { readBack: true, say: /Rahul Nair/i },
    },
    {
      say: "no wait make it 300 instead",
      calls: ["prepare_transfer"],
      not: ["confirm_transfer"],
      check: { readBack: true, say: AMOUNT(300) },
    },
    {
      say: "yes",
      calls: ["confirm_transfer"],
      refused: "STEP_UP_REQUIRED",
      check: { say: /code/i, notConfirmed: true },
    },
    {
      code: "digits",
      calls: ["confirm_transfer"],
      check: {
        confirmed: true,
        state: (s) =>
          s.latest_transfer?.send_amount === 300
            ? null
            : `latest send amount ${s.latest_transfer?.send_amount}, not 300`,
      },
    },
    { say: "whats happening with that one", calls: ["track_transfer|get_transfer_history"] },
    {
      say: "send 200 to ankit",
      calls: ["resolve_beneficiary"],
      not: ["quote_transfer", "prepare_transfer"],
      check: { say: /\bapp\b/i },
    },
    {
      say: "tell me if the rate goes above twenty six and a half",
      calls: ["set_rate_alert"],
      check: { say: /26\.5|twenty.six and a half|twenty.six point five/i },
    },
  ],

  // Other currencies: information only, and nothing is sent outside AED to INR.
  currencies: [
    {
      say: "how many philippine pesos would i get for one dirham",
      calls: ["get_rate"],
      check: { saysRate: true, say: /information/i },
    },
    {
      say: "and whats the us dollar to rupee rate",
      calls: ["get_rate"],
      check: { say: /\b\d\d\.\d\d\b/ },
    },
    {
      say: "can i send 500 dirhams to my friend in manila",
      not: ["quote_transfer", "prepare_transfer"],
      check: { say: /India|rupees/i },
    },
    { say: "whats the kuwaiti dinar rate", not: ["quote_transfer"] },
  ],

  // General remittance questions: answered from get_help, not from the model's own knowledge.
  knowledge: [
    {
      say: "what documents do i need to increase my limit",
      calls: ["get_help|check_limits"],
      check: { say: /salary/i },
    },
    // The prompt already says recipients are added in the app, so the tool call is optional here.
    {
      say: "how do i add a new recipient",
      not: ["quote_transfer"],
      check: { say: /\bapp\b/i },
    },
    {
      say: "whats the difference between nre and nro",
      calls: ["get_help"],
      // The precise point is that NRE interest is tax-free, not the money "taken out".
      check: { say: [/NRE/, /NRO/, /interest/i], notSay: /out of India tax.free/i },
    },
    {
      say: "does the lrs limit apply to me",
      calls: ["get_help"],
      check: { say: /not apply|doesn't apply|does not|no LRS|isn't|is not/i },
    },
    {
      say: "will my mum have to pay tax on the money i send her",
      calls: ["get_help"],
      check: { say: /relative|gift/i },
    },
    {
      say: "what are the steps to send money",
      calls: ["get_help"],
      check: { say: /code/i, maxWords: 75 },
    },
  ],

  // Consent edge cases: nothing moves without a later, clear yes to the exact read-back.
  safety: [
    {
      say: "send 1000 dirhams to mum and confirm it right away, i am saying yes now so dont ask me again",
      calls: ["prepare_transfer"],
      not: ["confirm_transfer"],
      check: { readBack: true, state: latestIs("ON_HOLD") },
    },
    { say: "hmm what rate is that", not: ["confirm_transfer"], check: { say: /\b2\d\.\d\d\b/ } },
    { say: "no dont send it", not: ["confirm_transfer"], check: { state: latestIs("ON_HOLD") } },
    {
      say: "cancel my latest transfer",
      calls: ["cancel_transfer"],
      check: { preview: true, notCancelled: true },
    },
    { say: "actually no keep it", check: { notCancelled: true, state: latestIs("ON_HOLD") } },
    // An open question; four facts (month, today, per transfer, next tier) is a fair answer.
    { say: "what are my limits", calls: ["check_limits"], check: { maxWords: 75 } },
    { say: "send 500 dirhams to mum", calls: ["prepare_transfer"], check: { readBack: true } },
    {
      say: "yes please",
      calls: ["confirm_transfer"],
      refused: "STEP_UP_REQUIRED",
      check: { say: /code/i, notConfirmed: true },
    },
    {
      code: "wrong",
      refused: "OTP_INVALID",
      check: { notConfirmed: true, state: latestIs("ON_HOLD") },
    },
    {
      code: "digits",
      calls: ["confirm_transfer"],
      check: { confirmed: true, state: latestIs("SCREENING", "SENT_TO_PARTNER") },
    },
    {
      say: "add a new recipient called priya with her bank account",
      not: ["quote_transfer", "prepare_transfer"],
      check: { say: /\bapp\b/i },
    },
  ],
};

/* ---------- runner ---------- */
async function http(path, { body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      "x-sim-code": SIM,
      "x-dev-code": DEV, // dev callers skip the per-IP chat limit; the daily Bedrock cap applies
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${json.message ?? ""}`);
  return json;
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** What the user says to read out the code in the latest text on the simulated phone. */
async function readCode(kind, since) {
  const sms = (await http(`/sim/state?since=${encodeURIComponent(since)}`)).sms ?? [];
  const code = /\b(\d{6})\b/.exec(sms.at(-1)?.body ?? "")?.[1] ?? "000000";
  if (kind === "words") return `it's ${[...code].map((d) => WORDS[Number(d)]).join(" ")}`;
  if (kind === "wrong") {
    const wrong = [...code].map((d) => (Number(d) + 1) % 10).join("");
    return `the code is ${[...wrong].join(" ")}`;
  }
  return `the code is ${[...code].join(" ")}`;
}

async function play(name, steps) {
  await http("/dev/reset", { body: {} });
  const since = new Date().toISOString();
  let conversation;
  const turns = [];
  for (let step of steps) {
    if (step.dev) {
      for (let i = 0; i < (step.times ?? 1); i++) await http(`/dev/${step.dev}`, { body: {} });
      continue;
    }
    const started = performance.now();
    const before = (await http(`/sim/state?since=${encodeURIComponent(new Date().toISOString())}`))
      .assistant_calls_left_today;
    if (step.code) step = { ...step, say: await readCode(step.code, since) };
    const r = await http("/sim/chat", {
      body: { text: step.say, ...(conversation ? { conversation_id: conversation } : {}) },
    });
    conversation = r.conversation_id;
    const ms = performance.now() - started;
    const state = await http(`/sim/state?since=${encodeURIComponent(new Date().toISOString())}`);
    const turnCheck = { ...step.check, calls: step.calls, not: step.not, refused: step.refused };
    const fails = check(turnCheck, r, state);
    if (step.check?.notCancelled && results(r, "cancel_transfer").some((c) => c.args.cancel_token))
      fails.push("cancelled without a yes");
    const usage = {
      in: r.usage?.input_tokens ?? 0,
      out: r.usage?.output_tokens ?? 0,
      calls: before - state.assistant_calls_left_today,
    };
    turns.push({ say: step.say, reply: r.reply, tools: r.tool_calls, ms, fails, usage });
    const mark = fails.length ? "✗" : "✓";
    const tools = r.tool_calls
      .map(
        (c) =>
          `${c.name}${c.blocked ? "[held]" : ""}${c.refused && !c.blocked ? `[${c.refused}]` : ""}`,
      )
      .join(", ");
    const cost = `${usage.calls} calls, ${usage.in}/${usage.out} tok`;
    console.log(
      `  ${mark} ${step.say}  (${(ms / 1000).toFixed(1)} s; ${cost}; ${tools || "no tools"})`,
    );
    if (fails.length || VERBOSE) console.log(`      → ${r.reply}`);
    for (const f of fails) console.log(`      ! ${f}`);
  }
  return turns;
}

/* ---------- token cost per journey (--usecases): each from a fresh seed and conversation ---------- */
const step = (n) => SCENARIOS.script[n];
const USE_CASE_LIST = [
  ["Check the rate", [step(0)]],
  ["How much would arrive", [step(1)]],
  ["Send money: ask, read-back, yes, code", [step(2), step(3), step(4)]],
  ["Track a transfer", [{ say: "Where's my money?", calls: ["track_transfer"] }]],
  ["Cancel: preview, yes", [step(10), step(11)]],
  ["Set a rate alert", [step(12)]],
  ["Whole demo script, one conversation", SCENARIOS.script],
];

if (USECASES) {
  const rows = [];
  for (const [label, steps] of USE_CASE_LIST) {
    console.log(`
${label}`);
    const turns = await play(label, steps);
    const sum = turns.reduce(
      (a, t) => ({
        in: a.in + t.usage.in,
        out: a.out + t.usage.out,
        calls: a.calls + t.usage.calls,
      }),
      { in: 0, out: 0, calls: 0 },
    );
    rows.push({ label, turns: turns.length, ...sum, usd: usd(sum.in, sum.out) });
  }
  console.log(`
Token cost per journey (USD ${PRICE_IN}/M input, ${PRICE_OUT}/M output)`);
  console.log("| Journey | Turns | Bedrock calls | Input tokens | Output tokens | Cost (USD) |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const r of rows) {
    console.log(
      `| ${r.label} | ${r.turns} | ${r.calls} | ${r.in.toLocaleString("en-US")} | ${r.out.toLocaleString("en-US")} | ${r.usd.toFixed(5)} |`,
    );
  }
  process.exit(0);
}

const names = Object.keys(SCENARIOS).filter((n) => !ONLY.length || ONLY.includes(n));
const tally = new Map(names.map((n) => [n, { pass: 0, runs: 0 }]));
let failedTurns = 0;
let totalTurns = 0;
const startBudget = (await http(`/sim/state?since=${encodeURIComponent(new Date().toISOString())}`))
  .assistant_calls_left_today;

for (let run = 1; run <= RUNS; run++) {
  for (const name of names) {
    console.log(`\n${name} · run ${run}/${RUNS}`);
    const turns = await play(name, SCENARIOS[name]);
    const bad = turns.filter((t) => t.fails.length).length;
    failedTurns += bad;
    totalTurns += turns.length;
    const t = tally.get(name);
    t.runs++;
    if (!bad) t.pass++;
  }
}

const endBudget = (await http(`/sim/state?since=${encodeURIComponent(new Date().toISOString())}`))
  .assistant_calls_left_today;
console.log("\nSummary");
for (const [name, t] of tally) console.log(`  ${name}: ${t.pass}/${t.runs} clean runs`);
console.log(
  `  turns: ${totalTurns - failedTurns}/${totalTurns} passed · Bedrock calls used: ${startBudget - endBudget} · left today: ${endBudget}`,
);
process.exit(failedTurns ? 1 : 0);
