/* Simulator controller. Stands in for Alexa+: the user speaks or types, the server's Bedrock loop
   calls the real MCP tools, and the page shows the reply, the cards those tool results carry, and
   the JSON-RPC traffic. State that matters lives on the server; the page only renders it. */

import { api } from "./api.js";
import { createAppHost } from "./apps.js";
import * as C from "./cards.js";
import { createOrb } from "./orb.js";
import {
  browserVoices,
  listen,
  micLevel,
  onVoicesChanged,
  POLLY,
  setPolly,
  setPreferredVoice,
  speak,
  stopListening,
  stopSpeaking,
  voice,
} from "./voice.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const { esc, fmt } = C;
const body = document.body;
const log = $("#log"),
  cap = $("#cap"),
  stage = $("#stage"),
  convo = $("#convo");
const proto = $("#proto"),
  feed = $("#pFeed");

const local = {
  get(k, d) {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage blocked */
    }
  },
};

const orb = createOrb({
  orbCanvas: $("#orb"),
  bgCanvas: $("#bg"),
  logoCanvas: $("#logo"),
  orbWrap: $("#orbwrap"),
});

const S = {
  connected: false,
  conversationId: null,
  busy: false,
  turn: 0,
  since: new Date().toISOString(),
  receipts: new Map(), // transfer_ref -> receipt card
  consent: null, // the open read-back or cancel-preview card
  stepUp: null, // the open "check your phone" card
  lastCode: null, // the code in the latest text on the simulated phone
  pollTimer: null,
  speakGen: 0,
  listening: null,
};

/* The page is an MCP Apps host: the transfer tools' results show in the server's own view
   (ui://acme-remit/transfer) instead of the page's cards, which remain the fallback. */
const apps = createAppHost({
  theme: () => (body.classList.contains("mono") ? "mono" : "blue"),
  onExchanges: appExchanges,
  onConfirmed: transferConfirmed,
  // ui/message from the view ("Yes." / "No."): the user's next turn, if the assistant is free.
  sendText: (text) => {
    if (S.busy || !S.connected) return false;
    void send(text);
    return true;
  },
  conversationId: () => S.conversationId,
  fallback: (paired) => cardsFor(paired, { cardsOnly: true }).cards,
});

/* ---------- small helpers ---------- */
const announce = (t) => {
  $("#sr").textContent = t;
};
const scrollLog = () =>
  requestAnimationFrame(() => log.scrollTo({ top: log.scrollHeight, behavior: "smooth" }));
