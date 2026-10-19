import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * Browser smoke tests (e2e/): the path a judge takes, in a real browser against a real server.
 * The server runs in scripted mode with Polly off, so no language model or AWS call is ever made,
 * on a fresh seeded database with a fast ticker. Uses the Chrome already installed (locally and
 * on GitHub's Ubuntu runners), so no browser download.
 */

const PORT = 3300;
export const ACCESS_CODE = "e2e-access-code";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 5 * 60_000,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: "chrome",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm e2e:serve",
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      DB_PATH: join(tmpdir(), `nuvio-remit-e2e-${process.pid}.db`),
      SIM_MODE: "scripted",
      POLLY_VOICE: "none",
      MCP_BEARER_TOKEN: "e2e-bearer-token-0123456789",
      SIM_ACCESS_CODE: ACCESS_CODE,
      TICKER_MS: "1000",
    },
  },
});
