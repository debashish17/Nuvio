import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/connection.js";
import { tokenPrefix, type ConfirmationGate } from "./confirm.js";
import type { LedgerService } from "./ledger.js";
import { sayAed } from "./money.js";
import { OTP } from "./policy.js";
import { isRefusal, refuse } from "./refusal.js";
import { addMinutes } from "./time.js";
import { consoleLogger, type Clock, type Logger, type Refusal } from "./types.js";
import { readCode } from "./spoken.js";

/**
 * Step-up check before money moves (SPEC "Quote and token lifecycle"), like 3-D Secure on a card
 * payment. confirm_transfer without a code sends a 6-digit one-time code by SMS to the customer's
 * registered phone and refuses STEP_UP_REQUIRED; with the code it hands over to
 * LedgerService.confirm, which spends the token and charges the card.
 *
 * The code never appears in a tool result, so the model cannot approve a payment by itself: only
 * someone holding the phone can. The text names the amount and the recipient, so the code is
 * bound to that one payment. Codes are stored as salted hashes, are never logged, last 5 minutes
 * (never past the token), and 3 wrong tries void the confirmation.
 */

/** Delivers a text message to the customer's registered phone. */
export interface SmsGateway {
  send(userId: string, toLast4: string, body: string): void;
}

/** The simulated phone: messages go to sms_outbox, which the simulator page shows. */
export class OutboxSms implements SmsGateway {
  constructor(
    private readonly db: Db,
    private readonly now: Clock = () => new Date(),
  ) {}

  send(userId: string, toLast4: string, body: string): void {
    this.db
      .prepare("INSERT INTO sms_outbox (user_id, to_last4, body, created_at) VALUES (?, ?, ?, ?)")
      .run(userId, toLast4, body, this.now().toISOString());
  }

  /** Messages after `since`, oldest first. */
  since(userId: string, since: string): { to: string; body: string; at: string }[] {
    return this.db
      .prepare(
        'SELECT to_last4 AS "to", body, created_at AS at FROM sms_outbox WHERE user_id = ? AND created_at > ? ORDER BY id',
      )
      .all(userId, since) as { to: string; body: string; at: string }[];
  }
}

export interface StepUpDeps {
  db: Db;
  gate: ConfirmationGate;
  ledger: LedgerService;
  sms: SmsGateway;
  now?: Clock;
  logger?: Logger;
  /** Test seam: the next code to send. */
  newCode?: () => string;
}

interface ChallengeRow {
  id: string;
  code_hash: string;
  expires_at: string;
  attempts: number;
  verified_at: string | null;
}

const codeHash = (id: string, code: string) =>
  createHash("sha256").update(`${id}:${code}`).digest("hex");

export class StepUpService {
  private readonly db: Db;
  private readonly now: Clock;
  private readonly logger: Logger;
  private readonly newCode: () => string;

  constructor(private readonly deps: StepUpDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? consoleLogger;
    this.newCode =
      deps.newCode ?? (() => String(randomInt(0, 10 ** OTP.digits)).padStart(OTP.digits, "0"));
  }

