import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { seed } from "../src/db/seed.js";
import { VERIFIED_TIER } from "../src/core/policy.js";

const NOW = new Date("2026-10-15T08:00:00Z");

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
});
afterEach(() => db.close());

const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("migrate", () => {
  it("creates the eleven SPEC.md tables and is idempotent", () => {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(tables).toEqual([
      "alerts",
      "beneficiaries",
      "confirmations",
      "quotes",
      "rates_cache",
      "rates_history",
      "sms_outbox",
      "step_up_challenges",
      "transfer_events",
      "transfers",
      "users",
    ]);
    expect(migrate(db)).toEqual([]);
  });
});

describe("seed", () => {
  it("wipes and reloads to identical state", () => {
    const first = seed(db, NOW);
    db.prepare("INSERT INTO alerts (id, user_id) VALUES ('al_x', 'usr_priya')").run();
    const second = seed(db, NOW);
    expect(second).toEqual(first);
    expect(count("alerts")).toBe(0);
    expect(count("users")).toBe(1);
    expect(count("beneficiaries")).toBe(4);
    expect(count("rates_history")).toBe(21);
    expect(count("transfers")).toBe(15);
  });

  it("every seeded transfer fits the limits it would be checked against today", () => {
    // A card-funded transfer the policy would refuse can't be in the history (review finding 2).
    seed(db, NOW);
    const rows = db
      .prepare("SELECT ref, send_amount_minor AS amount, created_at FROM transfers")
      .all() as { ref: string; amount: number; created_at: string }[];
    const byDay = new Map<string, number>();
    const byMonth = new Map<string, number>();
    for (const r of rows) {
      expect(r.amount, r.ref).toBeLessThanOrEqual(VERIFIED_TIER.perTransactionMinor);
      const day = r.created_at.slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + r.amount);
      byMonth.set(day.slice(0, 7), (byMonth.get(day.slice(0, 7)) ?? 0) + r.amount);
    }
    for (const [day, sum] of byDay) expect(sum, day).toBeLessThanOrEqual(VERIFIED_TIER.dailyMinor);
    for (const [m, sum] of byMonth) expect(sum, m).toBeLessThanOrEqual(VERIFIED_TIER.monthlyMinor);
  });

  it("leaves 16,500 AED used this month, in minor units", () => {
    seed(db, NOW);
    const { used } = db
      .prepare(
        "SELECT SUM(send_amount_minor) AS used FROM transfers WHERE created_at >= '2026-10-01' AND status != 'CANCELLED'",
      )
      .get() as { used: number };
    expect(used).toBe(1_650_000);
  });

  it("prices receive amounts as (send - fee) x rate floored to the paisa", () => {
    seed(db, NOW);
    const row = db
      .prepare(
        "SELECT receive_amount_minor, fee_minor, rate FROM transfers WHERE beneficiary_id = 'ben_01' AND created_at LIKE '2026-10-02%'",
      )
      .get() as { receive_amount_minor: number; fee_minor: number; rate: number };
    expect(row.fee_minor).toBe(1500);
    // October board rate: USD/INR 96.33 / 3.6725 = 26.2301 mid, less 0.9% = 25.9940
    expect(row.rate).toBe(25.994);
    expect(row.receive_amount_minor).toBe(5_159_809); // 1,985 x 25.9940
    expect(Number.isInteger(row.receive_amount_minor)).toBe(true);
  });

  it("seeds the ON_HOLD transfer with an RFI and no screening reason", () => {
    seed(db, NOW);
    const t = db.prepare("SELECT * FROM transfers WHERE status = 'ON_HOLD'").get() as Record<
      string,
      unknown
    >;
    expect(t.ref).toBe("NUV-240120");
    expect(t.send_amount_minor).toBe(500_000);
    expect(t.return_reason).toBeNull();
    const rfi = JSON.parse(t.hold_rfi_json as string) as Record<string, unknown>;
    expect(rfi).toEqual({
      type: "RFI",
      document: "updated Emirates ID",
      how: "upload in the Nuvio app",
      deadline: "2026-10-17",
    });
    const timeline = db
      .prepare("SELECT status FROM transfer_events WHERE ref = ? ORDER BY at")
      .all(t.ref) as { status: string }[];
    expect(timeline.map((e) => e.status)).toEqual(["FUNDS_RECEIVED", "SCREENING", "ON_HOLD"]);
  });

  it("seeds the RETURNED transfer with a 475 AED refund: FX loss and fee kept", () => {
    seed(db, NOW);
    const t = db.prepare("SELECT * FROM transfers WHERE status = 'RETURNED'").get() as Record<
      string,
      unknown
    >;
    expect(t.beneficiary_id).toBe("ben_03");
    expect(t.created_at).toBe("2026-08-15T09:00:00.000Z");
    expect(t.refund_minor).toBe(47_500);
    expect(t.return_reason).toBe("recipient bank reported a name mismatch");
    expect(t.utr).toBeNull();
  });

  it("gives every PAID_OUT transfer a UTR and a four-step timeline", () => {
    seed(db, NOW);
    const paid = db.prepare("SELECT ref, utr FROM transfers WHERE status = 'PAID_OUT'").all() as {
      ref: string;
      utr: string | null;
    }[];
    expect(paid).toHaveLength(13);
    for (const t of paid) {
      // Bank deposits carry the bank's IFSC prefix (Mum: HDFC, the NRE account: SBI); UPI, 12 digits.
      expect(t.utr).toMatch(/^((HDFC|SBIN|ICIC)R5\d{16}|\d{12})$/);
      const n = db
        .prepare("SELECT COUNT(*) AS n FROM transfer_events WHERE ref = ?")
        .get(t.ref) as {
        n: number;
      };
      expect(n.n).toBe(4);
    }
  });
});

