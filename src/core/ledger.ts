import type { Db } from "../db/connection.js";
import type { ConfirmationGate } from "./confirm.js";
import { tokenPrefix } from "./confirm.js";
import { limitExceeded, type LimitService } from "./limits.js";
import { aedNumber, sayAed } from "./money.js";
import { PAYOUT_POLICY, REFUND_ETA, REFUND_ETA_SPOKEN } from "./policy.js";
import { isRefusal, refuse } from "./refusal.js";
import { getRecipient, getUser, recipientPhrase } from "./repo.js";
import { dubaiDate, startOfDubaiMonth } from "./time.js";
import {
  consoleLogger,
  type Clock,
  type Logger,
  type PayoutMethod,
  type Purpose,
  type Refusal,
  type TransferStatus,
} from "./types.js";
import { makeUtr } from "./utr.js";

/**
 * LedgerService (SPEC): the only code that moves money. confirm() and cancel() each run in one
 * SQLite transaction that also consumes the ConfirmationGate token, so a refusal at any step rolls
 * the whole thing back, token included. The card is charged last, after every write, so a decline
 * leaves nothing behind. Output objects are wire-shaped (amounts in `_minor`).
 */

export interface CardGateway {
  charge(userId: string, amountMinor: number, ref: string): { ok: true } | { ok: false };
  refund(userId: string, amountMinor: number, ref: string): void;
}

/** The demo card: always approves, and records what it did so tests can count charges. */
export class MockCard implements CardGateway {
  readonly charges: { userId: string; amountMinor: number; ref: string }[] = [];
  readonly refunds: { userId: string; amountMinor: number; ref: string }[] = [];
  charge(userId: string, amountMinor: number, ref: string) {
    this.charges.push({ userId, amountMinor, ref });
    return { ok: true as const };
  }
  refund(userId: string, amountMinor: number, ref: string) {
    this.refunds.push({ userId, amountMinor, ref });
  }
}

export interface LedgerDeps {
  db: Db;
  gate: ConfirmationGate;
  limits: LimitService;
  card?: CardGateway;
  now?: Clock;
  logger?: Logger;
  /** Time a transfer spends in SCREENING and in SENT_TO_PARTNER before the ticker advances it. */
  stepMs?: number;
}

const CANCELLABLE: ReadonlySet<TransferStatus> = new Set([
  "CREATED",
  "FUNDS_RECEIVED",
  "SCREENING",
  "ON_HOLD",
]);

/** What the customer hears for each status. ON_HOLD is "Under review" and nothing more (rule 5). */
export const CUSTOMER_LABEL: Record<TransferStatus, string> = {
  CREATED: "Created",
  FUNDS_RECEIVED: "Payment received",
  SCREENING: "Checking details",
  SENT_TO_PARTNER: "Sent to the payout partner",
  PAID_OUT: "Paid out",
  ON_HOLD: "Under review",
  CANCELLED: "Cancelled",
  RETURNED: "Returned",
};

const RECEIPT = "Receipt and FIRA will be available in the Nuvio app once paid out.";
const RETURN_REFUND_NOTE = "refunded at the rate on the return date; fee not refunded";

interface TransferRow {
  ref: string;
  user_id: string;
  beneficiary_id: string;
  quote_id: string | null;
  send_amount_minor: number;
  send_currency: string;
  receive_amount_minor: number;
  fee_minor: number;
  rate: number;
  payout_method: PayoutMethod;
  purpose: Purpose;
  status: TransferStatus;
  utr: string | null;
  created_at: string;
  paid_out_at: string | null;
  eta: string | null;
  hold_rfi_json: string | null;
  return_reason: string | null;
  refund_minor: number | null;
  nickname: string;
  relationship: string;
}

/** Thrown inside a transaction to roll it back and return a refusal instead. */
class Rollback extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.refused.code);
  }
}

export class LedgerService {
  private readonly db: Db;
  private readonly gate: ConfirmationGate;
  private readonly limits: LimitService;
  private readonly card: CardGateway;
  private readonly now: Clock;
  private readonly logger: Logger;
  private readonly stepMs: number;

  constructor(deps: LedgerDeps) {
    this.db = deps.db;
    this.gate = deps.gate;
    this.limits = deps.limits;
    this.card = deps.card ?? new MockCard();
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? consoleLogger;
    this.stepMs = deps.stepMs ?? 15_000;
  }

  // ---------------------------------------------------------------- confirm

