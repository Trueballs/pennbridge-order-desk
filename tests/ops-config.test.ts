import { describe, expect, it } from "vitest";
import { budgetRunId, listMigrations } from "../packages/db";
import { cookieSecure, validateEnv } from "../packages/db/env";

const good = { DATABASE_URL: "postgresql://pennbridge:Zk3-very-long-random-pass@db:5432/pennbridge" };
describe("environment validation", () => {
  it("accepts a strong production configuration", () => expect(() => validateEnv(good, "app")).not.toThrow());
  it("rejects missing, default and short database passwords outside demo mode", () => {
    expect(() => validateEnv({}, "app")).toThrow(/DATABASE_URL: required/);
    expect(() => validateEnv({ DATABASE_URL: "postgresql://pennbridge:pennbridge-local@db:5432/pennbridge" }, "app")).toThrow(/known default/);
    expect(() => validateEnv({ DATABASE_URL: "postgresql://u:short@db/x" }, "app")).toThrow(/shorter than 16/);
    expect(() => validateEnv({ DATABASE_URL: "postgresql://u@db/x" }, "app")).toThrow(/no password/);
  });
  it("lets demo mode keep the local default", () => expect(() => validateEnv({ DEMO_MODE: "true" }, "app")).not.toThrow());
  it("requires the full live-AI settings, and a key only in the worker", () => {
    const live = { ...good, LIVE_AI_ENABLED: "true" };
    expect(() => validateEnv(live, "app")).toThrow(/AI_PROVIDER[\s\S]*EXTRACTION_MODEL[\s\S]*AI_INPUT_USD_PER_MILLION/);
    const full = { ...live, AI_PROVIDER: "gemini", EXTRACTION_MODEL: "m", AI_INPUT_USD_PER_MILLION: "0.3", AI_OUTPUT_USD_PER_MILLION: "2.5", AI_PRICING_VERSION: "v1" };
    expect(() => validateEnv(full, "app")).not.toThrow();
    expect(() => validateEnv(full, "worker")).toThrow(/GEMINI_API_KEY/);
    expect(() => validateEnv({ ...full, GEMINI_API_KEY: "k" }, "worker")).not.toThrow();
    expect(() => validateEnv({ ...full, GEMINI_API_KEY_FILE: "/nonexistent/key" }, "worker")).toThrow(/not found/);
    expect(() => validateEnv({ ...full, AI_RUN_BUDGET_USD: "five" }, "app")).toThrow(/AI_RUN_BUDGET_USD/);
  });
  it("reports every problem at once", () => {
    try { validateEnv({ DATABASE_URL: "x", LIVE_AI_ENABLED: "true" }, "app"); expect.unreachable(); }
    catch (e) { expect((e as Error).message.split("\n - ").length).toBeGreaterThan(3); }
  });
});
describe("cookie security default", () => {
  it("is secure unless demo or explicitly disabled", () => {
    expect(cookieSecure({})).toBe(true);
    expect(cookieSecure({ DEMO_MODE: "true" })).toBe(false);
    expect(cookieSecure({ SESSION_COOKIE_SECURE: "false" })).toBe(false);
    expect(cookieSecure({ DEMO_MODE: "true", SESSION_COOKIE_SECURE: "true" })).toBe(true);
  });
});
describe("migration list and budget month", () => {
  it("sorts numerically, ignores other files and rejects duplicates", () => {
    expect(listMigrations(["010-b.sql", "README.md", "002-a.sql", "001-initial.sql"]).map((m) => m.version)).toEqual([1, 2, 10]);
    expect(() => listMigrations(["002-a.sql", "002-b.sql"])).toThrow(/Duplicate/);
  });
  it("names budget runs by London calendar month", () => {
    expect(budgetRunId(new Date("2026-10-28T12:00:00Z"))).toBe("month-2026-10");
    expect(budgetRunId(new Date("2026-10-31T23:30:00Z"))).toBe("month-2026-10"); // 23:30 GMT
    expect(budgetRunId(new Date("2026-05-31T23:30:00Z"))).toBe("month-2026-06"); // 00:30 BST on 1 June
  });
});
