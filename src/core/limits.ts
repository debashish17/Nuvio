import type { Db } from "../db/connection.js";
import { maxSendForReceive, sayAed, sayDate, sayInr } from "./money.js";
import { PAYOUT_POLICY, VERIFIED_TIER, type TierConfig } from "./policy.js";
import { refuse } from "./refusal.js";
import { monthlyResetDate, startOfDubaiDay, startOfDubaiMonth, startOfDubaiYear } from "./time.js";
import type { Clock, PayoutMethod, Recipient, Refusal, RefusalCode, Warning } from "./types.js";

/**
 * LimitService (SPEC). Usage counts every transfer that is not CANCELLED or RETURNED, by Dubai
 * calendar day and month. Quotes do not reserve limit; confirm re-runs the check.
 */

export interface LimitsSnapshot {
  daily: { limit_minor: number; used_minor: number; remaining_minor: number };
  monthly: { limit_minor: number; used_minor: number; remaining_minor: number; resets_on: string };
}

export interface CheckInput {
  recipient: Recipient;
  sendMinor: number;
  method: PayoutMethod;
  /** Guaranteed INR paise, for the cash-pickup cash cap. */
  receiveMinor: number;
  /** Customer rate, to tell the sender the most they can send by cash pickup. */
  rate: number;
}

export type CheckResult = { ok: true; warnings: Warning[] } | Refusal;

const COUNTED = "status NOT IN ('CANCELLED', 'RETURNED')";

export class LimitService {
  constructor(
    private readonly db: Db,
    private readonly now: Clock = () => new Date(),
    readonly tier: TierConfig = VERIFIED_TIER,
  ) {}

  remaining(userId: string): LimitsSnapshot {
    const now = this.now();
    const daily = this.sumSince(userId, startOfDubaiDay(now));
    const monthly = this.sumSince(userId, startOfDubaiMonth(now));
    return {
      daily: {
        limit_minor: this.tier.dailyMinor,
        used_minor: daily,
        remaining_minor: Math.max(0, this.tier.dailyMinor - daily),
      },
      monthly: {
        limit_minor: this.tier.monthlyMinor,
        used_minor: monthly,
        remaining_minor: Math.max(0, this.tier.monthlyMinor - monthly),
        resets_on: monthlyResetDate(now),
      },
    };
  }

  check(userId: string, input: CheckInput): CheckResult {
    const { recipient, sendMinor, method } = input;
    const t = this.tier;
    const snap = this.remaining(userId);
    const aed = { currency: "AED" };

    if (sendMinor > t.perTransactionMinor) {
      return refuse(
        "PER_TRANSACTION_LIMIT",
        `The most you can send in one card-funded transfer is ${sayAed(t.perTransactionMinor)}. Send up to that now and the rest in another transfer, within your daily limit.`,
        { limit_minor: t.perTransactionMinor, requested_minor: sendMinor, ...aed },
      );
    }

    if (method === "cash_pickup") {
      const cash = this.checkCashPickup(userId, input);
      if (cash) return cash;
    }

    if (sendMinor > t.newRecipientFirstTransferMinor && this.isNewRecipient(userId, recipient)) {
      return refuse(
        "NEW_RECIPIENT_LIMIT",
        `${recipient.nickname} was added less than ${t.newRecipientWindowHours} hours ago, so the first transfer is capped at ${sayAed(t.newRecipientFirstTransferMinor)}. Send up to that now; normal limits apply after ${t.newRecipientWindowHours} hours.`,
        {
          limit_minor: t.newRecipientFirstTransferMinor,
          requested_minor: sendMinor,
          ...aed,
          window_hours: t.newRecipientWindowHours,
        },
      );
    }

    if (snap.daily.used_minor + sendMinor > t.dailyMinor) {
      const left = snap.daily.remaining_minor;
      return refuse(
        "DAILY_LIMIT",
        left > 0
          ? `Send up to ${sayAed(left)} today, or the rest after midnight UAE time when the daily limit resets.`
          : "You have used today's limit. It resets at midnight UAE time.",
        {
          limit_minor: t.dailyMinor,
          used_minor: snap.daily.used_minor,
          requested_minor: sendMinor,
          ...aed,
        },
      );
    }

    if (snap.monthly.used_minor + sendMinor > t.monthlyMinor) {
      const left = snap.monthly.remaining_minor;
      const raise = `raise your limit by adding ${t.nextTier.requirement} in the Nuvio app`;
      return refuse(
        "MONTHLY_LIMIT",
        left > 0
          ? `Send up to ${sayAed(left)} now, or ${raise}.`
          : `You have used this month's limit. It resets on ${sayDate(snap.monthly.resets_on)}, or you can ${raise}.`,
        {
          limit_minor: t.monthlyMinor,
          used_minor: snap.monthly.used_minor,
          requested_minor: sendMinor,
          ...aed,
          resets_on: snap.monthly.resets_on,
        },
      );
    }

    if (sendMinor >= t.sourceOfFundsThresholdMinor) {
      return refuse(
        "SOURCE_OF_FUNDS_REQUIRED",
        `Transfers of ${sayAed(t.sourceOfFundsThresholdMinor)} or more need proof of where the money came from, such as a salary certificate or bank statement, uploaded in the Nuvio app.`,
        { threshold_minor: t.sourceOfFundsThresholdMinor, requested_minor: sendMinor, ...aed },
      );
    }

    const warnings: Warning[] = [];
    const remainingAfter = t.monthlyMinor - snap.monthly.used_minor - sendMinor;
    if (remainingAfter < t.monthlyMinor * t.nearMonthlyLimitFraction) {
      warnings.push({
        code: "NEAR_MONTHLY_LIMIT",
        remaining_after_minor: remainingAfter,
        ...aed,
        resets_on: snap.monthly.resets_on,
      });
    }
    return { ok: true, warnings };
  }

