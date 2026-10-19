import { randomBytes } from "node:crypto";
import type { Db } from "../db/connection.js";
import type { ConfirmationGate } from "./confirm.js";
import type { LimitService } from "./limits.js";
import {
  aedNumber,
  applyMargin,
  maxSendForReceive,
  receiveMinor,
  sayAed,
  sayInr,
  sayRate,
} from "./money.js";
import {
  BENCHMARK,
  PAYOUT_POLICY,
  PURPOSE_WORDS,
  QUOTE_LOCK_MINUTES,
  RELATIVES,
  VERIFIED_TIER,
  type TierConfig,
} from "./policy.js";
import type { RatesService } from "./rates.js";
import { isRefusal, refuse } from "./refusal.js";
import { destinationPhrase, getRecipient, getUser, recipientPhrase } from "./repo.js";
import { addMinutes } from "./time.js";
import {
  PAYOUT_METHODS,
  type Clock,
  type PayoutMethod,
  type Purpose,
  type Recipient,
  type Refusal,
  type Warning,
} from "./types.js";

/**
 * QuoteService (SPEC): pricing and delivery options. A quote is priced once; the rate and fee are
 * locked for 30 minutes and confirm never re-fetches the rate. Output objects are wire-shaped
 * (snake_case, amounts in `_minor`) so the server only converts units.
 */

export interface QuoteInput {
  beneficiaryId: string;
  sendMinor: number;
  payoutMethod?: PayoutMethod | undefined;
  purpose?: Purpose | undefined;
}

export type QuoteStatus = "open" | "prepared" | "consumed" | "expired";

export interface Quote {
  quote_id: string;
  beneficiary_id: string;
  payout_method: PayoutMethod;
  purpose: Purpose;
  send_amount_minor: number;
  send_currency: "AED";
  fee_minor: number;
  locked_rate: number;
  receive_amount_minor: number;
  receive_currency: "INR";
  guaranteed: true;
  rate_locked_until: string;
  eta: string;
  funding: string;
  warnings: Warning[];
}

export interface QuoteRecord {
  id: string;
  userId: string;
  beneficiaryId: string;
  sendMinor: number;
  payoutMethod: PayoutMethod;
  purpose: Purpose;
  lockedRate: number;
  feeMinor: number;
  receiveMinor: number;
  createdAt: string;
  rateLockedUntil: string;
  /** Effective status: an open or prepared quote past its lock reads as expired. */
  status: QuoteStatus;
}

export interface PayoutOption {
  method: PayoutMethod;
  rail: string;
  fee_minor: number;
  receive_amount_minor: number;
  eta: string;
  available: boolean;
  note?: string;
  caps?: {
    per_transaction_aed_minor: number;
    per_recipient_per_year: number;
    max_cash_inr_minor: number;
  };
}

export interface CompareResult {
  send_amount_minor: number;
  send_currency: "AED";
  mid_rate: number;
  customer_rate: number;
  payout_methods: PayoutOption[];
  benchmark: {
    name: string;
    rate: number;
    fee_minor: number;
    receive_amount_minor: number;
    illustrative: true;
  };
  note: string;
}

export interface QuoteDeps {
  db: Db;
  rates: RatesService;
  limits: LimitService;
  gate: ConfirmationGate;
  now?: Clock;
  tier?: TierConfig;
  newId?: () => string;
}

const GIFT_TAX_NOTE =
  "In India, gifts from people who are not relatives are taxable for the recipient once they exceed 50,000 rupees in a year.";

export class QuoteService {
  private readonly db: Db;
  private readonly rates: RatesService;
  private readonly limits: LimitService;
  private readonly gate: ConfirmationGate;
  private readonly now: Clock;
  private readonly tier: TierConfig;
  private readonly newId: () => string;

  constructor(deps: QuoteDeps) {
    this.db = deps.db;
    this.rates = deps.rates;
    this.limits = deps.limits;
    this.gate = deps.gate;
    this.now = deps.now ?? (() => new Date());
    this.tier = deps.tier ?? VERIFIED_TIER;
    this.newId = deps.newId ?? (() => `q_${randomBytes(4).toString("hex")}`);
  }

