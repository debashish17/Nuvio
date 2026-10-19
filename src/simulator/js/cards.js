/* Cards for real tool results (shapes from POST /mcp tools/call structuredContent, major units).
   Visual language from the v6 design: glass cards, light figures, a gradient rule on the two
   cards that move money. Every value from the server is escaped. */

export const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

export const fmt = {
  n(v, dp) {
    const d = dp ?? (Number.isInteger(+v) ? 0 : 2);
    return Number(v).toLocaleString("en-US", {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });
  },
  aed: (v, dp) => `${fmt.n(v, dp)} AED`,
  inr: (v, dp = 2) =>
    `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`,
  rate: (v) => Number(v).toFixed(2),
  /** Any pair: small rates (e.g. INR to USD) need more places to mean anything. */
  anyRate: (v) => Number(v).toFixed(Math.abs(v) < 1 ? 4 : 2),
  day: (iso) =>
    new Date(/^\d{4}-\d\d-\d\d$/.test(iso) ? `${iso}T12:00:00` : iso).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
    }),
  mmss: (s) => {
    s = Math.max(0, Math.ceil(s));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  },
};

const svg = (p, cls = "") =>
  `<svg${cls ? ` class="${cls}"` : ""} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
export const ICON = {
  check: svg('<path d="M5 12.5l4.5 4.5L19 7"/>'),
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  pause: svg('<path d="M9 6v12M15 6v12"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  alert: svg('<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.01"/>'),
  bell: svg('<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>'),
  shield: svg(
    '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  ),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h9"/>'),
  sms: svg('<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10 18.5h4"/>'),
};

const el = (html) => {
  const t = document.createElement("template");
  t.innerHTML = html.trim(); // every interpolated value is passed through esc()
  const node = t.content.firstElementChild;
  // Widths via CSSOM: the page CSP has no unsafe-inline, so style attributes are not used.
  node.querySelectorAll("[data-pct]").forEach((i) => (i.style.width = `${i.dataset.pct}%`));
  return node;
};
const kv = (rows) =>
  `<dl class="kv">${rows
    .filter(Boolean)
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`)
    .join("")}</dl>`;
const meter = (left, limit, label) => {
  const pct = Math.max(0, Math.min(100, (left / limit) * 100));
  return `<div class="meter${pct < 15 ? " low" : ""}" role="meter" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="${limit}" aria-valuenow="${left}"><i data-pct="${pct.toFixed(1)}"></i></div>`;
};
const capital = (t) => String(t ?? "").replace(/^\p{Ll}/u, (c) => c.toUpperCase());
const METHOD = { bank_deposit: "Bank deposit", upi: "UPI", cash_pickup: "Cash pickup" };

/* ---------- transfer progress ---------- */
const STEPS = [
  ["FUNDS_RECEIVED", "Payment received"],
  ["SCREENING", "Checking details"],
  ["SENT_TO_PARTNER", "Sent to the payout partner"],
  ["PAID_OUT", "Paid out"],
];
const END = { ON_HOLD: "Under review", CANCELLED: "Cancelled", RETURNED: "Returned" };
export function stepsHtml(status, timeline = []) {
  const reached = new Set(timeline.map((e) => e.status));
  reached.add(status);
  const at = STEPS.findIndex(([s]) => s === status);
  const last = at >= 0 ? at : Math.max(-1, ...STEPS.map(([s], i) => (reached.has(s) ? i : -1)));
  const items = STEPS.map(([, label], i) => ({ label, cls: i <= last ? "on" : "" }));
  if (status === "ON_HOLD") {
    // Under review takes the place of the step it is waiting on.
    items.splice(last + 1, 1, { label: END.ON_HOLD, cls: "end" });
  } else if (END[status]) {
    // Cancelled and returned are final: the steps it never reached are dropped.
    items.length = last + 1;
    items.push({ label: END[status], cls: `end end-${status.toLowerCase()}` });
  }
  const parts = items.map((x) => `<span class="${x.cls}">${esc(x.label)}</span>`);
  return `<div class="steps" role="img" aria-label="Progress: ${esc(END[status] || STEPS[Math.max(0, last)]?.[1] || status)}">${parts.join("<i></i>")}</div>`;
}

/* ---------- spoken sentence with per-word spans (char offsets for highlighting) ---------- */
function sayHtml(text) {
  return [...text.matchAll(/\S+/g)]
    .map((m) => {
      const w = m[0];
      const key = /\d/.test(w) || /^(card|ending)$/i.test(w);
      return `<span class="w${key && /\d/.test(w) ? " k" : ""}" data-at="${m.index}">${esc(w)}</span>`;
    })
    .join(" ");
}
/** Lights words up to `charIndex` in a .say element; returns true if the index was inside it. */
export function highlightSay(sayEl, charIndex) {
  let now = null;
  for (const w of sayEl.querySelectorAll(".w")) {
    const at = Number(w.dataset.at);
    if (at <= charIndex) {
      w.classList.add("on");
      now = w;
    }
  }
  sayEl.querySelectorAll(".w.now").forEach((w) => w.classList.remove("now"));
  now?.classList.add("now");
  return Boolean(now);
}

/* ---------- consequential cards (read-back, cancel preview) ---------- */
function consentCard({
  tag,
  sentence,
  expiresAt,
  yesLabel,
  noLabel,
  holdHint,
  onYes,
  onNo,
  guardNote,
}) {
  const card = el(`<article class="card consent rise" aria-label="${esc(tag)}">
    <div class="c-head"><span class="c-tag">${esc(tag)}</span>
      <span class="c-timer"><svg class="ring" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="2.5"/><circle class="arc" cx="12" cy="12" r="10" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="62.8" stroke-dashoffset="0" transform="rotate(-90 12 12)"/></svg><span class="cd" aria-label="Confirmation expires in">5:00</span></span></div>
    <p class="say">${sayHtml(sentence)}</p>
    <div class="acts"><button class="btn yes" type="button"><span>${esc(yesLabel)}</span></button><button class="btn no" type="button">${esc(noLabel)}</button><small>${esc(holdHint)}</small></div>
    ${guardNote ? `<p class="guard" hidden>${ICON.shield}<span>${esc(guardNote)}</span></p>` : ""}
  </article>`);
  const yes = card.querySelector(".yes"),
    no = card.querySelector(".no");
  const cd = card.querySelector(".cd"),
    arc = card.querySelector(".arc");
  const total = 300;
  let decided = false;
  const tick = () => {
    const left = (Date.parse(expiresAt) - Date.now()) / 1000;
    cd.textContent = fmt.mmss(left);
    arc.setAttribute("stroke-dashoffset", (62.8 * (1 - Math.max(0, left) / total)).toFixed(1));
    if (left <= 0 && !decided) {
      card.classList.add("expired");
      card.querySelector(".c-tag").textContent = "Expired · ask again to get a fresh confirmation";
      yes.disabled = no.disabled = true;
      clearInterval(iv);
    }
  };
  const iv = setInterval(tick, 1000);
  tick();
  const decide = (fn) => {
    if (decided) return;
    decided = true;
    clearInterval(iv);
    yes.disabled = no.disabled = true;
    fn();
  };
  let holdT = null;
  const down = (e) => {
    e?.preventDefault();
    if (holdT || decided) return;
    yes.classList.add("holding");
    holdT = setTimeout(() => {
      holdT = null;
      decide(onYes);
    }, 1400);
  };
  const up = () => {
    if (!holdT) return;
    clearTimeout(holdT);
    holdT = null;
    yes.classList.remove("holding");
  };
  yes.addEventListener("pointerdown", down);
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => yes.addEventListener(ev, up));
  yes.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && !e.repeat) down(e);
  });
  yes.addEventListener("keyup", (e) => {
    if (e.key === "Enter" || e.key === " ") up();
  });
  no.addEventListener("click", () => decide(onNo));
  card.settle = (text) => {
    decided = true;
    clearInterval(iv);
    yes.disabled = no.disabled = true;
    card.classList.add("settled");
    if (text) card.querySelector(".c-tag").textContent = text;
  };
  card.showGuard = () => {
    const g = card.querySelector(".guard");
    if (g) g.hidden = false;
  };
  card.say = card.querySelector(".say");
  return card;
}

