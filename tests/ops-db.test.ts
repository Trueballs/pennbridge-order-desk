import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantReprocessAllowance, migrate, migrationsDir, pool, purgeExpiredSessions, readiness, recordHeartbeat, releaseStaleReservations, reserveBudget, settleBudget, runMaintenance } from "../packages/db";

const enabled = process.env.OPS_DB_TEST === "true";
const suite = enabled ? describe : describe.skip;
async function order(idv: string) {
  await pool.query("INSERT INTO messages(id,transport_key,content_hash,data,intake) VALUES($1,$1,'h','{}','{}')", [`m-${idv}`]);
  await pool.query("INSERT INTO orders(id,message_id,status,version,content_hash,data,created_at,updated_at) VALUES($1,$2,'needs_review',1,'h','{}',now(),now())", [idv, `m-${idv}`]);
}
suite("operations (real PostgreSQL)", () => {
  beforeAll(() => { if (!/test/i.test(new URL(process.env.DATABASE_URL!).pathname)) throw new Error("OPS_DB_TEST requires an isolated database whose name contains test"); });
  afterAll(async () => { await pool.end(); });

  it("applies numbered migrations once, in order, and rolls a failing one back", async () => {
    expect(await migrate()).toEqual(expect.arrayContaining(["001-initial.sql", "002-ops.sql"]));
    expect(await migrate()).toEqual([]);
    const dir = await mkdtemp(path.join(os.tmpdir(), "mig-"));
    try {
      for (const f of ["001-initial.sql", "002-ops.sql"]) await writeFile(path.join(dir, f), "SELECT 1;");
      await writeFile(path.join(dir, "090-extra.sql"), "CREATE TABLE ops_extra(x int);");
      expect(await migrate(dir)).toEqual(["090-extra.sql"]);
      await writeFile(path.join(dir, "091-bad.sql"), "CREATE TABLE ops_half(x int); SELECT nope FROM nowhere;");
      await expect(migrate(dir)).rejects.toThrow(/091-bad.sql/);
      expect((await pool.query("SELECT to_regclass('ops_half') AS t")).rows[0].t).toBeNull();
      expect((await pool.query("SELECT 1 FROM schema_migrations WHERE version=91")).rowCount).toBe(0);
      await writeFile(path.join(dir, "091-bad.sql"), "CREATE TABLE ops_half(x int);");
      expect(await migrate(dir)).toEqual(["091-bad.sql"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
    expect(migrationsDir()).toContain("migrations");
  });

  it("concurrent starters apply each migration exactly once", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mig-"));
    try {
      for (const f of ["001-initial.sql", "002-ops.sql", "090-extra.sql", "091-bad.sql"]) await writeFile(path.join(dir, f), "SELECT 1;");
      await writeFile(path.join(dir, "095-race.sql"), "CREATE TABLE ops_race(x int);");
      const results = await Promise.all([migrate(dir), migrate(dir), migrate(dir)]);
      expect(results.flat()).toEqual(["095-race.sql"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("releases a timed-out reservation after the grace period and frees the monthly cap", async () => {
    await order("O-rel");
    const r = await reserveBudget("month-2026-10", "O-rel", "0.08", "0.10", "0.10");
    expect(await releaseStaleReservations(15)).toBe(0);
    await expect(reserveBudget("month-2026-10", "O-other", "0.08", "0.10", "0.10")).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    await pool.query("UPDATE budget_reservations SET created_at=now()-interval '20 minutes' WHERE id=$1", [r]);
    expect(await releaseStaleReservations(15)).toBe(1);
    expect((await pool.query("SELECT reserved_usd FROM budget_runs WHERE id='month-2026-10'")).rows[0].reserved_usd).toBe("0.000000");
    await reserveBudget("month-2026-10", "O-other", "0.08", "0.10", "0.10");
    // The call that "timed out" did finish: its cost is booked, nothing is freed twice.
    await settleBudget(r, "0.05");
    const run = (await pool.query("SELECT spent_usd,reserved_usd FROM budget_runs WHERE id='month-2026-10'")).rows[0];
    expect([run.spent_usd, run.reserved_usd]).toEqual(["0.050000", "0.080000"]);
  });

  it("a new calendar month starts with an empty budget, and the cap follows the setting", async () => {
    await reserveBudget("month-2026-11", "O-nov", "0.09", "0.10", "0.10");
    await expect(reserveBudget("month-2026-11", "O-nov2", "0.05", "0.10", "0.10")).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    await reserveBudget("month-2026-11", "O-nov2", "0.05", "5.00", "0.10");
    expect((await pool.query("SELECT cap_usd FROM budget_runs WHERE id='month-2026-11'")).rows[0].cap_usd).toBe("5.000000");
    await pool.query("INSERT INTO budget_runs(id,cap_usd) VALUES('bench-1',1)");
    await reserveBudget("bench-1", "O-b", "0.01", "9.00", "0.10");
    expect((await pool.query("SELECT cap_usd FROM budget_runs WHERE id='bench-1'")).rows[0].cap_usd).toBe("1.000000");
  });

  it("an admin allowance lets one order exceed the two-attempt limit, and is audited", async () => {
    await order("O-allow");
    const run = "month-2027-01";
    await reserveBudget(run, "O-allow", "0.01", "5", "0.10");
    await reserveBudget(run, "O-allow", "0.01", "5", "0.10");
    await expect(reserveBudget(run, "O-allow", "0.01", "5", "0.10")).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(await grantReprocessAllowance("O-allow", "admin", 1)).toBe(1);
    await reserveBudget(run, "O-allow", "0.01", "5", "0.10");
    await expect(reserveBudget(run, "O-allow", "0.01", "5", "0.10")).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect((await pool.query("SELECT data FROM audit_events WHERE order_id='O-allow' AND data->>'action'='budget.reprocess_allowance'")).rowCount).toBe(1);
    await expect(grantReprocessAllowance("missing", "admin")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(grantReprocessAllowance("O-allow", "admin", 99)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("reprocess: a settled extraction does not block the next one, until the per-order cap", async () => {
    await order("O-re");
    const run = "month-2027-02";
    for (let i = 0; i < 3; i++) await settleBudget(await reserveBudget(run, "O-re", "0.02", "5", "0.10"), "0.01");
    await settleBudget(await reserveBudget(run, "O-re", "0.02", "5", "0.10"), "0.02");
    await expect(reserveBudget(run, "O-re", "0.06", "5", "0.10")).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("purges long-expired sessions only", async () => {
    await pool.query("INSERT INTO users(id,email,name,role,password_hash) VALUES('u1','u1@x.test','U','viewer','x') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('old','u1',now()-interval '3 days'),('recent','u1',now()-interval '1 hour'),('live','u1',now()+interval '1 hour')");
    expect(await purgeExpiredSessions()).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM sessions")).rows[0].n).toBe(2);
    expect((await runMaintenance()).sessionsPurged).toBe(0);
  });

  it("readiness reports worker, queue, dead letters and mailbox", async () => {
    let r = await readiness();
    expect(r.db.ok).toBe(true);
    expect(r.db.schemaVersion).toBeGreaterThanOrEqual(2);
    expect(r.problems).toContain("WORKER_NO_HEARTBEAT");
    await recordHeartbeat("worker", { owner: "t" });
    expect((await readiness()).problems).not.toContain("WORKER_NO_HEARTBEAT");
    await pool.query("INSERT INTO jobs(id,type,message_id,order_id,status,available_at) VALUES('j1','process_message','m-O-rel','O-rel','queued',now()-interval '10 minutes')");
    r = await readiness();
    expect(r.jobs.queued).toBe(1);
    expect(r.jobs.oldestQueuedAgeSeconds).toBeGreaterThanOrEqual(599);
    expect(r.problems).toContain("QUEUE_BACKLOG");
    await pool.query("UPDATE jobs SET status='dead_letter' WHERE id='j1'");
    expect((await readiness()).problems).toContain("DEAD_LETTER_JOBS");
    await pool.query("UPDATE service_heartbeats SET beat_at=now()-interval '10 minutes' WHERE name='worker'");
    expect((await readiness()).problems).toContain("WORKER_STALE");
    await recordHeartbeat("mailbox_poll", { intervalSeconds: 60, error: "auth_failed" });
    r = await readiness();
    expect(r.mailbox.lastError).toBe("auth_failed");
    expect(r.problems).toContain("MAILBOX_ERROR");
    expect(r.status).toBe("degraded");
  });
});
