import { Pool, type PoolClient } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { AuditEvent, Job, Session } from "@pennbridge/contracts";

import { validateEnv } from "./env";
export { validateEnv, cookieSecure, isDemo } from "./env";
export const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://pennbridge:pennbridge-local@127.0.0.1:5439/pennbridge", max: Number(process.env.DB_POOL_MAX ?? 10),
  connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, keepAlive: true, application_name: `pennbridge-${process.env.PB_ROLE ?? "app"}` });
// An idle client dropped by a database restart emits 'error'; without a listener Node would crash the process.
pool.on("error", (error) => console.error(JSON.stringify({ event: "db.pool_error", message: error.message })));
export type DbClient = Pick<PoolClient, "query">;
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const value = await fn(client); await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
export function migrationsDir(): string {
  const candidates = [process.env.MIGRATIONS_DIR, path.join(process.env.PROJECT_ROOT ?? process.cwd(), "packages/db/migrations")];
  const found = candidates.find((dir): dir is string => !!dir && existsSync(dir));
  if (!found) throw new Error("Database migrations directory not found (set MIGRATIONS_DIR)");
  return found;
}
/** Numbered `NNN-name.sql` files, sorted by number. Duplicate numbers are a packaging error, not something to guess about. */
export function listMigrations(files: string[]): { version: number; file: string }[] {
  const out = files.filter((f) => /^\d+-.+\.sql$/.test(f)).map((file) => ({ version: parseInt(file, 10), file })).sort((a, b) => a.version - b.version || a.file.localeCompare(b.file));
  for (let i = 1; i < out.length; i++) if (out[i].version === out[i - 1].version) throw new Error(`Duplicate migration number ${out[i].version}: ${out[i - 1].file} and ${out[i].file}`);
  return out;
}
/** Applies every unapplied numbered migration, each in its own transaction, under one advisory lock (web and worker race at startup). */
export async function migrate(dir: string = migrationsDir()): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(57282101)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version as number));
    for (const { version, file } of listMigrations(await readdir(dir))) {
      if (done.has(version)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING", [version]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw new Error(`Migration ${file} failed: ${(error as Error).message}`); }
      applied.push(file);
      console.log(JSON.stringify({ event: "db.migrated", file }));
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(57282101)").catch(() => undefined);
    client.release();
  }
  return applied;
}
export function id(prefix: string) { return `${prefix}_${randomUUID()}`; }
export function sha256(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
export async function audit(client: DbClient, orderId: string | null, actor: Pick<Session, "userId"> | string, action: string, version: number | null, detail: AuditEvent["detail"] = {}) {
  const event: AuditEvent = { id: id("audit"), orderId, actorId: typeof actor === "string" ? actor : actor.userId, action, version, at: new Date().toISOString(), detail };
  await client.query("INSERT INTO audit_events(id,order_id,data) VALUES($1,$2,$3)", [event.id, orderId, event]);
  return event;
}
export function jobFromRow(row: Record<string, any>): Job {
  const timestamp = (value: any) => value ? new Date(value).toISOString() : null;
  return { id: row.id, type: row.type, messageId: row.message_id, orderId: row.order_id, status: row.status,
    attempts: row.attempts, maxAttempts: row.max_attempts, availableAt: timestamp(row.available_at)!, leaseOwner: row.lease_owner,
    leaseExpiresAt: timestamp(row.lease_expires_at), errorCode: row.error_code, errorMessage: row.error_message,
    createdAt: timestamp(row.created_at)!, updatedAt: timestamp(row.updated_at)! };
}
export async function claimJob(owner: string, leaseSeconds = 120): Promise<Job | null> {
  const result = await pool.query(`WITH next AS (
    SELECT id FROM jobs WHERE (status IN ('queued','retry_wait') AND available_at<=now())
    OR (status='running' AND lease_expires_at<now()) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE jobs SET status='running',attempts=attempts+1,lease_owner=$1,
    lease_expires_at=now()+($2 * interval '1 second'),updated_at=now()
    WHERE id IN (SELECT id FROM next) AND attempts<max_attempts RETURNING *`, [owner, leaseSeconds]);
  // Exhausted expired leases must be visible as dead letters, not stuck forever.
  await pool.query("UPDATE jobs SET status='dead_letter',lease_owner=NULL,lease_expires_at=NULL,error_code=COALESCE(error_code,'PARSING_FAILED'),error_message=COALESCE(error_message,'Worker lease expired at retry limit'),updated_at=now() WHERE status='running' AND lease_expires_at<now() AND attempts>=max_attempts");
  return result.rows[0] ? jobFromRow(result.rows[0]) : null;
}
export async function heartbeatJob(jobId: string, owner: string, leaseSeconds = 120): Promise<boolean> {
  const result = await pool.query("UPDATE jobs SET lease_expires_at=now()+($3 * interval '1 second'),updated_at=now() WHERE id=$1 AND lease_owner=$2 AND status='running' AND lease_expires_at>now()", [jobId, owner, leaseSeconds]);
  return result.rowCount === 1;
}
export async function failJob(jobId: string, owner: string, code: string, message: string): Promise<void> {
  await pool.query(`UPDATE jobs SET status=CASE WHEN attempts>=max_attempts THEN 'dead_letter' ELSE 'retry_wait' END,
    available_at=now()+(LEAST(60,POWER(2,attempts)) * interval '1 second'),lease_owner=NULL,lease_expires_at=NULL,error_code=$3,error_message=$4,updated_at=now()
    WHERE id=$1 AND lease_owner=$2 AND status='running' AND lease_expires_at>now()`, [jobId,owner,code,message.slice(0,2000)]);
}
/** Budget runs are calendar months in Europe/London (`month-2026-10`), so the cap resets itself. */
export function budgetRunId(at: Date = new Date()): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit" }).formatToParts(at).map((x) => [x.type, x.value]));
  return `month-${p.year}-${p.month}`;
}
export async function reserveBudget(runId: string, orderId: string, maximumUsd: string, runCapUsd: string, perOrderCapUsd = "0.10"): Promise<string> {
  return transaction(async (client) => {
    // Monthly caps follow the current setting; fixed benchmark runs keep the cap they started with.
    await client.query(`INSERT INTO budget_runs(id,cap_usd) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET cap_usd=CASE WHEN budget_runs.id LIKE 'month-%' THEN EXCLUDED.cap_usd ELSE budget_runs.cap_usd END`, [runId,runCapUsd]);
    const run = (await client.query("SELECT * FROM budget_runs WHERE id=$1 FOR UPDATE", [runId])).rows[0];
    const extra = Number((await client.query("SELECT extra FROM budget_allowances WHERE order_id=$1", [orderId])).rows[0]?.extra ?? 0);
    // Released (timed-out) reservations no longer count as money. Only unsettled reservations (in flight or timed out) count against the attempt limit, so a reprocess after a finished extraction is allowed; the per-order USD cap bounds the total.
    const allowed = await client.query(`SELECT ($1::numeric>=0 AND $1::numeric<=$2::numeric AND $3::numeric+$4::numeric+$1::numeric<=$5::numeric AND
      (SELECT COALESCE(sum(COALESCE(actual_usd,amount_usd)),0) FROM budget_reservations WHERE run_id=$6 AND order_id=$7 AND state<>'released')+$1::numeric<=$2::numeric*(1+$8::int) AND
      (SELECT count(*) FROM budget_reservations WHERE run_id=$6 AND order_id=$7 AND state<>'settled')<2+$8::int) AS ok`,
      [maximumUsd,perOrderCapUsd,run.spent_usd,run.reserved_usd,run.cap_usd,runId,orderId,extra]);
    if (!allowed.rows[0].ok) throw Object.assign(new Error("Model budget would be exceeded"), { code: "BUDGET_EXCEEDED", status: 422 });
    const reservationId = id("budget");
    await client.query("INSERT INTO budget_reservations(id,run_id,order_id,amount_usd,state) VALUES($1,$2,$3,$4,'reserved')", [reservationId,runId,orderId,maximumUsd]);
    await client.query("UPDATE budget_runs SET reserved_usd=reserved_usd+$2 WHERE id=$1", [runId,maximumUsd]);
    return reservationId;
  });
}
export async function settleBudget(reservationId: string, actualUsd: string): Promise<void> {
  await transaction(async (client) => {
    const reservation = (await client.query("SELECT * FROM budget_reservations WHERE id=$1 FOR UPDATE", [reservationId])).rows[0];
    if (!reservation || reservation.state === "settled") return;
    const valid = (await client.query("SELECT ($1::numeric>=0 AND $1::numeric<=$2::numeric) AS ok", [actualUsd,reservation.amount_usd])).rows[0].ok;
    if (!valid) throw new Error("Actual model cost exceeds reserved ceiling");
    // A reservation released after its grace period was already freed from `reserved_usd`; a late settle only books the spend.
    const freed = reservation.state === "released" ? "0" : reservation.amount_usd;
    await client.query("UPDATE budget_runs SET reserved_usd=reserved_usd-$2,spent_usd=spent_usd+$3 WHERE id=$1", [reservation.run_id,freed,actualUsd]);
    await client.query("UPDATE budget_reservations SET state='settled',actual_usd=$2 WHERE id=$1", [reservationId,actualUsd]);
  });
}
/** Frees reservations whose call never settled (worker crash, unknown outcome) once the grace period has passed. Returns how many. */
export async function releaseStaleReservations(graceMinutes = 15): Promise<number> {
  return transaction(async (client) => {
    const stale = (await client.query("SELECT id,run_id,amount_usd FROM budget_reservations WHERE state='reserved' AND created_at<now()-($1 * interval '1 minute') ORDER BY id FOR UPDATE SKIP LOCKED", [graceMinutes])).rows;
    for (const r of stale) {
      await client.query("UPDATE budget_reservations SET state='released',released_at=now() WHERE id=$1", [r.id]);
      await client.query("UPDATE budget_runs SET reserved_usd=GREATEST(0,reserved_usd-$2) WHERE id=$1", [r.run_id,r.amount_usd]);
    }
    return stale.length;
  });
}
/** Admin action: lets one order run `extra` more model attempts (each with its own per-order cap). Audited. */
export async function grantReprocessAllowance(orderId: string, actor: Pick<Session, "userId"> | string, extra = 1): Promise<number> {
  if (!Number.isInteger(extra) || extra < 1 || extra > 5) throw Object.assign(new Error("Allowance must be 1 to 5 extra attempts"), { code: "VALIDATION_FAILED", status: 400 });
  return transaction(async (client) => {
    const found = await client.query("SELECT 1 FROM orders WHERE id=$1", [orderId]);
    if (!found.rowCount) throw Object.assign(new Error("Order not found"), { code: "NOT_FOUND", status: 404 });
    const userId = typeof actor === "string" ? actor : actor.userId;
    const total = (await client.query(`INSERT INTO budget_allowances(order_id,extra,granted_by) VALUES($1,$2,$3)
      ON CONFLICT(order_id) DO UPDATE SET extra=budget_allowances.extra+EXCLUDED.extra,granted_by=EXCLUDED.granted_by,updated_at=now() RETURNING extra`, [orderId,extra,userId])).rows[0].extra as number;
    await audit(client, orderId, actor, "budget.reprocess_allowance", null, { extra, total });
    return total;
  });
}

