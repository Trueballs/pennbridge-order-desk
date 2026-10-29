import { readFileSync } from "node:fs";
import Decimal from "decimal.js";
import type { ExportSnapshot, Job, Session } from "@pennbridge/contracts";
import { audit, failJob, id, pool, transaction } from "@pennbridge/db";
import { ServiceError } from "@pennbridge/domain";

/**
 * Direct push of an approved export into Odoo as a DRAFT quotation over external JSON-RPC (/jsonrpc).
 * Network I/O happens only in the worker (job type 'odoo_push'); the app container stays offline.
 * References are resolved by the SAME external IDs the CSV uses (ir.model.data). The quotation is created with an external id
 * `pennbridge.quote_<order>_v<version>` plus origin `pennbridge:<that name>`, so a retry (or a crash between create and
 * bookkeeping) adopts the existing record instead of duplicating it. The order is never confirmed.
 */
export interface OdooConfig { url: string; db: string; user: string; apiKey: string }
export type OdooErrorKind = "config" | "auth" | "permission" | "missing_reference" | "rejected" | "transient";
/** `message` is safe to show users; `detail` is for the log only. Transient errors retry, everything else is permanent. */
export class OdooPushError extends Error {
  constructor(public kind: OdooErrorKind, message: string, public detail = "") { super(message); this.name = "OdooPushError"; }
  get retryable() { return this.kind === "transient"; }
}
type Env = Record<string, string | undefined>;
export const odooPushConfigured = (env: Env = process.env) => !!env.ODOO_URL;
/** The API key is read from ODOO_API_KEY_FILE on every push (never from env/argv/logs, never cached). */
export function odooConfigFromEnv(env: Env = process.env): OdooConfig {
  const { ODOO_URL: url, ODOO_DB: db, ODOO_USER: user, ODOO_API_KEY_FILE: file } = env;
  if (!url || !db || !user || !file) throw new OdooPushError("config", "Direct push to Odoo is not configured on the server.");
  let apiKey: string;
  try { apiKey = readFileSync(file, "utf8").trim(); } catch { throw new OdooPushError("config", "The Odoo API key file is missing; ask an administrator to check the server configuration."); }
  if (!apiKey) throw new OdooPushError("config", "The Odoo API key file is empty; ask an administrator to check the server configuration.");
  return { url: url.replace(/\/+$/, ""), db, user, apiKey };
}
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;
export interface PushOptions { fetch?: FetchLike; timeoutMs?: number }
export type PushInput = Pick<ExportSnapshot, "orderId" | "orderVersion" | "externalId" | "customerExternalId" | "shippingAddressExternalId" | "poNumber" | "currency" | "lines" | "total">;
export interface PushResult { id: number; name: string; state: string; created: boolean; amountUntaxed: string | null; totalMatches: boolean | null }

const NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT"]);
class Rpc {
  private n = 0;
  constructor(private cfg: OdooConfig, private opts: PushOptions) {}
  async call(service: string, method: string, args: unknown[]): Promise<any> {
    const doFetch = this.opts.fetch ?? (fetch as unknown as FetchLike);
    let response;
    try {
      response = await doFetch(`${this.cfg.url}/jsonrpc`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: ++this.n }), signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20000) });
    } catch (error) {
      const e = error as { name?: string; code?: string; cause?: { code?: string } };
      const code = e.code ?? e.cause?.code;
      if (e.name === "TimeoutError" || e.name === "AbortError" || (code && NETWORK_CODES.has(code)) || e instanceof TypeError) throw new OdooPushError("transient", "Odoo could not be reached; the push will be retried automatically.", `${e.name ?? ""} ${code ?? ""}`);
      throw new OdooPushError("transient", "Odoo could not be reached; the push will be retried automatically.", String(error));
    }
    if (response.status >= 500 || response.status === 429 || response.status === 408) throw new OdooPushError("transient", "Odoo is temporarily unavailable; the push will be retried automatically.", `HTTP ${response.status}`);
    const text = await response.text();
    let body: any;
    try { body = JSON.parse(text); } catch { throw new OdooPushError("config", "The configured address did not answer like Odoo; ask an administrator to check ODOO_URL.", `HTTP ${response.status} non-JSON`); }
    if (body?.error) throw classifyRpcError(body.error);
    if (!response.ok) throw new OdooPushError("rejected", "Odoo rejected the request.", `HTTP ${response.status}`);
    return body?.result;
  }
  execute(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}, uid = this.uid) {
    return this.call("object", "execute_kw", [this.cfg.db, uid, this.cfg.apiKey, model, method, args, kwargs]);
  }
  uid = 0;
}
function classifyRpcError(error: any): OdooPushError {
  const name = String(error?.data?.name ?? ""), message = String(error?.data?.message ?? error?.message ?? "");
  const detail = `${name}: ${message}`.slice(0, 300);
  if (/AccessDenied/.test(name)) return new OdooPushError("auth", "Odoo refused the configured login or API key; ask an administrator to check the Odoo credentials.", detail);
  if (/AccessError/.test(name)) return new OdooPushError("permission", "The Odoo user is not allowed to create quotations or read the master data; ask an administrator to check its permissions.", detail);
  if (/MissingError|ValidationError|UserError|IntegrityError/.test(name)) return new OdooPushError("rejected", "Odoo rejected the quotation; check the customer, products and units in Odoo.", detail);
  if (/database .* does not exist|KeyError.*db/i.test(message)) return new OdooPushError("config", "The configured Odoo database was not found; ask an administrator to check ODOO_DB.", detail);
  // Serialization failures, lost DB connections, worker restarts: Odoo-side and usually short-lived.
  return new OdooPushError("transient", "Odoo reported a temporary error; the push will be retried automatically.", detail);
}