export function readBackCard(prep, { onYes, onNo }) {
  return consentCard({
    tag: "Confirm transfer · money moves after your yes",
    sentence: prep.read_back,
    expiresAt: prep.expires_at,
    yesLabel: "Hold to confirm",
    noLabel: "No",
    holdHint: "Hold, or say “yes”",
    guardNote:
      "The assistant tried to confirm before your answer; the server held it until you agree.",
    onYes,
    onNo,
  });
}

export function cancelPreviewCard(p, { onYes, onNo }) {
  const c = consentCard({
    tag: `Cancel ${p.transfer_ref} · refund after your yes`,
    sentence: p.preview,
    expiresAt: p.expires_at,
    yesLabel: "Hold to cancel",
    noLabel: "Keep it",
    holdHint: `Refund ${fmt.aed(p.refund)} · or say “yes”`,
    guardNote:
      "The assistant tried to cancel before your answer; the server held it until you agree.",
    onYes,
    onNo,
  });
  c.classList.add("cancel");
  return c;
}

/* ---------- receipt (confirm_transfer) ---------- */
export function receiptCard(r, { onCancel }) {
  const card =
    el(`<article class="card receipt rise" aria-label="Transfer receipt" data-ref="${esc(r.transfer_ref)}">
    <div class="r-head"><span class="r-tick">${ICON.check}</span><div><b>Sent to ${esc(r.recipient)}</b><small>${esc(r.transfer_ref)} · ${esc(fmt.aed(r.charged))} charged to your ${esc(r.funding)}</small></div><span class="fig">${esc(fmt.inr(r.receive_amount))}</span></div>
    <div class="r-steps">${stepsHtml(r.status)}</div>
    <div class="r-cancel"><span>Not sent to the payout partner yet, so you can still cancel.</span><button class="btn sm" type="button">Cancel</button></div>
    <p class="foot">${esc(r.receipt)}</p>
  </article>`);
  card.querySelector(".r-cancel .btn").addEventListener("click", () => onCancel(r.transfer_ref));
  /** Live update from /sim/state's latest_transfer. */
  card.update = (t) => {
    if (!t || t.transfer_ref !== r.transfer_ref) return;
    card.querySelector(".r-steps").innerHTML = stepsHtml(t.status, t.timeline);
    card.querySelector(".r-cancel").hidden = !t.cancellable;
    if (t.status === "PAID_OUT" && t.utr && !card.querySelector(".utr")) {
      card.querySelector(".foot").insertAdjacentHTML("beforebegin", utrHtml(t.utr));
    }
    if (t.status === "CANCELLED")
      card.querySelector(".r-head b").textContent = `Cancelled · refund on its way`;
  };
  return card;
}
const utrHtml = (utr) =>
  `<p class="utr"><span>Bank reference (UTR)</span><code>${esc(utr)}</code><button class="icon" type="button" data-copy="${esc(utr)}" aria-label="Copy UTR">${ICON.copy}</button></p>`;

