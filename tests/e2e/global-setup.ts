import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";

/** Starts the order-processing worker for the throwaway E2E database; returns the teardown. */
export default async function globalSetup() {
  if (!process.env.E2E_DATABASE_URL) throw new Error("Set E2E_DATABASE_URL to a throwaway database (name contains e2e or test). See playwright.config.ts.");
  mkdirSync("runtime", { recursive: true });
  const env = { ...process.env, DATABASE_URL: process.env.E2E_DATABASE_URL, DEMO_MODE: "true", LIVE_AI_ENABLED: "false", STORAGE_ROOT: "runtime/e2e-storage", PROJECT_ROOT: process.cwd(), WORKER_ALIVE_FILE: "runtime/e2e-worker.alive" };
  const worker: ChildProcess = spawn("npx", ["tsx", "apps/worker/index.ts"], { env, stdio: ["ignore", "ignore", "inherit"] });
  return async () => { worker.kill("SIGTERM"); };
}
