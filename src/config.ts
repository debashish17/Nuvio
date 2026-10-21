import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MCP_BEARER_TOKEN: z
    .string({ error: "is required" })
    .min(16, "must be at least 16 characters (use a long random string)"),
  // Nova 2 Lite has no in-Region endpoint in us-east-1: use the US inference profile.
  BEDROCK_MODEL_ID: z.string().min(1).default("us.amazon.nova-2-lite-v1:0"),
  AWS_REGION: z.string().min(1).default("us-east-1"),
  RATES_URL: z.url().default("https://api.frankfurter.dev/v1"),
  DB_PATH: z.string().min(1).default("./data/nuvio-remit.db"),
  TICKER_MS: z.coerce.number().int().min(100).default(15000),
  // Simulator and dev controls on a public URL. Unset means disabled (fail closed).
  SIM_ACCESS_CODE: z.string().min(8, "must be at least 8 characters").optional(),
  DEV_CONTROLS_CODE: z.string().min(8, "must be at least 8 characters").optional(),
  SIM_DAILY_BEDROCK_CALLS: z.coerce.number().int().min(1).default(500),
  // A hosted demo: opening the page after this many quiet minutes, or on a new day in Dubai,
  // reloads the demo data. 0 (the default) never does, so a local run keeps its ledger.
  SIM_AUTO_RESET_MINUTES: z.coerce.number().int().min(0).default(0),
  // The assistant's voice in the simulator: an Amazon Polly voice id, or "none" for the browser's.
  POLLY_VOICE: z.string().min(1).default("Kajal"),
  POLLY_ENGINE: z.enum(["standard", "neural", "generative", "long-form"]).default("neural"),
  // Characters Polly may bill per day (each reply bills its length twice: audio and word timings).
  SIM_DAILY_TTS_CHARS: z.coerce.number().int().min(1).default(100000),
  // Simulator mode: scripted (no language model) or bedrock (the live model through LLM_PROVIDER).
  // Unset: bedrock when a model is usable (AWS credentials, or an LLM_API_KEY), else scripted.
  SIM_MODE: z.enum(["scripted", "bedrock"]).optional(),
  // The live model: Amazon Bedrock (default) or any OpenAI-compatible /chat/completions endpoint.
  LLM_PROVIDER: z.enum(["bedrock", "openai_compatible"]).default("bedrock"),
  LLM_BASE_URL: z.url().default("https://api.openai.com/v1"),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_MODEL: z.string().min(1).default("gpt-4o-mini"),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Validates an environment object. Pure: does not read `.env` or `process.env`. */
export function parseConfig(env: Record<string, string | undefined>): Config {
  // Treat empty strings as unset so `FOO=` in .env falls back to the default.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ""));
  const result = ConfigSchema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new ConfigError(
      `Invalid configuration:\n${lines.join("\n")}\nSee .env.example for every variable.`,
    );
  }
  return result.data;
}

/** Loads `.env` (if present) into `process.env`, then validates. */
export function loadConfig(): Config {
  loadDotenv({ quiet: true });
  return parseConfig(process.env);
}
