import { existsSync } from "node:fs";
import { z } from "zod";

type Env = Record<string, string | undefined>;
/** DEMO_MODE=true keeps the synthetic seed, demo users, /api/demo, Mailpit and the mock provider. */
export const isDemo = (env: Env = process.env) => env.DEMO_MODE === "true";
/** Secure cookies by default; only an explicit SESSION_COOKIE_SECURE=false (or demo mode) turns them off. */
export function cookieSecure(env: Env = process.env): boolean {
  if (env.SESSION_COOKIE_SECURE === "true") return true;
  if (env.SESSION_COOKIE_SECURE === "false") return false;
  return !isDemo(env);
}
const WEAK = new Set(["pennbridge-local", "password", "postgres", "changeme", "secret", "admin"]);
const positive = z.string().regex(/^\d+(\.\d+)?$/, "must be a non-negative number");
const schema = z.object({
  DATABASE_URL: z.string().optional(),
  LIVE_AI_ENABLED: z.enum(["true", "false"]).optional(),
  AI_PROVIDER: z.enum(["gemini", "anthropic"]).optional(),
  EXTRACTION_MODEL: z.string().min(1).optional(),
  AI_INPUT_USD_PER_MILLION: positive.optional(),
  AI_OUTPUT_USD_PER_MILLION: positive.optional(),
  AI_PRICING_VERSION: z.string().min(1).optional(),
  AI_RUN_BUDGET_USD: positive.optional(),
  AI_ORDER_BUDGET_USD: positive.optional(),
  SESSION_COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  ODOO_URL: z.string().url().regex(/^https?:\/\//, "must be http(s)").optional(),
  ODOO_DB: z.string().min(1).optional(),
  ODOO_USER: z.string().min(1).optional(),
  ODOO_API_KEY_FILE: z.string().min(1).optional(),
});
export type Role = "app" | "worker";
/** Throws one Error listing every problem so an operator can fix the .env in a single pass. */
export function validateEnv(env: Env = process.env, role: Role = (env.PB_ROLE === "worker" ? "worker" : "app")): void {
  const problems: string[] = [];
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== "")));
  if (!parsed.success) for (const issue of parsed.error.issues) problems.push(`${issue.path.join(".")}: ${issue.message}`);
  const demo = isDemo(env);
  if (!demo) {
    if (!env.DATABASE_URL) problems.push("DATABASE_URL: required outside DEMO_MODE");
    else {
      try {
        const url = new URL(env.DATABASE_URL);
        const password = decodeURIComponent(url.password);
        if (!/^postgres(ql)?:$/.test(url.protocol)) problems.push("DATABASE_URL: must be a postgresql:// URL");
        if (!password) problems.push("DATABASE_URL: no password set");
        else if (WEAK.has(password.toLowerCase()) || password.length < 16) problems.push("DATABASE_URL: database password is a known default or shorter than 16 characters");
      } catch { problems.push("DATABASE_URL: not a valid URL"); }
    }
  }
  if (env.LIVE_AI_ENABLED === "true") {
    if (!env.AI_PROVIDER) problems.push("AI_PROVIDER: required when LIVE_AI_ENABLED=true (gemini or anthropic)");
    if (!env.EXTRACTION_MODEL) problems.push("EXTRACTION_MODEL: required when LIVE_AI_ENABLED=true");
    for (const k of ["AI_INPUT_USD_PER_MILLION", "AI_OUTPUT_USD_PER_MILLION", "AI_PRICING_VERSION"]) if (!env[k]) problems.push(`${k}: required when LIVE_AI_ENABLED=true`);
    if (role === "worker") {
      const prefix = env.AI_PROVIDER === "anthropic" ? "ANTHROPIC" : "GEMINI";
      const file = env[`${prefix}_API_KEY_FILE`];
      if (!env[`${prefix}_API_KEY`] && !(file && existsSync(file))) problems.push(`${prefix}_API_KEY or ${prefix}_API_KEY_FILE: live AI needs a key in the worker${file ? ` (file ${file} not found)` : ""}`);
    }
  }
  // Optional direct Odoo push: all four settings or none. The API key is read from a secret file, never from the environment.
  if (["ODOO_URL", "ODOO_DB", "ODOO_USER", "ODOO_API_KEY_FILE"].some((k) => env[k])) {
    // Only the worker holds the key; the app receives the non-secret settings to show the button.
    for (const k of role === "worker" ? ["ODOO_URL", "ODOO_DB", "ODOO_USER", "ODOO_API_KEY_FILE"] : ["ODOO_URL", "ODOO_DB", "ODOO_USER"]) if (!env[k]) problems.push(`${k}: required when any ODOO_* push setting is set`);
    if (role === "worker" && env.ODOO_API_KEY_FILE && !existsSync(env.ODOO_API_KEY_FILE)) problems.push(`ODOO_API_KEY_FILE: file ${env.ODOO_API_KEY_FILE} not found`);
  }
  if (problems.length) throw new Error(`Invalid configuration:\n - ${problems.join("\n - ")}`);
  if (!demo && !cookieSecure(env)) console.warn(JSON.stringify({ event: "config.warning", message: "SESSION_COOKIE_SECURE=false in production: session cookies will travel over plain HTTP" }));
}