export const reserveModelBudget = reserveBudget;
/** Unknown outcomes retain their reservation; do not free money after a timeout/crash. */
export async function settleModelBudget(reservationId: string, actualUsd: string | null): Promise<void> {
  if (actualUsd === null) return;
  await settleBudget(reservationId, actualUsd);
}

export async function purgeExpiredSessions(): Promise<number> {
  return (await pool.query("DELETE FROM sessions WHERE expires_at<now()-interval '1 day'")).rowCount ?? 0;
}
/** Services call this on a timer; readiness() reads it. Names in use: `worker`, `mailbox_poll` (detail may carry `intervalSeconds`, `error`). */
export async function recordHeartbeat(name: string, detail: Record<string, unknown> = {}, at?: Date): Promise<void> {
  await pool.query("INSERT INTO service_heartbeats(name,beat_at,detail) VALUES($1,COALESCE($3::timestamptz,now()),$2) ON CONFLICT(name) DO UPDATE SET beat_at=EXCLUDED.beat_at,detail=EXCLUDED.detail", [name, JSON.stringify(detail), at ?? null]);
}
export type Readiness = { status: "ok" | "degraded" | "down"; problems: string[]; checkedAt: string; db: { ok: boolean; latencyMs: number | null; schemaVersion: number | null };
  jobs: { queued: number; oldestQueuedAgeSeconds: number | null; running: number; deadLetter: number };
  worker: { lastSeenAt: string | null; ageSeconds: number | null }; mailbox: { lastPollAt: string | null; ageSeconds: number | null; intervalSeconds: number | null; lastError: string | null } };