function append(node, delay = 0) {
  log.append(node);
  if (node.classList.contains("rise")) setTimeout(() => node.classList.add("in"), 30 + delay);
  scrollLog();
  return node;
}
function addYou(text) {
  const d = document.createElement("div");
  d.className = "you";
  d.innerHTML = `<p>${esc(text)}</p>`;
  return append(d);
}
function addBot(text, err = false) {
  const p = document.createElement("p");
  p.className = `bot rise${err ? " err" : ""}`;
  p.textContent = text;
  return append(p);
}
function toast(title, sub, icon = C.ICON.bell, ms = 6000, action = null) {
  const t = document.createElement("div");
  t.className = "toast rise";
  t.innerHTML = `${icon}<div><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn sm";
    b.textContent = action.label;
    b.addEventListener("click", () => {
      action.onClick();
      t.remove();
    });
    t.append(b);
  }
  $("#toasts").append(t);
  setTimeout(() => t.classList.add("in"), 30);
  setTimeout(() => {
    t.classList.remove("in");
    setTimeout(() => t.remove(), 600);
  }, ms);
}
const hhmm = (iso) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/* ---------- chrome: theme, voice, protocol panel, focus mode ---------- */
function setTheme(th) {
  body.classList.remove("blue", "mono");
  body.classList.add(th);
  orb.setTheme(th);
  $$("[data-th]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.th === th)));
  local.set("acme.theme", th);
  apps.retheme();
}
function setVoice(on) {
  voice.muted = !on;
  if (!on) stopSpeaking();
  $("#sndBtn").setAttribute("aria-pressed", String(on));
  $("#sndBtn span").textContent = on ? "Voice on" : "Voice off";
  local.set("acme.voice", on ? "on" : "off");
}
function setProto(on) {
  body.classList.toggle("noproto", !on);
  $("#protoBtn").setAttribute("aria-pressed", String(on));
  local.set("acme.proto", on ? "on" : "off");
}
function setFocus(on) {
  body.classList.toggle("focus", on);
  $("#hideBar").setAttribute("aria-pressed", String(on));
  $("#hideBar span").textContent = on ? "Show" : "Hide";
}
$$("[data-th]").forEach((b) => b.addEventListener("click", () => setTheme(b.dataset.th)));
$("#sndBtn").addEventListener("click", () => setVoice(voice.muted));
$("#protoBtn").addEventListener("click", () => setProto(body.classList.contains("noproto")));
$("#hideBar").addEventListener("click", () => setFocus(!body.classList.contains("focus")));
setTheme(local.get("acme.theme", "blue") === "mono" ? "mono" : "blue");
setVoice(local.get("acme.voice", "on") !== "off");

/* ---------- voice picker ---------- */
const voiceSel = $("#voiceSel");
let pollyVoice = null; // { voice, engine } when the server offers Amazon Polly
function fillVoices() {
  const voices = browserVoices();
  voiceSel.replaceChildren();
  if (pollyVoice) voiceSel.append(new Option(`Amazon Polly · ${pollyVoice.voice} (en-IN)`, POLLY));
  voiceSel.append(new Option("Browser · auto", ""));
  for (const v of voices) {
    const name = v.name.replace(/^(Microsoft|Google)\s+/, "").replace(/\s*-\s*English.*$/, "");
    voiceSel.append(new Option(`${name} · ${v.lang}`, v.name));
  }
  // Polly is the default when offered; a saved choice wins if it is still available.
  const chosen = local.get("acme.voiceName", pollyVoice ? POLLY : "");
  const available = [...voiceSel.options].some((o) => o.value === chosen);
  voiceSel.value = available ? chosen : pollyVoice ? POLLY : "";
  setPreferredVoice(voiceSel.value);
}
fillVoices();
onVoicesChanged(fillVoices);
voiceSel.addEventListener("change", () => {
  local.set("acme.voiceName", voiceSel.value);
  setPreferredVoice(voiceSel.value);
  if (!S.busy && !voice.muted) void speak("Hi, I'm your Nuvio assistant.");
});
setProto(local.get("acme.proto", "on") !== "off");

/* ---------- caption under the orb ---------- */
function captionYou(firm, interim = "") {
  cap.innerHTML = `<span class="who">You</span>${esc(firm)}${interim ? ` <span class="interim">${esc(interim)}</span>` : ""}`;
}
function captionHint(text) {
  cap.innerHTML = `<span class="dim">${esc(text)}</span>`;
}
/** Splits at . ! ? followed by a space or the end, so "25.99" and "0.6%" stay whole. */
function sentences(text) {
  const out = [];
  const re = /[.!?]+(?=\s|$)/g;
  let start = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[0].length;
    out.push({ start, end, text: text.slice(start, end) });
    start = end;
  }
  if (start < text.length) out.push({ start, end: text.length, text: text.slice(start) });
  const kept = out.filter((x) => x.text.trim());
  return kept.length ? kept : [{ start: 0, end: text.length, text }];
}

const escRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Where the reply speaks the card's sentence. Models paraphrase the edges (one dropped
 * "Shall I go ahead?"), so this takes the longest leading run of its sentences, ignoring spacing.
 */
function findSpoken(reply, sentence) {
  const parts = sentences(sentence).map((x) => x.text.trim());
  for (let k = parts.length; k > 0; k--) {
    const words = parts.slice(0, k).join(" ").split(/\s+/).map(escRe);
    const m = new RegExp(words.join("\\s+"), "i").exec(reply);
    if (m) return { at: m.index, len: m[0].length };
  }
  return null;
}
function captionSpeak(sent, charIndex) {
  const words = [...sent.text.matchAll(/\S+/g)]
    .map(
      (m) => `<span${sent.start + m.index > charIndex ? ' class="dim"' : ""}>${esc(m[0])}</span>`,
    )
    .join(" ");
  cap.innerHTML = `<span class="who">Nuvio Remit</span>${words}`;
}

function setBig(on) {
  stage.classList.toggle("big", on);
  convo.classList.toggle("big", on);
}
function setOrb(st) {
  orb.setState(st);
  announce({ listening: "Listening", thinking: "Thinking", speaking: "", idle: "" }[st] ?? "");
}

/* ---------- protocol panel ---------- */
const MONEY_TOOLS = new Set(["confirm_transfer"]);
function exchangeDetail(x) {
  if (x.method === "initialize")
    return `protocol ${x.response?.result?.protocolVersion ?? "?"} · ${x.response?.result?.serverInfo?.name ?? ""}`;
  if (x.method === "tools/list") return `${x.response?.result?.tools?.length ?? 0} tools`;
  return JSON.stringify(x.request?.params?.arguments ?? {});
}
function protoRow({ title, ms, detail, flag, x }, i) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "row";
  if (x) b.dataset.x = String(x.id);
  const flagHtml = flag ? `<span class="${flag.cls}">${esc(flag.text)}</span> · ` : "";
  b.innerHTML = `<b>${esc(title)}</b><span>${ms === null ? "" : `${esc(Math.round(ms))} ms`}</span><span class="d">${flagHtml}${esc(detail)}</span>`;
  b.setAttribute("aria-expanded", "false");
  b.addEventListener("click", () => {
    const open = b.querySelector("pre");
    if (open) {
      open.remove();
      b.setAttribute("aria-expanded", "false");
      return;
    }
    const pre = document.createElement("pre");
    pre.textContent = x
      ? `→ ${JSON.stringify(x.request, null, 2)}\n\n← HTTP ${x.status}\n${JSON.stringify(x.response, null, 2)}`
      : detail;
    b.append(pre);
    b.setAttribute("aria-expanded", "true");
  });
  feed.append(b);
  setTimeout(
    () => {
      b.classList.add("in");
      proto.scrollTop = proto.scrollHeight;
    },
    60 + i * 140,
  );
  return b;
}
function protoHeading(left, right = "") {
  const h = document.createElement("p");
  h.className = "p-turn";
  h.innerHTML = `<span>${esc(left)}</span><span>${esc(right)}</span>`;
  feed.append(h);
}
function exchangeRows(exchanges, start = 0) {
  exchanges.forEach((x, i) =>
    protoRow({ title: x.method, ms: x.ms, detail: exchangeDetail(x), x }, start + i),
  );
}

/** Pairs each tool call the model made with the JSON-RPC exchange it produced (blocked calls have none). */
function pairCalls(r) {
  const calls = r.exchanges.filter((x) => x.method === "tools/call");
  const head = r.exchanges.filter((x) => x.method !== "tools/call");
  let k = 0;
  const paired = r.tool_calls.map((tc) => {
    if (tc.blocked) return { tc, x: null, sc: null };
    const x = calls[k]?.request?.params?.name === tc.name ? calls[k++] : null;
    return { tc, x, sc: x?.response?.result?.structuredContent ?? null };
  });
  return { head, paired };
}

function renderProtoTurn(n, r, { head, paired }) {
  protoHeading(
    `Turn ${n}`,
    `${r.model?.split(".").slice(-1)[0] ?? ""} · ${r.usage?.input_tokens ?? 0}/${r.usage?.output_tokens ?? 0} tok`,
  );
  exchangeRows(head);
  const rows = new Map();
  paired.forEach(({ tc, x, sc }, i) => {
    let flag = null;
    if (tc.blocked) flag = { cls: "bl", text: "held by consent guard" };
    else if (tc.refused === "STEP_UP_REQUIRED")
      flag = { cls: "bl", text: "code texted · nothing sent yet" };
    else if (tc.refused) flag = { cls: "rf", text: `refused ${tc.refused}` };
    else if (tc.error) flag = { cls: "rf", text: "error" };
    else if (
      MONEY_TOOLS.has(tc.name) ||
      (tc.name === "cancel_transfer" && sc?.status === "CANCELLED")
    )
      flag = { cls: "m", text: "moves money" };
    const detail = tc.blocked
      ? "token issued this turn; the server waits for your reply"
      : x
        ? exchangeDetail(x)
        : "no response";
    rows.set(
      i,
      protoRow({ title: tc.name, ms: tc.blocked ? null : tc.ms, detail, flag, x }, head.length + i),
    );
  });
  if (r.error)
    protoRow(
      {
        title: "assistant error",
        ms: null,
        detail: `${r.error.code}: ${r.error.message}`,
        flag: { cls: "rf", text: "error" },
      },
      head.length + paired.length,
    );
  return rows;
}

// Hovering a card lights the protocol row that produced it.
log.addEventListener("pointerover", (e) => {
  const card = e.target.closest?.(".card[data-x]");
  $$(".row.hl").forEach((r) => r.classList.remove("hl"));
  if (card) feed.querySelector(`.row[data-x="${card.dataset.x}"]`)?.classList.add("hl");
});
log.addEventListener("pointerleave", () => $$(".row.hl").forEach((r) => r.classList.remove("hl")));

/* ---------- cards from tool results ---------- */
function settleConsent(text) {
  if (S.consent) {
    S.consent.settle(text);
    S.consent = null;
  }
}
function chime() {
  if (voice.muted) return;
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1318.5].forEach((f, i) => {
      const o = ac.createOscillator(),
        g = ac.createGain();
      o.type = "sine";
      o.frequency.value = f;
      const t = ac.currentTime + i * 0.12;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g).connect(ac.destination);
      o.start(t);
      o.stop(t + 0.65);
    });
    setTimeout(() => ac.close(), 1200);
  } catch {
    /* audio blocked */
  }
}

/** A transfer went through (by voice, or with the code typed in the view): the confirm moment. */
function transferConfirmed(sc) {
  settleConsent(`Confirmed · ${sc.transfer_ref}`);
  S.stepUp?.settle(`Approved with the code from your phone · ${sc.transfer_ref}`);
  S.stepUp = null;
  S.lastCode = null;
  orb.setTick(1);
  setTimeout(() => orb.setTick(0), 2600);
  chime();
  void pollState();
}

/** Protocol rows for the MCP Apps view's own traffic (resources/read, its tools/call). */
function appExchanges(title, exchanges, call) {
  protoHeading(title, hhmm(new Date().toISOString()));
  exchanges.forEach((x, i) => {
    let flag = null;
    if (x.method === "tools/call" && call) {
      const r = call.sc?.refused;
      if (r?.code === "STEP_UP_REQUIRED")
        flag = { cls: "bl", text: "code texted · nothing sent yet" };
      else if (r) flag = { cls: "rf", text: `refused ${r.code}` };
      else if (MONEY_TOOLS.has(call.name))
        flag = { cls: "m", text: "moves money · code typed in the view" };
    }
    const detail =
      x.method === "resources/read"
        ? `${x.request?.params?.uri ?? ""} · the view's HTML`
        : exchangeDetail(x);
    protoRow(
      {
        title: x.method === "tools/call" ? (call?.name ?? x.method) : x.method,
        ms: x.ms,
        detail,
        flag,
        x,
      },
      i,
    );
  });
}