  /** What the recipient would receive by each payout method, against mid and a typical bank. */
  async compare(sendMinor: number): Promise<CompareResult | Refusal> {
    const tooSmall = this.checkAmount(sendMinor);
    if (tooSmall) return tooSmall;

    const mid = await this.rates.getMid("AED", "INR");
    const { rate } = await this.rates.getCustomerRate("AED", "INR");
    const cash = this.tier.cashPickup;

    const payout_methods = PAYOUT_METHODS.map((method): PayoutOption => {
      const p = PAYOUT_POLICY[method];
      const receive = receiveMinor(sendMinor, p.feeMinor, rate);
      const option: PayoutOption = {
        method,
        rail: p.rail,
        fee_minor: p.feeMinor,
        receive_amount_minor: receive,
        eta: p.eta,
        available: true,
      };
      if (method !== "cash_pickup") return option;

      option.caps = {
        per_transaction_aed_minor: cash.perTransactionMinor,
        per_recipient_per_year: cash.perRecipientPerYear,
        max_cash_inr_minor: cash.maxReceiveMinor,
      };
      if (receive > cash.maxReceiveMinor) {
        const maxSend = maxSendForReceive(cash.maxReceiveMinor, p.feeMinor, rate);
        option.available = false;
        option.note = `Over the cash cap of ${sayInr(cash.maxReceiveMinor)}; up to ${sayAed(maxSend)} can be sent for cash pickup.`;
      } else if (sendMinor > cash.perTransactionMinor) {
        option.available = false;
        option.note = `Over the ${sayAed(cash.perTransactionMinor)} cash pickup limit per transfer.`;
      }
      return option;
    });

    const benchRate = applyMargin(mid.rate, BENCHMARK.marginBp);
    return {
      send_amount_minor: sendMinor,
      send_currency: "AED",
      mid_rate: mid.rate,
      customer_rate: rate,
      payout_methods,
      benchmark: {
        name: BENCHMARK.name,
        rate: benchRate,
        fee_minor: BENCHMARK.feeMinor,
        receive_amount_minor: receiveMinor(sendMinor, BENCHMARK.feeMinor, benchRate),
        illustrative: true,
      },
      note: "Benchmark is illustrative: derived from the mid rate with a typical published FX margin.",
    };
  }

  /** Purpose rules, payout availability and limits; on success writes an open quote. */
  async create(userId: string, input: QuoteInput): Promise<Quote | Refusal> {
    const recipient = getRecipient(this.db, userId, input.beneficiaryId);
    if (!recipient) {
      return refuse(
        "BENEFICIARY_NOT_FOUND",
        "That recipient is not saved. Find them with resolve_beneficiary, or add them in the Nuvio app.",
        { beneficiary_id: input.beneficiaryId },
      );
    }

    const method = input.payoutMethod ?? recipient.payoutMethod;
    const available = availableMethods(recipient);
    if (!available.includes(method)) {
      return refuse(
        "PAYOUT_METHOD_UNAVAILABLE",
        `${recipient.nickname} has no ${method === "upi" ? "UPI ID" : "bank account"} saved. Choose ${available.map((m) => m.replace("_", " ")).join(" or ")}, or add the details in the Nuvio app.`,
        { payout_method: method, available_methods: available },
      );
    }

    const purpose = input.purpose ?? recipient.defaultPurpose;
    const purposeCheck = checkPurpose(purpose, recipient);
    if (isRefusal(purposeCheck)) return purposeCheck;

    const { feeMinor, eta } = PAYOUT_POLICY[method];
    const tooSmall = this.checkAmount(input.sendMinor, feeMinor);
    if (tooSmall) return tooSmall;

    const { rate } = await this.rates.getCustomerRate("AED", "INR");
    const receive = receiveMinor(input.sendMinor, feeMinor, rate);

    const limitCheck = this.limits.check(userId, {
      recipient,
      sendMinor: input.sendMinor,
      method,
      receiveMinor: receive,
      rate,
    });
    if (isRefusal(limitCheck)) return limitCheck;

    const now = this.now();
    const id = this.newId();
    const lockedUntil = addMinutes(now, QUOTE_LOCK_MINUTES).toISOString();
    this.db
      .prepare(
        `INSERT INTO quotes (id, user_id, beneficiary_id, send_amount_minor, send_currency,
          payout_method, purpose, locked_rate, fee_minor, receive_amount_minor, created_at,
          rate_locked_until, status)
         VALUES (?, ?, ?, ?, 'AED', ?, ?, ?, ?, ?, ?, ?, 'open')`,
      )
      .run(
        id,
        userId,
        recipient.id,
        input.sendMinor,
        method,
        purpose,
        rate,
        feeMinor,
        receive,
        now.toISOString(),
        lockedUntil,
      );

    return {
      quote_id: id,
      beneficiary_id: recipient.id,
      payout_method: method,
      purpose,
      send_amount_minor: input.sendMinor,
      send_currency: "AED",
      fee_minor: feeMinor,
      locked_rate: rate,
      receive_amount_minor: receive,
      receive_currency: "INR",
      guaranteed: true,
      rate_locked_until: lockedUntil,
      eta,
      funding: `debit card ending ${getUser(this.db, userId).cardLast4}`,
      warnings: [...limitCheck.warnings, ...purposeCheck.warnings],
    };
  }

