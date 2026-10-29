import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

// Optional: PW_CHROMIUM=/path/to/chrome-headless-shell when the Playwright-matched browser build is not installed.
const executablePath = process.env.PW_CHROMIUM && existsSync(process.env.PW_CHROMIUM) ? process.env.PW_CHROMIUM : undefined;

/**
 * Browser E2E suite. Starts `next dev` on port 3099 (never the pennbridge-dev stack on 3087) plus a worker, both against a
 * THROWAWAY database in DEMO_MODE. Provide a database whose name contains "e2e" or "test":
 *   E2E_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/pb_e2e_test npm run test:browser
 */
const databaseUrl = process.env.E2E_DATABASE_URL;
if (databaseUrl && !/e2e|test/i.test(new URL(databaseUrl).pathname)) throw new Error("E2E_DATABASE_URL must point at a throwaway database (name contains e2e or test).");
export const E2E_PORT = 3099;
export const e2eEnv = {
  DATABASE_URL: databaseUrl ?? "", DEMO_MODE: "true", LIVE_AI_ENABLED: "false", STORAGE_ROOT: "runtime/e2e-storage", PROJECT_ROOT: process.cwd(),
  WORKER_ALIVE_FILE: "runtime/e2e-worker.alive", NEXT_TELEMETRY_DISABLED: "1",
};
export default defineConfig({
  testDir: "tests/e2e", testMatch: "**/*.spec.ts", timeout: 60_000, expect: { timeout: 10_000 }, workers: 1, fullyParallel: false, retries: 0,
  reporter: [["list"]], globalSetup: "./tests/e2e/global-setup.ts",
  use: { baseURL: `http://127.0.0.1:${E2E_PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure", viewport: { width: 1280, height: 900 }, launchOptions: { executablePath } },
  outputDir: "test-results/e2e",
  webServer: databaseUrl ? { command: `npx next dev apps/web --hostname 127.0.0.1 --port ${E2E_PORT}`, url: `http://127.0.0.1:${E2E_PORT}/api/health`, reuseExistingServer: false, timeout: 120_000, env: e2eEnv, stdout: "ignore", stderr: "pipe" } : undefined,
});
