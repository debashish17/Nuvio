import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOL_DESCRIPTIONS } from "../src/server/tools/descriptions.js";

const dir = new URL("../skills/nuvio-remit/", import.meta.url);
const skill = readFileSync(new URL("SKILL.md", dir), "utf8");

/** The YAML front matter's top-level `key: value` lines (enough for name and description). */
function frontMatter(md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md.replace(/\r\n/g, "\n"));
  if (!m?.[1]) throw new Error("SKILL.md has no front matter");
  return Object.fromEntries(
    m[1]
      .split("\n")
      .filter((l) => /^[a-z-]+:\s*\S/.test(l))
      .map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]),
  );
}

describe("Agent Skill: skills/nuvio-remit (agentskills.io format)", () => {
  const fm = frontMatter(skill);

  it("has a valid name that matches its folder, and a description", () => {
    expect(fm.name).toBe("nuvio-remit");
    expect(fm.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(fm.name?.length).toBeLessThanOrEqual(64);
    expect(fm.description?.length).toBeGreaterThan(0);
    expect(fm.description?.length).toBeLessThanOrEqual(1024);
  });

  it("teaches the safe flow in order, with the step-up code", () => {
    const order = [
      "get_pending",
      "resolve_beneficiary",
      "quote_transfer",
      "prepare_transfer",
      "read_back",
      "STEP_UP_REQUIRED",
      "otp",
      "track_transfer",
    ];
    const positions = order.map((w) => skill.indexOf(w));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(skill).toMatch(/never guess, invent or reuse/i);
  });

  it("references files that exist and every tool the server has", () => {
    for (const ref of ["references/tools.md", "scripts/mcp-call.mjs"]) {
      expect(skill).toContain(ref);
      expect(existsSync(new URL(ref, dir)), ref).toBe(true);
    }
    const tools = readFileSync(new URL("references/tools.md", dir), "utf8");
    for (const name of Object.keys(TOOL_DESCRIPTIONS)) expect(tools, name).toContain(`\`${name}\``);
    expect(skill).toContain(`All ${Object.keys(TOOL_DESCRIPTIONS).length} tools`);
  });

  it("stays a reasonable size (the format recommends under 500 lines)", () => {
    expect(skill.split("\n").length).toBeLessThan(500);
  });
});
