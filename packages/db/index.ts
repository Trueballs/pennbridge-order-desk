import { Pool, type PoolClient } from "pg";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import type { AuditEvent, Job, Session } from "@pennbridge/contracts";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://pennbridge:pennbridge-local@127.0.0.1:5439/pennbridge", max: 10 });
export type DbClient = Pick<PoolClient, "query">;
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const value = await fn(client); await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
export async function migrate(): Promise<void> {
  // One transactional advisory lock prevents startup races across web and worker.
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(57282101)");
    await client.query(await readFile(fileURLToPath(new URL("./001-initial.sql", import.meta.url)), "utf8"));
  });
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
export async function reserveBudget(runId: string, orderId: string, maximumUsd: string, runCapUsd: string, perOrderCapUsd = "0.10"): Promise<string> {
  return transaction(async (client) => {
    await client.query("INSERT INTO budget_runs(id,cap_usd) VALUES($1,$2) ON CONFLICT DO NOTHING", [runId,runCapUsd]);
    const run = (await client.query("SELECT * FROM budget_runs WHERE id=$1 FOR UPDATE", [runId])).rows[0];
    const allowed = await client.query(`SELECT ($1::numeric>=0 AND $1::numeric<=$2::numeric AND $3::numeric+$4::numeric+$1::numeric<=$5::numeric AND
      (SELECT COALESCE(sum(COALESCE(actual_usd,amount_usd)),0) FROM budget_reservations WHERE run_id=$6 AND order_id=$7)+$1::numeric<=$2::numeric AND
      (SELECT count(*) FROM budget_reservations WHERE run_id=$6 AND order_id=$7)<2) AS ok`,
      [maximumUsd,perOrderCapUsd,run.spent_usd,run.reserved_usd,run.cap_usd,runId,orderId]);
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
    await client.query("UPDATE budget_runs SET reserved_usd=reserved_usd-$2,spent_usd=spent_usd+$3 WHERE id=$1", [reservation.run_id,reservation.amount_usd,actualUsd]);
    await client.query("UPDATE budget_reservations SET state='settled',actual_usd=$2 WHERE id=$1", [reservationId,actualUsd]);
  });
}

export const reserveModelBudget = reserveBudget;
/** Unknown outcomes retain their reservation; do not free money after a timeout/crash. */
export async function settleModelBudget(reservationId: string, actualUsd: string | null): Promise<void> {
  if (actualUsd === null) return;
  await settleBudget(reservationId, actualUsd);
}