  /**
   * SPEC token rule 2: an open (or already prepared) unexpired quote becomes prepared and gets a
   * single-use ct_ token, valid 5 minutes and never past the rate lock. Preparing again replaces
   * the previous token. Returns the exact sentence the assistant must read back.
   */
  prepare(userId: string, quoteId: string, callerId: string): Prepared | Refusal {
    const quote = this.get(userId, quoteId);
    if (!quote) {
      return refuse("QUOTE_UNKNOWN", "That quote was not found. Ask for a new quote.", {
        quote_id: quoteId,
      });
    }
    if (quote.status === "expired") {
      return refuse(
        "QUOTE_EXPIRED",
        `Rates are held for ${QUOTE_LOCK_MINUTES} minutes and this quote has expired. Ask for a new quote at today's rate.`,
        { quote_id: quoteId, rate_locked_until: quote.rateLockedUntil },
      );
    }
    if (quote.status === "consumed") {
      return refuse(
        "QUOTE_ALREADY_USED",
        "That quote has already been used for a transfer. Ask for a new quote to send again.",
        { quote_id: quoteId },
      );
    }
    const recipient = getRecipient(this.db, userId, quote.beneficiaryId);
    if (!recipient) throw new Error(`Quote ${quoteId} has no recipient`);

    const issued = this.db.transaction(() => {
      this.db.prepare("UPDATE quotes SET status = 'prepared' WHERE id = ?").run(quoteId);
      return this.gate.issue({ kind: "transfer", quoteId }, callerId, {
        notAfter: new Date(quote.rateLockedUntil),
      });
    })();

    return {
      quote_id: quoteId,
      confirmation_token: issued.token,
      expires_at: issued.expiresAt,
      read_back: readBack(quote, recipient, getUser(this.db, userId).cardLast4),
    };
  }

