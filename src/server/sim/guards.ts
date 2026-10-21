import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { dubaiDate } from "../../core/time.js";

/**
 * Guards for /sim/* and /dev/* on a public URL: an access code, per-IP rate limits and a daily
 * ceiling on Bedrock calls. All in memory: the service runs exactly one instance.
 */

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Requires header `name` to equal `code`. Unset code means the surface is disabled. */
export function requireCode(
  code: string | undefined,
  header: string,
  disabled: { status: number; message: string },
): RequestHandler {
  const expected = code ? digest(code) : undefined;
  return (req, res, next) => {
    if (!expected) {
      res.status(disabled.status).json({ error: "disabled", message: disabled.message });
      return;
    }
    const given = req.get(header);
    if (given && timingSafeEqual(digest(given), expected)) {
      next();
      return;
    }
    res.status(401).json({ error: "unauthorized", message: `Missing or wrong ${header}.` });
  };
}

/** True when header `name` carries `code` (false when the code is unset). */
export function hasCode(code: string | undefined, header: string): (req: Request) => boolean {
  const expected = code ? digest(code) : undefined;
  return (req) => {
    const given = req.get(header);
    return Boolean(expected && given && timingSafeEqual(digest(given), expected));
  };
}

/** Fixed-window limiter per client IP. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || t - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: t });
      if (this.hits.size > 10_000) this.sweep(t);
      return true;
    }
    entry.count++;
    return entry.count <= this.limit;
  }

  /** `skip` exempts a request, e.g. one carrying the dev-controls code. */
  middleware(skip?: (req: Request) => boolean): RequestHandler {
    return (req, res, next) => {
      if (skip?.(req) || this.allow(req.ip ?? "unknown")) {
        next();
        return;
      }
      res
        .status(429)
        .set("Retry-After", String(Math.ceil(this.windowMs / 1000)))
        .json({ error: "rate_limited", message: "Too many requests. Wait a few minutes." });
    };
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (t - v.windowStart >= this.windowMs) this.hits.delete(k);
  }
}

/** Counts Bedrock calls per UTC day and refuses once `limit` is reached. */
export class DailyBudget {
  private day = "";
  private used = 0;

  constructor(
    private readonly limit: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  take(): boolean {
    const today = this.now().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
    if (this.used >= this.limit) return false;
    this.used++;
    return true;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }
}

/**
 * Keeps a hosted demo fresh for each visitor: opening the page after `idleMs` with no activity, or
 * on a new day in Dubai, reloads the demo data. The seed's dates are relative to the day it loads,
 * and every visitor shares one ledger, so nobody inherits stale dates or an earlier visitor's
 * sends. `idleMs` 0 turns it off.
 */
export class DemoFreshness {
  private lastActive = Number.NEGATIVE_INFINITY;
  private day = "";

  constructor(
    private readonly idleMs: number,
    private readonly reseed: () => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get minutes(): number {
    return this.idleMs / 60_000;
  }

  /** A visitor did something: a chat turn, a view's call, a dev control. */
  touch(): void {
    this.lastActive = this.now().getTime();
  }

  /** On page load. True when it reloaded the demo data. */
  refresh(): boolean {
    if (this.idleMs <= 0) return false;
    const now = this.now();
    const today = dubaiDate(now);
    if (today === this.day && now.getTime() - this.lastActive < this.idleMs) return false;
    this.reseed();
    this.day = today;
    this.lastActive = now.getTime();
    return true;
  }
}