const quoteName = (p: PushInput) => `quote_${p.orderId.replace(/[^a-zA-Z0-9_]/g, "_")}_v${p.orderVersion}`;
/** Pure and exported for tests: the external id under which the pushed quotation is registered in Odoo. */
export const pushExternalId = (p: Pick<PushInput, "orderId" | "orderVersion">) => `pennbridge.${quoteName(p as PushInput)}`;
const split = (xmlid: string) => { const i = xmlid.indexOf("."); return i < 1 ? null : { module: xmlid.slice(0, i), name: xmlid.slice(i + 1) }; };

/** ir.model.data rows for external ids. `complete_name` is not searchable in Odoo 19, so query module/name and match the pairs here. */
async function lookupXmlids(rpc: Rpc, xmlids: string[]): Promise<Map<string, { model: string; res_id: number }>> {
  const pairs = xmlids.map((x) => ({ x, ...split(x)! })).filter((p) => p.module);
  if (!pairs.length) return new Map();
  const rows: { module: string; name: string; model: string; res_id: number }[] = await rpc.execute("ir.model.data", "search_read",
    [[["module", "in", [...new Set(pairs.map((p) => p.module))]], ["name", "in", [...new Set(pairs.map((p) => p.name))]]]], { fields: ["module", "name", "model", "res_id"] });
  return new Map(rows.map((r) => [`${r.module}.${r.name}`, { model: r.model, res_id: r.res_id }]));
}
/** Resolves external ids to database ids, checking the model each one points to. */
async function resolve(rpc: Rpc, wanted: Record<string, string>): Promise<Record<string, number>> {
  const ids = [...new Set(Object.keys(wanted))], found = await lookupXmlids(rpc, ids);
  const missing = ids.filter((x) => found.get(x)?.model !== wanted[x]);
  if (missing.length) throw new OdooPushError("missing_reference", `Odoo does not know ${missing.length} item(s) referenced by this export (first: ${missing[0]}). Load the master data into Odoo, then push again.`, missing.join(","));
  return Object.fromEntries(ids.map((x) => [x, found.get(x)!.res_id]));
}