  /** SPEC token rule 3. */
  confirm(userId: string, token: string, callerId: string) {
    const prefix = tokenPrefix(token);
    return this.atomically(`confirm ${prefix}`, () => {
      const target = this.gate.consume(token, callerId, "transfer");
      if (isRefusal(target)) throw new Rollback(target);
      if (target.kind !== "transfer") throw new Error("gate returned the wrong kind");

      const q = this.db
        .prepare("SELECT * FROM quotes WHERE id = ? AND user_id = ?")
        .get(target.quoteId, userId) as
        | {
            id: string;
            beneficiary_id: string;
            send_amount_minor: number;
            payout_method: PayoutMethod;
            purpose: Purpose;
            locked_rate: number;
            fee_minor: number;
            receive_amount_minor: number;
            rate_locked_until: string;
            status: string;
          }
        | undefined;
      if (!q || q.status !== "prepared") {
        throw new Rollback(
          refuse("QUOTE_UNKNOWN", "That quote can no longer be confirmed. Ask for a new quote."),
        );
      }
      const now = this.now();
      if (Date.parse(q.rate_locked_until) <= now.getTime()) {
        throw new Rollback(
          refuse("QUOTE_EXPIRED", "The rate lock on that quote has ended. Ask for a new quote.", {
            quote_id: q.id,
          }),
        );
      }
      const recipient = getRecipient(this.db, userId, q.beneficiary_id);
      if (!recipient) throw new Rollback(refuse("BENEFICIARY_NOT_FOUND", "Recipient not found."));

      const check = this.limits.check(userId, {
        recipient,
        sendMinor: q.send_amount_minor,
        method: q.payout_method,
        receiveMinor: q.receive_amount_minor,
        rate: q.locked_rate,
      });
      if (isRefusal(check)) throw new Rollback(limitExceeded(check));

      const ref = this.nextRef();
      const at = now.toISOString();
      const eta = PAYOUT_POLICY[q.payout_method].eta.split(",")[0] ?? "";
      this.db
        .prepare(
          `INSERT INTO transfers (ref, user_id, beneficiary_id, quote_id, send_amount_minor,
            send_currency, receive_amount_minor, fee_minor, rate, payout_method, purpose, status,
            created_at, eta)
           VALUES (?, ?, ?, ?, ?, 'AED', ?, ?, ?, ?, ?, 'SCREENING', ?, ?)`,
        )
        .run(
          ref,
          userId,
          recipient.id,
          q.id,
          q.send_amount_minor,
          q.receive_amount_minor,
          q.fee_minor,
          q.locked_rate,
          q.payout_method,
          q.purpose,
          at,
          eta,
        );
      this.addEvent(ref, "FUNDS_RECEIVED", at);
      this.addEvent(ref, "SCREENING", at);
      this.db.prepare("UPDATE quotes SET status = 'consumed' WHERE id = ?").run(q.id);

      // Last, so a decline rolls back every write above (and the token).
      const charge = this.card.charge(userId, q.send_amount_minor, ref);
      if (!charge.ok) {
        throw new Rollback(
          refuse(
            "CARD_DECLINED",
            "Your card was declined and nothing was sent. Check the card in the Nuvio app, then try again.",
          ),
        );
      }

      this.logger.info(`ledger: confirmed ${ref} with ${prefix}`);
      return {
        transfer_ref: ref,
        status: "SCREENING" as const,
        customer_label: CUSTOMER_LABEL.SCREENING,
        recipient: recipient.nickname,
        send_amount_minor: q.send_amount_minor,
        charged_minor: q.send_amount_minor,
        funding: `debit card ending ${getUser(this.db, userId).cardLast4}`,
        receive_amount_minor: q.receive_amount_minor,
        eta,
        receipt: RECEIPT,
      };
    });
  }

  // ---------------------------------------------------------------- cancel

  cancellable(ref: string): boolean {
    const row = this.db.prepare("SELECT status FROM transfers WHERE ref = ?").get(ref) as
      { status: TransferStatus } | undefined;
    return row ? CANCELLABLE.has(row.status) : false;
  }

  /** Step 1: the preview to read back, and a cx_ token valid for 5 minutes. */
  cancelPreview(userId: string, ref: string, callerId: string) {
    const t = this.find(userId, ref);
    if (!t) return notFound(ref);
    if (!CANCELLABLE.has(t.status)) return windowClosed(t);

    const issued = this.gate.issue({ kind: "cancel", ref }, callerId);
    const card = getUser(this.db, userId).cardLast4;
    const to = t.relationship === "self" ? recipientPhrase(this.recipientOf(t)) : t.nickname;
    return {
      transfer_ref: ref,
      status: t.status,
      customer_label: CUSTOMER_LABEL[t.status],
      cancellable: true,
      cancel_token: issued.token,
      expires_at: issued.expiresAt,
      refund_minor: t.send_amount_minor,
      preview:
        `Cancel the ${aedNumber(t.send_amount_minor)} dirham transfer to ${to}. ` +
        `${sayAed(t.send_amount_minor)}, including the ${aedNumber(t.fee_minor)} dirham fee, go back to your card ending ${card} ${REFUND_ETA_SPOKEN}. ` +
        "Shall I cancel it?",
    };
  }

