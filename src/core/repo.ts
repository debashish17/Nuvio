import type { Db } from "../db/connection.js";
import type { PayoutMethod, Purpose, Recipient, User } from "./types.js";

/** Row mappers shared by the services. Read-only. */

interface BeneficiaryRow {
  id: string;
  user_id: string;
  nickname: string;
  full_name: string;
  relationship: string;
  payout_method: PayoutMethod;
  bank_name: string | null;
  ifsc: string | null;
  account_last4: string | null;
  account_type: string | null;
  upi_id: string | null;
  city: string | null;
  state: string | null;
  default_purpose: Purpose;
  name_verified: number;
  added_at: string;
  aliases: string | null;
}

function toRecipient(r: BeneficiaryRow): Recipient {
  return {
    id: r.id,
    userId: r.user_id,
    nickname: r.nickname,
    fullName: r.full_name,
    relationship: r.relationship,
    payoutMethod: r.payout_method,
    bankName: r.bank_name,
    ifsc: r.ifsc,
    accountLast4: r.account_last4,
    accountType: r.account_type,
    upiId: r.upi_id,
    city: r.city,
    state: r.state,
    defaultPurpose: r.default_purpose,
    nameVerified: r.name_verified === 1,
    addedAt: r.added_at,
    aliases: r.aliases ? (JSON.parse(r.aliases) as string[]) : [],
  };
}

export function listRecipients(db: Db, userId: string): Recipient[] {
  const rows = db
    .prepare("SELECT * FROM beneficiaries WHERE user_id = ? ORDER BY id")
    .all(userId) as BeneficiaryRow[];
  return rows.map(toRecipient);
}

export function getRecipient(db: Db, userId: string, id: string): Recipient | undefined {
  const row = db
    .prepare("SELECT * FROM beneficiaries WHERE user_id = ? AND id = ?")
    .get(userId, id) as BeneficiaryRow | undefined;
  return row ? toRecipient(row) : undefined;
}

export function getUser(db: Db, userId: string): User {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as
    { id: string; name: string; country: string; kyc_tier: string; card_last4: string } | undefined;
  if (!row) throw new Error(`Unknown user ${userId}`);
  return {
    id: row.id,
    name: row.name,
    country: row.country,
    kycTier: row.kyc_tier,
    cardLast4: row.card_last4,
  };
}

/**
 * A nickname as the assistant says it to the user: "Mum" stays "Mum", and "My NRE account"
 * becomes "your NRE account". At the start of a sentence, wrap it in `capitalise`.
 */
export function spokenNickname(nickname: string): string {
  return nickname.replace(/^my\s+/i, "your ");
}

export const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** How the recipient is addressed in read-backs: "Mum", or "your NRE account" for self. */
export function recipientPhrase(r: Recipient): string {
  if (r.relationship === "self") return spokenNickname(r.nickname);
  return r.nickname;
}

/** "HDFC Bank ending 4421", "UPI ID rahul.nair@okhdfc", or "cash pickup in Pune". */
export function destinationPhrase(r: Recipient, method: PayoutMethod): string {
  if (method === "upi") return `UPI ID ${r.upiId ?? "on file"}`;
  if (method === "cash_pickup") return `cash pickup${r.city ? ` in ${r.city}` : ""}`;
  return `${r.bankName ?? "their bank"} ending ${r.accountLast4 ?? "on file"}`;
}