/* ---------- read-only cards ---------- */
export function rateCard(d) {
  if (d.sendable === false) {
    const [f, t] = String(d.pair).split("/");
    return el(`<article class="card rate rise" aria-label="Exchange rate">
    <p class="eyebrow">Mid-market rate · ${esc(f)} to ${esc(t)} · information only</p>
    <div class="mini"><span class="fig">${esc(fmt.anyRate(d.mid_rate))}</span><span>${esc(t)} for 1 ${esc(f)}</span></div>
    ${kv([
      ["Trend", esc(d.trend)],
      [
        "Week high / low",
        `${esc(fmt.anyRate(d.mid_week_high))} / ${esc(fmt.anyRate(d.mid_week_low))}`,
      ],
    ])}
    <p class="foot">${esc(d.note)} ${esc(d.source)}</p></article>`);
  }
  return el(`<article class="card rate rise" aria-label="Today's rate">
    <p class="eyebrow">Today's rate · AED to INR</p>
    <div class="mini"><span class="fig">${esc(fmt.inr(d.customer_rate))}</span><span>for 1 dirham · Nuvio rate</span></div>
    ${kv([
      ["Mid-market", esc(fmt.rate(d.mid_rate))],
      ["Trend", esc(d.trend)],
      [
        "Nuvio rate this week",
        `${esc(fmt.rate(d.customer_week_low))} to ${esc(fmt.rate(d.customer_week_high))}`,
      ],
    ])}
    <p class="foot">${esc(d.source)}</p></article>`);
}