  /** Step 2: SPEC token rule 4. Refunds the amount charged (fee included) and frees the limits. */
  cancel(userId: string, ref: string, token: string, callerId: string) {
    const prefix = tokenPrefix(token);
    return this.atomically(`cancel ${ref} ${prefix}`, () => {
      const target = this.gate.consume(token, callerId, "cancel");
      if (isRefusal(target)) throw new Rollback(target);
      if (target.kind !== "cancel" || target.ref !== ref) {
        throw new Rollback(
          refuse(
            "TOKEN_UNKNOWN",
            "That cancellation confirmation is for a different transfer. Ask to cancel again to get a new preview.",
          ),
        );
      }
      const t = this.find(userId, ref);
      if (!t) throw new Rollback(notFound(ref));
      // The ticker may have sent it on since the preview.
      if (!CANCELLABLE.has(t.status)) throw new Rollback(windowClosed(t));

      const at = this.now().toISOString();
      this.db
        .prepare("UPDATE transfers SET status = 'CANCELLED', refund_minor = ? WHERE ref = ?")
        .run(t.send_amount_minor, ref);
      this.addEvent(ref, "CANCELLED", at);
      this.card.refund(userId, t.send_amount_minor, ref);

      const snap = this.limits.remaining(userId);
      this.logger.info(`ledger: cancelled ${ref} with ${prefix}`);
      return {
        transfer_ref: ref,
        status: "CANCELLED" as const,
        customer_label: CUSTOMER_LABEL.CANCELLED,
        refund: {
          amount_minor: t.send_amount_minor,
          currency: "AED",
          to: `card ending ${getUser(this.db, userId).cardLast4}`,
          eta: REFUND_ETA,
        },
        limits_now: {
          monthly: { remaining_minor: snap.monthly.remaining_minor },
          daily: { remaining_minor: snap.daily.remaining_minor },
        },
      };
    });
  }

  // ---------------------------------------------------------------- read

  /** One transfer by ref, or the most recent one. */
  track(userId: string, ref?: string) {
    const t = ref ? this.find(userId, ref) : this.latest(userId);
    if (!t) {
      return ref
        ? notFound(ref)
        : refuse("TRANSFER_NOT_FOUND", "There are no transfers on your account yet.");
    }
    const timeline = this.db
      .prepare("SELECT status, at FROM transfer_events WHERE ref = ? ORDER BY at, rowid")
      .all(t.ref) as { status: TransferStatus; at: string }[];

    return {
      transfer_ref: t.ref,
      status: t.status,
      customer_label: CUSTOMER_LABEL[t.status],
      recipient: t.nickname,
      beneficiary_id: t.beneficiary_id,
      payout_method: t.payout_method,
      send_amount_minor: t.send_amount_minor,
      fee_minor: t.fee_minor,
      receive_amount_minor: t.receive_amount_minor,
      sent_on: dubaiDate(new Date(t.created_at)),
      eta: t.eta,
      cancellable: CANCELLABLE.has(t.status),
      timeline,
      ...(t.status === "PAID_OUT" ? { utr: t.utr, paid_out_at: t.paid_out_at } : {}),
      ...(t.status === "ON_HOLD" ? holdDetails(t) : {}),
      ...(t.status === "RETURNED"
        ? {
            reason: t.return_reason,
            refund: {
              amount_minor: t.refund_minor,
              currency: "AED",
              note: RETURN_REFUND_NOTE,
              eta: REFUND_ETA,
            },
          }
        : {}),
      ...(t.status === "CANCELLED"
        ? { refund: { amount_minor: t.refund_minor, currency: "AED", eta: REFUND_ETA } }
        : {}),
    };
  }

