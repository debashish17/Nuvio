import { z } from "zod";
import type { Db } from "../db/connection.js";
import { applyMargin } from "./money.js";
import {
  AED_PER_USD,
  FX_MARGIN_BP,
  RATES_CACHE_MINUTES,
  SENDING_PAIR,
  USD_PEGS,
} from "./policy.js";
import { refuse } from "./refusal.js";
import { consoleLogger, type Clock, type Logger, type Refusal } from "./types.js";

/**
 * RatesService (SPEC "Core module interface"). The only outbound call in the system.
 *
 * ECB, and so Frankfurter, publishes no AED. One request fetches every currency ECB publishes
 * against USD for the last two weeks, stored as USD/XXX; AED/INR is USD/INR divided by the CBUAE
 * peg and GBP/INR is the cross. Any other pair of ECB or dollar-pegged currencies is a cross of
 * two USD rows, quoted for information only: Nuvio sends money from AED to INR alone. The latest
 * day goes to rates_cache, every day to rates_history (the offline fallback).
 *
 * Caching is stale-while-revalidate: under 15 minutes old the cache is served as is; up to 24 hours
 * old it is served immediately while a background refresh runs. Only a cold start waits for the
 * network, with a timeout, and any failure falls back to the newest rates_history row.
 */

export const SUPPORTED_PAIRS = ["AED/INR", "USD/INR", "GBP/INR"] as const;
export type Pair = (typeof SUPPORTED_PAIRS)[number];

export interface MidRate {
  rate: number;
  asOf: string;
  source: "live" | "fallback";
}

export interface RateSnapshot {
  corridor: string;
  pair: Pair;
  sendable: true;
  customer_rate: number;
  mid_rate: number;
  fx_margin_pct: number;
  /** This week's range of Nuvio's rate, the one the customer gets. */
  customer_week_high: number;
  customer_week_low: number;
  /** This week's range of the mid-market rate, for reference. */
  mid_week_high: number;
  mid_week_low: number;
  trend: string;
  as_of: string;
  source: string;
}

export interface RatesDeps {
  db: Db;
  baseUrl: string;
  fetch?: typeof fetch;
  now?: Clock;
  logger?: Logger;
  /** Cold-start fetch timeout. */
  timeoutMs?: number;
}

const STALE_LIMIT_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60_000;

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** AED/INR mid from USD/INR at the peg. */
export function deriveAedInr(usdInr: number): number {
  return round4(usdInr / AED_PER_USD);
}

/** A mid-market rate for a pair Nuvio does not send in. */
export interface InfoSnapshot {
  pair: string;
  sendable: false;
  mid_rate: number;
  mid_week_high: number;
  mid_week_low: number;
  trend: string;
  as_of: string;
  source: string;
  note: string;
}

const SeriesSchema = z.object({
  base: z.literal("USD"),
  rates: z.record(
    z.string(),
    z.record(z.string(), z.number().positive()).refine((d) => "INR" in d, "no INR"),
  ),
});
type Day = Record<string, number>;