export function compareCard(d) {
  const rows = d.payout_methods
    .map((o) =>
      o.available
        ? `<li><div><b>${esc(METHOD[o.method] || o.method)}</b><small>${esc(o.rail)} · ${esc(o.eta)} · fee ${esc(fmt.aed(o.fee))}</small></div><span class="amt">${esc(fmt.inr(o.receive_amount))}</span></li>`
        : `<li class="off"><div><b>${esc(METHOD[o.method] || o.method)} <em>Unavailable</em></b><small>${esc(o.note || "")}</small></div><span class="amt">—</span></li>`,
    )
    .join("");
  const b = d.benchmark;
  return el(`<article class="card compare rise" aria-label="Compare payout options">
    <p class="eyebrow">For ${esc(fmt.aed(d.send_amount))} · Nuvio rate ${esc(fmt.rate(d.customer_rate))} · mid-market ${esc(fmt.rate(d.mid_rate))}</p>
    <ul class="opts">${rows}</ul>
    <p class="bench"><span>${esc(b.name)} <em>illustrative</em></span><span>rate ${esc(fmt.rate(b.rate))} · fee ${esc(fmt.aed(b.fee))}</span><span class="amt">${esc(fmt.inr(b.receive_amount))}</span></p>
    <p class="foot">${esc(d.note)}</p></article>`);
}

export function recipientsCard(d) {
  const rows = d.recipients
    .map((r) => {
      const where =
        r.payout_method === "upi"
          ? `UPI ${esc(r.upi_id)}`
          : `${esc(r.bank)} ••${esc(r.account_last4)}`;
      const last = r.last_sent
        ? `last sent ${esc(fmt.aed(r.last_sent.send_amount))} on ${esc(fmt.day(r.last_sent.date))}`
        : "no payouts yet";
      return `<li><span class="av">${esc(r.nickname[0])}</span><div><b>${esc(r.nickname)}</b><small>${esc(r.full_name)} · ${esc(r.relationship)} · ${where}</small></div><small class="last">${last}</small></li>`;
    })
    .join("");
  return el(
    `<article class="card people rise" aria-label="Saved recipients"><p class="eyebrow">Saved recipients</p><ul class="list">${rows}</ul></article>`,
  );
}

export function chooseCard(d, { onPick }) {
  const card = el(`<article class="card choose rise" aria-label="Which recipient?">
    <p class="eyebrow">Which recipient?</p>
    <div class="picks">${d.candidates
      .map(
        (c, i) =>
          `<button class="pick" type="button" data-i="${i}"><b>${esc(c.full_name)}</b><small>${esc(c.nickname)} · ${esc(c.relationship)}</small></button>`,
      )
      .join("")}</div></article>`);
  card.querySelectorAll(".pick").forEach((b) =>
    b.addEventListener("click", () => {
      const c = d.candidates[Number(b.dataset.i)];
      card.querySelectorAll(".pick").forEach((x) => (x.disabled = true));
      b.classList.add("picked");
      onPick(`${c.full_name}, my ${c.relationship}`);
    }),
  );
  return card;
}