  /**
   * confirm_transfer. Without `otp`: send a code and refuse STEP_UP_REQUIRED. With `otp`: check
   * it against the latest code for this token, then confirm through the ledger.
   */
  confirm(userId: string, token: string, callerId: string, otp?: string) {
    const peek = this.deps.gate.peek(token, callerId, "transfer");
    if (isRefusal(peek)) return peek;
    const { target, tokenHash, expiresAt } = peek;
    if (target.kind !== "transfer") throw new Error("gate returned the wrong kind");
    if (otp === undefined)
      return this.challenge(userId, { target, tokenHash, expiresAt }, callerId);

    const code = readCode(otp, OTP.digits);
    const row = this.db
      .prepare(
        `SELECT id, code_hash, expires_at, attempts, verified_at FROM step_up_challenges
         WHERE token = ? AND session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(peek.tokenHash, callerId) as ChallengeRow | undefined;
    if (!row || row.verified_at) {
      return refuse(
        "OTP_INVALID",
        "No code has been sent for this transfer yet. Call confirm_transfer with the confirmation_token alone to text one to the user's phone.",
        { attempts_left: OTP.maxAttempts },
      );
    }
    if (Date.parse(row.expires_at) <= this.now().getTime()) {
      return refuse(
        "OTP_EXPIRED",
        "That code has expired and nothing was sent. If the user still wants to go ahead, call confirm_transfer with the confirmation_token alone to text a new code.",
      );
    }
    // Not six digits however it is read: it can't be the code, so it uses no try.
    if (code === undefined) {
      return refuse(
        "OTP_INVALID",
        "That wasn't six digits, and nothing was sent. Ask the user to read the 6-digit code from the latest Nuvio text again, one digit at a time.",
        { attempts_left: OTP.maxAttempts - row.attempts },
      );
    }
    const given = Buffer.from(codeHash(row.id, code), "hex");
    const expected = Buffer.from(row.code_hash, "hex");
    if (!timingSafeEqual(given, expected)) {
      const attempts = row.attempts + 1;
      this.db
        .prepare("UPDATE step_up_challenges SET attempts = ? WHERE id = ?")
        .run(attempts, row.id);
      this.logger.warn(
        `stepup: wrong code for ${tokenPrefix(token)} (${attempts}/${OTP.maxAttempts})`,
      );
      if (attempts >= OTP.maxAttempts) {
        this.deps.gate.void(token);
        return refuse(
          "OTP_LOCKED",
          "Too many wrong codes, so the confirmation was cancelled and nothing was sent. Prepare the transfer again if the user still wants to send it.",
        );
      }
      return refuse(
        "OTP_INVALID",
        "That code didn't match and nothing was sent. Ask the user to read the 6-digit code from the latest Nuvio text again.",
        { attempts_left: OTP.maxAttempts - attempts },
      );
    }

    const done = this.deps.ledger.confirm(userId, token, callerId);
    if (!isRefusal(done)) {
      this.db
        .prepare("UPDATE step_up_challenges SET verified_at = ? WHERE id = ?")
        .run(this.now().toISOString(), row.id);
    }
    return done;
  }

  private challenge(
    userId: string,
    peek: { target: { kind: "transfer"; quoteId: string }; tokenHash: string; expiresAt: string },
    callerId: string,
  ): Refusal {
    const sends = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM step_up_challenges WHERE token = ?")
        .get(peek.tokenHash) as { n: number }
    ).n;
    if (sends >= OTP.maxSends) {
      return refuse(
        "OTP_LOCKED",
        "The most codes for this confirmation have been sent. Prepare the transfer again to start over.",
      );
    }
    const info = this.db
      .prepare(
        `SELECT q.send_amount_minor AS amount, b.nickname AS nickname, u.phone_last4 AS phone
         FROM quotes q JOIN beneficiaries b ON b.id = q.beneficiary_id JOIN users u ON u.id = q.user_id
         WHERE q.id = ? AND q.user_id = ?`,
      )
      .get(peek.target.quoteId, userId) as
      { amount: number; nickname: string; phone: string | null } | undefined;
    if (!info?.phone) {
      return refuse("QUOTE_UNKNOWN", "That quote can no longer be confirmed. Ask for a new quote.");
    }

    const now = this.now();
    const ttlEnd = addMinutes(now, OTP.ttlMinutes);
    const tokenEnd = new Date(peek.expiresAt);
    const expires = tokenEnd < ttlEnd ? tokenEnd : ttlEnd;
    const id = `su_${randomUUID()}`;
    const code = this.newCode();
    this.db
      .prepare(
        `INSERT INTO step_up_challenges (id, token, session_id, code_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        peek.tokenHash,
        callerId,
        codeHash(id, code),
        now.toISOString(),
        expires.toISOString(),
      );
    this.deps.sms.send(
      userId,
      info.phone,
      `Nuvio: ${code} is your code to send ${sayAed(info.amount)} to ${info.nickname}. It expires in ${OTP.ttlMinutes} minutes. Nuvio staff will never ask you for it.`,
    );
    this.logger.info(`stepup: code sent to phone ending ${info.phone}`);
    return refuse(
      "STEP_UP_REQUIRED",
      `Nothing has been sent yet. A 6-digit code was texted to the phone ending ${info.phone}. Ask the user to read it out, then call confirm_transfer again with the same confirmation_token and otp set to those 6 digits. Never guess the code.`,
      {
        method: "sms_otp",
        sent_to: `phone ending ${info.phone}`,
        expires_at: expires.toISOString(),
        attempts_left: OTP.maxAttempts,
      },
    );
  }
}
