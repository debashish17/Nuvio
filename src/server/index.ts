import { ConfigError, loadConfig, type Config } from "../config.js";
import { createCore } from "../core/index.js";
import { openDb } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { seed } from "../db/seed.js";
import { createApp } from "./app.js";
import { startJobs } from "./jobs.js";
import { bedrockConverse, ChatService } from "./sim/chat.js";
import { DailyBudget } from "./sim/guards.js";
import { SYSTEM_PROMPT } from "./sim/prompt.js";
import { decideMode, hasAwsCredentials } from "./sim/mode.js";
import { openAiCompatibleConverse } from "./sim/openai.js";
import { McpRelay } from "./sim/relay.js";
import { ScriptedChat, type ChatEngine } from "./sim/scripted.js";
import { pollySynthesize, TtsService } from "./sim/tts.js";

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const db = openDb(config.DB_PATH);
const applied = migrate(db);
if (applied.length) console.log(`db: applied ${applied.join(", ")}`);
const users = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
if (users === 0) {
  // A fresh container has an empty database; load the demo data so the endpoint works at once.
  console.log("db: empty, loading demo seed", seed(db));
}

const core = createCore({ db, ratesUrl: config.RATES_URL, stepMs: config.TICKER_MS });
const stopJobs = startJobs(core, config.TICKER_MS);

// The simulator relay calls this same server over loopback HTTP: a real /mcp round trip.
const relay = new McpRelay({
  url: `http://127.0.0.1:${config.PORT}/mcp`,
  bearer: config.MCP_BEARER_TOKEN,
});
const budget = new DailyBudget(config.SIM_DAILY_BEDROCK_CALLS);
// One look at the AWS credential chain decides the defaults: a clean clone with no AWS account
// runs the scripted demo and the browser's voice, with no failing calls.
const awsCredentials = await hasAwsCredentials(config.AWS_REGION);
const { mode, reason } = decideMode(config, awsCredentials);
const openai = config.LLM_PROVIDER === "openai_compatible";
const llm = {
  provider: config.LLM_PROVIDER,
  model: openai ? config.LLM_MODEL : config.BEDROCK_MODEL_ID,
};
const chat: ChatEngine =
  mode === "scripted"
    ? new ScriptedChat(relay)
    : new ChatService({
        relay,
        converse: openai
          ? openAiCompatibleConverse({
              baseUrl: config.LLM_BASE_URL,
              apiKey: config.LLM_API_KEY ?? "",
              model: config.LLM_MODEL,
            })
          : bedrockConverse(config.AWS_REGION),
        modelId: llm.model,
        systemPrompt: SYSTEM_PROMPT,
        budget,
      });

// Polly needs AWS credentials; without them the page uses the browser's voice directly.
const tts =
  config.POLLY_VOICE === "none" || !awsCredentials
    ? undefined
    : new TtsService({
        synthesize: pollySynthesize({
          region: config.AWS_REGION,
          voice: config.POLLY_VOICE,
          engine: config.POLLY_ENGINE,
        }),
        voice: config.POLLY_VOICE,
        engine: config.POLLY_ENGINE,
        dailyChars: config.SIM_DAILY_TTS_CHARS,
      });

const app = createApp({
  bearerToken: config.MCP_BEARER_TOKEN,
  core,
  sim: {
    chat,
    relay,
    budget,
    accessCode: config.SIM_ACCESS_CODE,
    devCode: config.DEV_CONTROLS_CODE,
    tts,
    mode,
    llm: mode === "scripted" ? null : llm,
    reseed: () => {
      seed(db);
      chat.clear();
      relay.reset();
      console.log("dev: demo seed reloaded");
    },
  },
});
const httpServer = app.listen(config.PORT, (err) => {
  if (err) {
    console.error(`Failed to listen on port ${config.PORT}: ${err.message}`);
    process.exit(1);
  }
  console.log(`nuvio-remit listening on :${config.PORT} (POST /mcp, GET /health)`);
  console.log(
    `simulator ${config.SIM_ACCESS_CODE ? "on" : "off (set SIM_ACCESS_CODE)"}; dev controls ${config.DEV_CONTROLS_CODE ? "on" : "off"}; voice ${tts ? `Polly ${config.POLLY_VOICE} (${config.POLLY_ENGINE})` : "browser"}`,
  );
  console.log(
    mode === "scripted"
      ? `simulator mode: scripted (${reason}): Play demo runs the real tools with no language model`
      : `simulator mode: live model (${reason}): ${llm.provider} ${llm.model}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopJobs();
    httpServer.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