export function notFoundCard(d) {
  return el(
    `<article class="card note rise"><p class="eyebrow">Recipient not saved</p><p>${esc(d.hint)}</p></article>`,
  );
}

export function quoteCard(q) {
  const warn = (q.warnings || [])
    .map((w) =>
      w.code === "NEAR_MONTHLY_LIMIT"
        ? `<li>${ICON.alert}<span>Only ${esc(fmt.aed(w.remaining_after))} left this month after this · resets ${esc(fmt.day(w.resets_on))}</span></li>`
        : `<li>${ICON.alert}<span>${esc(w.note || w.code)}</span></li>`,
    )
    .join("");
  return el(`<article class="card quote rise" aria-label="Quote">
    <p class="eyebrow">Quote · rate and fee held 30 minutes</p>
    <div class="mini"><span class="fig">${esc(fmt.inr(q.receive_amount))}</span><span>guaranteed receive amount · ${esc(q.eta)}</span></div>
    ${kv([
      ["You send", esc(fmt.aed(q.send_amount))],
      ["Fee (included)", esc(fmt.aed(q.fee))],
      ["Locked rate", esc(fmt.rate(q.locked_rate))],
      ["Paid with", esc(q.funding)],
    ])}
    ${warn ? `<ul class="warns">${warn}</ul>` : ""}</article>`);
}

export function statusCard(t) {
  const label = t.customer_label || t.status;
  let body = "";
  if (t.status === "ON_HOLD") {
    const a = t.action_required;
    body = a
      ? `<div class="action"><b>Action needed</b><span>${esc(capital(a.document))}: ${esc(a.how)}${a.deadline ? ` by ${esc(fmt.day(a.deadline))}` : ""}.</span></div>`
      : `<div class="action"><span>No action needed from you right now.</span></div>`;
  } else if (t.status === "RETURNED") {
    body = `<div class="action"><b>${esc(t.reason)}</b><span>Refund ${esc(fmt.aed(t.refund?.amount))} · ${esc(t.refund?.note || "")} · ${esc(t.refund?.eta || "")}</span></div>`;
  } else if (t.status === "CANCELLED") {
    body = `<div class="action"><span>Refund ${esc(fmt.aed(t.refund?.amount))} to your card · ${esc(t.refund?.eta || "")}</span></div>`;
  } else if (t.status === "PAID_OUT" && t.utr) {
    body = utrHtml(t.utr);
  }
  return el(`<article class="card status rise st-${esc(t.status.toLowerCase())}" aria-label="Transfer status" data-ref="${esc(t.transfer_ref)}">
    <div class="r-head"><div><b>${esc(t.recipient)} · ${esc(label)}</b><small>${esc(t.transfer_ref)} · sent ${esc(fmt.day(t.sent_on))} · ${esc(fmt.aed(t.send_amount))}</small></div><span class="fig sm">${esc(fmt.inr(t.receive_amount))}</span></div>
    ${stepsHtml(t.status, t.timeline)}${body}</article>`);
}

export function cancelledCard(c) {
  return el(`<article class="card receipt cancelled rise" aria-label="Transfer cancelled">
    <div class="r-head"><span class="r-tick x">${ICON.x}</span><div><b>Cancelled ${esc(c.transfer_ref)}</b><small>${esc(fmt.aed(c.refund.amount))} back to your ${esc(c.refund.to)} · ${esc(c.refund.eta)}</small></div><span class="fig sm">${esc(fmt.aed(c.refund.amount))}</span></div>
    <p class="foot">${esc(fmt.aed(c.limits_now.monthly.remaining))} of this month's limit is free again.</p></article>`);
}

