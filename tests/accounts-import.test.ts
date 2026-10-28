import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdtemp, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { getRounds } from "bcryptjs";
import type { Session } from "../packages/contracts";

// compare is spied (not replaced) to prove the dummy hash is compared for unknown accounts.
const bcrypt = vi.hoisted(() => ({ compare: vi.fn() }));
vi.mock("bcryptjs", async (orig) => { const m: any = await orig(); bcrypt.compare.mockImplementation(m.compare); return { ...m, compare: bcrypt.compare }; });

import { migrate, pool, audit } from "../packages/db";
import { seedDatabase, currentCatalogueVersion, CATALOGUE_VERSION } from "../packages/db/seed";
import { initialiseDatabase, login, session, logout } from "../packages/server";
import { authenticate, bcryptCost, passwordProblems, purgeExpired, sessionFromToken } from "../packages/server/auth";
import * as admin from "../packages/server/admin";
import * as imp from "../packages/server/import";

const enabled = process.env.W3_DB_TEST === "true";
const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const PW = "correct-horse-battery";
let boss: Session;
const asSession = (u: { id: string; email: string; name: string; role: any }): Session => ({ userId: u.id, email: u.email, name: u.name, role: u.role, expiresAt: new Date(Date.now() + 3600000).toISOString() });
const err = (status: number, code = "FORBIDDEN") => ({ status, code });

