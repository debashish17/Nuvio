import type { Db } from "../db/connection.js";
import { sayRate } from "./money.js";
import type { RatesService } from "./rates.js";
import { refuse } from "./refusal.js";
import type { Clock } from "./types.js";

/**
 * AlertService (SPEC). set_rate_alert is the only writer besides confirm and cancel. Alerts track
 * Nuvio's customer rate, the rate the sender actually gets. evaluate() runs from the background
 * job and fires each alert once.
 */

export type AlertDirection = "above" | "below";

export interface Alert {
  alert_id: string;
  pair: string;
  target: number;
  direction: AlertDirection;
  channel: string;
  created_at: string;
  fired_at: string | null;
}

export interface FiredAlert extends Alert {
  rate: number;
  notification: string;
  /** True when a dev control fired it while recording, not a real rate move. */
  simulated?: boolean;
}

const CHANNEL = "push and email";
/** Sanity bounds: AED/INR has been in the 15–35 range for decades. */
const MIN_TARGET = 1;
const MAX_TARGET = 100;

interface AlertRow {
  id: string;
  pair: string;
  target: number;
  direction: AlertDirection;
  created_at: string;
  fired_at: string | null;
}

export class AlertService {
  constructor(
    private readonly db: Db,
    private readonly rates: RatesService,
    private readonly now: Clock = () => new Date(),
  ) {}

  async set(userId: string, pair: string, target: number, direction: AlertDirection) {
    if (!Number.isFinite(target) || target < MIN_TARGET || target > MAX_TARGET) {
      return refuse(
        "ALERT_TARGET_INVALID",
        "The alert target must be a rate in rupees per dirham, such as 26.5.",
        { target },
      );
    }
    const rounded = Math.round(target * 10_000) / 10_000;
    const [from = "", to = ""] = pair.split("/");
    const { rate } = await this.rates.getCustomerRate(from, to);

    const existing = this.db
      .prepare(
        `SELECT * FROM alerts WHERE user_id = ? AND pair = ? AND target = ? AND direction = ?
         AND fired_at IS NULL`,
      )
      .get(userId, pair, rounded, direction) as AlertRow | undefined;
    const row = existing ?? this.insert(userId, pair, rounded, direction);

    const met = direction === "above" ? rate >= rounded : rate <= rounded;
    const word = direction === "above" ? "more" : "less";
    return {
      ...toAlert(row),
      current_rate: rate,
      already_met: met,
      message:
        `I'll let you know when a dirham buys ${word} than ${sayRate(rounded)} rupees. ` +
        (met
          ? `It already does today, at ${sayRate(rate)}, so you'll hear about it shortly.`
          : `Today it buys ${sayRate(rate)}.`),
    };
  }

  list(userId: string): Alert[] {
    return (
      this.db
        .prepare("SELECT * FROM alerts WHERE user_id = ? ORDER BY created_at, id")
        .all(userId) as AlertRow[]
    ).map(toAlert);
  }

  /** Fires every unfired alert whose target the current customer rate has reached. */
  async evaluate(): Promise<FiredAlert[]> {
    const pending = this.db
      .prepare("SELECT * FROM alerts WHERE fired_at IS NULL ORDER BY created_at, id")
      .all() as AlertRow[];
    if (pending.length === 0) return [];

    const rateByPair = new Map<string, number>();
    const fired: FiredAlert[] = [];
    const at = this.now().toISOString();
    for (const a of pending) {
      if (!rateByPair.has(a.pair)) {
        const [from = "", to = ""] = a.pair.split("/");
        rateByPair.set(a.pair, (await this.rates.getCustomerRate(from, to)).rate);
      }
      const rate = rateByPair.get(a.pair) ?? 0;
      const hit = a.direction === "above" ? rate >= a.target : rate <= a.target;
      if (!hit) continue;
      // Conditional update so a concurrent evaluate cannot fire the same alert twice.
      const { changes } = this.db
        .prepare("UPDATE alerts SET fired_at = ? WHERE id = ? AND fired_at IS NULL")
        .run(at, a.id);
      if (changes !== 1) continue;
      fired.push({
        ...toAlert({ ...a, fired_at: at }),
        rate,
        notification: `A dirham now buys ${sayRate(rate)} rupees, ${a.direction} your ${sayRate(a.target)} target.`,
      });
    }
    return fired;
  }

  /** Dev control: fire the oldest pending alert now, as if its target had been reached. */
  fireNext(userId: string): FiredAlert | undefined {
    const a = this.db
      .prepare(
        "SELECT * FROM alerts WHERE user_id = ? AND fired_at IS NULL ORDER BY created_at, id LIMIT 1",
      )
      .get(userId) as AlertRow | undefined;
    if (!a) return undefined;
    const at = this.now().toISOString();
    this.db
      .prepare("UPDATE alerts SET fired_at = ? WHERE id = ? AND fired_at IS NULL")
      .run(at, a.id);
    return {
      ...toAlert({ ...a, fired_at: at }),
      rate: a.target,
      notification: `A dirham now buys ${sayRate(a.target)} rupees, your target.`,
      simulated: true,
    };
  }

  /** Alerts fired after `since` (ISO), oldest first: the simulator's toast feed. */
  firedSince(userId: string, since: string): Alert[] {
    return (
      this.db
        .prepare("SELECT * FROM alerts WHERE user_id = ? AND fired_at > ? ORDER BY fired_at, id")
        .all(userId, since) as AlertRow[]
    ).map(toAlert);
  }

  private insert(userId: string, pair: string, target: number, direction: AlertDirection) {
    const n = (
      this.db
        .prepare("SELECT MAX(CAST(substr(id, 4) AS INTEGER)) AS n FROM alerts WHERE id LIKE 'al_%'")
        .get() as { n: number | null }
    ).n;
    const row: AlertRow = {
      id: `al_${String((n ?? 0) + 1).padStart(2, "0")}`,
      pair,
      target,
      direction,
      created_at: this.now().toISOString(),
      fired_at: null,
    };
    this.db
      .prepare(
        "INSERT INTO alerts (id, user_id, pair, target, direction, created_at, fired_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(row.id, userId, pair, target, direction, row.created_at);
    return row;
  }
}

function toAlert(r: AlertRow): Alert {
  return {
    alert_id: r.id,
    pair: r.pair,
    target: r.target,
    direction: r.direction,
    channel: CHANNEL,
    created_at: r.created_at,
    fired_at: r.fired_at,
  };
}