/** Idempotent: a second call for the same order version returns the same quotation without creating another. */
export async function pushQuotation(cfg: OdooConfig, input: PushInput, unitMapping: Partial<Record<string, string>>, opts: PushOptions = {}): Promise<PushResult> {
  const rpc = new Rpc(cfg, opts);
  const uid = await rpc.call("common", "authenticate", [cfg.db, cfg.user, cfg.apiKey, {}]);
  if (!uid) throw new OdooPushError("auth", "Odoo refused the configured login or API key; ask an administrator to check the Odoo credentials.", "authenticate returned false");
  rpc.uid = uid;
  const xmlid = pushExternalId(input), marker = `pennbridge:${quoteName(input)}`;
  const units = new Map<string, string>();
  for (const line of input.lines) { const u = unitMapping[line.unit]; if (!u) throw new OdooPushError("rejected", `No Odoo unit mapping is configured for "${line.unit}".`, line.unit); units.set(line.unit, u); }

  const existing: number | null = await findExisting(rpc, input, xmlid, marker);
  let quotationId: number = existing ?? 0, created = false;
  if (!quotationId) {
    const wanted: Record<string, string> = { [input.customerExternalId]: "res.partner", [input.shippingAddressExternalId]: "res.partner", [`base.${input.currency}`]: "res.currency" };
    for (const line of input.lines) wanted[line.productExternalId] = "product.product";
    for (const u of units.values()) wanted[u] = "uom.uom";
    const ref = await resolve(rpc, wanted);
    const vals = { partner_id: ref[input.customerExternalId], partner_shipping_id: ref[input.shippingAddressExternalId], client_order_ref: input.poNumber, currency_id: ref[`base.${input.currency}`], origin: marker,
      order_line: input.lines.map((l) => [0, 0, { product_id: ref[l.productExternalId], name: l.description, product_uom_qty: Number(l.quantity), product_uom_id: ref[units.get(l.unit)!], price_unit: Number(l.unitPrice) }]) };
    const made = await rpc.execute("sale.order", "create", [vals]);
    quotationId = Array.isArray(made) ? made[0] : made; created = true;
  }
  const split_ = split(xmlid)!;
  const registered: any[] = await rpc.execute("ir.model.data", "search_read", [[["module", "=", split_.module], ["name", "=", split_.name]]], { fields: ["id"], limit: 1 });
  if (!registered.length) {
    // Best effort: the origin marker already guarantees idempotency, the external id is for people and imports.
    await rpc.execute("ir.model.data", "create", [{ module: split_.module, name: split_.name, model: "sale.order", res_id: quotationId, noupdate: true }]).catch((error) => { if (!(error instanceof OdooPushError) || error.retryable) throw error; });
  }
  const [row] = await rpc.execute("sale.order", "read", [[quotationId]], { fields: ["name", "state", "amount_untaxed"] });
  if (!row) throw new OdooPushError("transient", "The quotation could not be read back from Odoo; the push will be retried.", `read ${quotationId} empty`);
  const untaxed = row.amount_untaxed === undefined || row.amount_untaxed === null ? null : new Decimal(String(row.amount_untaxed)).toFixed(2);
  return { id: quotationId, name: row.name, state: row.state, created, amountUntaxed: untaxed, totalMatches: untaxed === null ? null : new Decimal(untaxed).eq(new Decimal(input.total)) };
}
/** Looks for an earlier push (this version's external id), a CSV import of the same export (its external id), then the origin marker. */
async function findExisting(rpc: Rpc, input: PushInput, xmlid: string, marker: string): Promise<number | null> {
  const found = await lookupXmlids(rpc, [xmlid, input.externalId]);
  for (const wanted of [xmlid, input.externalId]) {
    const hit = found.get(wanted);
    if (hit?.model === "sale.order") { const alive: any[] = await rpc.execute("sale.order", "search", [[["id", "=", hit.res_id]]], { limit: 1 }); if (alive.length) return hit.res_id; }
  }
  const byOrigin: number[] = await rpc.execute("sale.order", "search", [[["origin", "=", marker]]], { limit: 1, order: "id" });
  return byOrigin[0] ?? null;
}
export const quotationUrl = (cfg: Pick<OdooConfig, "url">, quotationId: number) => `${cfg.url}/odoo/action-sale.action_quotations_with_onboarding/${quotationId}`;