export function historyCard(h) {
  const rows = h.transfers
    .slice(0, 8)
    .map(
      (t) =>
        `<li><small class="d">${esc(fmt.day(t.date))}</small><b>${esc(t.recipient)}</b><span class="lbl lbl-${esc(t.status.toLowerCase())}">${esc(t.customer_label)}</span><span class="amt">${esc(fmt.aed(t.send_amount))}</span></li>`,
    )
    .join("");
  const m = h.limits_used.monthly;
  return el(`<article class="card history rise" aria-label="Transfer history">
    <p class="eyebrow">${h.filter.months ? `Last ${esc(h.filter.months)} months` : "History"} · ${esc(h.totals.count)} transfers · ${esc(fmt.aed(h.totals.send_amount))} sent</p>
    <ul class="hist">${rows}</ul>
    <p class="foot">This month ${esc(fmt.aed(m.used))} of ${esc(fmt.aed(m.limit))} used · resets ${esc(fmt.day(m.resets_on))}${h.totals.returned ? ` · ${esc(h.totals.returned)} returned` : ""}${h.totals.cancelled ? ` · ${esc(h.totals.cancelled)} cancelled` : ""}</p></article>`);
}

export function limitsCard(l) {
  return el(`<article class="card limits rise" aria-label="Your limits">
    <p class="eyebrow">${esc(l.kyc_tier)}</p>
    <div class="meters">
      <div><span>This month</span><b>${esc(fmt.aed(l.monthly.remaining))} left of ${esc(fmt.n(l.monthly.limit))}</b>${meter(l.monthly.remaining, l.monthly.limit, "Monthly limit left")}<small>resets ${esc(fmt.day(l.monthly.resets_on))}</small></div>
      <div><span>Today</span><b>${esc(fmt.aed(l.daily.remaining))} left of ${esc(fmt.n(l.daily.limit))}</b>${meter(l.daily.remaining, l.daily.limit, "Daily limit left")}<small>resets at midnight UAE time</small></div>
    </div>
    ${kv([
      ["Per transfer", esc(fmt.aed(l.per_transaction.limit))],
      [
        "Cash pickup",
        `${esc(fmt.aed(l.cash_pickup.per_transaction_aed))} each · ${esc(l.cash_pickup.per_recipient_per_year)} a year · max ${esc(fmt.inr(l.cash_pickup.max_cash_inr, 0))}`,
      ],
      ["New recipient, first transfer", esc(fmt.aed(l.new_recipient_first_transfer.limit))],
    ])}
    <p class="explain">${esc(l.explanation)}</p>
    <p class="foot">${esc(l.next_tier)}</p></article>`);
}

export function helpCard(h) {
  const points = h.points.map((p) => `<li>${esc(p)}</li>`).join("");
  return el(`<article class="card help rise" aria-label="${esc(h.title)}">
    <p class="eyebrow">Nuvio help · ${esc(h.title)}</p>
    <p>${esc(h.answer)}</p>
    <ul class="points">${points}</ul>
    <p class="foot">${esc(h.source)} · ${h.last_reviewed ? `reviewed ${esc(fmt.day(h.last_reviewed))}` : "demo text, not yet compliance-reviewed"}${h.disclaimer ? ` · ${esc(h.disclaimer)}` : ""}</p></article>`);
}

export function alertCard(a) {
  return el(`<article class="card alert rise" aria-label="Rate alert set">
    <div class="r-head"><span class="r-tick bell">${ICON.bell}</span><div><b>Rate alert · ${esc(a.direction)} ${esc(fmt.rate(a.target))}</b><small>${esc(a.channel)} · today ${esc(fmt.rate(a.current_rate))}</small></div></div>
    ${a.already_met ? `<p>${esc(a.message)}</p>` : ""}</article>`);
}

