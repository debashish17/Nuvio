import type { Db } from "../db/connection.js";
import { getRecipient, listRecipients } from "./repo.js";
import { dubaiDate } from "./time.js";
import type { Recipient } from "./types.js";

/**
 * BeneficiaryService (SPEC). Read-only by design: adding or editing recipients by voice is a fraud
 * surface, so new recipients are added and name-verified in the Nuvio app.
 */

export interface LastSent {
  date: string;
  send_amount_minor: number;
  currency: string;
}

export type RecipientWithLastSent = Recipient & { lastSent: LastSent | null };

export type ResolveResult =
  | { match: Recipient }
  | { ambiguous: true; candidates: Recipient[] }
  | { notFound: true; hint: string };

export const NOT_FOUND_HINT = "Recipients are added and name-verified in the Nuvio app.";

/** Words a sender might use for a relationship, beyond each recipient's own aliases. */
const RELATIONSHIP_WORDS: Record<string, string[]> = {
  mother: ["mum", "mom", "mother", "amma", "maa", "mummy", "mommy"],
  father: ["dad", "father", "papa", "appa", "daddy"],
  brother: ["brother", "bro", "bhai"],
  sister: ["sister", "sis", "didi"],
  self: ["me", "myself", "my account", "my own account"],
};

const FILLER = /^(?:my|to|for|send to|send it to)\s+/;

export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class BeneficiaryService {
  constructor(private readonly db: Db) {}

  list(userId: string): RecipientWithLastSent[] {
    const last = this.db.prepare(
      `SELECT created_at, send_amount_minor, send_currency FROM transfers
       WHERE user_id = ? AND beneficiary_id = ? AND status = 'PAID_OUT'
       ORDER BY created_at DESC LIMIT 1`,
    );
    return listRecipients(this.db, userId).map((r) => {
      const row = last.get(userId, r.id) as
        { created_at: string; send_amount_minor: number; send_currency: string } | undefined;
      return {
        ...r,
        lastSent: row
          ? {
              date: dubaiDate(new Date(row.created_at)),
              send_amount_minor: row.send_amount_minor,
              currency: row.send_currency,
            }
          : null,
      };
    });
  }

  get(userId: string, id: string): Recipient | undefined {
    return getRecipient(this.db, userId, id);
  }

  /**
   * Scores each saved recipient: 3 for an exact nickname, alias, full name or first name; 2 for a
   * relationship word; 1 when every word of the query appears in their names or aliases. The top
   * score wins; a tie at the top is ambiguous.
   */
  resolve(userId: string, query: string): ResolveResult {
    const q = normalise(query);
    const variants = [...new Set([q, q.replace(FILLER, "")])].filter(Boolean);
    if (variants.length === 0) return { notFound: true, hint: NOT_FOUND_HINT };

    const scored = listRecipients(this.db, userId)
      .map((r) => ({ r, score: Math.max(...variants.map((v) => score(r, v))) }))
      .filter((s) => s.score > 0);
    const top = Math.max(0, ...scored.map((s) => s.score));
    const best = scored.filter((s) => s.score === top).map((s) => s.r);

    if (best.length === 0) return { notFound: true, hint: NOT_FOUND_HINT };
    if (best.length === 1 && best[0]) return { match: best[0] };
    return { ambiguous: true, candidates: best };
  }
}

function score(r: Recipient, v: string): number {
  const names = [r.nickname, r.fullName, r.fullName.split(" ")[0] ?? "", ...r.aliases].map(
    normalise,
  );
  if (names.includes(v)) return 3;
  if ((RELATIONSHIP_WORDS[r.relationship] ?? [r.relationship]).includes(v)) return 2;
  const tokens = new Set(names.flatMap((n) => n.split(" ")));
  return v.split(" ").every((t) => tokens.has(t)) ? 1 : 0;
}