// ---- Export state machine + job glue (DB only; no network here except through pushQuotation) ----------------------------------
// prepared|downloaded --push-odoo--> push_queued --worker--> pushed (terminal, counts as verified: quotationReference = Odoo name)
//                                       |-- permanent failure / retries exhausted --> back to prepared|downloaded with pushState 'failed' + pushError
const MAX_ATTEMPTS = 5;
const restState = (s: ExportSnapshot): ExportSnapshot["state"] => (s.downloadedAt ? "downloaded" : "prepared");
function mutateRole(actor: Session | null) {
  if (!actor) throw new ServiceError("FORBIDDEN", "Login required", 401);
  if (!["reviewer", "admin"].includes(actor.role)) throw new ServiceError("FORBIDDEN", "This action is not permitted for your role", 403);
}
export async function queueOdooPush(actor: Session | null, orderId: string, exportId: string, env: Env = process.env): Promise<ExportSnapshot> {
  mutateRole(actor);
  if (!odooPushConfigured(env)) throw new ServiceError("VALIDATION_FAILED", "Direct push to Odoo is not enabled on this installation; download the CSV instead.", 409);
  return transaction(async (client) => {
    const row = (await client.query("SELECT data FROM exports WHERE id=$1 AND order_id=$2 FOR UPDATE", [exportId, orderId])).rows[0];
    if (!row) throw new ServiceError("NOT_FOUND", "Export not found", 404);
    const current: ExportSnapshot = row.data;
    if (current.state === "push_queued" || current.state === "pushed") return current; // idempotent replay
    if (current.state === "voided") throw new ServiceError("VALIDATION_FAILED", "This export was voided", 409);
    if (current.state === "import_verified") throw new ServiceError("VALIDATION_FAILED", "This export was already verified as imported", 409);
    const now = new Date().toISOString();
    const snapshot: ExportSnapshot = { ...current, state: "push_queued", pushState: "queued", pushError: null, pushRequestedBy: actor!.userId, pushRequestedAt: now };
    await client.query("INSERT INTO jobs(id,type,order_id,export_id,status,max_attempts) VALUES($1,'odoo_push',$2,$3,'queued',$4)", [id("job"), orderId, exportId, MAX_ATTEMPTS]);
    await client.query("UPDATE exports SET data=$2 WHERE id=$1", [exportId, snapshot]);
    await audit(client, orderId, actor!, "export.push_queued", snapshot.orderVersion, { exportId });
    return snapshot;
  });
}
/** Worker: runs one odoo_push job. Throws on failure; the worker then calls odooPushFailed. */
export async function runOdooPush(job: Job, owner: string, unitMapping: Partial<Record<string, string>>, opts: PushOptions = {}, env: Env = process.env): Promise<void> {
  const exportId = (await pool.query("SELECT export_id FROM jobs WHERE id=$1", [job.id])).rows[0]?.export_id as string | undefined;
  const row = exportId ? (await pool.query("SELECT data FROM exports WHERE id=$1", [exportId])).rows[0] : null;
  if (!row || !job.orderId) throw new OdooPushError("rejected", "The export for this push no longer exists.");
  const snapshot: ExportSnapshot = row.data;
  if (snapshot.state !== "push_queued") { // already pushed by an earlier attempt, or voided meanwhile: nothing to do
    await pool.query("UPDATE jobs SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,error_message=NULL,updated_at=now() WHERE id=$1 AND lease_owner=$2", [job.id, owner]);
    return;
  }
  const cfg = odooConfigFromEnv(env);
  const result = await pushQuotation(cfg, snapshot, unitMapping, opts);
  await transaction(async (client) => {
    const lease = (await client.query("SELECT 1 FROM jobs WHERE id=$1 AND lease_owner=$2 AND status='running' FOR UPDATE", [job.id, owner])).rowCount;
    const current: ExportSnapshot = (await client.query("SELECT data FROM exports WHERE id=$1 FOR UPDATE", [exportId])).rows[0].data;
    // The Odoo record exists whatever happens here; record it even if the lease was lost so a retry only re-adopts it.
    if (current.state === "push_queued") {
      const pushed: ExportSnapshot = { ...current, state: "pushed", pushState: "succeeded", pushError: null, verifiedAt: new Date().toISOString(), verifiedBy: current.pushRequestedBy ?? null,
        quotationReference: result.name, odooQuotation: { id: result.id, name: result.name, url: quotationUrl(cfg, result.id) } };
      await client.query("UPDATE exports SET data=$2 WHERE id=$1", [exportId, pushed]);
    }
    if (lease) await client.query("UPDATE jobs SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,error_message=NULL,updated_at=now() WHERE id=$1", [job.id]);
    await audit(client, job.orderId, owner, "export.pushed", current.orderVersion, { exportId: exportId!, quotationId: result.id, quotationReference: result.name, created: result.created, state: result.state, amountUntaxed: result.amountUntaxed, totalMatches: result.totalMatches, jobId: job.id });
  });
}
export async function odooPushFailed(job: Job, owner: string, error: unknown): Promise<void> {
  const known = error instanceof OdooPushError;
  const retryable = known ? error.retryable : true;
  const message = known ? error.message : "Unexpected problem while sending to Odoo; the push will be retried automatically.";
  console.error(JSON.stringify({ event: "odoo_push.error", jobId: job.id, kind: known ? error.kind : "unexpected", retryable, detail: (known ? error.detail || error.message : error instanceof Error ? error.message : String(error)).slice(0, 300) }));
  if (!retryable) await pool.query("UPDATE jobs SET max_attempts=attempts WHERE id=$1 AND lease_owner=$2 AND status='running'", [job.id, owner]);
  await failJob(job.id, owner, retryable ? "INTERNAL_ERROR" : "VALIDATION_FAILED", message);
  await transaction(async (client) => {
    const j = (await client.query("SELECT status,export_id,attempts,max_attempts FROM jobs WHERE id=$1 FOR UPDATE", [job.id])).rows[0];
    if (!j?.export_id || !job.orderId) return;
    const current: ExportSnapshot | undefined = (await client.query("SELECT data FROM exports WHERE id=$1 FOR UPDATE", [j.export_id])).rows[0]?.data;
    if (!current || current.state !== "push_queued") return;
    const final = j.status === "dead_letter";
    const next: ExportSnapshot = final ? { ...current, state: restState(current), pushState: "failed", pushError: message }
      : { ...current, pushError: `${message} (attempt ${j.attempts} of ${j.max_attempts})` };
    await client.query("UPDATE exports SET data=$2 WHERE id=$1", [j.export_id, next]);
    await audit(client, job.orderId, owner, final ? "export.push_failed" : "export.push_retry", current.orderVersion, { exportId: j.export_id, kind: known ? error.kind : "unexpected", retryable, attempt: j.attempts, jobId: job.id });
  });
}
