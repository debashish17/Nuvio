import type { Db } from "../db/connection.js";
import type { AlertService } from "./alerts.js";
import type { LedgerService } from "./ledger.js";
import { CUSTOMER_LABEL } from "./ledger.js";
import { aedNumber, sayAed, sayDate } from "./money.js";
import { isRefusal } from "./refusal.js";
import { dubaiDate } from "./time.js";
import type { Clock, TransferStatus } from "./types.js";

/**
 * get_pending (SPEC tool 14): what is waiting on the user since their last conversation, read
 * from the ledger, so context carries across sessions even though conversations do not. Also
 * the last transfer to each recipient, so "send the usual to Mum" resolves from history.
 */

/** Rate alerts that fired this recently still count as news. */
const FIRED_ALERT_DAYS = 7;

interface QuoteRow {
  id: string;
  beneficiary_id: string;
  nickname: string;
  send_amount_minor: number;
  receive_amount_minor: number;
  status: string;
  rate_locked_until: string;
}

interface LastRow {
  beneficiary_id: string;
  nickname: string;
  full_name: string;
  ref: string;
  send_amount_minor: number;
  payout_method: string;
  purpose: string;
  status: TransferStatus;
  created_at: string;
}

export class PendingService {
  constructor(
    private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly alerts: AlertService,
    private readonly now: Clock = () => new Date(),
  ) {}

  pending(userId: string) {
    const now = this.now();
    const openQuotes = (
      this.db
        .prepare(
          `SELECT q.id, q.beneficiary_id, b.nickname, q.send_amount_minor, q.receive_amount_minor,
                  q.status, q.rate_locked_until
           FROM quotes q JOIN beneficiaries b ON b.id = q.beneficiary_id
           WHERE q.user_id = ? AND q.status IN ('open', 'prepared') AND q.rate_locked_until > ?
           ORDER BY q.created_at DESC`,
        )
        .all(userId, now.toISOString()) as QuoteRow[]
    ).map((q) => ({
      quote_id: q.id,
      recipient: q.nickname,
      beneficiary_id: q.beneficiary_id,
      send_amount_minor: q.send_amount_minor,
      receive_amount_minor: q.receive_amount_minor,
      status: q.status,
      rate_locked_until: q.rate_locked_until,
    }));

    const underReview = (
      this.db
        .prepare(
          "SELECT ref FROM transfers WHERE user_id = ? AND status = 'ON_HOLD' ORDER BY created_at DESC",
        )
        .all(userId) as { ref: string }[]
    ).flatMap(({ ref }) => {
      const t = this.ledger.track(userId, ref);
      if (isRefusal(t)) return [];
      return [
        {
          transfer_ref: t.transfer_ref,
          recipient: t.recipient,
          send_amount_minor: t.send_amount_minor,
          sent_on: t.sent_on,
          customer_label: t.customer_label,
          cancellable: t.cancellable,
          action_required: "action_required" in t ? t.action_required : null,
        },
      ];
    });

    const since = now.getTime() - FIRED_ALERT_DAYS * 86_400_000;
    const firedAlerts = this.alerts
      .list(userId)
      .filter((a) => a.fired_at && Date.parse(a.fired_at) >= since)
      .map((a) => ({
        alert_id: a.alert_id,
        pair: a.pair,
        target: a.target,
        direction: a.direction,
        fired_at: a.fired_at,
      }));

    // The last transfer to each recipient that actually went (or is going) through.
    const lastByRecipient = (
      this.db
        .prepare(
          `SELECT b.id AS beneficiary_id, b.nickname, b.full_name, t.ref, t.send_amount_minor,
                  t.payout_method, t.purpose, t.status, t.created_at
           FROM beneficiaries b
           JOIN transfers t ON t.ref = (
             SELECT ref FROM transfers
             WHERE user_id = b.user_id AND beneficiary_id = b.id
               AND status NOT IN ('CANCELLED', 'RETURNED')
             ORDER BY created_at DESC, rowid DESC LIMIT 1)
           WHERE b.user_id = ?
           ORDER BY t.created_at DESC`,
        )
        .all(userId) as LastRow[]
    ).map((r) => ({
      beneficiary_id: r.beneficiary_id,
      recipient: r.nickname,
      full_name: r.full_name,
      transfer_ref: r.ref,
      send_amount_minor: r.send_amount_minor,
      payout_method: r.payout_method,
      purpose: r.purpose,
      date: dubaiDate(new Date(r.created_at)),
      customer_label: CUSTOMER_LABEL[r.status],
    }));

    return {
      open_quotes: openQuotes,
      under_review: underReview,
      fired_alerts: firedAlerts,
      last_by_recipient: lastByRecipient,
      summary: summarise(openQuotes, underReview, firedAlerts),
    };
  }
}

/** One line per item that needs attention, in plain words; "Nothing needs your attention." if none. */
function summarise(
  quotes: { recipient: string; send_amount_minor: number }[],
  review: {
    recipient: string;
    send_amount_minor: number;
    action_required: { document?: unknown; deadline?: unknown } | null;
  }[],
  alerts: { target: number; direction: string; fired_at: string | null }[],
): string {
  const lines = [
    ...review.map((r) => {
      const a = r.action_required;
      const what = a
        ? `: upload ${String(a.document)} in the Nuvio app${typeof a.deadline === "string" ? ` by ${sayDate(a.deadline)}` : ""}`
        : "; nothing is needed from you right now";
      return `Your ${aedNumber(r.send_amount_minor)} dirham transfer to ${r.recipient} is under review${what}.`;
    }),
    ...alerts.map(
      (a) =>
        `Your rate alert fired: the dirham went ${a.direction} ${a.target.toFixed(2)} rupees${a.fired_at ? ` on ${sayDate(a.fired_at.slice(0, 10))}` : ""}.`,
    ),
    ...quotes.map(
      (q) => `You have an open quote to send ${sayAed(q.send_amount_minor)} to ${q.recipient}.`,
    ),
  ];
  return lines.length ? lines.join(" ") : "Nothing needs your attention.";
}