  private checkCashPickup(userId: string, input: CheckInput): Refusal | undefined {
    const { recipient, sendMinor, receiveMinor, rate } = input;
    const cap = this.tier.cashPickup;
    const base = { currency: "AED", requested_minor: sendMinor };
    if (sendMinor > cap.perTransactionMinor) {
      return refuse(
        "CASH_PICKUP_LIMIT",
        `Cash pickup is capped at ${sayAed(cap.perTransactionMinor)} per transfer. Send less, or choose bank deposit or UPI.`,
        { cap: "per_transaction", limit_minor: cap.perTransactionMinor, ...base },
      );
    }
    const pickups = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM transfers WHERE user_id = ? AND beneficiary_id = ?
         AND payout_method = 'cash_pickup' AND ${COUNTED} AND created_at >= ?`,
      )
      .get(userId, recipient.id, startOfDubaiYear(this.now()).toISOString()) as { n: number };
    if (pickups.n >= cap.perRecipientPerYear) {
      return refuse(
        "CASH_PICKUP_LIMIT",
        `${recipient.nickname} has had ${cap.perRecipientPerYear} cash pickups this year, the yearly maximum. Choose bank deposit or UPI instead.`,
        { cap: "per_recipient_per_year", limit: cap.perRecipientPerYear, used: pickups.n, ...base },
      );
    }
    if (receiveMinor > cap.maxReceiveMinor) {
      const fee = PAYOUT_POLICY.cash_pickup.feeMinor;
      const maxSend = maxSendForReceive(cap.maxReceiveMinor, fee, rate);
      return refuse(
        "CASH_PICKUP_LIMIT",
        `Cash pickup can pay out at most ${sayInr(cap.maxReceiveMinor)}. Send up to ${sayAed(maxSend)} for cash pickup, or choose bank deposit or UPI.`,
        {
          cap: "max_cash_inr",
          limit_inr_minor: cap.maxReceiveMinor,
          receive_inr_minor: receiveMinor,
          max_send_minor: maxSend,
          ...base,
        },
      );
    }
    return undefined;
  }

  private isNewRecipient(userId: string, r: Recipient): boolean {
    const windowMs = this.tier.newRecipientWindowHours * 3_600_000;
    if (this.now().getTime() - Date.parse(r.addedAt) >= windowMs) return false;
    const prior = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM transfers WHERE user_id = ? AND beneficiary_id = ? AND ${COUNTED}`,
      )
      .get(userId, r.id) as { n: number };
    return prior.n === 0;
  }

  private sumSince(userId: string, since: Date): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(send_amount_minor), 0) AS used FROM transfers
         WHERE user_id = ? AND ${COUNTED} AND created_at >= ?`,
      )
      .get(userId, since.toISOString()) as { used: number };
    return row.used;
  }

  /** Plain-words explanation of a refusal code, with the numbers that apply to this user now. */
  explain(code: RefusalCode, userId: string): string {
    const t = this.tier;
    const s = this.remaining(userId);
    const nextTier = `Adding ${t.nextTier.requirement} in the Nuvio app moves you to ${t.nextTier.name}, with ${sayAed(t.nextTier.monthlyMinor)} a month.`;
    const texts: Record<RefusalCode, string> = {
      MONTHLY_LIMIT: `On your current tier you can send ${sayAed(t.monthlyMinor)} a month. You have ${sayAed(s.monthly.remaining_minor)} left until ${sayDate(s.monthly.resets_on)}. ${nextTier}`,
      DAILY_LIMIT: `You can send up to ${sayAed(t.dailyMinor)} a day. You have ${sayAed(s.daily.remaining_minor)} left today; the daily limit resets at midnight UAE time.`,
      PER_TRANSACTION_LIMIT: `Card-funded transfers are capped at ${sayAed(t.perTransactionMinor)} each. You can send more in separate transfers within your daily and monthly limits.`,
      NEW_RECIPIENT_LIMIT: `The first transfer to a recipient added in the last ${t.newRecipientWindowHours} hours is capped at ${sayAed(t.newRecipientFirstTransferMinor)}, to protect you if the details were added by someone else. After ${t.newRecipientWindowHours} hours the normal limits apply.`,
      SOURCE_OF_FUNDS_REQUIRED: `Transfers of ${sayAed(t.sourceOfFundsThresholdMinor)} or more need proof of where the money came from, such as a salary certificate or bank statement. Upload it in the Nuvio app.`,
      CASH_PICKUP_LIMIT: `Cash pickup in India follows the Money Transfer Service Scheme: at most ${sayAed(t.cashPickup.perTransactionMinor)} per transfer, ${t.cashPickup.perRecipientPerYear} pickups per recipient a year, and ${sayInr(t.cashPickup.maxReceiveMinor)} in cash. Bank deposit and UPI have no cash cap.`,
      LIMIT_EXCEEDED:
        "Your limits changed after the quote, for example because another transfer went through. Ask for a new quote.",
      AMOUNT_TOO_SMALL: "The amount must be more than the transfer fee.",
      PURPOSE_NOT_SUPPORTED:
        "Business payments are not supported in the personal Nuvio app. Use Nuvio Business instead.",
      PURPOSE_REQUIRES_DOCUMENTS:
        "Property payments need a sale agreement uploaded in the Nuvio app before sending.",
      PAYOUT_METHOD_UNAVAILABLE:
        "That payout method needs details this recipient does not have saved. Choose another method, or add the details in the Nuvio app.",
      BENEFICIARY_NOT_FOUND:
        "That recipient is not saved. Recipients are added and name-verified in the Nuvio app.",
      QUOTE_UNKNOWN: "That quote was not found. Ask for a new quote.",
      QUOTE_EXPIRED: "Rates are held for 30 minutes. That quote has expired; ask for a new one.",
      QUOTE_ALREADY_USED: "That quote has already been used for a transfer. Ask for a new quote.",
      TOKEN_UNKNOWN:
        "That confirmation is not valid. Prepare the transfer again to get a new read-back.",
      TOKEN_EXPIRED:
        "Confirmations last 5 minutes. Prepare the transfer again to get a new read-back.",
      TOKEN_USED: "That confirmation has already been used, so nothing was sent twice.",
      STEP_UP_REQUIRED:
        "Every transfer is approved twice: your yes to the read-back, then the one-time code Nuvio texts to your registered phone.",
      OTP_INVALID:
        "That code didn't match. Read the 6-digit code from the latest Nuvio text message.",
      OTP_EXPIRED: "Codes last 5 minutes. Ask for a new code; nothing has been sent.",
      OTP_LOCKED:
        "After 3 wrong codes the confirmation is cancelled, so nothing was sent. Prepare the transfer again to start over.",
      CARD_DECLINED:
        "Your card was declined and nothing was sent. Check the card in the Nuvio app or try again later.",
      TRANSFER_NOT_FOUND: "No transfer with that reference was found on your account.",
      CANCEL_WINDOW_CLOSED:
        "Transfers can be cancelled only before they are sent to the payout partner. After that, a recall needs the recipient's consent; Nuvio support can request one from the app.",
      CURRENCY_NOT_SUPPORTED:
        "Rates are available for the currencies with a published ECB reference rate, plus the Gulf currencies tied to the US dollar. Nuvio sends money from AED to INR only.",
      RATE_UNAVAILABLE:
        "The reference rate couldn't be fetched just now. Ask again in a few minutes.",
      ALERT_TARGET_INVALID: "The alert target must be a positive rate, such as 26.5.",
      INTERNAL_ERROR: "Something went wrong on our side. Nothing was charged; try again shortly.",
    };
    return texts[code];
  }

  /** Everything check_limits returns. */
  describe(userId: string, code?: RefusalCode) {
    const t = this.tier;
    const s = this.remaining(userId);
    return {
      kyc_tier: t.label,
      next_tier: `${t.nextTier.name}: add ${t.nextTier.requirement} to raise the monthly limit to ${sayAed(t.nextTier.monthlyMinor)}`,
      per_transaction: {
        limit_minor: t.perTransactionMinor,
        currency: "AED",
        funding: "debit card",
      },
      daily: s.daily,
      monthly: s.monthly,
      cash_pickup: {
        per_transaction_aed_minor: t.cashPickup.perTransactionMinor,
        per_recipient_per_year: t.cashPickup.perRecipientPerYear,
        max_cash_inr_minor: t.cashPickup.maxReceiveMinor,
      },
      new_recipient_first_transfer: {
        limit_minor: t.newRecipientFirstTransferMinor,
        window_hours: t.newRecipientWindowHours,
      },
      source_of_funds: { threshold_minor: t.sourceOfFundsThresholdMinor },
      explanation: this.explain(code ?? "MONTHLY_LIMIT", userId),
      ...(code ? { refusal_code: code } : {}),
    };
  }
}

/** Confirm-time wrapper: limits moved between quote and confirm. */
export function limitExceeded(inner: Refusal): Refusal {
  const { code, resolution, ...numbers } = inner.refused;
  return refuse("LIMIT_EXCEEDED", `Your limits changed since the quote. ${resolution}`, {
    limit_code: code,
    ...numbers,
  });
}