  /** Last N calendar months (Dubai), and/or one recipient; newest first. Defaults to 3 months. */
  history(userId: string, filter: { months?: number; beneficiaryId?: string } = {}) {
    const months = filter.months ?? (filter.beneficiaryId ? undefined : 3);
    const where = ["t.user_id = ?"];
    const args: unknown[] = [userId];
    if (months !== undefined) {
      where.push("t.created_at >= ?");
      args.push(startOfDubaiMonth(this.now(), -(months - 1)).toISOString());
    }
    if (filter.beneficiaryId) {
      where.push("t.beneficiary_id = ?");
      args.push(filter.beneficiaryId);
    }
    const rows = this.db
      .prepare(
        `SELECT t.*, b.nickname, b.relationship FROM transfers t
         JOIN beneficiaries b ON b.id = t.beneficiary_id
         WHERE ${where.join(" AND ")} ORDER BY t.created_at DESC, t.rowid DESC`,
      )
      .all(...args) as TransferRow[];

    const counted = rows.filter((r) => r.status !== "CANCELLED" && r.status !== "RETURNED");
    const snap = this.limits.remaining(userId);
    return {
      filter: { months: months ?? null, beneficiary_id: filter.beneficiaryId ?? null },
      transfers: rows.map((r) => ({
        transfer_ref: r.ref,
        date: dubaiDate(new Date(r.created_at)),
        recipient: r.nickname,
        beneficiary_id: r.beneficiary_id,
        payout_method: r.payout_method,
        send_amount_minor: r.send_amount_minor,
        fee_minor: r.fee_minor,
        receive_amount_minor: r.receive_amount_minor,
        status: r.status,
        customer_label: CUSTOMER_LABEL[r.status],
        ...(r.utr ? { utr: r.utr } : {}),
        ...(r.refund_minor !== null ? { refund_minor: r.refund_minor } : {}),
      })),
      totals: {
        count: rows.length,
        send_amount_minor: counted.reduce((sum, r) => sum + r.send_amount_minor, 0),
        currency: "AED",
        returned: rows.filter((r) => r.status === "RETURNED").length,
        cancelled: rows.filter((r) => r.status === "CANCELLED").length,
      },
      limits_used: {
        monthly: {
          used_minor: snap.monthly.used_minor,
          limit_minor: snap.monthly.limit_minor,
          resets_on: snap.monthly.resets_on,
        },
        daily: { used_minor: snap.daily.used_minor, limit_minor: snap.daily.limit_minor },
      },
    };
  }

  // ---------------------------------------------------------------- ticker

  /**
   * Advances each transfer at most one step: SCREENING -> SENT_TO_PARTNER and SENT_TO_PARTNER ->
   * PAID_OUT (with a UTR) once `stepMs` has passed since its last status change. ON_HOLD,
   * CANCELLED and RETURNED are never touched. `force` (dev control) skips the wait.
   */
  tick(opts: { force?: boolean } = {}): { ref: string; status: TransferStatus }[] {
    const now = this.now();
    const due = new Date(opts.force ? now.getTime() : now.getTime() - this.stepMs).toISOString();
    const at = now.toISOString();
    const rows = this.db
      .prepare(
        `SELECT t.ref, t.status, t.payout_method, b.bank_name FROM transfers t
         JOIN beneficiaries b ON b.id = t.beneficiary_id
         WHERE t.status IN ('SCREENING', 'SENT_TO_PARTNER')
           AND (SELECT MAX(e.at) FROM transfer_events e WHERE e.ref = t.ref) <= ?`,
      )
      .all(due) as {
      ref: string;
      status: TransferStatus;
      payout_method: PayoutMethod;
      bank_name: string | null;
    }[];

    return this.db.transaction(() =>
      rows.map((r) => {
        if (r.status === "SCREENING") {
          this.db
            .prepare("UPDATE transfers SET status = 'SENT_TO_PARTNER' WHERE ref = ?")
            .run(r.ref);
          this.addEvent(r.ref, "SENT_TO_PARTNER", at);
          return { ref: r.ref, status: "SENT_TO_PARTNER" as const };
        }
        this.db
          .prepare(
            "UPDATE transfers SET status = 'PAID_OUT', utr = ?, paid_out_at = ? WHERE ref = ?",
          )
          .run(makeUtr(r.payout_method, r.bank_name, now), at, r.ref);
        this.addEvent(r.ref, "PAID_OUT", at);
        return { ref: r.ref, status: "PAID_OUT" as const };
      }),
    )();
  }

