import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtractedOrder, ExtractionProvider, Session } from "../packages/contracts";
import { OdooPushError, odooConfigFromEnv, pushExternalId, pushQuotation, type PushInput } from "../packages/server/odoo";
import { validateEnv } from "../packages/db/env";

// ---- Fake Odoo JSON-RPC server (just enough of common.authenticate + object.execute_kw) -----------------------------------
const KEY = "test-secret-key-do-not-log";
class FakeOdoo {
  xmlids = new Map<string, { model: string; res_id: number }>();
  orders = new Map<number, { id: number; name: string; origin: string; state: string; vals: any; amount_untaxed: number }>();
  fail5xx = 0; rejectKey = false; accessError = false; calls: string[] = []; creates = 0; server!: http.Server; url = "";
  seedMaster(snapshot: PushInput) {
    this.xmlids.set(snapshot.customerExternalId, { model: "res.partner", res_id: 7 });
    this.xmlids.set(snapshot.shippingAddressExternalId, { model: "res.partner", res_id: 8 });
    this.xmlids.set(`base.${snapshot.currency}`, { model: "res.currency", res_id: 2 });
    snapshot.lines.forEach((l, i) => this.xmlids.set(l.productExternalId, { model: "product.product", res_id: 100 + i }));
    for (const u of ["pennbridge.uom_pack", "uom.product_uom_unit"]) this.xmlids.set(u, { model: "uom.uom", res_id: 50 });
  }
  private rpcError(name: string, message = "x") { return { jsonrpc: "2.0", id: 1, error: { code: 200, message: "Odoo Server Error", data: { name, message } } }; }
  handle(body: any) {
    const { service, method, args } = body.params;
    if (service === "common" && method === "authenticate") { this.calls.push("authenticate"); return { jsonrpc: "2.0", id: 1, result: this.rejectKey || args[2] !== KEY ? false : 5 }; }
    const [, uid, key, model, m, a, kw = {}] = args;
    if (key !== KEY || uid !== 5) return this.rpcError("odoo.exceptions.AccessDenied");
    if (this.accessError) return this.rpcError("odoo.exceptions.AccessError", "Sorry, you are not allowed");
    this.calls.push(`${model}.${m}`);
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: 1, result });
    if (model === "ir.model.data" && m === "search_read") {
      const d = a[0];
      if (d[0][0] === "module" && d[0][1] === "in") { // batch lookup by module/name pairs (complete_name is not searchable in Odoo 19)
        return ok([...this.xmlids].map(([k, v]) => ({ module: k.split(".")[0], name: k.slice(k.indexOf(".") + 1), ...v })).filter((r) => d[0][2].includes(r.module) && d[1][2].includes(r.name)));
      }
      const full = `${d[0][2]}.${d[1][2]}`; return ok(this.xmlids.has(full) ? [{ id: 1 }] : []);
    }
    if (model === "ir.model.data" && m === "create") { const v = a[0]; this.xmlids.set(`${v.module}.${v.name}`, { model: v.model, res_id: v.res_id }); return ok(99); }
    if (model === "sale.order" && m === "search") {
      const [[field, , value]] = a[0];
      return ok([...this.orders.values()].filter((o) => (field === "id" ? o.id === value : o.origin === value)).map((o) => o.id));
    }
    if (model === "sale.order" && m === "create") {
      const v = a[0]; this.creates++; const id = 10 + this.orders.size;
      const amount = v.order_line.reduce((s: number, l: any) => s + l[2].product_uom_qty * l[2].price_unit, 0);
      this.orders.set(id, { id, name: `S${String(id).padStart(5, "0")}`, origin: v.origin, state: "draft", vals: v, amount_untaxed: amount }); return ok(id);
    }
    if (model === "sale.order" && m === "read") { const o = this.orders.get(a[0][0]); return ok(o ? [{ id: o.id, name: o.name, state: o.state, amount_untaxed: o.amount_untaxed }] : []); }
    return this.rpcError("odoo.exceptions.UserError", `unsupported ${model}.${m}`);
  }
  async start() {
    this.server = http.createServer((req, res) => {
      let data = ""; req.on("data", (c) => (data += c));
      req.on("end", () => {
        if (req.url !== "/jsonrpc") { res.statusCode = 404; return res.end("nope"); }
        if (this.fail5xx > 0) { this.fail5xx--; res.statusCode = 502; return res.end("bad gateway"); }
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify(this.handle(JSON.parse(data))));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as any).port}`;
  }
  stop() { return new Promise((r) => this.server.close(r)); }
}
const input = (over: Partial<PushInput> = {}): PushInput => ({ orderId: `ord_${randomUUID().slice(0, 8)}`, orderVersion: 3, externalId: "pennbridge.quote_x", customerExternalId: "pennbridge.partner_C001", shippingAddressExternalId: "pennbridge.address_C001_MAIN", poNumber: "PO-1", currency: "GBP", total: "20.00",
  lines: [{ lineId: "L1", productExternalId: "pennbridge.product_FB-0830-A2-100", sku: "FB", description: "Pack of FB", quantity: "2", unit: "pack", unitPrice: "10.00" }], ...over });
const UNITS = { pack: "pennbridge.uom_pack", each: "uom.product_uom_unit" };
const cfg = (url: string, apiKey = KEY) => ({ url, db: "d", user: "u", apiKey });

describe("Odoo push against a fake JSON-RPC server", () => {
  const odoo = new FakeOdoo();
  beforeAll(() => odoo.start()); afterAll(() => odoo.stop());

  it("creates a draft quotation with PO, partner, shipping partner, lines and reads the name back", async () => {
    const i = input(); odoo.seedMaster(i);
    const r = await pushQuotation(cfg(odoo.url), i, UNITS);
    expect(r).toMatchObject({ created: true, state: "draft", amountUntaxed: "20.00", totalMatches: true });
    const order = odoo.orders.get(r.id)!;
    expect(order.vals).toMatchObject({ partner_id: 7, partner_shipping_id: 8, client_order_ref: "PO-1", currency_id: 2, origin: `pennbridge:quote_${i.orderId}_v3` });
    expect(order.vals.order_line[0][2]).toMatchObject({ product_id: 100, product_uom_qty: 2, product_uom_id: 50, price_unit: 10, name: "Pack of FB" });
    expect(odoo.xmlids.get(pushExternalId(i))).toMatchObject({ model: "sale.order", res_id: r.id });
    expect(r.name).toMatch(/^S\d{5}$/);
  });
  it("is idempotent: a retry returns the same quotation and creates nothing", async () => {
    const i = input(); odoo.seedMaster(i); const before = odoo.creates;
    const a = await pushQuotation(cfg(odoo.url), i, UNITS), b = await pushQuotation(cfg(odoo.url), i, UNITS);
    expect(b).toMatchObject({ id: a.id, name: a.name, created: false }); expect(odoo.creates).toBe(before + 1);
  });
  it("recovers when the process died after create but before the external id was written (origin marker)", async () => {
    const i = input(); odoo.seedMaster(i);
    const a = await pushQuotation(cfg(odoo.url), i, UNITS); odoo.xmlids.delete(pushExternalId(i)); const before = odoo.creates;
    expect(await pushQuotation(cfg(odoo.url), i, UNITS)).toMatchObject({ id: a.id, created: false }); expect(odoo.creates).toBe(before);
    expect(odoo.xmlids.has(pushExternalId(i))).toBe(true);
  });
  it("adopts a quotation already imported from the CSV (same export external id)", async () => {
    const i = input({ externalId: `pennbridge.quote_csv_${randomUUID().slice(0, 6)}` }); odoo.seedMaster(i);
    odoo.orders.set(900, { id: 900, name: "S00900", origin: "", state: "draft", vals: {}, amount_untaxed: 20 }); odoo.xmlids.set(i.externalId, { model: "sale.order", res_id: 900 });
    const before = odoo.creates;
    expect(await pushQuotation(cfg(odoo.url), i, UNITS)).toMatchObject({ id: 900, name: "S00900", created: false }); expect(odoo.creates).toBe(before);
  });
  it("a missing external id is a permanent error naming the id and creates nothing", async () => {
    const i = input(); odoo.seedMaster(i); odoo.xmlids.delete(i.lines[0].productExternalId); const before = odoo.creates;
    const error = await pushQuotation(cfg(odoo.url), i, UNITS).catch((e) => e);
    expect(error).toBeInstanceOf(OdooPushError); expect(error).toMatchObject({ kind: "missing_reference", retryable: false }); expect(error.message).toContain(i.lines[0].productExternalId);
    expect(odoo.creates).toBe(before);
  });
  it("an external id pointing at the wrong model counts as missing", async () => {
    const i = input(); odoo.seedMaster(i); odoo.xmlids.set(i.customerExternalId, { model: "res.users", res_id: 1 });
    await expect(pushQuotation(cfg(odoo.url), i, UNITS)).rejects.toMatchObject({ kind: "missing_reference" });
  });
  it("bad credentials and missing permission are permanent with a safe message", async () => {
    const i = input(); odoo.seedMaster(i);
    const bad = await pushQuotation(cfg(odoo.url, "wrong-key-xyz"), i, UNITS).catch((e) => e);
    expect(bad).toMatchObject({ kind: "auth", retryable: false }); expect(bad.message).not.toContain("wrong-key-xyz"); expect(JSON.stringify(bad)).not.toContain("wrong-key-xyz");
    odoo.accessError = true; const denied = await pushQuotation(cfg(odoo.url), i, UNITS).catch((e) => e); odoo.accessError = false;
    expect(denied).toMatchObject({ kind: "permission", retryable: false }); expect(denied.message).not.toContain("Sorry");
  });
  it("5xx, timeouts and unreachable hosts are transient; the next attempt succeeds without duplicates", async () => {
    const i = input(); odoo.seedMaster(i);
    odoo.fail5xx = 1; const e5 = await pushQuotation(cfg(odoo.url), i, UNITS).catch((e) => e);
    expect(e5).toMatchObject({ kind: "transient", retryable: true });
    const down = await pushQuotation(cfg("http://127.0.0.1:1"), i, UNITS).catch((e) => e); expect(down).toMatchObject({ kind: "transient", retryable: true });
    const slow = await pushQuotation(cfg(odoo.url), i, UNITS, { fetch: () => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("t"), { name: "TimeoutError" })), 5)) }).catch((e) => e);
    expect(slow).toMatchObject({ kind: "transient" });
    const before = odoo.creates; const ok = await pushQuotation(cfg(odoo.url), i, UNITS); expect(ok.created).toBe(true); expect(odoo.creates).toBe(before + 1);
  });
  it("flags a total mismatch instead of silently accepting it", async () => {
    const i = input({ total: "99.00" }); odoo.seedMaster(i);
    expect(await pushQuotation(cfg(odoo.url), i, UNITS)).toMatchObject({ amountUntaxed: "20.00", totalMatches: false });
  });
  it("never confirms the order (only create/read/search calls are made)", () => {
    expect(odoo.calls.filter((c) => /action_confirm|write|unlink/.test(c))).toEqual([]);
  });
});

describe("Odoo push configuration", () => {
  it("reads the key from the secret file and complains safely when it is missing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "odoo-key-")), file = path.join(dir, "key"); writeFileSync(file, `${KEY}\n`);
    expect(odoo_cfg(file).apiKey).toBe(KEY);
    expect(() => odoo_cfg(path.join(dir, "nope"))).toThrow(/key file is missing/);
  });
  it("validateEnv requires all ODOO_* settings together and an existing key file in the worker", () => {
    const base = { DEMO_MODE: "true" };
    expect(() => validateEnv({ ...base, ODOO_URL: "http://odoo" }, "app")).toThrow(/ODOO_DB.*ODOO_USER/s);
    expect(() => validateEnv({ ...base, ODOO_URL: "http://odoo" }, "worker")).toThrow(/ODOO_API_KEY_FILE/);
    // The app never holds the key; it only needs the non-secret settings (regression: dev overlay crashed the app).
    expect(() => validateEnv({ ...base, ODOO_URL: "http://odoo", ODOO_DB: "d", ODOO_USER: "u" }, "app")).not.toThrow();
    expect(() => validateEnv({ ...base, ODOO_URL: "http://odoo", ODOO_DB: "d", ODOO_USER: "u", ODOO_API_KEY_FILE: "/nope/key" }, "app")).not.toThrow();
    expect(() => validateEnv({ ...base, ODOO_URL: "http://odoo", ODOO_DB: "d", ODOO_USER: "u", ODOO_API_KEY_FILE: "/nope/key" }, "worker")).toThrow(/not found/);
    expect(() => validateEnv({ ...base, ODOO_URL: "ftp://x", ODOO_DB: "d", ODOO_USER: "u", ODOO_API_KEY_FILE: "/x" }, "app")).toThrow(/ODOO_URL/);
  });
});
function odoo_cfg(file: string) { return odooConfigFromEnv({ ODOO_URL: "http://odoo/", ODOO_DB: "d", ODOO_USER: "u", ODOO_API_KEY_FILE: file }); }

// ---- Export state machine + worker glue on real PostgreSQL ------------------------------------------------------------------
const enabled = process.env.ODOO_PUSH_DB_TEST === "true";
describe.skipIf(!enabled)("Odoo push: export state machine and worker on real PostgreSQL", () => {
  const run = randomUUID(), tag = run.slice(0, 8), owner = `odoo-${tag}`;
  const odoo = new FakeOdoo();
  let S: typeof import("../packages/server"), D: typeof import("../packages/db"), admin: Session, reviewer: Session, viewer: Session, seq = 0;
  const provider = (po: string): ExtractionProvider => ({ mode: "mock", extract: async () => ({ usage: null, extracted: { schemaVersion: 1, intent: "new_order", poNumber: po, relatedPoNumber: null, revision: null, requestedDeliveryDate: null, requestedAddress: "MAIN", currency: "GBP", quotedTotal: null, evidence: [], reasons: [],
    lines: [{ id: "L1", position: 1, rawText: "2 packs FB-0830-A2-100", sku: "FB-0830-A2-100", manufacturerReference: null, customerAlias: null, description: "FB-0830-A2-100", quantity: "2", unit: "pack", originalUnit: "packs", quotedUnitPrice: null, attributes: {}, evidenceIds: [] }] } as ExtractedOrder }) });
  async function exported(po: string) {
    const { parseInput } = await import("../packages/ingestion");
    const eml = Buffer.from([`From: Buyer <b-${tag}@x.example>`, "To: orders@pennbridge.example", `Subject: Order ${po}`, `Message-ID: <${run}-${++seq}@t.example>`, "", `2 packs FB-0830-A2-100 for ${po}. Deliver MAIN.`, ""].join("\r\n"));
    const receipt = await S.intake(admin, { filename: "o.eml", mediaType: "message/rfc822", contentBase64: eml.toString("base64"), channel: "upload", externalMessageId: `${run}-${++seq}`, trustedCustomerId: "C001" });
    const job = await D.claimJob(owner); expect(job?.id).toBe(receipt.jobId);
    await S.processMessage(job!, owner, { parse: parseInput, provider: provider(po) });
    let d = await S.getOrder(admin, receipt.orderId!);
    d = await S.approveOrder(reviewer, d.order.id, { expectedVersion: d.order.version, contentHash: d.order.contentHash });
    const snap = await S.exportOrder(reviewer, d.order.id, { expectedVersion: d.order.version, idempotencyKey: `k-${po}-${run}` });
    odoo.seedMaster(snap as any); return { orderId: d.order.id, snap };
  }
  /** One worker iteration, exactly as apps/worker does it. */
  async function workOnce() {
    await D.pool.query("UPDATE jobs SET available_at=now() WHERE type='odoo_push' AND status='retry_wait'");
    const job = await D.claimJob(owner); if (!job) return null;
    try { await S.runOdooPush(job, owner); } catch (e) { await S.odooPushFailed(job, owner, e); }
    return job;
  }
  beforeAll(async () => {
    if (!/test/i.test(new URL(process.env.DATABASE_URL!).pathname)) throw new Error("ODOO_PUSH_DB_TEST requires an isolated database whose name contains test");
    process.env.DEMO_MODE = "true"; S = await import("../packages/server"); D = await import("../packages/db");
    await S.initialiseDatabase();
    admin = (await S.login("admin@pennbridge.example", "admin-demo")).session; reviewer = (await S.login("reviewer@pennbridge.example", "reviewer-demo")).session; viewer = (await S.login("viewer@pennbridge.example", "viewer-demo")).session;
    await odoo.start(); S.setOdooUnitMapping({ pack: "pennbridge.uom_pack" });
    const file = path.join(mkdtempSync(path.join(tmpdir(), "odoo-key-")), "key"); writeFileSync(file, KEY);
    Object.assign(process.env, { ODOO_URL: odoo.url, ODOO_DB: "d", ODOO_USER: "u", ODOO_API_KEY_FILE: file });
  });
  afterAll(async () => { await odoo.stop(); await D.pool.end(); });

  it("push-odoo: role check, queue, worker pushes, state becomes pushed with quotation and verified fields", async () => {
    const { orderId, snap } = await exported(`PUSH-${tag}`);
    await expect(S.queueOdooPush(viewer, orderId, snap.id)).rejects.toMatchObject({ status: 403 });
    await expect(S.queueOdooPush(reviewer, orderId, "export_nope")).rejects.toMatchObject({ status: 404 });
    const queued = await S.queueOdooPush(reviewer, orderId, snap.id);
    expect(queued).toMatchObject({ state: "push_queued", pushState: "queued", pushError: null, pushRequestedBy: reviewer.userId });
    expect((await S.queueOdooPush(admin, orderId, snap.id)).state).toBe("push_queued"); // replay does not enqueue twice
    expect((await D.pool.query("SELECT count(*)::int AS n FROM jobs WHERE type='odoo_push' AND export_id=$1", [snap.id])).rows[0].n).toBe(1);
    await expect(S.verifyExport(reviewer, orderId, snap.id, { quotationReference: "S1" })).rejects.toMatchObject({ status: 409 });
    await expect(S.voidExport(reviewer, orderId, snap.id, { reason: "x" })).rejects.toMatchObject({ status: 409 });
    expect((await workOnce())?.type).toBe("odoo_push");
    const detail = await S.getOrder(admin, orderId), done = detail.exports[0];
    expect(done).toMatchObject({ state: "pushed", pushState: "succeeded", pushError: null, verifiedBy: reviewer.userId, quotationReference: expect.stringMatching(/^S\d+$/) });
    expect(done.odooQuotation).toMatchObject({ id: expect.any(Number), name: done.quotationReference }); expect(done.verifiedAt).toBeTruthy();
    expect(detail.audit.map((a) => a.action)).toEqual(expect.arrayContaining(["export.push_queued", "export.pushed"]));
    expect((await S.queueOdooPush(reviewer, orderId, snap.id)).state).toBe("pushed"); // terminal + idempotent
    expect((await S.verifyExport(reviewer, orderId, snap.id, { quotationReference: done.quotationReference! })).state).toBe("pushed"); // verify replay is a no-op
    await expect(S.verifyExport(reviewer, orderId, snap.id, { quotationReference: "S99999" })).rejects.toMatchObject({ status: 409 });
    await expect(S.voidExport(reviewer, orderId, snap.id, { reason: "x" })).rejects.toMatchObject({ status: 409 });
    expect(JSON.stringify(detail)).not.toContain(KEY);
  });
  it("transient failure retries with a visible message, then succeeds without duplicating", async () => {
    const { orderId, snap } = await exported(`RETRY-${tag}`); const creates = odoo.creates;
    await S.queueOdooPush(reviewer, orderId, snap.id); odoo.fail5xx = 1;
    await workOnce();
    let e = (await S.getOrder(admin, orderId)).exports[0];
    expect(e).toMatchObject({ state: "push_queued", pushState: "queued" }); expect(e.pushError).toMatch(/retried automatically.*attempt 1 of 5/);
    await workOnce();
    e = (await S.getOrder(admin, orderId)).exports[0]; expect(e.state).toBe("pushed"); expect(odoo.creates).toBe(creates + 1);
  });
  it("permanent failure (missing external id) returns the export to its resting state with a safe error; re-push after fixing works", async () => {
    const { orderId, snap } = await exported(`PERM-${tag}`); const pid = snap.lines[0].productExternalId;
    odoo.xmlids.delete(pid); await S.queueOdooPush(reviewer, orderId, snap.id); await workOnce();
    const detail = await S.getOrder(admin, orderId), e = detail.exports[0];
    expect(e).toMatchObject({ state: "prepared", pushState: "failed", quotationReference: null }); expect(e.pushError).toContain(pid);
    const job = (await D.pool.query("SELECT status,attempts,error_code FROM jobs WHERE type='odoo_push' AND export_id=$1", [snap.id])).rows[0];
    expect(job).toMatchObject({ status: "dead_letter", attempts: 1 });
    expect(detail.audit.map((a) => a.action)).toContain("export.push_failed");
    odoo.seedMaster(snap as any);
    expect((await S.queueOdooPush(reviewer, orderId, snap.id)).state).toBe("push_queued"); await workOnce();
    expect((await S.getOrder(admin, orderId)).exports[0]).toMatchObject({ state: "pushed", pushError: null });
  });
  it("refuses to queue when direct push is not configured", async () => {
    const { orderId, snap } = await exported(`OFF-${tag}`);
    const { queueOdooPush } = await import("../packages/server/odoo");
    await expect(queueOdooPush(reviewer, orderId, snap.id, {})).rejects.toMatchObject({ status: 409 });
  });
  // Opt-in against a real local Odoo (ODOO_REAL_URL/DB/USER + ODOO_REAL_KEY_FILE); creates test quotations only.
  it.skipIf(!process.env.ODOO_REAL_URL)("REAL Odoo: draft quotation is created once; a second push does not duplicate", async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { ODOO_URL: process.env.ODOO_REAL_URL, ODOO_DB: process.env.ODOO_REAL_DB, ODOO_USER: process.env.ODOO_REAL_USER, ODOO_API_KEY_FILE: process.env.ODOO_REAL_KEY_FILE });
    try {
      const { orderId, snap } = await exported(`REAL-${tag}`);
      await S.queueOdooPush(reviewer, orderId, snap.id); await workOnce();
      const first = (await S.getOrder(admin, orderId)).exports[0];
      console.log("REAL_RESULT", JSON.stringify({ state: first.state, error: first.pushError, quotation: first.odooQuotation, po: snap.poNumber, total: snap.total, lines: snap.lines.map((l) => [l.sku, l.quantity, l.unit, l.unitPrice]), externalId: `pennbridge.quote_${orderId}_v${snap.orderVersion}` }));
      expect(first.state).toBe("pushed");
      // second push: force a fresh job for the same export (as if the first outcome were lost) and run it
      const before = JSON.stringify(first.odooQuotation);
      await D.pool.query("UPDATE exports SET data=jsonb_set(jsonb_set(data,'{state}','\"push_queued\"'),'{pushState}','\"queued\"') WHERE id=$1", [snap.id]);
      await D.pool.query("INSERT INTO jobs(id,type,order_id,export_id,status,max_attempts) VALUES($1,'odoo_push',$2,$3,'queued',5)", [`job_again_${tag}`, orderId, snap.id]);
      await workOnce();
      const second = (await S.getOrder(admin, orderId)).exports[0];
      expect(second.state).toBe("pushed"); expect(JSON.stringify(second.odooQuotation)).toBe(before);
    } finally { for (const k of ["ODOO_URL", "ODOO_DB", "ODOO_USER", "ODOO_API_KEY_FILE"]) process.env[k] = saved[k]; }
  });
});

describe("quotation link", () => {
  it("uses ODOO_PUBLIC_URL for reviewers' browsers when the worker reaches Odoo internally", async () => {
    const { quotationUrl } = await import("../packages/server/odoo");
    expect(quotationUrl({ url: "http://odoo-web" }, 9)).toBe("http://odoo-web/odoo/action-sale.action_quotations_with_onboarding/9");
    process.env.ODOO_PUBLIC_URL = "http://127.0.0.1:8067/";
    try { expect(quotationUrl({ url: "http://odoo-web" }, 9)).toBe("http://127.0.0.1:8067/odoo/action-sale.action_quotations_with_onboarding/9"); }
    finally { delete process.env.ODOO_PUBLIC_URL; }
  });
});