/**
 * Builds the cards for one turn. Returns them plus the sentence the read-back card shows, if any.
 * Calls to tools that link an MCP Apps view go to the view instead (cardsOnly: the fallback).
 */
function cardsFor(paired, { cardsOnly = false } = {}) {
  const out = [];
  const toView = [];
  let viewAt = -1; // where the view cards go among this turn's cards
  let spoken = null; // { card, sentence }
  let guarded = false;
  const lookupOnly = paired.some(({ tc }) => /^(track|cancel)_transfer$/.test(tc.name));
  const prepared = paired.some(({ tc, sc }) => tc.name === "prepare_transfer" && sc && !sc.refused);
  for (const p of paired) {
    const { tc, x, sc } = p;
    if (tc.blocked) {
      guarded = true;
      continue;
    }
    if (tc.app && !cardsOnly && apps.enabled) {
      const r = tc.app.result?.structuredContent ?? {};
      if (tc.name === "prepare_transfer" && !r.refused)
        settleConsent("Replaced by a new confirmation");
      if (tc.name === "confirm_transfer" && r.transfer_ref && !r.refused) transferConfirmed(r);
      if (viewAt < 0) viewAt = out.length;
      toView.push(p);
      continue;
    }
    if (!sc) continue;
    let card = null;
    if (sc.refused?.code === "STEP_UP_REQUIRED") {
      settleConsent("You said yes · waiting for the code from your phone");
      S.stepUp?.settle("Replaced by a new code");
      card = C.stepUpCard(sc.refused);
      S.stepUp = card;
    } else if (sc.refused) {
      card = C.refusalCard(sc.refused);
      if (tc.name === "confirm_transfer") settleConsent("Not confirmed · see below");
      if (tc.name === "confirm_transfer" && /OTP_LOCKED|OTP_EXPIRED/.test(sc.refused.code)) {
        S.stepUp?.settle("Not sent");
        S.stepUp = null;
      }
      if (tc.name === "cancel_transfer" && sc.refused.code !== "AWAITING_USER_CONFIRMATION")
        settleConsent("Not cancelled · see below");
    } else {
      switch (tc.name) {
        case "get_rate":
          card = C.rateCard(sc);
          break;
        case "compare_options":
          card = C.compareCard(sc);
          break;
        case "list_beneficiaries":
          card = C.recipientsCard(sc);
          break;
        case "resolve_beneficiary":
          if (sc.ambiguous) card = C.chooseCard(sc, { onPick: (t) => send(t) });
          else if (sc.not_found) card = C.notFoundCard(sc);
          break;
        case "quote_transfer":
          if (!prepared) card = C.quoteCard(sc);
          break;
        case "prepare_transfer":
          settleConsent("Replaced by a new confirmation");
          card = C.readBackCard(sc, {
            onYes: () => send("Yes."),
            onNo: () => {
              settleConsent("Not sent · you said no");
              send("No.");
            },
          });
          S.consent = card;
          spoken = { card, sentence: sc.read_back };
          break;
        case "confirm_transfer":
          transferConfirmed(sc);
          card = C.receiptCard(sc, { onCancel: (ref) => send(`Cancel transfer ${ref}.`) });
          S.receipts.set(sc.transfer_ref, card);
          break;
        case "cancel_transfer":
          if (sc.preview && sc.cancel_token) {
            settleConsent("Replaced by a new confirmation");
            card = C.cancelPreviewCard(sc, {
              onYes: () => send("Yes."),
              onNo: () => {
                settleConsent("Kept · not cancelled");
                send("No, keep it.");
              },
            });
            S.consent = card;
            spoken = { card, sentence: sc.preview };
          } else if (sc.status === "CANCELLED") {
            settleConsent(`Cancelled · ${sc.transfer_ref}`);
            card = C.cancelledCard(sc);
          }
          break;
        case "track_transfer":
          card = C.statusCard(sc);
          break;
        case "get_transfer_history":
          // A lookup on the way to tracking or cancelling one transfer isn't worth a card.
          if (!lookupOnly) card = C.historyCard(sc);
          break;
        case "check_limits":
          card = C.limitsCard(sc);
          break;
        case "get_help":
          card = C.helpCard(sc);
          break;
        case "set_rate_alert":
          card = C.alertCard(sc);
          break;
      }
    }
    if (card) {
      if (x) card.dataset.x = String(x.id);
      out.push(card);
    }
  }
  if (toView.length) out.splice(viewAt, 0, ...apps.place(toView));
  if (guarded) (spoken?.card ?? S.consent)?.showGuard?.();
  return { cards: out, spoken };
}