  /** The newest quote still open or prepared and within its lock (the simulator ledger strip). */
  latestOpen(userId: string): QuoteRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id FROM quotes WHERE user_id = ? AND status IN ('open', 'prepared')
         AND rate_locked_until > ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(userId, this.now().toISOString()) as { id: string } | undefined;
    return row ? this.get(userId, row.id) : undefined;
  }

  get(userId: string, quoteId: string): QuoteRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM quotes WHERE id = ? AND user_id = ?")
      .get(quoteId, userId) as QuoteRow | undefined;
    if (!row) return undefined;
    const lapsed =
      (row.status === "open" || row.status === "prepared") &&
      Date.parse(row.rate_locked_until) <= this.now().getTime();
    return {
      id: row.id,
      userId: row.user_id,
      beneficiaryId: row.beneficiary_id,
      sendMinor: row.send_amount_minor,
      payoutMethod: row.payout_method,
      purpose: row.purpose,
      lockedRate: row.locked_rate,
      feeMinor: row.fee_minor,
      receiveMinor: row.receive_amount_minor,
      createdAt: row.created_at,
      rateLockedUntil: row.rate_locked_until,
      status: lapsed ? "expired" : row.status,
    };
  }

  private checkAmount(sendMinor: number, feeMinor = 0): Refusal | undefined {
    const minFee = feeMinor || Math.min(...PAYOUT_METHODS.map((m) => PAYOUT_POLICY[m].feeMinor));
    if (Number.isInteger(sendMinor) && sendMinor > minFee) return undefined;
    return refuse("AMOUNT_TOO_SMALL", `The amount must be more than the ${sayAed(minFee)} fee.`, {
      minimum_exclusive_minor: minFee,
      requested_minor: sendMinor,
      currency: "AED",
    });
  }
}

export interface Prepared {
  quote_id: string;
  confirmation_token: string;
  expires_at: string;
  read_back: string;
}

/**
 * The consent sentence. Names the recipient and destination, purpose, fee (taken out of the send
 * amount), rate, the card charged and the guaranteed receive amount, then asks.
 */
export function readBack(q: QuoteRecord, r: Recipient, cardLast4: string): string {
  const who = r.relationship === "self" ? recipientPhrase(r) : `${r.nickname}, ${r.fullName}`;
  const where = destinationPhrase(r, q.payoutMethod);
  const link = q.payoutMethod === "cash_pickup" ? " for " : " at ";
  const subject = r.relationship === "self" ? capitalise(recipientPhrase(r)) : r.nickname;
  const eta = PAYOUT_POLICY[q.payoutMethod].eta.split(",")[0];
  return [
    `Send ${sayAed(q.sendMinor)} to ${who}${link}${where}, for ${PURPOSE_WORDS[q.purpose]}.`,
    `The ${aedNumber(q.feeMinor)} dirham fee is included and the rate is ${sayRate(q.lockedRate)}; your card ending ${cardLast4} is charged ${sayAed(q.sendMinor)}.`,
    `${subject} receives ${sayInr(q.receiveMinor)}, guaranteed, ${eta}.`,
    "Shall I go ahead?",
  ].join(" ");
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

interface QuoteRow {
  id: string;
  user_id: string;
  beneficiary_id: string;
  send_amount_minor: number;
  payout_method: PayoutMethod;
  purpose: Purpose;
  locked_rate: number;
  fee_minor: number;
  receive_amount_minor: number;
  created_at: string;
  rate_locked_until: string;
  status: QuoteStatus;
}

/** Bank deposit needs a saved account, UPI a saved UPI ID; cash pickup only the name on file. */
export function availableMethods(r: Recipient): PayoutMethod[] {
  return PAYOUT_METHODS.filter((m) => {
    if (m === "bank_deposit") return Boolean(r.bankName && r.accountLast4);
    if (m === "upi") return Boolean(r.upiId);
    return true;
  });
}

/** SPEC purpose rules: business refused; property needs documents; gift to a non-relative warns. */
export function checkPurpose(purpose: Purpose, r: Recipient): { warnings: Warning[] } | Refusal {
  if (purpose === "business") {
    return refuse(
      "PURPOSE_NOT_SUPPORTED",
      "Business payments are not supported in the personal Nuvio app. Use Nuvio Business for supplier or company payments.",
      { purpose },
    );
  }
  if (purpose === "property_purchase") {
    return refuse(
      "PURPOSE_REQUIRES_DOCUMENTS",
      "Property payments need a sale agreement uploaded in the Nuvio app before sending.",
      { purpose },
    );
  }
  if (purpose === "gift" && !RELATIVES.has(r.relationship)) {
    return { warnings: [{ code: "GIFT_TAXABLE_IN_INDIA", note: GIFT_TAX_NOTE }] };
  }
  return { warnings: [] };
}
