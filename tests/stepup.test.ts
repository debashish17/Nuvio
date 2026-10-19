import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCore, type Core } from "../src/core/index.js";
import { MockCard } from "../src/core/ledger.js";
import { isRefusal } from "../src/core/refusal.js";
import type { Refusal } from "../src/core/types.js";
import { USER_ID } from "../src/db/seed.js";
import { liveFetch, seededDb, testClock } from "./helpers.js";

const CALLER = "usr_priya:caller-a";
const OTHER = "usr_priya:caller-b";

let clock: ReturnType<typeof testClock>;
let card: MockCard;
let core: Core;
let codes: string[];
let logs: string[];

beforeEach(() => {
  clock = testClock();
  card = new MockCard();
  codes = ["482913", "105577", "990001", "123123"];
  logs = [];
  const log = (m: string) => logs.push(m);
  core = createCore({
    db: seededDb(),
    ratesUrl: "https://rates.test/v1",
    fetch: liveFetch(),
    now: clock,
    logger: { info: log, warn: log },
    card,
    newOtp: () => codes.shift() ?? "000000",
  });
});
afterEach(() => core.db.close());

function ok<T>(r: T | Refusal): T {
  if (isRefusal(r)) throw new Error(`unexpected refusal ${r.refused.code}`);
  return r;
}
async function prepared(sendAed = 2000) {
  const q = ok(
    await core.quotes.create(USER_ID, { beneficiaryId: "ben_01", sendMinor: sendAed * 100 }),
  );
  return ok(core.quotes.prepare(USER_ID, q.quote_id, CALLER)).confirmation_token;
}
const transfers = () =>
  (core.db.prepare("SELECT COUNT(*) AS n FROM transfers").get() as { n: number }).n;
const texts = () => core.outbox.since(USER_ID, "2000-01-01T00:00:00Z");