/* ---------- a turn ---------- */
async function send(text, { voiceTurn = false } = {}) {
  text = text.trim();
  if (!text || S.busy || !S.connected) return;
  S.busy = true;
  body.classList.add("busy");
  S.speakGen++;
  stopSpeaking();
  $("#chips").classList.add("off");
  addYou(text);
  captionYou(text);
  setOrb("thinking");
  setBig(voiceTurn);
  demoSync();

  let r;
  try {
    r = await api.chat(text, S.conversationId);
  } catch (e) {
    const msg =
      e.status === 429
        ? "Too many requests for the demo just now. Wait a minute and try again."
        : e.status === 401
          ? "The access code has expired. Enter it again."
          : "The server could not be reached. Check your connection and try again.";
    addBot(msg, true);
    captionHint(msg);
    if (e.status === 401) showGate("Enter the access code again.");
    return done();
  }
  S.conversationId = r.conversation_id;
  const n = ++S.turn;
  const pairing = pairCalls(r);
  renderProtoTurn(n, r, pairing);
  const { cards, spoken } = cardsFor(pairing.paired);

  // The read-back sentence is on its card; the bot line keeps whatever else was said.
  const reply = r.reply || "";
  const hit = spoken ? findSpoken(reply, spoken.sentence) : null;
  const at = hit ? hit.at : -1;
  const rest = hit ? (reply.slice(0, hit.at) + reply.slice(hit.at + hit.len)).trim() : reply;
  if (rest && !(r.error && cards.length)) addBot(rest, Boolean(r.error));
  if (r.notice) showMode(r.notice);
  cards.forEach((c, i) => append(c, 120 * i));
  pollState();

  setBig(voiceTurn && cards.length === 0);
  setOrb("speaking");
  const gen = S.speakGen;
  const sents = sentences(reply);
  await speak(reply, {
    onWord(ci) {
      if (gen !== S.speakGen) return;
      captionSpeak(sents.find((s) => ci < s.end) ?? sents[sents.length - 1], ci);
      if (at >= 0 && ci >= at) C.highlightSay(spoken.card.say, ci - at);
    },
  });
  if (gen === S.speakGen && at >= 0) {
    C.highlightSay(spoken.card.say, Infinity);
    spoken.card.say.querySelectorAll(".now").forEach((w) => w.classList.remove("now"));
  }
  return done();

  function done() {
    S.busy = false;
    body.classList.remove("busy");
    setBig(false);
    setOrb("idle");
    demoSync();
  }
}