describe("db modules", () => {
  it("have no command-line side effects (the server bundles them)", () => {
    for (const file of ["migrate.ts", "seed.ts", "connection.ts"]) {
      const src = readFileSync(new URL(`../src/db/${file}`, import.meta.url), "utf8");
      expect(src, file).not.toMatch(/process\.argv|import\.meta\.url === /);
    }
  });
});

describe("seed dates", () => {
  const dubaiMonthStart = (now: Date) => {
    const d = new Date(now.getTime() + 4 * 3_600_000);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 4 * 3_600_000);
  };

  it.each([
    ["2 Oct in Dubai, still 1 Oct in UTC (the live failure)", "2026-10-01T20:52:00Z", 0],
    ["6 Oct: the 10th moves before today", "2026-10-06T10:00:00Z", 0],
    ["mid-month: SPEC days unchanged", "2026-10-15T08:00:00Z", 0],
    ["late on the 31st in Dubai", "2026-10-31T19:30:00Z", 0],
    ["the 1st in Dubai: lands earlier today", "2026-10-31T21:00:00Z", 1_650_000],
  ])("%s", (_label, at, expectedDailyUsed) => {
    const now = new Date(at);
    seed(db, now);
    const rows = db
      .prepare("SELECT ref, created_at, status FROM transfers ORDER BY created_at, rowid")
      .all() as { ref: string; created_at: string; status: string }[];
    const events = db.prepare("SELECT MAX(at) AS last FROM transfer_events").get() as {
      last: string;
    };

    expect(rows.every((r) => r.created_at <= now.toISOString())).toBe(true);
    expect(events.last <= now.toISOString()).toBe(true);
    expect(rows.at(-1)).toMatchObject({ ref: "NUV-240120", status: "ON_HOLD" });
    expect(rows.map((r) => r.ref)).toEqual([...rows.map((r) => r.ref)].sort());

    const since = (d: Date) =>
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(send_amount_minor), 0) AS n FROM transfers WHERE status NOT IN ('CANCELLED','RETURNED') AND created_at >= ?",
          )
          .get(d.toISOString()) as { n: number }
      ).n;
    const dubaiDayStart = new Date(
      Math.floor((now.getTime() + 4 * 3_600_000) / 86_400_000) * 86_400_000 - 4 * 3_600_000,
    );
    expect(since(dubaiMonthStart(now))).toBe(1_650_000);
    expect(since(dubaiDayStart)).toBe(expectedDailyUsed);
  });
});