/* ---------- step-up: a code texted to the phone before money moves ---------- */
export function stepUpCard(r) {
  const card = el(`<article class="card consent stepup rise" aria-label="Check your phone">
    <div class="c-head"><span class="c-tag">Check your phone · nothing sent yet</span>
      <span class="c-timer"><span class="cd" aria-label="Code expires in">5:00</span></span></div>
    <div class="r-head"><span class="r-tick bell">${ICON.sms}</span><div><b>Code sent to your ${esc(r.sent_to)}</b><small>Read the 6-digit code out to approve this transfer · ${esc(r.attempts_left)} tries</small></div></div>
  </article>`);
  const cd = card.querySelector(".cd");
  const tick = () => {
    const left = (Date.parse(r.expires_at) - Date.now()) / 1000;
    cd.textContent = fmt.mmss(left);
    if (left <= 0) {
      card.classList.add("expired");
      card.querySelector(".c-tag").textContent = "Code expired · nothing was sent";
      clearInterval(iv);
    }
  };
  const iv = setInterval(tick, 1000);
  tick();
  card.settle = (text) => {
    clearInterval(iv);
    card.classList.add("settled");
    card.querySelector(".c-tag").textContent = text;
  };
  return card;
}

const REFUSAL_TITLE = {
  MONTHLY_LIMIT: "Monthly limit reached",
  DAILY_LIMIT: "Daily limit reached",
  PER_TRANSACTION_LIMIT: "Over the per-transfer limit",
  NEW_RECIPIENT_LIMIT: "New recipient limit",
  SOURCE_OF_FUNDS_REQUIRED: "Proof of funds needed",
  CASH_PICKUP_LIMIT: "Cash pickup limit",
  LIMIT_EXCEEDED: "Limits changed since the quote",
  AMOUNT_TOO_SMALL: "Amount too small",
  PURPOSE_NOT_SUPPORTED: "Purpose not supported",
  PURPOSE_REQUIRES_DOCUMENTS: "Documents needed first",
  PAYOUT_METHOD_UNAVAILABLE: "Payout method unavailable",
  BENEFICIARY_NOT_FOUND: "Recipient not saved",
  QUOTE_UNKNOWN: "Quote not found",
  QUOTE_EXPIRED: "Quote expired",
  QUOTE_ALREADY_USED: "Quote already used",
  TOKEN_UNKNOWN: "Confirmation not valid",
  TOKEN_EXPIRED: "Confirmation expired",
  TOKEN_USED: "Already done",
  OTP_INVALID: "Code didn't match",
  OTP_EXPIRED: "Code expired",
  OTP_LOCKED: "Too many wrong codes",
  CURRENCY_NOT_SUPPORTED: "Currency not available",
  RATE_UNAVAILABLE: "Rate unavailable",
  CARD_DECLINED: "Card declined",
  TRANSFER_NOT_FOUND: "Transfer not found",
  CANCEL_WINDOW_CLOSED: "Too late to cancel",
  ALERT_TARGET_INVALID: "Alert target not valid",
  INTERNAL_ERROR: "Something went wrong",
};
const MONEY_KEYS = {
  limit: "Limit",
  used: "Used",
  requested: "Requested",
  remaining_after: "Left after",
  threshold: "Threshold",
  max_send: "Most you can send",
  limit_inr: "Cash cap",
  receive_inr: "Would receive",
};

export function refusalCard(r) {
  const cur = r.currency || "AED";
  const rows = Object.entries(MONEY_KEYS)
    .filter(([k]) => typeof r[k] === "number")
    .map(([k, label]) => [
      label,
      esc(k.endsWith("_inr") ? fmt.inr(r[k], 0) : `${fmt.n(r[k])} ${cur}`),
    ]);
  if (r.resets_on) rows.push(["Resets", esc(fmt.day(r.resets_on))]);
  if (r.status) rows.push(["Status", esc(String(r.status).replaceAll("_", " ").toLowerCase())]);
  return el(`<article class="card refusal rise" aria-label="Refused by the server">
    <div class="r-head"><span class="r-tick warn">${ICON.alert}</span><div><b>${esc(REFUSAL_TITLE[r.code] || "Not possible")}</b><small>Refused by the server · ${esc(r.code)}</small></div></div>
    <p class="resolution">${esc(r.resolution)}</p>${rows.length ? kv(rows) : ""}</article>`);
}

export function systemCard(title, text) {
  return el(
    `<article class="card note sys rise"><p class="eyebrow">${esc(title)}</p><p>${esc(text)}</p></article>`,
  );
}