/* ---------- typing, chips ---------- */
$("#bar").addEventListener("submit", (e) => {
  e.preventDefault();
  const m = $("#msg");
  const t = m.value;
  if (!t.trim() || S.busy) return;
  m.value = "";
  void send(t);
});
$$("[data-say]").forEach((b) => b.addEventListener("click", () => send(b.dataset.say)));
log.addEventListener("click", (e) => {
  const c = e.target.closest?.("[data-copy]");
  if (!c) return;
  navigator.clipboard?.writeText(c.dataset.copy).then(
    () => toast("Copied", c.dataset.copy, C.ICON.copy, 2500),
    () => {},
  );
});

/* ---------- talk: hold to talk, or tap once and it listens until you pause ---------- */
const TAP_MS = 350; // a press shorter than this is a tap
const PAUSE_MS = 1500; // in tap mode, this much silence after speech ends the turn
const WAIT_MS = 6000; // in tap mode, how long to wait for the first word
const MAX_MS = 15000; // a turn never listens longer than this
let maxTimer = null;
let pauseTimer = null;
let pressedAt = 0;
let tapMode = false;
let heard = false;

function armPause() {
  clearTimeout(pauseTimer);
  pauseTimer = setTimeout(stopListen, heard ? PAUSE_MS : WAIT_MS);
}
function startListen() {
  if (S.listening || S.busy || !S.connected) return;
  if (!voice.canListen) {
    toast("Voice input needs Chrome or Edge", "Type your message instead.", C.ICON.alert);
    return;
  }
  S.speakGen++;
  stopSpeaking();
  heard = false;
  setOrb("listening");
  setBig(true);
  $("#orbwrap").classList.add("hold");
  orb.setLevelSource(micLevel);
  captionHint("Listening…");
  S.listening = listen({
    onInterim: (firm, interim) => {
      captionYou(firm, interim);
      if (firm || interim) heard = true;
      if (tapMode) armPause();
    },
  })
    .then((t) => {
      if (t) return send(t, { voiceTurn: true });
      captionHint("I didn't catch that. Tap or hold to talk, or type.");
      setOrb("idle");
      setBig(false);
    })
    .catch((err) => {
      const blocked = err?.message === "not-allowed" || err?.message === "service-not-allowed";
      toast(
        blocked ? "Microphone blocked" : "Voice input stopped",
        blocked
          ? "Allow the microphone for this site, or type instead."
          : String(err?.message || err),
        C.ICON.alert,
      );
      captionHint("");
      setOrb("idle");
      setBig(false);
    })
    .finally(() => {
      clearTimeout(maxTimer);
      clearTimeout(pauseTimer);
      S.listening = null;
      tapMode = false;
      orb.setLevelSource(null);
      $("#orbwrap").classList.remove("hold", "tap");
    });
  maxTimer = setTimeout(stopListen, MAX_MS);
}
function stopListen() {
  clearTimeout(maxTimer);
  clearTimeout(pauseTimer);
  if (S.listening) stopListening();
}
/** Press: start listening; or, during a tap session, end it. */
function press() {
  if (S.listening) {
    if (tapMode) stopListen();
    return;
  }
  pressedAt = performance.now();
  tapMode = false;
  startListen();
}
/** Release: a hold ends the turn; a quick tap switches to listening until a pause. */
function release() {
  if (!S.listening || tapMode) return;
  if (performance.now() - pressedAt < TAP_MS) {
    tapMode = true;
    $("#orbwrap").classList.replace("hold", "tap");
    armPause();
    return;
  }
  stopListen();
}
for (const b of [$("#orbBtn"), $("#barMic")]) {
  b.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    press();
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => b.addEventListener(ev, release));
  b.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
      e.preventDefault();
      press();
    }
  });
  b.addEventListener("keyup", (e) => {
    if (e.key === "Enter" || e.key === " ") release();
  });
}
const typing = (t) =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable;
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    S.speakGen++;
    stopSpeaking();
    stopListen();
    return;
  }
  if (
    typing(e.target) ||
    e.target instanceof HTMLButtonElement ||
    e.ctrlKey ||
    e.metaKey ||
    e.altKey
  )
    return;
  if (e.code === "Space" && !e.repeat) {
    e.preventDefault();
    press();
  } else if (e.key === "h" || e.key === "H") setFocus(!body.classList.contains("focus"));
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && !typing(e.target)) release();
});

