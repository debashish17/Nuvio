/**
 * ui://nuvio-remit/transfer: the MCP Apps view for a transfer (SPEC "MCP Apps view"). It draws
 * whatever the host last sent (quote, read-back, code entry, receipt) and does two things itself:
 * it sends the step-up code to confirm_transfer through the host, so the code never passes through
 * the model, and it polls track_transfer while a receipt can still change. Confirm and Not now are
 * words for the assistant (ui/message): consent stays in the conversation.
 *
 * Runs in a sandboxed iframe with no network access; everything goes through postMessage.
 */

import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import {
  aed,
  confirmedContext,
  digits,
  FINAL,
  inr,
  initialState,
  mmss,
  onToolInput,
  onToolResult,
  secondsLeft,
  steps,
  type Phase,
  type Quote,
  type ViewState,
} from "./model.js";

const POLL_MS = 3000;
const POLL_FOR_MS = 10 * 60_000;

const app = new App({ name: "nuvio-remit-transfer", version: "1.0.0" }, {}, { autoResize: true });
const root = document.getElementById("app") as HTMLElement;
const live = document.getElementById("live") as HTMLElement;

let state: ViewState = initialState;
let busy = false;
let tornDown = false;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let pollStarted = 0;
let lastAnnounced = "";

const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

const kv = (rows: [string, string | undefined][]) =>
  `<dl class="kv">${rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
    .join("")}</dl>`;

const timer = (until: string, label: string) =>
  until
    ? `<span class="timer" data-until="${esc(until)}" data-label="${esc(label)}">${esc(label)} ${mmss(secondsLeft(until, Date.now()))}</span>`
    : "";

const hero = (label: string, amount: number | undefined, sub = "") =>
  typeof amount === "number"
    ? `<div class="hero"><small>${esc(label)}</small><b>${esc(inr(amount))}</b>${sub ? `<span>${esc(sub)}</span>` : ""}</div>`
    : "";

const expired = (iso: string) => Boolean(iso) && secondsLeft(iso, Date.now()) === 0;

function quoteFigures(q: Quote): string {
  return kv([
    ["You send", aed(q.send_amount)],
    ["Fee, included", aed(q.fee)],
    ["Our rate", q.locked_rate.toFixed(2)],
    ["Arrives", q.eta],
    ["Paid with", q.funding],
  ]);
}