const CODE = /^[A-Z]{3}$/;
/** Spoken names; the standard English name is used for the rest. */
const SHORT_NAMES: Record<string, string> = { AED: "UAE Dirham" };
const currencyName = (code: string) => {
  if (SHORT_NAMES[code]) return SHORT_NAMES[code];
  try {
    return new Intl.DisplayNames(["en"], { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
};

export function toPair(from: string, to: string): Pair {
  const pair = `${from}/${to}`;
  if (!(SUPPORTED_PAIRS as readonly string[]).includes(pair)) {
    throw new Error(`Unsupported pair ${pair}`);
  }
  return pair as Pair;
}

export class RatesService {
  private readonly db: Db;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: Clock;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private inflight: Promise<boolean> | null = null;
  private lastFailureAt = 0;

  constructor(deps: RatesDeps) {
    this.db = deps.db;
    this.baseUrl = deps.baseUrl.replace(/\/+$/, "");
    this.fetchFn = deps.fetch ?? fetch;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? consoleLogger;
    this.timeoutMs = deps.timeoutMs ?? 1500;
  }

  async getMid(from: string, to: string): Promise<MidRate> {
    const pair = toPair(from, to);
    const cached = this.readCache(pair);
    const age = cached ? this.now().getTime() - Date.parse(cached.fetched_at) : Infinity;

    if (cached && age < RATES_CACHE_MINUTES * 60_000) return this.live(cached);
    if (cached && age < STALE_LIMIT_MS) {
      void this.refresh();
      return this.live(cached);
    }
    if (await this.refresh()) {
      const fresh = this.readCache(pair);
      if (fresh) return this.live(fresh);
    }
    return this.fallback(pair);
  }

  async getCustomerRate(from: string, to: string): Promise<{ rate: number; fxMarginPct: number }> {
    const pair = toPair(from, to);
    const { rate } = await this.getMid(from, to);
    const marginBp = FX_MARGIN_BP[pair] ?? 0;
    return { rate: applyMargin(rate, marginBp), fxMarginPct: marginBp / 100 };
  }

  async getWeekRange(
    from: string,
    to: string,
  ): Promise<{ high: number; low: number; changePct: number }> {
    const pair = toPair(from, to);
    await this.getMid(from, to); // make sure history includes the latest fetch
    const rows = this.db
      .prepare("SELECT mid FROM rates_history WHERE pair = ? ORDER BY day DESC LIMIT 7")
      .all(pair) as { mid: number }[];
    if (rows.length === 0) throw new Error(`No rate history for ${pair}`);
    const mids = rows.map((r) => r.mid);
    const latest = mids[0] ?? 0;
    const oldest = mids[mids.length - 1] ?? latest;
    return {
      high: Math.max(...mids),
      low: Math.min(...mids),
      changePct: Math.round(((latest - oldest) / oldest) * 1000) / 10,
    };
  }

  /** Currencies get_rate can quote: USD, the dollar pegs, and every currency ECB published. */
  currencies(): string[] {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT substr(pair, 5) AS code FROM rates_history WHERE pair LIKE 'USD/%' " +
          "UNION SELECT substr(pair, 5) FROM rates_cache WHERE pair LIKE 'USD/%'",
      )
      .all() as { code: string }[];
    return [...new Set(["USD", ...Object.keys(USD_PEGS), ...rows.map((r) => r.code)])].sort();
  }

  /**
   * Everything get_rate returns, from one call. AED/INR is Nuvio's sending rate; any other pair is
   * the mid-market rate for information.
   */
  async snapshot(fromCode: string, toCode: string): Promise<RateSnapshot | InfoSnapshot | Refusal> {
    const from = fromCode.trim().toUpperCase();
    const to = toCode.trim().toUpperCase();
    if (`${from}/${to}` !== SENDING_PAIR) return this.infoSnapshot(from, to);
    const pair = toPair(from, to);
    const mid = await this.getMid(from, to);
    const customer = await this.getCustomerRate(from, to);
    const week = await this.getWeekRange(from, to);
    // Today's rate can be newer than the stored history, so the range always includes it. Each
    // range is labelled by rate: the customer's (what Nuvio pays out) and the mid-market one.
    const midHigh = Math.max(week.high, mid.rate);
    const midLow = Math.min(week.low, mid.rate);
    const marginBp = FX_MARGIN_BP[pair] ?? 0;
    return {
      corridor: "AE-IN",
      pair,
      sendable: true,
      customer_rate: customer.rate,
      mid_rate: mid.rate,
      fx_margin_pct: customer.fxMarginPct,
      customer_week_high: applyMargin(midHigh, marginBp),
      customer_week_low: applyMargin(midLow, marginBp),
      mid_week_high: midHigh,
      mid_week_low: midLow,
      trend: describeTrend(week.changePct),
      as_of: mid.asOf,
      source:
        mid.source === "live"
          ? "ECB via Frankfurter (USD/INR, AED at the 3.6725 peg), cached"
          : "ECB reference history, offline fallback",
    };
  }

  private async infoSnapshot(from: string, to: string): Promise<InfoSnapshot | Refusal> {
    // Brings the USD rows up to date the same way the corridor rate does.
    const anchor = await this.getMid("USD", "INR");
    const supported = this.currencies();
    for (const code of [from, to]) {
      if (!CODE.test(code) || !supported.includes(code)) {
        return refuse(
          "CURRENCY_NOT_SUPPORTED",
          `${code} has no published reference rate here. Try another currency, such as ${supported.slice(0, 6).join(", ")}.`,
          { currency: code, supported },
        );
      }
    }
    if (from === to) {
      return refuse("CURRENCY_NOT_SUPPORTED", "Choose two different currencies.", {
        currency: from,
        supported,
      });
    }
    const latest = this.cross(from, to, (code) => this.readCache(`USD/${code}`)?.mid);
    const days = this.history(from, to);
    const mid = latest ?? days[0];
    if (mid === undefined) {
      return refuse(
        "RATE_UNAVAILABLE",
        "That rate isn't available right now. Ask again in a few minutes.",
        { pair: `${from}/${to}` },
      );
    }
    const week = days.length ? days : [mid];
    const oldest = week[week.length - 1] ?? mid;
    const changePct = Math.round(((mid - oldest) / oldest) * 1000) / 10;
    const pegged = [from, to].filter((c) => USD_PEGS[c]);
    return {
      pair: `${from}/${to}`,
      sendable: false,
      mid_rate: mid,
      mid_week_high: Math.max(mid, ...week),
      mid_week_low: Math.min(mid, ...week),
      trend: describeCrossTrend(from, to, changePct),
      as_of: latest !== undefined ? anchor.asOf : `${this.latestDay(from, to)}T00:00:00.000Z`,
      source:
        (latest !== undefined ? "ECB via Frankfurter, cached" : "ECB reference history, offline") +
        (pegged.length ? `; ${pegged.join(", ")} at the US dollar peg` : ""),
      note: "Mid-market rate for information only. Nuvio sends money from AED to INR only.",
    };
  }

  /** Units of `to` per unit of `from`, from units per USD; undefined if either is missing. */
  private cross(from: string, to: string, perUsdOf: (code: string) => number | undefined) {
    const perUsd = (code: string) => (code === "USD" ? 1 : (USD_PEGS[code] ?? perUsdOf(code)));
    const f = perUsd(from);
    const t = perUsd(to);
    return f && t ? round4(t / f) : undefined;
  }

  /** The cross for each of the last 7 published days, newest first. */
  private history(from: string, to: string): number[] {
    const rows = this.db
      .prepare(
        "SELECT day, substr(pair, 5) AS code, mid FROM rates_history " +
          "WHERE pair IN (?, ?, 'USD/INR') ORDER BY day DESC",
      )
      .all(`USD/${from}`, `USD/${to}`) as { day: string; code: string; mid: number }[];
    const byDay = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const m = byDay.get(r.day) ?? new Map<string, number>();
      m.set(r.code, r.mid);
      byDay.set(r.day, m);
    }
    return [...byDay.values()]
      .map((m) => this.cross(from, to, (code) => m.get(code)))
      .filter((v): v is number => v !== undefined)
      .slice(0, 7);
  }

  private latestDay(from: string, to: string): string {
    const row = this.db
      .prepare("SELECT MAX(day) AS day FROM rates_history WHERE pair IN (?, ?, 'USD/INR')")
      .get(`USD/${from}`, `USD/${to}`) as { day: string | null };
    return row.day ?? this.now().toISOString().slice(0, 10);
  }

  /**
   * Fetches the last two weeks and updates cache and history. Concurrent callers share one
   * request; after a failure, retries wait a minute so an outage cannot slow every call.
   * Background callers pass a generous timeout; a tool call on a cold cache uses the short default.
   */
  refresh(timeoutMs: number = this.timeoutMs): Promise<boolean> {
    if (this.inflight) return this.inflight;
    if (this.now().getTime() - this.lastFailureAt < RETRY_AFTER_FAILURE_MS) {
      return Promise.resolve(false);
    }
    this.inflight = this.fetchSeries(timeoutMs)
      .then((ok) => {
        if (!ok) this.lastFailureAt = this.now().getTime();
        return ok;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async fetchSeries(timeoutMs: number): Promise<boolean> {
    const start = new Date(this.now().getTime() - 14 * 86_400_000).toISOString().slice(0, 10);
    const url = `${this.baseUrl}/${start}..?from=USD`;
    try {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const series = SeriesSchema.parse(await res.json());
      const days = Object.keys(series.rates).sort();
      const latestDay = days[days.length - 1];
      if (!latestDay) throw new Error("empty series");

      const fetchedAt = this.now().toISOString();
      const upsertHistory = this.db.prepare(
        "INSERT OR REPLACE INTO rates_history (pair, day, mid) VALUES (?, ?, ?)",
      );
      const upsertCache = this.db.prepare(
        "INSERT OR REPLACE INTO rates_cache (pair, mid, fetched_at, source) VALUES (?, ?, ?, 'live')",
      );
      this.db.transaction(() => {
        for (const day of days) {
          for (const [pair, mid] of pairsFor(series.rates[day])) upsertHistory.run(pair, day, mid);
        }
        for (const [pair, mid] of pairsFor(series.rates[latestDay])) {
          upsertCache.run(pair, mid, fetchedAt);
        }
        // Drop codes the latest day no longer has (a currency ECB stopped publishing).
        const latestCodes = Object.keys(series.rates[latestDay] ?? {}).map((c) => `USD/${c}`);
        this.db
          .prepare(
            `DELETE FROM rates_cache WHERE pair LIKE 'USD/%' AND pair NOT IN (${latestCodes.map(() => "?").join(",")})`,
          )
          .run(...latestCodes);
      })();
      return true;
    } catch (err) {
      this.logger.warn(
        `rates: fetch failed, using cache or fallback (${err instanceof Error ? err.message : String(err)})`,
      );
      return false;
    }
  }

  private readCache(pair: string): { mid: number; fetched_at: string } | undefined {
    return this.db.prepare("SELECT mid, fetched_at FROM rates_cache WHERE pair = ?").get(pair) as
      { mid: number; fetched_at: string } | undefined;
  }

  private live(row: { mid: number; fetched_at: string }): MidRate {
    return { rate: row.mid, asOf: row.fetched_at, source: "live" };
  }

  private fallback(pair: Pair): MidRate {
    const row = this.db
      .prepare("SELECT mid, day FROM rates_history WHERE pair = ? ORDER BY day DESC LIMIT 1")
      .get(pair) as { mid: number; day: string } | undefined;
    if (!row) throw new Error(`No live or fallback rate for ${pair}`);
    return { rate: row.mid, asOf: `${row.day}T00:00:00.000Z`, source: "fallback" };
  }
}

/** The corridor pairs, plus USD/XXX for every currency that day. */
function pairsFor(day: Day | undefined): [string, number][] {
  if (!day?.INR) return [];
  const out: [string, number][] = [["AED/INR", deriveAedInr(day.INR)]];
  if (day.GBP) out.push(["GBP/INR", round4(day.INR / day.GBP)]);
  for (const [code, perUsd] of Object.entries(day)) {
    if (CODE.test(code) && code !== "USD") out.push([`USD/${code}`, round4(perUsd)]);
  }
  return out;
}

/** How X/Y moved, said of the currency Y: X/Y going up means each X buys more Y, so Y weakened. */
export function describeCrossTrend(from: string, to: string, changePct: number): string {
  const subject = currencyName(to);
  const against = `against the ${currencyName(from)}`;
  if (Math.abs(changePct) < 0.1) return `${subject} steady ${against} this week`;
  const pct = Math.abs(changePct).toFixed(1);
  return `${subject} ${changePct > 0 ? "weakened" : "strengthened"} ${pct}% ${against} this week`;
}

/** AED/INR going up means each dirham buys more rupees: the rupee weakened. */
export function describeTrend(changePct: number): string {
  if (Math.abs(changePct) < 0.1) return "rupee steady this week";
  const pct = Math.abs(changePct).toFixed(1);
  return changePct > 0
    ? `rupee weakened ${pct}% this week`
    : `rupee strengthened ${pct}% this week`;
}