/* ---------- demo player: the server's demo beats, one at a time or all in a row ---------- */
/** Stands for "read out the code from the latest text"; the code is only known at run time. */
const CODE_BEAT = "{code}";
const beatText = (b) =>
  b === CODE_BEAT
    ? S.lastCode
      ? `The code is ${S.lastCode.split("").join(" ")}.`
      : "Read the code from the text message."
    : b;
// Replaced on connect by /sim/tools demo_beats, the same list the scripted mode follows.
let BEATS = [
  "Hi, anything I should know?",
  "What's the rupee at today?",
  "How much would Mum get for 2,000 dirhams?",
  "Send 2,000 dirhams to Mum.",
  "Yes.",
  CODE_BEAT,
  "Send her another three thousand.",
  "Send 500 to Rahul.",
  "Where's Mum's money?",
  "And the one to my NRE account?",
  "Cancel the one to my NRE account.",
  "Yes.",
  "Tell me when the dirham hits 26.5.",
];
let beat = -1;
let auto = false; // "Play all" is running
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await sleep(200);
  }
  return true;
}
function demoSync() {
  const on = beat >= 0 && beat < BEATS.length;
  $("#demobar").hidden = !on;
  $("#demoBtn").setAttribute("aria-pressed", String(on));
  $("#demoBtn span").textContent = on ? "Stop demo" : "Play demo";
  if (!on) return;
  $("#dCount").textContent = `${beat + 1} / ${BEATS.length}`;
  $("#dLine").textContent = `“${beatText(BEATS[beat])}”`;
  $("#dSend").disabled = S.busy || auto;
  $("#dAuto").textContent = auto ? "Pause" : "Play all";
}
function demoGo(i) {
  beat = i;
  if (i < 0) auto = false;
  demoSync();
}
/** Says the current beat and waits until the reply has been spoken. */
async function sayBeat() {
  if (BEATS[beat] === CODE_BEAT && !S.lastCode) {
    void pollState();
    if (!(await waitFor(() => S.lastCode, 15_000))) return false; // the text never came
  }
  const t = beatText(BEATS[beat]);
  demoGo(beat + 1 < BEATS.length ? beat + 1 : -1);
  await send(t);
  return true;
}
$("#demoBtn").addEventListener("click", () => demoGo(beat >= 0 ? -1 : 0));
$("#dSkip").addEventListener("click", () => demoGo(beat + 1 < BEATS.length ? beat + 1 : -1));
$("#dExit").addEventListener("click", () => demoGo(-1));
$("#dSend").addEventListener("click", () => {
  if (S.busy || auto) return;
  void sayBeat();
});
$("#dAuto").addEventListener("click", async () => {
  if (auto) {
    auto = false;
    demoSync();
    return;
  }
  auto = true;
  demoSync();
  while (auto && beat >= 0) {
    await waitFor(() => !S.busy, 60_000);
    if (!auto || beat < 0) break;
    if (!(await sayBeat())) break;
    await sleep(700); // a breath between beats
  }
  auto = false;
  demoSync();
});