function view(p: Phase): string {
  switch (p.kind) {
    case "waiting":
      return `<section class="card"><p class="muted">Waiting for the assistant…</p></section>`;

    case "quote": {
      const near = p.quote.warnings?.find((w) => w.code === "NEAR_MONTHLY_LIMIT");
      return `<section class="card" aria-label="Quote">
        <header><span class="tag">Quote</span>${timer(p.quote.rate_locked_until, "Rate held for")}</header>
        ${hero("They receive", p.quote.receive_amount, "guaranteed")}
        ${quoteFigures(p.quote)}
        ${near ? `<p class="note">After this, ${esc(aed(near.remaining_after))} of your monthly limit is left.</p>` : ""}
      </section>`;
    }

    case "readback": {
      const gone = expired(p.expiresAt);
      const hint = gone
        ? "This confirmation has expired and nothing was sent. Ask the assistant for a new quote."
        : p.answered === "yes"
          ? "You said yes. The assistant will text you a code."
          : p.answered === "no"
            ? "You said not now. Nothing was sent."
            : "Or say yes to the assistant. Nothing is sent until you approve with the code we text you.";
      const off = gone || p.answered ? " disabled" : "";
      return `<section class="card consent${gone ? " expired" : ""}" aria-label="Confirm this transfer">
        <header><span class="tag">Read-back</span>${timer(p.expiresAt, "Expires in")}</header>
        ${hero("They receive", p.quote?.receive_amount, "guaranteed")}
        <blockquote class="say">${esc(p.readBack)}</blockquote>
        <div class="acts">
          <button class="btn yes" type="button" data-act="yes"${off}>Confirm</button>
          <button class="btn" type="button" data-act="no"${off}>Not now</button>
        </div>
        <p class="hint">${esc(hint)}</p>
      </section>`;
    }

    case "code": {
      const gone = expired(p.expiresAt);
      const off = gone || busy ? " disabled" : "";
      return `<section class="card consent${gone ? " expired" : ""}" aria-label="Enter the code from your phone">
        <header><span class="tag">Check your phone</span>${timer(p.expiresAt, "Code expires in")}</header>
        <p>We texted a 6-digit code to your ${esc(p.sentTo)}. Type it here: it goes straight to Nuvio and never through the assistant.</p>
        <form class="code" data-act="code" autocomplete="off" novalidate>
          <label class="sr" for="otp">6-digit code from the text message</label>
          <input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="••••••"${off} />
          <button class="btn yes" type="submit"${off}>${busy ? "Checking…" : "Approve"}</button>
        </form>
        <p class="err" role="alert">${esc(gone ? "The code has expired and nothing was sent. Say yes to the assistant to get a new one." : (p.error ?? ""))}</p>
        <p class="hint">${esc(p.attemptsLeft)} ${p.attemptsLeft === 1 ? "try" : "tries"} left. Nuvio staff will never ask you for this code.</p>
      </section>`;
    }

    case "receipt": {
      const t = p.transfer;
      const label = t.customer_label ?? t.status;
      const tone =
        t.status === "PAID_OUT"
          ? "ok"
          : t.status === "ON_HOLD"
            ? "warn"
            : FINAL.has(t.status)
              ? "bad"
              : "";
      const rfi = t.action_required;
      const stepsHtml = steps(t.status, t.timeline)
        .map((s) => `<li class="${s.state}">${esc(s.label)}</li>`)
        .join("");
      return `<section class="card" aria-label="Transfer ${esc(t.transfer_ref)}">
        <header><span class="tag ${tone}">${esc(label)}</span><span class="ref">${esc(t.transfer_ref)}</span></header>
        ${hero(`${t.recipient ?? "They"} ${t.recipient ? "receives" : "receive"}`, t.receive_amount)}
        <ol class="steps" aria-label="Progress">${stepsHtml}</ol>
        ${kv([
          ["Charged", aed(t.charged ?? t.send_amount)],
          ["Arrives", t.status === "PAID_OUT" ? "Paid out" : t.eta],
          ["Bank reference (UTR)", t.utr],
        ])}
        ${
          rfi
            ? `<p class="rfi"><b>Action needed.</b> Upload ${esc(rfi.document)} ${esc(rfi.how)}${rfi.deadline ? ` by ${esc(rfi.deadline)}` : ""}.</p>`
            : ""
        }
        ${pollTimer ? `<p class="hint live">Live: this updates on its own.</p>` : ""}
      </section>`;
    }

    case "refused":
      return `<section class="card" aria-label="Not done">
        <header><span class="tag bad">Not done</span></header>
        <p>${esc(p.message)}</p>
      </section>`;
  }
}

function render(): void {
  root.innerHTML = view(state.phase);
  if (tornDown) {
    // The host closed this view (a newer one took over) but may leave it on screen: freeze it.
    root.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input").forEach((el) => {
      el.disabled = true;
    });
    root.querySelector(".timer")?.remove();
    return;
  }
  const say = root.querySelector("[aria-label]")?.getAttribute("aria-label") ?? "";
  if (say !== lastAnnounced) {
    live.textContent = say;
    lastAnnounced = say;
  }
  root
    .querySelectorAll<HTMLButtonElement>("[data-act=yes],[data-act=no]")
    .forEach((b) => b.addEventListener("click", () => void answer(b.dataset.act as "yes" | "no")));
  const form = root.querySelector<HTMLFormElement>("form[data-act=code]");
  if (form) {
    const input = form.querySelector("input") as HTMLInputElement;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void submitCode(input.value);
    });
    input.addEventListener("input", () => {
      if (digits(input.value).length === 6) void submitCode(input.value);
    });
    if (!input.disabled) input.focus({ preventScroll: true });
  }
}