describe("StepUpService.confirm", () => {
  it("first call texts a code bound to the amount and recipient, and moves no money", async () => {
    const token = await prepared();
    const before = transfers();
    const r = core.stepUp.confirm(USER_ID, token, CALLER);
    expect(r).toMatchObject({
      refused: {
        code: "STEP_UP_REQUIRED",
        method: "sms_otp",
        sent_to: "phone ending 4471",
        attempts_left: 3,
        expires_at: "2026-10-15T08:05:00.000Z",
      },
    });
    expect(JSON.stringify(r)).not.toContain("482913"); // the code is never in the tool result
    expect(texts()).toEqual([
      {
        to: "4471",
        at: "2026-10-15T08:00:00.000Z",
        body: "Nuvio: 482913 is your code to send 2,000 dirhams to Mum. It expires in 5 minutes. Nuvio staff will never ask you for it.",
      },
    ]);
    expect(transfers()).toBe(before);
    expect(card.charges).toEqual([]);
  });

  it("the text names a 'My ...' recipient as 'your ...'", async () => {
    const q = ok(
      await core.quotes.create(USER_ID, { beneficiaryId: "ben_04", sendMinor: 100_000 }),
    );
    const token = ok(core.quotes.prepare(USER_ID, q.quote_id, CALLER)).confirmation_token;
    core.stepUp.confirm(USER_ID, token, CALLER);
    expect(texts().at(-1)?.body).toContain("to send 1,000 dirhams to your NRE account.");
  });

  it("the right code confirms once; replaying it is refused", async () => {
    const token = await prepared();
    core.stepUp.confirm(USER_ID, token, CALLER);
    const done = ok(core.stepUp.confirm(USER_ID, token, CALLER, "4 8 2 9 1 3")); // as spoken
    expect(done).toMatchObject({ status: "SCREENING" });
    expect(card.charges).toHaveLength(1);
    expect(core.stepUp.confirm(USER_ID, token, CALLER, "482913")).toMatchObject({
      refused: { code: "TOKEN_USED" },
    });
    expect(card.charges).toHaveLength(1);
  });

  it("takes the code as the user said it: words, digits, punctuation", async () => {
    const token = await prepared();
    core.stepUp.confirm(USER_ID, token, CALLER);
    const done = ok(core.stepUp.confirm(USER_ID, token, CALLER, "four eight two nine one three."));
    expect(done).toMatchObject({ status: "SCREENING" });
    expect(card.charges).toHaveLength(1);
  });

  it("something that isn't six digits is refused without using a try", async () => {
    const token = await prepared();
    core.stepUp.confirm(USER_ID, token, CALLER);
    for (const said of ["banana", "12345", "four eight two"]) {
      const r = core.stepUp.confirm(USER_ID, token, CALLER, said);
      expect(r, said).toMatchObject({ refused: { code: "OTP_INVALID", attempts_left: 3 } });
      expect(isRefusal(r) && r.refused.resolution).toMatch(/six digits/);
    }
    // The tries are all still there: the right code works.
    expect(ok(core.stepUp.confirm(USER_ID, token, CALLER, "482913"))).toMatchObject({
      status: "SCREENING",
    });
  });

  it("a wrong code counts down, and the third voids the confirmation", async () => {
    const token = await prepared();
    core.stepUp.confirm(USER_ID, token, CALLER);
    expect(core.stepUp.confirm(USER_ID, token, CALLER, "000000")).toMatchObject({
      refused: { code: "OTP_INVALID", attempts_left: 2 },
    });
    expect(core.stepUp.confirm(USER_ID, token, CALLER, "111112")).toMatchObject({
      refused: { code: "OTP_INVALID", attempts_left: 1 },
    });
    expect(core.stepUp.confirm(USER_ID, token, CALLER, "111111")).toMatchObject({
      refused: { code: "OTP_LOCKED" },
    });
    // Even the right code no longer works: the token itself is void.
    expect(core.stepUp.confirm(USER_ID, token, CALLER, "482913")).toMatchObject({
      refused: { code: "TOKEN_EXPIRED" },
    });
    expect(card.charges).toEqual([]);
  });

  it("a code expires after 5 minutes; a new one can be sent, at most 3 per confirmation", async () => {
    const token = await prepared();
    core.stepUp.confirm(USER_ID, token, CALLER);
    clock.advance(5 * 60_000 - 1000); // the token itself has 1 s left
    core.stepUp.confirm(USER_ID, token, CALLER); // second code, capped at the token's expiry
    expect(core.stepUp.confirm(USER_ID, token, CALLER, "482913")).toMatchObject({
      refused: { code: "OTP_INVALID" }, // the old code is replaced by the new one
    });
    clock.advance(2000);
    expect(core.stepUp.confirm(USER_ID, token, CALLER, "105577")).toMatchObject({
      refused: { code: "TOKEN_EXPIRED" },
    });
  });

  it("caps the codes sent per confirmation", async () => {
    const token = await prepared();
    for (let i = 0; i < 3; i++) {
      expect(core.stepUp.confirm(USER_ID, token, CALLER)).toMatchObject({
        refused: { code: "STEP_UP_REQUIRED" },
      });
    }
    expect(core.stepUp.confirm(USER_ID, token, CALLER)).toMatchObject({
      refused: { code: "OTP_LOCKED" },
    });
    expect(texts()).toHaveLength(3);
  });

  it("an expired code is refused even if correct", async () => {
    const token = await prepared();
    core.stepUp.confirm(USER_ID, token, CALLER);
    clock.advance(4 * 60_000);
    // Re-prepare is not needed: the token still has a minute, the code is checked first.
    core.db.prepare("UPDATE step_up_challenges SET expires_at = ?").run(clock().toISOString());
    expect(core.stepUp.confirm(USER_ID, token, CALLER, "482913")).toMatchObject({
      refused: { code: "OTP_EXPIRED" },
    });
  });

  it("a code before any was sent, another caller's token, or another payment's code is refused", async () => {
    const token = await prepared();
    expect(core.stepUp.confirm(USER_ID, token, CALLER, "482913")).toMatchObject({
      refused: { code: "OTP_INVALID" },
    });
    core.stepUp.confirm(USER_ID, token, CALLER);
    expect(core.stepUp.confirm(USER_ID, token, OTHER, "482913")).toMatchObject({
      refused: { code: "TOKEN_UNKNOWN" },
    });
    // A second payment gets its own code; the first payment's code does not confirm it.
    const second = await prepared(500);
    core.stepUp.confirm(USER_ID, second, CALLER);
    expect(core.stepUp.confirm(USER_ID, second, CALLER, "482913")).toMatchObject({
      refused: { code: "OTP_INVALID" },
    });
    expect(card.charges).toEqual([]);
  });

  it("never logs or stores a code in the clear", async () => {
    const token = await prepared();
    core.stepUp.confirm(USER_ID, token, CALLER);
    core.stepUp.confirm(USER_ID, token, CALLER, "000000");
    ok(core.stepUp.confirm(USER_ID, token, CALLER, "482913"));
    expect(logs.join("\n")).not.toContain("482913");
    const rows = JSON.stringify(core.db.prepare("SELECT * FROM step_up_challenges").all());
    expect(rows).not.toContain("482913");
  });
});