/* ---------- ledger strip and live updates from /sim/state ---------- */
function setLedger(id, text, warn = false) {
  const b = $(id);
  b.textContent = text;
  b.parentElement.classList.toggle("warn", warn);
}
function renderState(s) {
  const { daily, monthly } = s.limits;
  setLedger("#lMonth", fmt.aed(monthly.remaining), monthly.remaining / monthly.limit < 0.15);
  setLedger("#lDay", fmt.aed(daily.remaining), daily.remaining / daily.limit < 0.15);
  const t = s.latest_transfer;
  setLedger(
    "#lTransfer",
    t ? `${t.recipient} · ${t.customer_label}` : "None",
    Boolean(t && /ON_HOLD|RETURNED/.test(t.status)),
  );
  const q = s.open_quote;
  setLedger(
    "#lQuote",
    q ? `${fmt.aed(q.send_amount)} · held to ${hhmm(q.rate_locked_until)}` : "None",
  );
  if (s.rate)
    setLedger("#lRate", `${fmt.rate(s.rate.customer_rate)} · mid ${fmt.rate(s.rate.mid_rate)}`);
  if (t) S.receipts.get(t.transfer_ref)?.update(t);
  for (const m of s.sms ?? []) {
    const code = /\b(\d{6})\b/.exec(m.body)?.[1];
    if (code) S.lastCode = code;
    toast(
      `Messages · to phone ending ${m.to}`,
      m.body,
      C.ICON.sms,
      90_000,
      code
        ? { label: "Use code", onClick: () => send(`The code is ${code.split("").join(" ")}.`) }
        : null,
    );
    announce("New text message from Nuvio with a one-time code.");
  }
  for (const a of s.alerts) {
    toast(
      `Rate alert · AED/INR ${a.direction} ${fmt.rate(a.target)}`,
      `Fired ${hhmm(a.fired_at)} · ${a.channel}`,
    );
    announce(`Rate alert: the dirham reached ${fmt.rate(a.target)} rupees.`);
  }
  $("#pMeta").dataset.left = String(s.assistant_calls_left_today);
  metaLine();
}
let meta = { version: "", tools: 0 };

/** The mode banner: scripted (no language model) is explained up front; a notice flashes it. */
const SCRIPTED_NOTE =
  "Scripted demo: no language model is configured, so Play demo and the suggestions run the real tools from a fixed script. For free conversation, add AWS credentials (Bedrock) or an OpenAI-compatible key; see the README.";
function showMode(notice) {
  const n = $("#modeNote");
  n.hidden = S.mode !== "scripted" && !notice;
  n.textContent = notice || SCRIPTED_NOTE;
  if (notice) {
    n.classList.remove("flash");
    void n.offsetWidth; // restart the animation
    n.classList.add("flash");
  }
}
function metaLine() {
  const left = $("#pMeta").dataset.left;
  const model = S.mode === "scripted" ? "scripted, no model" : (S.llm?.model ?? "");
  const calls = left && S.mode !== "scripted" ? ` · ${left} assistant calls left today` : "";
  $("#pMeta").textContent =
    `MCP · Streamable HTTP · ${meta.version || "?"} · ${meta.tools} tools${model ? ` · ${model}` : ""}${calls}`;
}
let polling = false;
async function pollState() {
  if (polling || !S.connected) return;
  polling = true;
  try {
    const s = await api.state(S.since);
    S.since = s.server_time;
    renderState(s);
  } catch (e) {
    if (e.status === 401) showGate("Enter the access code again.");
  } finally {
    polling = false;
  }
}
function startPolling() {
  clearInterval(S.pollTimer);
  S.pollTimer = setInterval(() => {
    if (!document.hidden) void pollState();
  }, 3000);
  void pollState();
}

