import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeCrossTrend,
  describeTrend,
  deriveAedInr,
  RatesService,
} from "../src/core/rates.js";
import { applyMargin } from "../src/core/money.js";
import { FX_MARGIN_BP } from "../src/core/policy.js";
import type { Db } from "../src/db/connection.js";
import {
  failingFetch,
  frankfurterSeries,
  liveFetch,
  seededDb,
  silentLogger,
  testClock,
} from "./helpers.js";

let db: Db;
afterEach(() => db?.close());

function service(fetchFn: typeof fetch, clock = testClock()) {
  db = seededDb();
  return new RatesService({
    db,
    baseUrl: "https://rates.test/v1/",
    fetch: fetchFn,
    now: clock,
    logger: silentLogger,
  });
}

describe("RatesService", () => {
  it("live fetch populates the cache and derives AED/INR from USD/INR at the peg", async () => {
    const fetchFn = liveFetch();
    const rates = service(fetchFn);
    const mid = await rates.getMid("AED", "INR");
    expect(mid).toEqual({ rate: 26.2301, asOf: "2026-10-15T08:00:00.000Z", source: "live" });

    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://rates.test/v1/2026-10-01..?from=USD");

    const cache = db.prepare("SELECT pair, mid, source FROM rates_cache ORDER BY pair").all();
    expect(cache).toEqual([
      { pair: "AED/INR", mid: 26.2301, source: "live" },
      { pair: "GBP/INR", mid: 127.4797, source: "live" },
      { pair: "USD/GBP", mid: 0.7557, source: "live" },
      { pair: "USD/INR", mid: 96.33, source: "live" },
    ]);
    const history = db
      .prepare("SELECT mid FROM rates_history WHERE pair = 'AED/INR' AND day = '2026-10-14'")
      .get();
    expect(history).toEqual({ mid: 26.2301 });
  });

  it("a second call within 15 minutes does not hit the network", async () => {
    const fetchFn = liveFetch();
    const clock = testClock();
    const rates = service(fetchFn, clock);
    await rates.getMid("AED", "INR");
    clock.advance(14 * 60_000);
    await rates.getMid("AED", "INR");
    await rates.getCustomerRate("AED", "INR");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("network failure falls back to seeded history with source=fallback", async () => {
    const rates = service(failingFetch());
    const mid = await rates.getMid("AED", "INR");
    // newest seeded day: USD/INR 96.33 on 2026-10-01
    expect(mid).toEqual({ rate: 26.2301, asOf: "2026-10-01T00:00:00.000Z", source: "fallback" });
    expect(silentLogger.warnings.at(-1)).toMatch(/rates: fetch failed/);
  });

  it("falls back on a non-200 and on a malformed body", async () => {
    const bad = vi.fn(async () => new Response("nope", { status: 404 }));
    expect((await service(bad).getMid("AED", "INR")).source).toBe("fallback");
    const malformed = vi.fn(async () => new Response(JSON.stringify({ base: "USD", rates: 1 })));
    expect((await service(malformed).getMid("AED", "INR")).source).toBe("fallback");
  });

  it("after a failure, waits a minute before trying the network again", async () => {
    const fetchFn = failingFetch();
    const clock = testClock();
    const rates = service(fetchFn, clock);
    await rates.getMid("AED", "INR");
    clock.advance(30_000);
    await rates.getMid("AED", "INR");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    clock.advance(31_000);
    await rates.getMid("AED", "INR");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("serves a stale cache immediately and refreshes in the background", async () => {
    const fetchFn = liveFetch();
    const clock = testClock();
    const rates = service(fetchFn, clock);
    await rates.getMid("AED", "INR");
    clock.advance(20 * 60_000);
    fetchFn.mockImplementationOnce(async () =>
      frankfurterSeries({ "2026-10-15": { INR: 97.0, GBP: 0.76 } }),
    );
    const stale = await rates.getMid("AED", "INR");
    expect(stale.rate).toBe(26.2301);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await rates.refresh(); // joins the in-flight request
    expect((await rates.getMid("AED", "INR")).rate).toBe(deriveAedInr(97.0));
  });

  it("shares one request between concurrent cold-start callers", async () => {
    const fetchFn = liveFetch();
    const rates = service(fetchFn);
    await Promise.all([rates.getMid("AED", "INR"), rates.getMid("AED", "INR")]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("customer rate is mid less the 0.9% AED/INR margin, floored to 4 dp", async () => {
    const rates = service(liveFetch());
    expect(await rates.getCustomerRate("AED", "INR")).toEqual({ rate: 25.994, fxMarginPct: 0.9 });
  });

  it("week range and trend come from the newest 7 history days", async () => {
    const rates = service(failingFetch());
    const week = await rates.getWeekRange("AED", "INR");
    // seeded USD/INR 95.74 (23 Sep) -> 96.33 (1 Oct): AED/INR 26.0694 -> 26.2301
    expect(week).toEqual({ high: 26.2301, low: 26.0694, changePct: 0.6 });
    const snap = await rates.snapshot("AED", "INR");
    expect(snap).toMatchObject({
      sendable: true,
      trend: "rupee weakened 0.6% this week",
      source: "ECB reference history, offline fallback",
    });
  });

  it("labels the week range by rate: Nuvio's customer rate and the mid-market rate", async () => {
    // Review of the live run (2026-10-19): an unlabelled mid-market range read as Nuvio's rate.
    const rates = service(failingFetch());
    const snap = await rates.snapshot("AED", "INR");
    const bp = FX_MARGIN_BP["AED/INR"] ?? 0;
    expect(snap).toMatchObject({
      mid_week_high: 26.2301,
      mid_week_low: 26.0694,
      customer_week_high: applyMargin(26.2301, bp),
      customer_week_low: applyMargin(26.0694, bp),
    });
    expect(snap).not.toHaveProperty("week_high");
    expect(snap).not.toHaveProperty("week_low");
  });

  it("the week range always contains today's rate, live or cached", async () => {
    // A live mid newer than the stored history used to fall outside the week's high and low.
    const rates = service(liveFetch());
    const snap = (await rates.snapshot("AED", "INR")) as unknown as Record<string, number>;
    expect(snap.mid_week_low).toBeLessThanOrEqual(snap.mid_rate as number);
    expect(snap.mid_rate).toBeLessThanOrEqual(snap.mid_week_high as number);
    expect(snap.customer_week_low).toBeLessThanOrEqual(snap.customer_rate as number);
    expect(snap.customer_rate).toBeLessThanOrEqual(snap.customer_week_high as number);
  });

  it("describes the trend from the sender's side", () => {
    expect(describeTrend(0.6)).toBe("rupee weakened 0.6% this week");
    expect(describeTrend(-0.4)).toBe("rupee strengthened 0.4% this week");
    expect(describeTrend(0.04)).toBe("rupee steady this week");
  });

  it("rejects unsupported pairs", async () => {
    await expect(service(liveFetch()).getMid("EUR", "INR")).rejects.toThrow(/Unsupported pair/);
  });
});

describe("rates for other currencies (information only)", () => {
  /** USD base with INR, GBP, EUR and PHP for two days. */
  const wideFetch = () =>
    vi.fn(async () =>
      frankfurterSeries({
        "2026-10-13": { INR: 95.9, GBP: 0.755, EUR: 0.86, PHP: 57.0 },
        "2026-10-14": { INR: 96.33, GBP: 0.75565, EUR: 0.8612, PHP: 57.4 },
      } as unknown as Record<string, { INR: number; GBP: number }>),
    );

  it("quotes any pair of ECB currencies as a cross of their USD rates", async () => {
    const rates = service(wideFetch());
    const snap = await rates.snapshot("gbp", "eur");
    expect(snap).toMatchObject({
      pair: "GBP/EUR",
      sendable: false,
      mid_rate: 1.1396, // 0.8612 / 0.7557 (USD/GBP stored at 4 dp)
      note: "Mid-market rate for information only. Nuvio sends money from AED to INR only.",
    });
    expect(snap).not.toHaveProperty("customer_rate");
    // Information-only pairs have only mid-market rates, and say so in the field names.
    expect(snap).toHaveProperty("mid_week_high");
    expect(snap).toHaveProperty("mid_week_low");
    expect(snap).not.toHaveProperty("week_high");
    expect(snap).not.toHaveProperty("customer_week_high");
  });

  it("derives the Gulf currencies from their US dollar pegs", async () => {
    const rates = service(wideFetch());
    expect(await rates.snapshot("SAR", "INR")).toMatchObject({
      pair: "SAR/INR",
      mid_rate: 25.688, // 96.33 / 3.75
      source: "ECB via Frankfurter, cached; SAR at the US dollar peg",
    });
    expect(await rates.snapshot("AED", "PHP")).toMatchObject({ mid_rate: 15.6297 }); // 57.4 / 3.6725
    expect(await rates.snapshot("USD", "AED")).toMatchObject({ mid_rate: 3.6725 });
  });

  it("keeps AED/INR as the sending rate with Nuvio's margin", async () => {
    const rates = service(wideFetch());
    expect(await rates.snapshot("AED", "INR")).toMatchObject({
      pair: "AED/INR",
      sendable: true,
      customer_rate: 25.994,
    });
  });

  it("lists USD, the pegs and every fetched currency", async () => {
    const rates = service(wideFetch());
    await rates.getMid("USD", "INR");
    expect(rates.currencies()).toEqual([
      "AED",
      "BHD",
      "EUR",
      "GBP",
      "INR",
      "OMR",
      "PHP",
      "QAR",
      "SAR",
      "USD",
    ]);
  });

  it("refuses an unknown currency, the same currency twice, and a basket currency", async () => {
    const rates = service(wideFetch());
    expect(await rates.snapshot("AED", "XYZ")).toMatchObject({
      refused: { code: "CURRENCY_NOT_SUPPORTED", currency: "XYZ" },
    });
    expect(await rates.snapshot("KWD", "INR")).toMatchObject({
      refused: { code: "CURRENCY_NOT_SUPPORTED", currency: "KWD" },
    });
    expect(await rates.snapshot("PHP", "PHP")).toMatchObject({
      refused: { code: "CURRENCY_NOT_SUPPORTED" },
    });
  });

  it("offline, quotes what the seeded history covers and nothing it doesn't", async () => {
    const rates = service(failingFetch());
    expect(await rates.snapshot("USD", "INR")).toMatchObject({
      pair: "USD/INR",
      source: "ECB reference history, offline",
    });
    expect(await rates.snapshot("USD", "PHP")).toMatchObject({
      refused: { code: "CURRENCY_NOT_SUPPORTED" },
    });
  });

  it("describes a cross trend from the second currency's side", () => {
    expect(describeCrossTrend("AED", "PHP", 0.4)).toBe(
      "Philippine Peso weakened 0.4% against the UAE Dirham this week",
    );
    expect(describeCrossTrend("USD", "EUR", -0.05)).toBe(
      "Euro steady against the US Dollar this week",
    );
  });
});