export async function readiness(thresholds = { queueAgeSeconds: 300, workerSeconds: 120 }): Promise<Readiness> {
  const out: Readiness = { status: "ok", problems: [], checkedAt: new Date().toISOString(), db: { ok: false, latencyMs: null, schemaVersion: null },
    jobs: { queued: 0, oldestQueuedAgeSeconds: null, running: 0, deadLetter: 0 }, worker: { lastSeenAt: null, ageSeconds: null }, mailbox: { lastPollAt: null, ageSeconds: null, intervalSeconds: null, lastError: null } };
  const started = Date.now();
  try {
    const version = await pool.query("SELECT max(version) AS v FROM schema_migrations");
    out.db = { ok: true, latencyMs: Date.now() - started, schemaVersion: version.rows[0].v };
    const jobs = (await pool.query(`SELECT count(*) FILTER (WHERE status IN ('queued','retry_wait'))::int AS queued,
      extract(epoch FROM now()-min(available_at) FILTER (WHERE status IN ('queued','retry_wait') AND available_at<=now()))::int AS oldest,
      count(*) FILTER (WHERE status='running')::int AS running, count(*) FILTER (WHERE status='dead_letter')::int AS dead FROM jobs`)).rows[0];
    out.jobs = { queued: jobs.queued, oldestQueuedAgeSeconds: jobs.oldest, running: jobs.running, deadLetter: jobs.dead };
    const beats = (await pool.query("SELECT name,detail,extract(epoch FROM now()-beat_at)::int AS age,beat_at FROM service_heartbeats")).rows;
    const worker = beats.find((b) => b.name === "worker"); const mailbox = beats.find((b) => b.name === "mailbox_poll");
    if (worker) out.worker = { lastSeenAt: new Date(worker.beat_at).toISOString(), ageSeconds: worker.age };
    if (mailbox) out.mailbox = { lastPollAt: new Date(mailbox.beat_at).toISOString(), ageSeconds: mailbox.age, intervalSeconds: mailbox.detail?.intervalSeconds ?? null, lastError: mailbox.detail?.error ?? null };
    if (!worker) out.problems.push("WORKER_NO_HEARTBEAT"); else if (worker.age > thresholds.workerSeconds) out.problems.push("WORKER_STALE");
    if ((out.jobs.oldestQueuedAgeSeconds ?? 0) > thresholds.queueAgeSeconds) out.problems.push("QUEUE_BACKLOG");
    if (out.jobs.deadLetter > 0) out.problems.push("DEAD_LETTER_JOBS");
    if (mailbox) {
      if (mailbox.age > Math.max(600, 3 * Number(out.mailbox.intervalSeconds ?? 60))) out.problems.push("MAILBOX_STALE");
      if (out.mailbox.lastError) out.problems.push("MAILBOX_ERROR");
    }
    out.status = out.problems.length ? "degraded" : "ok";
  } catch (error) {
    out.status = "down"; out.problems.push("DATABASE_UNREACHABLE");
    console.error(JSON.stringify({ event: "readiness.db_error", message: (error as Error).message }));
  }
  return out;
}
/** Housekeeping run by the worker: session purge and stale-budget release. */
export async function runMaintenance(graceMinutes = Number(process.env.BUDGET_RELEASE_GRACE_MINUTES ?? 15)) {
  return { sessionsPurged: await purgeExpiredSessions(), reservationsReleased: await releaseStaleReservations(graceMinutes) };
}