  /**
   * Dev control (SPEC: "ON_HOLD stays until a dev control releases it"): an ON_HOLD transfer goes
   * back to SCREENING, so the ticker carries it on to PAID_OUT. Not reachable from any tool.
   */
  releaseHold(userId: string, ref?: string): { ref: string; status: TransferStatus } | undefined {
    const t = ref ? this.find(userId, ref) : this.oldestOnHold(userId);
    if (!t || t.status !== "ON_HOLD") return undefined;
    const at = this.now().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE transfers SET status = 'SCREENING' WHERE ref = ?").run(t.ref);
      this.addEvent(t.ref, "SCREENING", at);
    })();
    this.logger.info(`ledger: dev control released ${t.ref}`);
    return { ref: t.ref, status: "SCREENING" };
  }

  /** Runs tick() every `intervalMs` (default 1 s, so steps land on time). Returns a stop function. */
  startTicker(intervalMs = 1000): () => void {
    const handle = setInterval(() => {
      try {
        for (const c of this.tick()) this.logger.info(`ledger: ${c.ref} -> ${c.status}`);
      } catch (err) {
        this.logger.warn(`ledger: tick failed (${err instanceof Error ? err.message : err})`);
      }
    }, intervalMs);
    handle.unref();
    return () => clearInterval(handle);
  }

  // ---------------------------------------------------------------- helpers

  private atomically<T>(label: string, fn: () => T): T | Refusal {
    try {
      return this.db.transaction(fn)();
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
      // SPEC token rule 5: rejected confirms are logged with the reason and the token prefix.
      if (!err.refusal.refused.code.startsWith("TOKEN_")) {
        this.logger.warn(`ledger: rejected ${label} (${err.refusal.refused.code})`);
      }
      return err.refusal;
    }
  }

  private find(userId: string, ref: string): TransferRow | undefined {
    return this.db
      .prepare(
        `SELECT t.*, b.nickname, b.relationship FROM transfers t
         JOIN beneficiaries b ON b.id = t.beneficiary_id WHERE t.ref = ? AND t.user_id = ?`,
      )
      .get(ref.trim().toUpperCase(), userId) as TransferRow | undefined;
  }

  private oldestOnHold(userId: string): TransferRow | undefined {
    return this.db
      .prepare(
        `SELECT t.*, b.nickname, b.relationship FROM transfers t
         JOIN beneficiaries b ON b.id = t.beneficiary_id
         WHERE t.user_id = ? AND t.status = 'ON_HOLD' ORDER BY t.created_at, t.rowid LIMIT 1`,
      )
      .get(userId) as TransferRow | undefined;
  }

  private latest(userId: string): TransferRow | undefined {
    return this.db
      .prepare(
        `SELECT t.*, b.nickname, b.relationship FROM transfers t
         JOIN beneficiaries b ON b.id = t.beneficiary_id WHERE t.user_id = ?
         ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1`,
      )
      .get(userId) as TransferRow | undefined;
  }

  private recipientOf(t: TransferRow) {
    const r = getRecipient(this.db, t.user_id, t.beneficiary_id);
    if (!r) throw new Error(`Transfer ${t.ref} has no recipient`);
    return r;
  }

  private nextRef(): string {
    const row = this.db
      .prepare(
        "SELECT MAX(CAST(substr(ref, 5) AS INTEGER)) AS n FROM transfers WHERE ref LIKE 'ACM-%'",
      )
      .get() as { n: number | null };
    return `ACM-${(row.n ?? 240100) + 1}`;
  }

  private addEvent(ref: string, status: TransferStatus, at: string) {
    this.db
      .prepare("INSERT INTO transfer_events (ref, status, at) VALUES (?, ?, ?)")
      .run(ref, status, at);
  }
}

/** Under review: the label and, if one exists, what the customer must do. Never a reason. */
function holdDetails(t: TransferRow) {
  if (!t.hold_rfi_json) return {};
  const rfi = JSON.parse(t.hold_rfi_json) as Record<string, unknown>;
  return {
    action_required: {
      type: rfi.type,
      document: rfi.document,
      how: rfi.how,
      deadline: rfi.deadline,
    },
  };
}

function notFound(ref: string): Refusal {
  return refuse(
    "TRANSFER_NOT_FOUND",
    "No transfer with that reference was found on your account. Check the reference, or ask for the most recent transfer.",
    { transfer_ref: ref },
  );
}

function windowClosed(t: TransferRow): Refusal {
  const resolution =
    t.status === "CANCELLED"
      ? "This transfer is already cancelled; the refund is on its way to your card."
      : t.status === "RETURNED"
        ? "This transfer was returned by the recipient's bank and has already been refunded."
        : "This transfer has already been sent. A recall needs the recipient's consent; Nuvio support can request one from the app.";
  return refuse("CANCEL_WINDOW_CLOSED", resolution, {
    transfer_ref: t.ref,
    status: t.status,
  });
}
