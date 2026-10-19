import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";

const TOKEN = "test-token-0123456789abcdef";

describe("parseConfig", () => {
  it("applies defaults when only the bearer token is set", () => {
    const cfg = parseConfig({ MCP_BEARER_TOKEN: TOKEN });
    expect(cfg).toEqual({
      PORT: 3000,
      MCP_BEARER_TOKEN: TOKEN,
      BEDROCK_MODEL_ID: "us.amazon.nova-2-lite-v1:0",
      AWS_REGION: "us-east-1",
      RATES_URL: "https://api.frankfurter.dev/v1",
      DB_PATH: "./data/nuvio-remit.db",
      TICKER_MS: 15000,
      SIM_DAILY_BEDROCK_CALLS: 500,
      POLLY_VOICE: "Kajal",
      POLLY_ENGINE: "neural",
      SIM_DAILY_TTS_CHARS: 100000,
      LLM_PROVIDER: "bedrock",
      LLM_BASE_URL: "https://api.openai.com/v1",
      LLM_MODEL: "gpt-4o-mini",
    });
  });

  it("coerces numeric variables", () => {
    const cfg = parseConfig({ MCP_BEARER_TOKEN: TOKEN, PORT: "8080", TICKER_MS: "500" });
    expect(cfg.PORT).toBe(8080);
    expect(cfg.TICKER_MS).toBe(500);
  });

  it("fails fast when the bearer token is missing", () => {
    expect(() => parseConfig({})).toThrow(ConfigError);
    expect(() => parseConfig({})).toThrow(/MCP_BEARER_TOKEN: is required/);
  });

  it("lists every invalid variable and never echoes the token", () => {
    const short = "short-secret";
    let message = "";
    try {
      parseConfig({ MCP_BEARER_TOKEN: short, PORT: "abc", RATES_URL: "not a url" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/MCP_BEARER_TOKEN/);
    expect(message).toMatch(/PORT/);
    expect(message).toMatch(/RATES_URL/);
    expect(message).not.toContain(short);
  });

  it("treats empty strings as unset", () => {
    expect(parseConfig({ MCP_BEARER_TOKEN: TOKEN, PORT: "" }).PORT).toBe(3000);
  });

  it("leaves the simulator and dev controls disabled unless their codes are set", () => {
    const cfg = parseConfig({ MCP_BEARER_TOKEN: TOKEN });
    expect(cfg.SIM_ACCESS_CODE).toBeUndefined();
    expect(cfg.DEV_CONTROLS_CODE).toBeUndefined();
    const on = parseConfig({
      MCP_BEARER_TOKEN: TOKEN,
      SIM_ACCESS_CODE: "sim-code-123",
      DEV_CONTROLS_CODE: "dev-code-123",
    });
    expect(on.SIM_ACCESS_CODE).toBe("sim-code-123");
    expect(() => parseConfig({ MCP_BEARER_TOKEN: TOKEN, SIM_ACCESS_CODE: "short" })).toThrow(
      /SIM_ACCESS_CODE: must be at least 8 characters/,
    );
  });
});
