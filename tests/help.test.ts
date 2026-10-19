import { describe, expect, it } from "vitest";
import { HELP_TOPICS, helpAnswer } from "../src/core/help.js";
import { OTP, VERIFIED_TIER } from "../src/core/policy.js";

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

describe("get_help content", () => {
  it("answers every topic with a spoken answer, points and a source, and claims no review yet", () => {
    for (const topic of HELP_TOPICS) {
      const a = helpAnswer(topic);
      expect(a.topic).toBe(topic);
      expect(a.answer.length, topic).toBeGreaterThan(40);
      expect(words(a.answer), `${topic} is too long to speak`).toBeLessThanOrEqual(75);
      expect(a.answer, topic).not.toMatch(/[*#`•]|^\s*-/m); // read aloud: no markdown
      expect(a.points.length, topic).toBeGreaterThan(0);
      expect(a.source, topic).not.toBe("");
      // No compliance review has happened; set the date in help.ts when one does.
      expect(a.last_reviewed, topic).toBeNull();
      for (const r of a.related) expect(HELP_TOPICS).toContain(r);
    }
  });

  it("takes its numbers from the same policy the limits enforce", () => {
    const t = VERIFIED_TIER;
    expect(helpAnswer("limits_and_tiers").answer).toContain("5,000 dirhams per transfer");
    expect(helpAnswer("limits_and_tiers").answer).toContain("20,000 dirhams a month");
    expect(helpAnswer("documents").answer).toContain(t.nextTier.requirement);
    expect(helpAnswer("documents").answer).toContain("15,000 dirhams or more");
    expect(helpAnswer("payout_methods").answer).toContain("50,000 rupees in cash");
    expect(helpAnswer("how_to_send").answer).toContain(`${OTP.digits}-digit code`);
    // A different tier changes the answers with it.
    const plus = { ...t, name: "Plus", label: "Plus", monthlyMinor: 6_000_000 };
    expect(helpAnswer("limits_and_tiers", plus).answer).toContain("60,000 dirhams a month");
  });

  it("is clear that LRS does not apply to remittances into India", () => {
    const a = helpAnswer("lrs");
    expect(a.answer).toMatch(/out of India/);
    expect(a.answer).toMatch(/does not apply/);
    expect(a.disclaimer).toMatch(/not legal or tax advice/);
  });

  it("keeps regulatory and tax topics labelled as general information", () => {
    for (const topic of ["nre_nro", "lrs", "tax"] as const) {
      expect(helpAnswer(topic).disclaimer, topic).toMatch(/General information/);
    }
  });

  it("never says recipients can be added by voice", () => {
    expect(helpAnswer("recipients").answer).toMatch(/only in the Nuvio app, never by voice/);
  });
});