/* ---------- access gate and connection ---------- */
function showGate(msg) {
  S.connected = false;
  clearInterval(S.pollTimer);
  $("#gate").hidden = false;
  if (msg) {
    $("#gateMsg").textContent = msg;
    $("#gateMsg").classList.add("err");
  }
  $("#gateCode").focus();
  const g = $("#gateLogo").getContext("2d");
  const copy = () => {
    if ($("#gate").hidden) return;
    g.clearRect(0, 0, 44, 44);
    g.drawImage($("#logo"), 0, 0, 44, 44);
    requestAnimationFrame(copy);
  };
  copy();
}
$("#gateForm").addEventListener("submit", (e) => {
  e.preventDefault();
  api.simCode = $("#gateCode").value.trim();
  void connect();
});

async function connect() {
  if (!api.simCode) return showGate();
  $("#pStatus").textContent = "Protocol · connecting";
  try {
    const t = await api.tools();
    $("#gate").hidden = true;
    $("#gateCode").value = "";
    S.connected = true;
    proto.classList.remove("down");
    $("#pStatus").textContent = "Protocol · connected";
    meta = { version: t.protocol_version, tools: t.tools.length };
    pollyVoice = t.tts ?? null;
    if (Array.isArray(t.demo_beats) && t.demo_beats.length) BEATS = [...t.demo_beats];
    S.mode = t.mode ?? "bedrock";
    S.llm = t.llm ?? null;
    showMode();
    void apps.preload(); // the MCP Apps host bridge, before the first transfer
    setPolly(pollyVoice ? (text) => api.speak(text) : null);
    fillVoices();
    metaLine();
    if (!feed.childElementCount) {
      protoHeading(
        "Session",
        new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
      );
      exchangeRows(t.exchanges);
    }
    captionHint(
      voice.canListen
        ? "Tap or hold the orb (or Space) to talk, or type below."
        : "Type below, or pick a suggestion.",
    );
    startPolling();
  } catch (e) {
    if (e.status === 401) {
      api.simCode = "";
      return showGate("That code didn't work. Check it and try again.");
    }
    proto.classList.add("down");
    if (e.status === 503) {
      $("#pStatus").textContent = "Protocol · simulator disabled";
      $("#gate").hidden = false;
      $("#gateMsg").textContent = "The simulator is switched off on this server.";
      $("#gateForm button").disabled = true;
      return;
    }
    $("#pStatus").textContent = "Protocol · unreachable";
    captionHint("The server could not be reached. Retrying…");
    setTimeout(connect, 5000);
  }
}

/* ---------- dev drawer (?dev=1): recording controls behind DEV_CONTROLS_CODE ---------- */
if (new URLSearchParams(location.search).get("dev") === "1") {
  const dev = $("#dev"),
    out = $("#devOut");
  dev.hidden = false;
  $("#devCode").value = api.devCode;
  $("#devCode").addEventListener("change", (e) => {
    api.devCode = e.target.value.trim();
  });
  $$("[data-dev]").forEach((b) =>
    b.addEventListener("click", async () => {
      const action = b.dataset.dev;
      if (
        action === "reset" &&
        !confirm("Reset the demo data? Transfers, quotes and alerts go back to the seed.")
      )
        return;
      b.disabled = true;
      try {
        const r = await api.dev(action);
        out.textContent = `${action}: ${JSON.stringify(r).slice(0, 160)}`;
        if (action === "reset") {
          S.conversationId = null;
          S.receipts.clear();
          S.consent = null;
          apps.reset();
          log.replaceChildren();
          protoHeading("Demo data reset", hhmm(new Date().toISOString()));
          $("#chips").classList.remove("off");
        }
        void pollState();
      } catch (e) {
        out.textContent = `${action}: ${e.status === 404 ? "not available (wrong dev code, or nothing to do)" : e.message}`;
      } finally {
        b.disabled = false;
      }
    }),
  );
  $$("[data-st]").forEach((b) => b.addEventListener("click", () => orb.setState(b.dataset.st)));
  // Collapses to its title so it stays out of a screen recording.
  $("#devToggle").addEventListener("click", () => {
    const min = dev.classList.toggle("min");
    $("#devToggle").setAttribute("aria-expanded", String(!min));
  });
}

void connect();
