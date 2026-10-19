import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfirmationGate, tokenPrefix } from "../src/core/confirm.js";
import type { Db } from "../src/db/connection.js";
import { seededDb, testClock } from "./helpers.js";

const CALLER = "usr_priya:caller-a";
const OTHER = "usr_priya:caller-b";

let db: Db;
let clock: ReturnType<typeof testClock>;
let logs: string[];
let gate: ConfirmationGate;

beforeEach(() => {
  db = seededDb();
  clock = testClock();
  logs = [];
  const logger = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) };
  gate = new ConfirmationGate({ db, now: clock, logger });
});
afterEach(() => db.close());

const transfer = (quoteId = "q_1") => ({ kind: "transfer" as const, quoteId });

describe("ConfirmationGate", () => {
  it("unknown token refused", () => {
    expect(gate.consume(`ct_${"A".repeat(43)}`, CALLER, "transfer")).toMatchObject({
      refused: { code: "TOKEN_UNKNOWN" },
    });
  });

  it("expired token refused", () => {
    const { token, expiresAt } = gate.issue(transfer(), CALLER);
    expect(expiresAt).toBe("2026-10-15T08:05:00.000Z");
    clock.advance(5 * 60_000);
    expect(gate.consume(token, CALLER, "transfer")).toMatchObject({
      refused: { code: "TOKEN_EXPIRED" },
    });
  });

  it("is still valid one second before expiry", () => {
    const { token } = gate.issue(transfer(), CALLER);
    clock.advance(5 * 60_000 - 1000);
    expect(gate.consume(token, CALLER, "transfer")).toEqual(transfer());
  });

  it("reused token refused", () => {
    const { token } = gate.issue(transfer(), CALLER);
    expect(gate.consume(token, CALLER, "transfer")).toEqual(transfer());
    expect(gate.consume(token, CALLER, "transfer")).toMatchObject({
      refused: { code: "TOKEN_USED" },
    });
  });

  it("token from another caller refused, and does not burn it", () => {
    const { token } = gate.issue(transfer(), CALLER);
    expect(gate.consume(token, OTHER, "transfer")).toMatchObject({
      refused: { code: "TOKEN_UNKNOWN" },
    });
    expect(gate.consume(token, CALLER, "transfer")).toEqual(transfer());
  });

  it("a second issue for the same target invalidates the first token", () => {
    const first = gate.issue(transfer(), CALLER);
    const second = gate.issue(transfer(), CALLER);
    expect(gate.consume(first.token, CALLER, "transfer")).toMatchObject({
      refused: { code: "TOKEN_EXPIRED" },
    });
    expect(gate.consume(second.token, CALLER, "transfer")).toEqual(transfer());
  });

  it("tokens for different quotes are independent", () => {
    const a = gate.issue(transfer("q_a"), CALLER);
    gate.issue(transfer("q_b"), CALLER);
    expect(gate.consume(a.token, CALLER, "transfer")).toEqual(transfer("q_a"));
  });

  it("happy path consumes exactly once, even when two consumers race", () => {
    const { token } = gate.issue(transfer(), CALLER);
    const results = [
      gate.consume(token, CALLER, "transfer"),
      gate.consume(token, CALLER, "transfer"),
    ];
    expect(results.filter((r) => !("refused" in r))).toHaveLength(1);
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM confirmations WHERE used_at IS NOT NULL")
      .get();
    expect(row).toEqual({ n: 1 });
  });

  it("a cancel token only works as a cancel token, and carries the transfer ref", () => {
    const cx = gate.issue({ kind: "cancel", ref: "NUV-240120" }, CALLER);
    expect(cx.token).toMatch(/^cx_[A-Za-z0-9_-]{43}$/);
    expect(gate.consume(cx.token, CALLER, "transfer")).toMatchObject({
      refused: { code: "TOKEN_UNKNOWN" },
    });
    expect(gate.consume(cx.token, CALLER, "cancel")).toEqual({ kind: "cancel", ref: "NUV-240120" });

    const ct = gate.issue(transfer(), CALLER);
    expect(gate.consume(ct.token, CALLER, "cancel")).toMatchObject({
      refused: { code: "TOKEN_UNKNOWN" },
    });
  });

  it("never expires later than notAfter", () => {
    const notAfter = new Date(clock().getTime() + 60_000);
    expect(gate.issue(transfer(), CALLER, { notAfter }).expiresAt).toBe(notAfter.toISOString());
  });

  it("rolls back with the caller's transaction, so a refused state change keeps the token", () => {
    const { token } = gate.issue(transfer(), CALLER);
    expect(() =>
      db.transaction(() => {
        gate.consume(token, CALLER, "transfer");
        throw new Error("limits changed");
      })(),
    ).toThrow("limits changed");
    expect(gate.consume(token, CALLER, "transfer")).toEqual(transfer());
  });

  it("stores only a hash of the token and logs only its prefix", () => {
    const { token } = gate.issue(transfer(), CALLER);
    gate.consume(token, OTHER, "transfer");
    gate.consume(token, CALLER, "transfer");
    gate.consume(token, CALLER, "transfer");

    const stored = db.prepare("SELECT token FROM confirmations").all() as { token: string }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.token).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]?.token).not.toContain(token.slice(3));

    expect(logs).toEqual([
      `gate: rejected transfer token ${tokenPrefix(token)} (issued to another caller)`,
      `gate: consumed transfer token ${tokenPrefix(token)}`,
      `gate: rejected transfer token ${tokenPrefix(token)} (already used)`,
    ]);
    for (const line of logs) expect(line).not.toContain(token.slice(8));
  });

  it("issues unpredictable tokens", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => gate.issue(transfer(), CALLER).token));
    expect(tokens.size).toBe(50);
  });
});