describe.skipIf(!enabled)("W3 accounts, auth and CSV import on real PostgreSQL", () => {
  beforeAll(async () => {
    if (!/test/i.test(new URL(process.env.DATABASE_URL!).pathname)) throw new Error("W3_DB_TEST requires a database whose name contains test");
    process.env.BCRYPT_COST = "4";
    await migrate();
    for (const f of (await readdir(path.join(ROOT, "packages/db/migrations"))).filter((f) => /^02\d-.*\.sql$/.test(f)).sort()) await pool.query(await readFile(path.join(ROOT, "packages/db/migrations", f), "utf8"));
    // Production behaviour first: seeding an empty database creates neither demo users nor demo master data.
    delete process.env.DEMO_MODE;
    await seedDatabase();
    expect(Number((await pool.query("SELECT count(*) FROM users")).rows[0].count)).toBe(0);
    expect(Number((await pool.query("SELECT count(*) FROM products")).rows[0].count)).toBe(0);
    expect(await currentCatalogueVersion(pool)).toBe(CATALOGUE_VERSION);
    boss = asSession(await admin.insertUser({ email: "boss@wholesale.test", name: "Boss", role: "admin", password: PW }, "test"));
  });
  afterAll(async () => { await pool.end(); });

  describe("password policy and hashing", () => {
    it("enforces length, repetition, common and name rules", () => {
      expect(passwordProblems("short").length).toBeGreaterThan(0);
      expect(passwordProblems("elevenchars")).toContain("Password must be at least 12 characters.");
      expect(passwordProblems("aaaaaaaaaaaaaaaa").join()).toMatch(/repeated/);
      expect(passwordProblems("changeme1234").join()).toMatch(/common/);
      expect(passwordProblems("jane.smith-2026!", { email: "jane.smith@x.test" }).join()).toMatch(/email name/);
      expect(passwordProblems("é".repeat(40)).join()).toMatch(/72 bytes/);
      expect(passwordProblems("correct-horse-battery")).toEqual([]);
    });
    it("uses cost 12 outside tests and stores the configured cost", async () => {
      const e = process.env as Record<string, string | undefined>; const saved = { n: e.NODE_ENV, v: e.VITEST }; delete e.NODE_ENV; delete e.VITEST;
      expect(bcryptCost()).toBe(12); e.NODE_ENV = saved.n; e.VITEST = saved.v;
      const user = await admin.insertUser({ email: "cost@wholesale.test", name: "Cost", role: "viewer", password: PW }, "test");
      expect(getRounds((await pool.query("SELECT password_hash FROM users WHERE id=$1", [user.id])).rows[0].password_hash)).toBe(4);
    });
    it("rejects weak passwords when creating users", async () => {
      await expect(admin.createUser(boss, { email: "weak@wholesale.test", name: "Weak", role: "viewer", password: "short" })).rejects.toMatchObject(err(400, "VALIDATION_FAILED"));
    });
  });

  describe("login throttling", () => {
    it("locks per IP+account after repeated failures without locking other IPs or accounts", async () => {
      await admin.insertUser({ email: "thr@wholesale.test", name: "Thr", role: "viewer", password: PW }, "test");
      for (let i = 0; i < 5; i++) await expect(authenticate("thr@wholesale.test", "wrong-password-x", { ip: "10.0.0.1" })).rejects.toMatchObject(err(401));
      await expect(authenticate("thr@wholesale.test", PW, { ip: "10.0.0.1" })).rejects.toMatchObject({ status: 429 });
      expect((await authenticate("thr@wholesale.test", PW, { ip: "10.0.0.2" })).session.email).toBe("thr@wholesale.test");
      expect((await authenticate("boss@wholesale.test", PW, { ip: "10.0.0.1" })).session.role).toBe("admin");
    });
    it("throttles unknown accounts identically (no enumeration) and compares a dummy hash", async () => {
      bcrypt.compare.mockClear();
      const known = await authenticate("thr@wholesale.test", "nope-nope-nope", { ip: "10.9.9.9" }).catch((e) => e);
      const calls = bcrypt.compare.mock.calls.length;
      const unknown = await authenticate("ghost@wholesale.test", "nope-nope-nope", { ip: "10.9.9.9" }).catch((e) => e);
      expect(bcrypt.compare.mock.calls.length).toBe(calls + 1);
      expect(unknown.message).toBe(known.message);
      for (let i = 0; i < 4; i++) await authenticate("ghost@wholesale.test", "nope-nope-nope", { ip: "10.9.9.9" }).catch(() => undefined);
      await expect(authenticate("ghost@wholesale.test", "nope-nope-nope", { ip: "10.9.9.9" })).rejects.toMatchObject({ status: 429 });
    });
    it("a successful login resets the pair counter", async () => {
      await admin.insertUser({ email: "reset@wholesale.test", name: "R", role: "viewer", password: PW }, "test");
      for (let i = 0; i < 4; i++) await authenticate("reset@wholesale.test", "wrong-password-x", { ip: "10.1.1.1" }).catch(() => undefined);
      await authenticate("reset@wholesale.test", PW, { ip: "10.1.1.1" });
      for (let i = 0; i < 4; i++) await authenticate("reset@wholesale.test", "wrong-password-x", { ip: "10.1.1.1" }).catch(() => undefined);
      await expect(authenticate("reset@wholesale.test", PW, { ip: "10.1.1.1" })).resolves.toBeTruthy();
    });
  });

  describe("sessions", () => {
    it("expires absolutely and when idle, and purges", async () => {
      await admin.insertUser({ email: "sess@wholesale.test", name: "S", role: "reviewer", password: PW }, "test");
      const { token } = await authenticate("sess@wholesale.test", PW, { ip: "10.2.0.1" });
      expect((await sessionFromToken(token))?.role).toBe("reviewer");
      await pool.query("UPDATE sessions SET last_seen_at=now()-interval '3 hours' WHERE user_id=(SELECT id FROM users WHERE email='sess@wholesale.test')");
      expect(await sessionFromToken(token)).toBeNull();
      const second = await authenticate("sess@wholesale.test", PW, { ip: "10.2.0.1" });
      await pool.query("UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE token_hash<>'x' AND user_id=(SELECT id FROM users WHERE email='sess@wholesale.test')");
      expect(await sessionFromToken(second.token)).toBeNull();
      expect((await purgeExpired()).sessions).toBeGreaterThanOrEqual(1);
      expect(Number((await pool.query("SELECT count(*) FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email='sess@wholesale.test'")).rows[0].count)).toBe(0);
    });
    it("deactivation, role change and password reset revoke sessions immediately", async () => {
      const u = await admin.createUser(boss, { email: "rev@wholesale.test", name: "Rev", role: "reviewer", password: PW });
      let { token } = await authenticate("rev@wholesale.test", PW, { ip: "10.3.0.1" });
      await admin.updateUser(boss, u.id, { role: "viewer" }); expect(await sessionFromToken(token)).toBeNull();
      ({ token } = await authenticate("rev@wholesale.test", PW, { ip: "10.3.0.1" }));
      await admin.setUserPassword(boss, u.id, "another-long-password"); expect(await sessionFromToken(token)).toBeNull();
      await expect(authenticate("rev@wholesale.test", PW, { ip: "10.3.0.1" })).rejects.toMatchObject(err(401));
      ({ token } = await authenticate("rev@wholesale.test", "another-long-password", { ip: "10.3.0.1" }));
      const off = await admin.deactivateUser(boss, u.id); expect(off.active).toBe(false);
      expect(await sessionFromToken(token)).toBeNull();
      await expect(authenticate("rev@wholesale.test", "another-long-password", { ip: "10.3.0.1" })).rejects.toMatchObject(err(401));
      expect((await admin.updateUser(boss, u.id, { active: true })).active).toBe(true);
    });
  });

  describe("user administration", () => {
    it("is admin-only", async () => {
      const reviewer = asSession(await admin.insertUser({ email: "plain@wholesale.test", name: "Plain", role: "reviewer", password: PW }, "test"));
      await expect(admin.listUsers(reviewer)).rejects.toMatchObject(err(403));
      await expect(admin.createUser(reviewer, { email: "x@wholesale.test", name: "X", role: "admin", password: PW })).rejects.toMatchObject(err(403));
      await expect(admin.updateUser(reviewer, reviewer.userId, { role: "admin" })).rejects.toMatchObject(err(403));
      await expect(admin.setUserPassword(reviewer, boss.userId, "hijacked-password-1")).rejects.toMatchObject(err(403));
      await expect(admin.listUsers(null as any)).rejects.toMatchObject(err(401));
    });
    it("creates, lists, updates and audits; duplicate email is a conflict", async () => {
      const u = await admin.createUser(boss, { email: "Mixed.Case@Wholesale.Test", name: "Mixed", role: "viewer", password: PW });
      expect(u.email).toBe("mixed.case@wholesale.test");
      await expect(admin.createUser(boss, { email: "mixed.case@wholesale.test", name: "Dup", role: "viewer", password: PW })).rejects.toMatchObject({ status: 409 });
      expect((await admin.updateUser(boss, u.id, { name: "Renamed", role: "reviewer" })).name).toBe("Renamed");
      expect((await admin.listUsers(boss)).map((x) => x.email)).toContain("mixed.case@wholesale.test");
      const actions = (await pool.query("SELECT data->>'action' AS a FROM audit_events WHERE data->'detail'->>'userId'=$1 ORDER BY created_at", [u.id])).rows.map((r) => r.a);
      expect(actions).toEqual(["user.created", "user.updated"]);
      expect(JSON.stringify((await pool.query("SELECT data FROM audit_events WHERE data->'detail'->>'userId'=$1", [u.id])).rows)).not.toContain("password");
    });
    it("never removes the last active administrator", async () => {
      await expect(admin.deactivateUser(boss, boss.userId)).rejects.toMatchObject({ status: 409 });
      await expect(admin.updateUser(boss, boss.userId, { role: "viewer" })).rejects.toMatchObject({ status: 409 });
      const second = await admin.createUser(boss, { email: "second@wholesale.test", name: "Second", role: "admin", password: PW });
      await admin.updateUser(boss, second.id, { role: "reviewer" });
      const races = await Promise.allSettled([admin.updateUser(boss, boss.userId, { active: false }), admin.updateUser(asSession({ id: second.id, email: second.email, name: "S", role: "admin" }), boss.userId, { role: "viewer" })]);
      expect(races.every((r) => r.status === "rejected")).toBe(true);
    });
    it("lets a user change their own password with the current one, revokes other sessions and throttles guesses", async () => {
      const u = await admin.createUser(boss, { email: "self@wholesale.test", name: "Self", role: "viewer", password: PW });
      const a = await authenticate("self@wholesale.test", PW, { ip: "10.5.0.1" }); const b = await authenticate("self@wholesale.test", PW, { ip: "10.5.0.2" });
      await expect(admin.changeOwnPassword(a.session, "bad-current-pw-1", "brand-new-password", a.token)).rejects.toMatchObject(err(403));
      await expect(admin.changeOwnPassword(a.session, PW, "short", a.token)).rejects.toMatchObject(err(400, "VALIDATION_FAILED"));
      await expect(admin.changeOwnPassword(a.session, PW, PW, a.token)).rejects.toMatchObject(err(400, "VALIDATION_FAILED"));
      expect((await admin.changeOwnPassword(a.session, PW, "brand-new-password", a.token)).revokedSessions).toBe(1);
      expect(await sessionFromToken(a.token)).not.toBeNull(); expect(await sessionFromToken(b.token)).toBeNull();
      await authenticate("self@wholesale.test", "brand-new-password", { ip: "10.5.0.3" });
      for (let i = 0; i < 5; i++) await admin.changeOwnPassword(a.session, "bad-current-pw-1", "another-new-password", a.token).catch(() => undefined);
      await expect(admin.changeOwnPassword(a.session, "brand-new-password", "another-new-password", a.token)).rejects.toMatchObject({ status: 429 });
      void u;
    });
  });

  describe("bootstrap CLI", () => {
    it("creates the first admin from a password file, refuses a second, and can reset", async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pb-admin-")); const pwFile = path.join(dir, "pw");
      const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: "test", BCRYPT_COST: "4", ADMIN_PASSWORD: "" } as NodeJS.ProcessEnv;
      const cli = (...args: string[]) => run(path.join(ROOT, "node_modules/.bin/tsx"), ["scripts/create_admin.ts", ...args], { cwd: ROOT, env }).then((r) => ({ ok: true, out: r.stdout }), (e) => ({ ok: false, out: String(e.stderr) }));
      await writeFile(pwFile, "bootstrap-password-1\n");
      // other tests created admins already: the guard must refuse without --allow-additional.
      expect(await cli("--email", "cli@wholesale.test", "--name", "CLI", "--password-file", pwFile)).toMatchObject({ ok: false });
      const created = await cli("--email", "cli@wholesale.test", "--name", "CLI Admin", "--password-file", pwFile, "--allow-additional");
      expect(created).toMatchObject({ ok: true }); expect((await authenticate("cli@wholesale.test", "bootstrap-password-1", { ip: "10.6.0.1" })).session.role).toBe("admin");
      await writeFile(pwFile, "short\n"); expect(await cli("--email", "cli2@wholesale.test", "--name", "X", "--password-file", pwFile, "--allow-additional")).toMatchObject({ ok: false });
      await writeFile(pwFile, "recovered-password-2\n");
      expect(await cli("--email", "cli@wholesale.test", "--reset", "--password-file", pwFile)).toMatchObject({ ok: true });
      await expect(authenticate("cli@wholesale.test", "bootstrap-password-1", { ip: "10.6.0.2" })).rejects.toMatchObject(err(401));
      await authenticate("cli@wholesale.test", "recovered-password-2", { ip: "10.6.0.2" });
    }, 90000);
  });

  describe("CSV import", () => {
    const csvOf = (kind: imp.ImportKind) => readFile(path.join(ROOT, "docs/import-templates", `${kind}.csv`), "utf8");
    const preview = (kind: imp.ImportKind, csv: string) => imp.previewImport(boss, { kind, csv });
    const apply = (kind: imp.ImportKind, csv: string) => imp.applyImport(boss, { kind, csv, filename: `${kind}.csv` });
    const count = async (table: string) => Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
    const P = "sku,description,selling_unit,list_price,attributes\n";

    it("ships templates that match the code and import cleanly in dependency order", async () => {
      for (const kind of imp.IMPORT_KINDS) expect(await csvOf(kind), kind).toBe(imp.templateCsv(kind));
      const before = await count("products");
      const dry = await preview("products", await csvOf("products"));
      expect(dry).toMatchObject({ dryRun: true, applied: false, errors: [], counts: { create: 1 }, bumpsCatalogueVersion: true });
      expect(await count("products")).toBe(before); // dry run writes nothing
      for (const kind of ["products", "customers", "addresses", "price_agreements", "aliases", "stock"] as const) {
        const result = await apply(kind, await csvOf(kind)); expect(result, kind).toMatchObject({ applied: true, errors: [] });
      }
      expect((await pool.query("SELECT data FROM products WHERE sku='BOLT-M8-30'")).rows[0].data).toMatchObject({ id: "BOLT-M8-30", externalId: "pennbridge.product_BOLT-M8-30", sellingUnit: "pack", physicalUnit: "each", listPrice: "12.00", unitsPerPack: "100", attributes: { diameter_mm: 8, length_mm: 30, material: "A2 stainless" } });
      expect((await pool.query("SELECT data FROM customers WHERE id='CUST100'")).rows[0].data.approvedSenders).toEqual(["buyer@example-engineering.co.uk", "ap@example-engineering.co.uk"]);
      expect((await pool.query("SELECT count(*) FROM price_agreements WHERE customer_id='CUST100'")).rows[0].count).toBe("2");
      expect((await pool.query("SELECT data FROM stock_snapshots WHERE product_id='BOLT-M8-30'")).rows[0].data).toMatchObject({ availableQuantity: "250", observedAt: "2026-10-28T09:00:00.000Z" });
      expect((await imp.listImportBatches(boss)).length).toBeGreaterThanOrEqual(6);
    });
    it("reports every bad row with its row number and column and applies nothing", async () => {
      const csv = P + 'GOOD-1,"Fine, with comma",each,1.50,\n' + 'BAD UNIT,x,crate,1.00,\n' + 'GOOD-1,dupe,each,1.00,\n' + 'NOPRICE,x,each,12.345,\n' + 'BADATTR,x,each,1.00,notapair\n' + ",nosku,each,1.00,\n";
      const before = await count("products"); const result = await apply("products", csv);
      expect(result.applied).toBe(false); expect(result.dryRun).toBe(false);
      expect(result.errors.map((e) => [e.row, e.column])).toEqual([[3, "sku"], [3, "selling_unit"], [4, "sku"], [5, "list_price"], [6, "attributes"], [7, "sku"]]);
      expect(result.errors.filter((e) => e.row === 3).map((e) => e.column).sort()).toEqual(["selling_unit", "sku"]);
      expect(result.errors).toContainEqual({ row: 4, column: "sku", message: "Duplicate of row 2" });
      expect(result.errors).toContainEqual(expect.objectContaining({ row: 5, column: "list_price" }));
      expect(result.errors).toContainEqual(expect.objectContaining({ row: 6, column: "attributes" }));
      expect(result.errorRows).toBe(5); expect(result.validRows).toBe(1); expect(await count("products")).toBe(before);
      expect((await preview("products", csv)).errors).toEqual(result.errors);
    });
    it("rejects missing required columns, bad CSV, unknown columns warn", async () => {
      expect((await preview("products", "sku,description\nA,b\n")).errors.map((e) => e.column)).toEqual(["selling_unit", "list_price"]);
      expect((await preview("products", 'sku,description,selling_unit,list_price\nA,"unterminated,each,1\n')).errors[0].message).toMatch(/CSV could not be read/);
      expect((await preview("products", "sku,description,selling_unit,list_price\nA,b,each\n")).errors[0].message).toMatch(/CSV could not be read/);
      const r = await preview("stock", "﻿SKU,Available,colour\r\nBOLT-M8-30,5,red\r\n");
      expect(r.errors).toEqual([]); expect(r.warnings).toContainEqual(expect.objectContaining({ column: "colour" }));
    });
    it("versions the catalogue only when products really change", async () => {
      const v0 = await currentCatalogueVersion(pool);
      const same = await apply("products", await csvOf("products"));
      expect(same).toMatchObject({ applied: true, bumpsCatalogueVersion: false, counts: { unchanged: 1, create: 0, update: 0 } }); expect(await currentCatalogueVersion(pool)).toBe(v0);
      const changed = await apply("products", P.replace("\n", ",family\n") + 'BOLT-M8-30,"M8 x 30 mm A2 stainless hex bolt, pack 100",pack,12.50,diameter_mm=8,hex_bolt\n' + 'NEW-1,New item,each,2.00,,\n');
      expect(changed).toMatchObject({ applied: true, bumpsCatalogueVersion: true, counts: { create: 1, update: 1 } });
      expect(changed.sample.find((s) => s.key === "BOLT-M8-30")?.changedFields?.sort()).toEqual(expect.arrayContaining(["listPrice"]));
      const v1 = await currentCatalogueVersion(pool); expect(v1).toBe(changed.newCatalogueVersion); expect(v1).not.toBe(v0);
      // every product and customer moves to the new version so approved orders must be revalidated
      expect((await pool.query("SELECT count(*) FROM products WHERE data->>'catalogueVersion'<>$1", [v1])).rows[0].count).toBe("0");
      expect((await pool.query("SELECT count(*) FROM customers WHERE data->>'catalogueVersion'<>$1", [v1])).rows[0].count).toBe("0");
      expect((await pool.query("SELECT catalogue_version FROM import_batches ORDER BY created_at DESC LIMIT 1")).rows[0].catalogue_version).toBe(v1);
      expect((await pool.query("SELECT data FROM products WHERE sku='NEW-1'")).rows[0].data).toMatchObject({ family: "general", category: "general", unitsPerPack: "1", active: true });
      // deactivating a product via re-import is a normal update
      expect((await apply("products", P + "NEW-1,New item,each,2.00,\n")).counts.unchanged).toBe(1);
    });
    it("imports customers, merging fields owned by other modules", async () => {
      await pool.query("UPDATE customers SET data=data||'{\"w2Extra\":true}' WHERE id='CUST100'");
      const r = await apply("customers", "id,name,status\nCUST100,Example Engineering Ltd,credit_hold\nCUST101,Second Co,active\n");
      expect(r.counts).toMatchObject({ create: 1, update: 1 }); expect(r.sample[0].changedFields).toEqual(["onHold"]);
      const data = (await pool.query("SELECT data FROM customers WHERE id='CUST100'")).rows[0].data; expect(data).toMatchObject({ w2Extra: true, onHold: true }); expect(data.approvedSenders).toHaveLength(2); // column absent: senders kept
      expect((await preview("customers", "id,name,status,approved_senders\nCUST102,X,paused,not-an-email\n")).errors.map((e) => e.column)).toEqual(["status", "approved_senders"]);
      await apply("customers", "id,name,status,approved_senders\nCUST100,Example Engineering Ltd,active,\n"); expect((await pool.query("SELECT data FROM customers WHERE id='CUST100'")).rows[0].data.approvedSenders).toEqual([]);
    });
    it("validates addresses against customers", async () => {
      const r = await preview("addresses", "customer_id,code,address\nNOPE,MAIN,x\nCUST101,MAIN,1 High St\nCUST101,MAIN,dup\nCUST101,SIDE,\n");
      expect(r.errors.map((e) => [e.row, e.column])).toEqual([[2, "customer_id"], [4, "code"], [5, "address"]]);
      const ok = await apply("addresses", "customer_id,code,address,approved\nCUST101,MAIN,1 High St,true\nCUST101,SIDE,2 Low Rd,no\n"); expect(ok.counts.create).toBe(2);
      expect((await pool.query("SELECT data FROM addresses WHERE id='ADDR-CUST101-SIDE'")).rows[0].data).toMatchObject({ approved: false, label: "SIDE", customerId: "CUST101" });
      const idClash = await preview("addresses", "customer_id,code,address,id\nCUST100,Z,x,ADDR-CUST101-MAIN\n"); expect(idClash.errors[0].message).toMatch(/already belongs to customer CUST101/);
    });
    it("validates price agreements: money, dates, unknown refs and overlaps", async () => {
      const H = "customer_id,sku,unit_price,valid_from,valid_to,minimum_quantity\n";
      const bad = await preview("price_agreements", H + "NOPE,BOLT-M8-30,1.00,2026-01-01,,1\nCUST100,NOSKU,1.00,2026-01-01,,1\nCUST100,BOLT-M8-30,1.005,2026-02-30,,1\nCUST100,BOLT-M8-30,1.00,2026-05-01,2026-04-01,1\nCUST100,BOLT-M8-30,1.00,2026-01-01,,0\n");
      expect(bad.errors.map((e) => [e.row, e.column])).toEqual([[2, "customer_id"], [3, "sku"], [4, "unit_price"], [4, "valid_from"], [5, "valid_to"], [6, "minimum_quantity"]]);
      const overlapDb = await preview("price_agreements", H + "CUST100,BOLT-M8-30,11.00,2026-06-01,2027-06-01,1\n"); expect(overlapDb.errors[0].message).toMatch(/Overlaps existing agreement/);
      const overlapFile = await preview("price_agreements", H + "CUST100,BOLT-M8-30,11.00,2027-01-01,2027-06-01,5\nCUST100,BOLT-M8-30,12.00,2027-03-01,,5\n"); expect(overlapFile.errors).toEqual([expect.objectContaining({ row: 3, column: "valid_from" })]);
      const before = (await pool.query("SELECT data FROM price_agreements WHERE customer_id='CUST100' AND data->>'minimumQuantity'='1'")).rows[0].data;
      const upd = await apply("price_agreements", H + "CUST100,BOLT-M8-30,10.75,2026-01-01,2026-12-31,1\n"); expect(upd.counts).toMatchObject({ update: 1 }); expect(upd.sample[0].changedFields).toEqual(["unitPrice"]);
      const after = (await pool.query("SELECT data FROM price_agreements WHERE id=$1", [before.id])).rows[0].data; expect(after.unitPrice).toBe("10.75"); expect(after.version).not.toBe(before.version);
      expect(upd.bumpsCatalogueVersion).toBe(false);
    });
    it("imports, warns on ambiguity and deletes aliases", async () => {
      await apply("products", P + "BOLT-M8-30,\"M8 x 30 mm A2 stainless hex bolt, pack 100\",pack,12.50,diameter_mm=8\nNEW-1,New item,each,2.00,\n".replace("diameter_mm=8", "diameter_mm=8"));
      const r = await apply("aliases", "customer_id,alias,sku,delete\nCUST100,ex-1,BOLT-M8-30,\nCUST100,EX-1,NEW-1,\n");
      expect(r.counts.create).toBe(2); expect(r.warnings).toContainEqual(expect.objectContaining({ column: "alias", message: expect.stringContaining("maps to 2 SKUs") }));
      expect((await pool.query("SELECT alias FROM customer_aliases WHERE customer_id='CUST100' AND alias='EX-1'")).rowCount).toBe(2);
      const del = await apply("aliases", "customer_id,alias,sku,delete\nCUST100,EX-1,NEW-1,yes\nCUST100,GHOST,NEW-1,yes\n"); expect(del.counts).toMatchObject({ delete: 1, unchanged: 1 });
      expect((await pool.query("SELECT product_id FROM customer_aliases WHERE customer_id='CUST100' AND alias='EX-1'")).rows.map((x) => x.product_id)).toEqual(["BOLT-M8-30"]);
      expect((await preview("aliases", "customer_id,alias,sku\nCUST100,A,NOSKU\nNOPE,A,NEW-1\n,B,NEW-1\n")).errorRows).toBe(3);
    });
    it("imports stock and treats equal quantities as unchanged", async () => {
      expect((await apply("stock", "sku,available\nBOLT-M8-30,250\nNEW-1,12.5\n")).counts).toMatchObject({ unchanged: 1, create: 1 });
      expect((await apply("stock", "sku,available,as_of\nBOLT-M8-30,240,2026-10-29\n")).counts.update).toBe(1);
      expect((await preview("stock", "sku,available,as_of\nNOSKU,1,\nNEW-1,-3,\nNEW-1,1,yesterday\n")).errors.map((e) => [e.row, e.column])).toEqual([[2, "sku"], [3, "available"], [4, "as_of"]]);
    });
    it("validates and stores sender mappings in the order workflow table (and honours an override adapter)", async () => {
      const csv = await csvOf("sender_mappings");
      expect((await preview("sender_mappings", csv))).toMatchObject({ errors: [], counts: { create: 2 } });
      expect((await preview("sender_mappings", "sender,customer_id,trusted\nnope,CUST100,maybe\nok@x.test,NOPE,\n@gmail.com,CUST100,true\n")).errors.map((e) => [e.row, e.column])).toEqual([[2, "sender"], [2, "trusted"], [3, "customer_id"], [4, "trusted"]]);
      expect(await apply("sender_mappings", csv)).toMatchObject({ applied: true, counts: { create: 2 } });
      expect((await pool.query("SELECT kind,value,customer_id,trusted FROM sender_mappings ORDER BY kind")).rows).toEqual([{ kind: "domain", value: "example-engineering.co.uk", customer_id: "CUST100", trusted: false }, { kind: "email", value: "buyer@example-engineering.co.uk", customer_id: "CUST100", trusted: false }]);
      expect(await apply("sender_mappings", csv)).toMatchObject({ counts: { unchanged: 2, create: 0 } });
      expect(await apply("sender_mappings", "sender,customer_id,trusted\nBuyer@Example-Engineering.co.uk,CUST101,yes\n")).toMatchObject({ counts: { update: 1 } });
      expect((await pool.query("SELECT customer_id,trusted FROM sender_mappings WHERE kind='email'")).rows[0]).toEqual({ customer_id: "CUST101", trusted: true });
      const applied: imp.SenderMappingRow[][] = [];
      imp.registerSenderMappingAdapter({ plan: async (_c, rows) => ({ create: rows.length, update: 0, unchanged: 0 }), apply: async (_c, rows) => { applied.push(rows); } });
      try { await apply("sender_mappings", "sender,customer_id\nz@x.test,CUST100\n"); expect(applied[0][0]).toMatchObject({ pattern: "z@x.test", customerId: "CUST100" }); } finally { imp.registerSenderMappingAdapter(null); }
    });
    it("is admin-only and records an audit event", async () => {
      const viewer = asSession(await admin.insertUser({ email: "viewer-only@wholesale.test", name: "V", role: "viewer", password: PW }, "test"));
      await expect(imp.previewImport(viewer, { kind: "stock", csv: "sku,available\nA,1\n" })).rejects.toMatchObject(err(403));
      await expect(imp.applyImport(viewer, { kind: "stock", csv: "sku,available\nA,1\n" })).rejects.toMatchObject(err(403));
      await expect(imp.listImportBatches(viewer)).rejects.toMatchObject(err(403));
      expect(Number((await pool.query("SELECT count(*) FROM audit_events WHERE data->>'action'='import.applied'")).rows[0].count)).toBeGreaterThan(0);
      void audit;
    });
  });

  describe("server call sites (demo mode)", () => {
    it("is wired through the server's login/session/logout call sites", async () => {
      process.env.DEMO_MODE = "true"; await initialiseDatabase();
      const { token, session: s } = await login("admin@pennbridge.example", "admin-demo", { ip: "10.4.0.1" });
      expect(s.role).toBe("admin"); expect((await session(token))?.userId).toBe("admin");
      await logout(token); expect(await session(token)).toBeNull();
      for (let i = 0; i < 5; i++) await login("viewer@pennbridge.example", "wrong-password-x", { ip: "10.4.0.9" }).catch(() => undefined);
      await expect(login("viewer@pennbridge.example", "viewer-demo", { ip: "10.4.0.9" })).rejects.toMatchObject({ status: 429 });
    });
    it("serves the admin API routes with role checks", async () => {
      const { GET, POST, PATCH } = await import("../apps/web/app/api/[...path]/route");
      const { NextRequest } = await import("next/server");
      const call = async (fn: typeof GET, method: string, route: string, body?: unknown, cookie?: string) => {
        const req = new NextRequest(`http://localhost/api/${route}`, { method, headers: { "content-type": "application/json", host: "localhost", "x-forwarded-for": "198.51.100.7", ...(cookie ? { cookie: `pennbridge_session=${cookie}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
        const res = await fn(req, { params: Promise.resolve({ path: route.split("/") }) }); return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text(), res };
      };
      const loginAs = async (email: string, password: string) => { const r = await call(POST, "POST", "auth/login", { email, password }); return { r, token: r.res.cookies.get("pennbridge_session")?.value }; };
      expect((await loginAs("admin@pennbridge.example", "wrong-password-x")).r.status).toBe(401);
      const adminToken = (await loginAs("admin@pennbridge.example", "admin-demo")).token!;
      const reviewerToken = (await loginAs("reviewer@pennbridge.example", "reviewer-demo")).token!;
      expect((await call(GET, "GET", "admin/users")).status).toBe(401);
      expect((await call(GET, "GET", "admin/users", undefined, reviewerToken)).status).toBe(403);
      expect((await call(POST, "POST", "admin/import/preview", { kind: "stock", csv: "sku,available\nA,1\n" }, reviewerToken)).status).toBe(403);
      const created = await call(POST, "POST", "admin/users", { email: "api@wholesale.test", name: "Api", role: "viewer", password: PW }, adminToken);
      expect(created.status).toBe(201); expect(JSON.stringify(created.body)).not.toMatch(/hash|\$2[aby]\$/i);
      expect((await call(POST, "POST", "admin/users", { email: "api@wholesale.test", name: "Api", role: "viewer", password: "short" }, adminToken)).status).toBe(400);
      expect((await call(PATCH, "PATCH", `admin/users/${created.body.id}`, { role: "reviewer" }, adminToken)).body.role).toBe("reviewer");
      expect((await call(POST, "POST", `admin/users/${created.body.id}/password`, { password: "route-reset-password" }, adminToken)).body).toEqual({ revokedSessions: 0 });
      const own = await loginAs("api@wholesale.test", "route-reset-password");
      expect((await call(POST, "POST", "auth/password", { currentPassword: "route-reset-password", newPassword: "route-own-password" }, own.token)).status).toBe(200);
      const bad = await call(POST, "POST", "admin/import/apply", { kind: "stock", csv: "sku,available\nNOSKU,1\n" }, adminToken);
      expect(bad.status).toBe(422); expect(bad.body).toMatchObject({ applied: false, errors: [{ row: 2, column: "sku" }] });
      expect((await call(POST, "POST", "admin/import/preview", { kind: "stock", csv: "sku,available\nNEW-1,3\n" }, adminToken)).body).toMatchObject({ dryRun: true, errors: [] });
      expect((await call(GET, "GET", "admin/import/templates/products", undefined, adminToken)).body).toMatch(/^sku,description,selling_unit,list_price/);
      expect((await call(GET, "GET", "admin/import/templates", undefined, adminToken)).body.kinds).toHaveLength(7);
      expect((await call(GET, "GET", "admin/import/batches", undefined, adminToken)).body.batches.length).toBeGreaterThan(0);
      expect((await pool.query("SELECT ip FROM sessions WHERE token_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1")).rows[0].ip).toBe("198.51.100.7");
    });
  });
});