/** Confirm / Not now: words for the assistant, so consent stays in the conversation. */
async function answer(said: "yes" | "no"): Promise<void> {
  if (state.phase.kind !== "readback" || state.phase.answered) return;
  state = { ...state, phase: { ...state.phase, answered: said } };
  render();
  try {
    await app.sendMessage({
      role: "user",
      content: [{ type: "text", text: said === "yes" ? "Yes." : "No." }],
    });
  } catch {
    if (state.phase.kind === "readback") {
      // The host could not take the words: open the buttons again.
      const phase = { ...state.phase };
      delete phase.answered;
      state = { ...state, phase };
      render();
    }
  }
}

/** The step-up code goes to confirm_transfer through the host, never through the model. */
async function submitCode(typed: string): Promise<void> {
  const phase = state.phase;
  const code = digits(typed);
  if (phase.kind !== "code" || busy) return;
  if (code.length !== 6) {
    state = { ...state, phase: { ...phase, error: "Enter all 6 digits from the text message." } };
    render();
    return;
  }
  busy = true;
  render();
  const args = { confirmation_token: phase.token, otp: code };
  try {
    state = onToolInput(state, args);
    const result = await app.callServerTool({ name: "confirm_transfer", arguments: args });
    state = onToolResult(state, result);
  } catch {
    state = {
      ...state,
      input: undefined,
      phase: { ...phase, error: "Couldn't reach Nuvio, and nothing was sent. Try again." },
    };
  }
  busy = false;
  if (state.phase.kind === "receipt") {
    const note = confirmedContext(state.phase.transfer);
    void app
      .updateModelContext({
        content: [{ type: "text", text: note.text }],
        structuredContent: note.structured,
      })
      .catch(() => undefined);
    startPolling(true);
  }
  render();
}

function stopPolling(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = undefined;
}

/** Polls track_transfer while the receipt can still change, for 10 minutes at most. */
function startPolling(fresh = false): void {
  const p = state.phase;
  if (tornDown || p.kind !== "receipt" || FINAL.has(p.transfer.status)) return stopPolling();
  if (fresh || !pollTimer) pollStarted = Date.now();
  stopPolling();
  pollTimer = setTimeout(async () => {
    const now = state.phase;
    if (tornDown || now.kind !== "receipt" || Date.now() - pollStarted > POLL_FOR_MS) {
      stopPolling();
      return render();
    }
    const args = { transfer_ref: now.transfer.transfer_ref };
    try {
      const result = await app.callServerTool({ name: "track_transfer", arguments: args });
      const before = JSON.stringify(state.phase);
      state = onToolResult(onToolInput(state, args), result);
      pollTimer = undefined;
      startPolling();
      if (JSON.stringify(state.phase) !== before || !pollTimer) render();
    } catch {
      stopPolling();
      render();
    }
  }, POLL_MS);
}

/** Countdowns tick without redrawing; at zero the card redraws as expired. */
setInterval(() => {
  let expiredNow = false;
  root.querySelectorAll<HTMLElement>(".timer[data-until]").forEach((el) => {
    const left = secondsLeft(el.dataset.until ?? "", Date.now());
    el.textContent = `${el.dataset.label ?? ""} ${mmss(left)}`;
    el.classList.toggle("low", left <= 60);
    if (left === 0 && !el.closest(".expired")) expiredNow = true;
  });
  if (expiredNow && !tornDown && (state.phase.kind === "readback" || state.phase.kind === "code"))
    render();
}, 1000);

function applyContext(ctx: McpUiHostContext | undefined): void {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

// Handlers go on before connect, so nothing the host sends right after initialize is missed.
app.ontoolinput = (params) => {
  state = onToolInput(state, params.arguments);
};
app.ontoolresult = (result) => {
  state = onToolResult(state, result);
  startPolling(true);
  render();
};
app.onhostcontextchanged = (ctx) => applyContext(ctx);
app.onteardown = async () => {
  tornDown = true;
  stopPolling();
  document.body.classList.add("closed");
  render();
  return {};
};

render();
app
  .connect()
  .then(() => applyContext(app.getHostContext()))
  .catch((err: unknown) => {
    root.innerHTML = `<section class="card"><p class="muted">This view needs an MCP Apps host.</p></section>`;
    console.error("transfer view: could not connect to the host", err);
  });
