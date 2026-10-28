import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import Decimal from "decimal.js";
import { z } from "zod";
import { DateSchema, UnitSchema, type Address, type Customer, type PriceAgreement, type Product, type Session } from "@pennbridge/contracts";
import { audit, id, pool, transaction, type DbClient } from "@pennbridge/db";
import { currentCatalogueVersion } from "@pennbridge/db/seed";
import { canonicalJson, ServiceError } from "@pennbridge/domain";
import { requireAdmin } from "./admin";

export const IMPORT_KINDS = ["products", "customers", "addresses", "price_agreements", "aliases", "stock", "sender_mappings"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
export const ImportRequestSchema = z.object({ kind: z.enum(IMPORT_KINDS), csv: z.string().min(1).max(12_000_000), filename: z.string().max(250).optional() }).strict();
export type ImportRequest = z.infer<typeof ImportRequestSchema>;

export type RowIssue = { row: number; column: string | null; message: string };
export type ImportAction = "create" | "update" | "unchanged" | "delete";
export type ImportResult = {
  kind: ImportKind; dryRun: boolean; applied: boolean; batchId: string | null;
  totalRows: number; validRows: number; errorRows: number;
  errors: RowIssue[]; warnings: RowIssue[]; errorsTruncated: boolean;
  counts: Record<ImportAction, number>;
  bumpsCatalogueVersion: boolean; catalogueVersion: string; newCatalogueVersion: string | null;
  sample: { row: number; key: string; action: ImportAction; changedFields?: string[] }[];
};
export const MAX_IMPORT_ROWS = 100_000; const MAX_ISSUES = 500;
const IMPORT_LOCK = 57282120;
const prefix = () => (process.env.ODOO_EXTERNAL_ID_PREFIX || "pennbridge").replace(/[^A-Za-z0-9_]/g, "");

/** Column documentation; also the source of docs/import-templates/*.csv (a test keeps them in sync). */
export const IMPORT_TEMPLATES: Record<ImportKind, { required: string[]; optional: string[]; example: string[][] }> = {
  products: { required: ["sku", "description", "selling_unit", "list_price"], optional: ["family", "category", "units_per_pack", "manufacturer_reference", "active", "attributes", "external_id"],
    example: [["BOLT-M8-30", "M8 x 30 mm A2 stainless hex bolt, pack 100", "pack", "12.00", "hex_bolt", "fasteners", "100", "MFR-0830", "true", "diameter_mm=8;length_mm=30;material=A2 stainless", ""]] },
  customers: { required: ["id", "name"], optional: ["status", "approved_senders", "external_id"], example: [["CUST100", "Example Engineering Ltd", "active", "buyer@example-engineering.co.uk;ap@example-engineering.co.uk", ""]] },
  addresses: { required: ["customer_id", "code", "address"], optional: ["id", "approved", "external_id"], example: [["CUST100", "MAIN", "Unit 4, Example Park, Reading RG1 1AA", "", "true", ""]] },
  price_agreements: { required: ["customer_id", "sku", "unit_price", "valid_from"], optional: ["minimum_quantity", "valid_to", "id"], example: [["CUST100", "BOLT-M8-30", "10.50", "2026-01-01", "1", "2026-12-31", ""], ["CUST100", "BOLT-M8-30", "9.75", "2026-01-01", "10", "2026-12-31", ""]] },
  aliases: { required: ["customer_id", "alias", "sku"], optional: ["delete", "id"], example: [["CUST100", "EX-BOLT-8", "BOLT-M8-30", "", ""]] },
  stock: { required: ["sku", "available"], optional: ["as_of"], example: [["BOLT-M8-30", "250", "2026-10-28T09:00:00Z"]] },
  sender_mappings: { required: ["sender", "customer_id"], optional: ["trusted"], example: [["buyer@example-engineering.co.uk", "CUST100", "false"], ["@example-engineering.co.uk", "CUST100", "false"]] },
};
/** Column order of a template: required first, then optional; example rows are written in this order. */
export function templateColumns(kind: ImportKind) { const t = IMPORT_TEMPLATES[kind]; return [...t.required, ...t.optional]; }
const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export function templateCsv(kind: ImportKind): string {
  return [templateColumns(kind), ...IMPORT_TEMPLATES[kind].example].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------------------------- sender mappings hook
export type SenderMappingRow = { row: number; pattern: string; customerId: string; trusted: boolean };
/**
 * Sender->customer storage is W2's `sender_mappings` table (migration 010); the default adapter below writes it with the same rules as
 * upsertSenderMapping (lower-cased, unique(kind,value), no trusted freemail domains). Register another adapter only to override that.
 */
export interface SenderMappingAdapter {
  plan(client: DbClient, rows: SenderMappingRow[]): Promise<{ create: number; update: number; unchanged: number; issues?: RowIssue[] }>;
  apply(client: DbClient, rows: SenderMappingRow[]): Promise<void>;
}
const FREEMAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "btinternet.com", "sky.com"]);
const split = (pattern: string) => (pattern.startsWith("@") ? { kind: "domain", value: pattern.slice(1) } : { kind: "email", value: pattern });
const defaultSenderAdapter: SenderMappingAdapter = {
  async plan(client, rows) {
    const issues: RowIssue[] = []; let create = 0, update = 0, unchanged = 0;
    const found = (await client.query("SELECT kind,value,customer_id,trusted FROM sender_mappings WHERE value=ANY($1)", [rows.map((r) => split(r.pattern).value)])).rows;
    for (const r of rows) {
      const { kind, value } = split(r.pattern); const old = found.find((f) => f.kind === kind && f.value === value);
      if (kind === "domain" && r.trusted && FREEMAIL.has(value)) { issues.push({ row: r.row, column: "trusted", message: "A public mail provider domain cannot be trusted; map individual addresses instead" }); continue; }
      if (!old) create++; else if (old.customer_id !== r.customerId || old.trusted !== r.trusted) update++; else unchanged++;
    }
    return { create, update, unchanged, issues };
  },
  async apply(client, rows) {
    await client.query(`INSERT INTO sender_mappings(id,kind,value,customer_id,trusted,created_by) SELECT x->>'id',x->>'kind',x->>'value',x->>'customerId',(x->>'trusted')::boolean,'csv-import' FROM jsonb_array_elements($1::jsonb) x
      ON CONFLICT(kind,value) DO UPDATE SET customer_id=excluded.customer_id,trusted=excluded.trusted,created_by=excluded.created_by`,
      [JSON.stringify(rows.map((r) => ({ id: id("sender"), ...split(r.pattern), customerId: r.customerId, trusted: r.trusted })))]);
  },
};
let senderAdapter: SenderMappingAdapter | null = null;
export const registerSenderMappingAdapter = (adapter: SenderMappingAdapter | null) => { senderAdapter = adapter; };

// ---------------------------------------------------------------------------------------------------------------- parsing helpers
type Data = Record<string, string>;
type Entry = { row: number; key: string; action: ImportAction; changed?: string[] };
type Plan = { issues: RowIssue[]; warnings: RowIssue[]; entries: Entry[]; totalRows: number; validRows: number; apply: (client: DbClient, ctx: Ctx) => Promise<void>; bumps?: boolean };
type Ctx = { version: string; newVersion: string };

const norm = (h: string) => h.trim().toLowerCase().replace(/^﻿/, "").replace(/[\s-]+/g, "_");
function parseCsv(text: string, kind: ImportKind): { rows: { row: number; data: Data }[]; present: Set<string>; issues: RowIssue[]; warnings: RowIssue[] } {
  const issues: RowIssue[] = []; const warnings: RowIssue[] = [];
  let records: Data[] = [];
  try {
    records = parse(text, { columns: (h: string[]) => h.map(norm), skip_empty_lines: true, bom: true, trim: true, relax_column_count: false, max_record_size: 200_000 });
  } catch (e: any) { issues.push({ row: Number(e.lines) || 1, column: null, message: `CSV could not be read: ${String(e.message).slice(0, 200)}` }); return { rows: [], present: new Set(), issues, warnings }; }
  const present = new Set(records.length ? Object.keys(records[0]) : text.split(/\r?\n/)[0].split(",").map(norm));
  const known = new Set(templateColumns(kind));
  for (const column of IMPORT_TEMPLATES[kind].required) if (!present.has(column)) issues.push({ row: 1, column, message: `Missing required column "${column}"` });
  for (const column of present) if (column && !known.has(column)) warnings.push({ row: 1, column, message: `Unknown column "${column}" is ignored` });
  if (records.length > MAX_IMPORT_ROWS) issues.push({ row: 1, column: null, message: `At most ${MAX_IMPORT_ROWS} rows per import` });
  if (!records.length && !issues.length) issues.push({ row: 1, column: null, message: "File has a header but no data rows" });
  return { rows: records.map((data, i) => ({ row: i + 2, data })), present, issues, warnings };
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const BOOL_TRUE = new Set(["true", "yes", "y", "1"]); const BOOL_FALSE = new Set(["false", "no", "n", "0"]);
function boolean(value: string, fallback: boolean): boolean | null { if (!value) return fallback; const v = value.toLowerCase(); return BOOL_TRUE.has(v) ? true : BOOL_FALSE.has(v) ? false : null; }
const money = (v: string) => (/^\d{1,12}(\.\d{1,2})?$/.test(v) ? new Decimal(v).toFixed(2) : null);
const quantityOf = (v: string) => (/^\d{1,12}(\.\d{1,6})?$/.test(v) ? new Decimal(v).toFixed() : null);
const EMAIL = /^[^\s@;,]+@[^\s@;,]+\.[^\s@;,]+$/;
function changedFields(before: any, after: any, ignore: string[] = []): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((k) => !ignore.includes(k) && canonicalJson(before?.[k] ?? null) !== canonicalJson(after?.[k] ?? null));
}
class Collector {
  issues: RowIssue[] = []; warnings: RowIssue[] = []; entries: Entry[] = []; bad = new Set<number>(); seen = new Map<string, number>();
  err(row: number, column: string | null, message: string) { this.issues.push({ row, column, message }); this.bad.add(row); }
  warn(row: number, column: string | null, message: string) { this.warnings.push({ row, column, message }); }
  /** Rejects the second occurrence of a key inside one file (keeps last-write-wins ambiguity out of imports). */
  unique(row: number, key: string, column: string): boolean { const first = this.seen.get(key); if (first !== undefined) { this.err(row, column, `Duplicate of row ${first}`); return false; } this.seen.set(key, row); return true; }
}
const IDENT = /^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,63}$/;
function ident(c: Collector, row: number, column: string, value: string | undefined): string | null {
  if (!value) { c.err(row, column, `"${column}" is required`); return null; }
  if (!IDENT.test(value)) { c.err(row, column, `"${column}" may contain only letters, digits and . _ / - (max 64)`); return null; }
  return value;
}
function text(c: Collector, row: number, column: string, value: string | undefined, max = 500, required = true): string | null {
  if (!value) { if (required) c.err(row, column, `"${column}" is required`); return null; }
  if (value.length > max) { c.err(row, column, `"${column}" is longer than ${max} characters`); return null; }
  return value;
}
function finish(c: Collector, totalRows: number, apply: Plan["apply"], bumps = false): Plan {
  return { issues: c.issues, warnings: c.warnings, entries: c.entries, totalRows, validRows: totalRows - c.bad.size, apply, bumps };
}
const attributesOf = (c: Collector, row: number, raw: string): Record<string, string | number | boolean> | null => {
  if (!raw) return {};
  try {
    if (raw.startsWith("{")) { const parsed = JSON.parse(raw); const ok = parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.values(parsed).every((v) => ["string", "number", "boolean"].includes(typeof v)); if (!ok) throw new Error(); return parsed; }
    const out: Record<string, string | number | boolean> = {};
    for (const pair of raw.split(";").map((s) => s.trim()).filter(Boolean)) {
      const at = pair.indexOf("="); if (at < 1) throw new Error();
      const key = pair.slice(0, at).trim(), value = pair.slice(at + 1).trim();
      out[key] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value === "true" ? true : value === "false" ? false : value;
    }
    return out;
  } catch { c.err(row, "attributes", 'Attributes must be JSON like {"length_mm":30} or key=value pairs separated by ;'); return null; }
};

// ---------------------------------------------------------------------------------------------------------------- per-kind planners
async function planProducts(client: DbClient, rows: { row: number; data: Data }[], present: Set<string>, ctx: Ctx): Promise<Plan> {
  const c = new Collector(); const built: { row: number; product: Product }[] = [];
  const existing = new Map<string, Product>((await client.query("SELECT sku,data FROM products WHERE sku=ANY($1)", [rows.map((r) => r.data.sku).filter(Boolean)])).rows.map((r) => [r.sku, r.data]));
  for (const { row, data } of rows) {
    const sku = ident(c, row, "sku", data.sku); const description = text(c, row, "description", data.description);
    const unit = UnitSchema.safeParse(data.selling_unit); if (!unit.success) c.err(row, "selling_unit", `selling_unit must be one of ${UnitSchema.options.join(", ")}`);
    const price = money(data.list_price ?? ""); if (!price) c.err(row, "list_price", "list_price must be a non-negative amount with at most 2 decimals, e.g. 12.50");
    const perPack = quantityOf(data.units_per_pack || "1"); if (!perPack || !/[1-9]/.test(perPack)) c.err(row, "units_per_pack", "units_per_pack must be a positive number");
    const active = boolean(data.active ?? "", true); if (active === null) c.err(row, "active", "active must be true or false");
    const attributes = attributesOf(c, row, data.attributes ?? "");
    const family = text(c, row, "family", data.family || "general", 100); const category = text(c, row, "category", data.category || family?.split("_")[0] || "general", 100);
    const manufacturerReference = text(c, row, "manufacturer_reference", data.manufacturer_reference, 100, false);
    const externalId = data.external_id || undefined; if (externalId && !/^[A-Za-z0-9_.]{1,100}$/.test(externalId)) c.err(row, "external_id", "external_id may contain only letters, digits, _ and .");
    if (!sku || !description || !unit.success || !price || !perPack || active === null || !attributes || !family || !category || c.bad.has(row) || !c.unique(row, sku, "sku")) continue;
    const old = existing.get(sku);
    const sellingUnit = unit.data;
    built.push({ row, product: {
      id: old?.id ?? sku, externalId: externalId ?? old?.externalId ?? `${prefix()}.product_${sku}`, sku, manufacturerReference: manufacturerReference ?? null,
      description, category, family, attributes, active, sellingUnit, unitsPerPack: perPack, physicalUnit: ["pack", "box"].includes(sellingUnit) ? "each" : sellingUnit,
      allowsFractionalQuantity: !!attributes.decimal_quantity || ["metre", "litre", "kg"].includes(sellingUnit), listPrice: price, currency: "GBP", catalogueVersion: ctx.version } });
  }
  const changes: Product[] = [];
  for (const { row, product } of built) {
    const old = existing.get(product.sku);
    const fields = old ? changedFields(old, product, ["catalogueVersion"]) : [];
    const action: ImportAction = !old ? "create" : fields.length ? "update" : "unchanged";
    c.entries.push({ row, key: product.sku, action, changed: fields }); if (action !== "unchanged") changes.push(product);
  }
  const bump = changes.length > 0; void present;
  return finish(c, rows.length, async (tx, k) => {
    if (!bump) return;
    const stamped = changes.map((p) => ({ ...p, catalogueVersion: k.newVersion }));
    await tx.query(`INSERT INTO products(id,sku,manufacturer_reference,family,description,active,data) SELECT x->>'id',x->>'sku',x->>'manufacturerReference',x->>'family',x->>'description',(x->>'active')::boolean,x FROM jsonb_array_elements($1::jsonb) x
      ON CONFLICT(id) DO UPDATE SET sku=excluded.sku,manufacturer_reference=excluded.manufacturer_reference,family=excluded.family,description=excluded.description,active=excluded.active,data=excluded.data`, [JSON.stringify(stamped)]);
    // A product change moves the whole catalogue to a new version so approved-but-unexported orders must be revalidated (see export STALE_CATALOGUE guard).
    await tx.query("UPDATE products SET data=jsonb_set(data,'{catalogueVersion}',to_jsonb($1::text)) WHERE data->>'catalogueVersion' IS DISTINCT FROM $1", [k.newVersion]);
    await tx.query("UPDATE customers SET data=jsonb_set(data,'{catalogueVersion}',to_jsonb($1::text)) WHERE data->>'catalogueVersion' IS DISTINCT FROM $1", [k.newVersion]);
    await tx.query("INSERT INTO catalogue_versions(version,note) VALUES($1,$2)", [k.newVersion, `products import: ${changes.length} changed`]);
  }, bump);
}

async function planCustomers(client: DbClient, rows: { row: number; data: Data }[], present: Set<string>, ctx: Ctx): Promise<Plan> {
  const c = new Collector(); const built: Customer[] = [];
  const existing = new Map<string, Customer>((await client.query("SELECT id,data FROM customers WHERE id=ANY($1)", [rows.map((r) => r.data.id).filter(Boolean)])).rows.map((r) => [r.id, r.data]));
  const rowOf = new Map<string, number>();
  for (const { row, data } of rows) {
    const cid = ident(c, row, "id", data.id); const name = text(c, row, "name", data.name, 200);
    const status = (data.status || "active").toLowerCase(); if (!["active", "credit_hold"].includes(status)) c.err(row, "status", "status must be active or credit_hold");
    const senders = (data.approved_senders ?? "").split(/[;,\s]+/).filter(Boolean).map((s) => s.toLowerCase());
    for (const s of senders) if (!EMAIL.test(s)) c.err(row, "approved_senders", `"${s}" is not an email address`);
    if (!cid || !name || c.bad.has(row) || !c.unique(row, cid, "id")) continue;
    const old = existing.get(cid);
    // Merge so fields owned by other modules survive; blank approved_senders only clears when the column exists.
    built.push({ ...(old ?? {}), id: cid, externalId: data.external_id || old?.externalId || `${prefix()}.partner_${cid}`, name, onHold: status === "credit_hold",
      approvedSenders: present.has("approved_senders") ? [...new Set(senders)] : old?.approvedSenders ?? [], catalogueVersion: old?.catalogueVersion ?? ctx.version });
    rowOf.set(cid, row);
  }
  const changes: Customer[] = [];
  for (const customer of built) {
    const old = existing.get(customer.id); const fields = old ? changedFields(old, customer) : [];
    const action: ImportAction = !old ? "create" : fields.length ? "update" : "unchanged";
    c.entries.push({ row: rowOf.get(customer.id)!, key: customer.id, action, changed: fields }); if (action !== "unchanged") changes.push(customer);
  }
  return finish(c, rows.length, async (tx) => { if (changes.length) await tx.query("INSERT INTO customers(id,data) SELECT x->>'id',x FROM jsonb_array_elements($1::jsonb) x ON CONFLICT(id) DO UPDATE SET data=excluded.data", [JSON.stringify(changes)]); });
}

async function customerIds(client: DbClient, ids: string[]): Promise<Set<string>> {
  return new Set((await client.query("SELECT id FROM customers WHERE id=ANY($1)", [ids])).rows.map((r) => r.id));
}
async function productIdsBySku(client: DbClient, skus: string[]): Promise<Map<string, string>> {
  return new Map((await client.query("SELECT sku,id FROM products WHERE sku=ANY($1)", [skus])).rows.map((r) => [r.sku, r.id]));
}

async function planAddresses(client: DbClient, rows: { row: number; data: Data }[]): Promise<Plan> {
  const c = new Collector(); const known = await customerIds(client, rows.map((r) => r.data.customer_id).filter(Boolean));
  const ids = rows.map((r) => r.data.id || `ADDR-${r.data.customer_id}-${r.data.code}`);
  const existing = new Map<string, Address>((await client.query("SELECT id,data FROM addresses WHERE id=ANY($1)", [ids])).rows.map((r) => [r.id, r.data]));
  const built: { row: number; address: Address }[] = [];
  for (const { row, data } of rows) {
    const customerId = data.customer_id; if (!customerId) c.err(row, "customer_id", '"customer_id" is required'); else if (!known.has(customerId)) c.err(row, "customer_id", `Unknown customer "${customerId}" (import customers first)`);
    const code = ident(c, row, "code", data.code); const formatted = text(c, row, "address", data.address, 500);
    const approved = boolean(data.approved ?? "", true); if (approved === null) c.err(row, "approved", "approved must be true or false");
    if (data.id && !IDENT.test(data.id)) c.err(row, "id", "id may contain only letters, digits and . _ / -");
    if (c.bad.has(row) || !code || !formatted || approved === null) continue;
    const aid = data.id || `ADDR-${customerId}-${code}`;
    if (!c.unique(row, `${customerId}|${code}`, "code") || !c.unique(row, `id|${aid}`, "id")) continue;
    const old = existing.get(aid);
    if (old && old.customerId !== customerId) { c.err(row, "id", `Address id "${aid}" already belongs to customer ${old.customerId}`); continue; }
    built.push({ row, address: { id: aid, customerId, externalId: data.external_id || old?.externalId || `${prefix()}.address_${customerId}_${code}`, label: code, formatted, approved } });
  }
  const changes: Address[] = [];
  for (const { row, address } of built) {
    const old = existing.get(address.id); const fields = old ? changedFields(old, address) : [];
    const action: ImportAction = !old ? "create" : fields.length ? "update" : "unchanged";
    c.entries.push({ row, key: address.id, action, changed: fields }); if (action !== "unchanged") changes.push(address);
  }
  return finish(c, rows.length, async (tx) => { if (changes.length) await tx.query("INSERT INTO addresses(id,customer_id,data) SELECT x->>'id',x->>'customerId',x FROM jsonb_array_elements($1::jsonb) x ON CONFLICT(id) DO UPDATE SET data=excluded.data", [JSON.stringify(changes)]); });
}

async function planPrices(client: DbClient, rows: { row: number; data: Data }[]): Promise<Plan> {
  const c = new Collector(); const known = await customerIds(client, rows.map((r) => r.data.customer_id).filter(Boolean));
  const skus = await productIdsBySku(client, rows.map((r) => r.data.sku).filter(Boolean));
  const stored = (await client.query("SELECT id,data FROM price_agreements WHERE customer_id=ANY($1) AND product_id=ANY($2)", [[...known], [...skus.values()]])).rows.map((r) => r.data as PriceAgreement);
  const byId = new Map(stored.map((p) => [p.id, p]));
  const built: { row: number; price: PriceAgreement; old?: PriceAgreement }[] = [];
  const overlaps = (a: PriceAgreement, b: PriceAgreement) => a.customerId === b.customerId && a.productId === b.productId && new Decimal(a.minimumQuantity).eq(b.minimumQuantity) && a.validFrom <= (b.validTo ?? "9999-12-31") && b.validFrom <= (a.validTo ?? "9999-12-31");
  for (const { row, data } of rows) {
    const customerId = data.customer_id; if (!customerId) c.err(row, "customer_id", '"customer_id" is required'); else if (!known.has(customerId)) c.err(row, "customer_id", `Unknown customer "${customerId}"`);
    const productId = data.sku ? skus.get(data.sku) : undefined; if (!data.sku) c.err(row, "sku", '"sku" is required'); else if (!productId) c.err(row, "sku", `Unknown SKU "${data.sku}" (import products first)`);
    const unitPrice = money(data.unit_price ?? ""); if (!unitPrice) c.err(row, "unit_price", "unit_price must be an amount with at most 2 decimals, e.g. 9.75");
    const minimumQuantity = quantityOf(data.minimum_quantity || "1"); if (!minimumQuantity || !/[1-9]/.test(minimumQuantity)) c.err(row, "minimum_quantity", "minimum_quantity must be a positive number");
    const from = DateSchema.safeParse(data.valid_from); if (!from.success) c.err(row, "valid_from", "valid_from must be a valid date YYYY-MM-DD");
    const to = data.valid_to ? DateSchema.safeParse(data.valid_to) : null; if (to && !to.success) c.err(row, "valid_to", "valid_to must be a valid date YYYY-MM-DD");
    if (from.success && to?.success && to.data < from.data) c.err(row, "valid_to", "valid_to is before valid_from");
    if (data.id && !IDENT.test(data.id)) c.err(row, "id", "id may contain only letters, digits and . _ / -");
    if (c.bad.has(row) || !customerId || !productId || !unitPrice || !minimumQuantity || !from.success) continue;
    const pid = data.id || `PRICE-${customerId}-${data.sku}-${from.data}-${minimumQuantity}`;
    if (!c.unique(row, pid, "id")) continue;
    const base = { id: pid, customerId, productId, validFrom: from.data, validTo: to?.success ? to.data : null, minimumQuantity, unitPrice, currency: "GBP" as const };
    const old = byId.get(pid);
    // Version moves with content so an order priced from an earlier agreement is detectably different.
    const price: PriceAgreement = { ...base, version: `${pid}#${sha(canonicalJson(base)).slice(0, 8)}` };
    built.push({ row, price, old });
  }
  for (let i = 0; i < built.length; i++) {
    const a = built[i].price;
    for (let j = i + 1; j < built.length; j++) if (overlaps(a, built[j].price)) { c.err(built[j].row, "valid_from", `Overlaps the agreement in row ${built[i].row} (same customer, SKU and minimum quantity)`); }
    for (const other of stored) if (other.id !== a.id && overlaps(a, other)) c.err(built[i].row, "valid_from", `Overlaps existing agreement ${other.id}; end-date it first (same customer, SKU and minimum quantity)`);
  }
  const changes: PriceAgreement[] = [];
  for (const { row, price, old } of built) {
    if (c.bad.has(row)) continue;
    const fields = old ? changedFields(old, price, ["version"]) : [];
    const action: ImportAction = !old ? "create" : fields.length ? "update" : "unchanged";
    c.entries.push({ row, key: price.id, action, changed: fields }); if (action !== "unchanged") changes.push(price);
  }
  return finish(c, rows.length, async (tx) => { if (changes.length) await tx.query("INSERT INTO price_agreements(id,customer_id,product_id,valid_from,valid_to,minimum_quantity,data) SELECT x->>'id',x->>'customerId',x->>'productId',(x->>'validFrom')::date,(x->>'validTo')::date,(x->>'minimumQuantity')::numeric,x FROM jsonb_array_elements($1::jsonb) x ON CONFLICT(id) DO UPDATE SET valid_from=excluded.valid_from,valid_to=excluded.valid_to,minimum_quantity=excluded.minimum_quantity,data=excluded.data", [JSON.stringify(changes)]); });
}

async function planAliases(client: DbClient, rows: { row: number; data: Data }[]): Promise<Plan> {
  const c = new Collector(); const known = await customerIds(client, rows.map((r) => r.data.customer_id).filter(Boolean));
  const skus = await productIdsBySku(client, rows.map((r) => r.data.sku).filter(Boolean));
  const stored = (await client.query("SELECT id,customer_id,alias,product_id FROM customer_aliases WHERE customer_id=ANY($1)", [[...known]])).rows;
  const tripleOf = (cust: string, alias: string, product: string) => `${cust}|${alias}|${product}`;
  const storedKeys = new Set(stored.map((r) => tripleOf(r.customer_id, r.alias, r.product_id)));
  const creates: { id: string; customer_id: string; alias: string; product_id: string }[] = []; const deletes: { customer_id: string; alias: string; product_id: string }[] = [];
  const perAlias = new Map<string, Set<string>>(); for (const r of stored) { const k = `${r.customer_id}|${r.alias}`; (perAlias.get(k) ?? perAlias.set(k, new Set()).get(k)!).add(r.product_id); }
  for (const { row, data } of rows) {
    const customerId = data.customer_id; if (!customerId) c.err(row, "customer_id", '"customer_id" is required'); else if (!known.has(customerId)) c.err(row, "customer_id", `Unknown customer "${customerId}"`);
    const alias = text(c, row, "alias", data.alias, 100)?.toUpperCase();
    const productId = data.sku ? skus.get(data.sku) : undefined; if (!data.sku) c.err(row, "sku", '"sku" is required'); else if (!productId) c.err(row, "sku", `Unknown SKU "${data.sku}"`);
    const del = boolean(data.delete ?? "", false); if (del === null) c.err(row, "delete", "delete must be true or false");
    if (c.bad.has(row) || !customerId || !alias || !productId) continue;
    if (!c.unique(row, tripleOf(customerId, alias, productId), "alias")) continue;
    const exists = storedKeys.has(tripleOf(customerId, alias, productId));
    if (del) { c.entries.push({ row, key: `${customerId} ${alias}`, action: exists ? "delete" : "unchanged" }); if (exists) { deletes.push({ customer_id: customerId, alias, product_id: productId }); perAlias.get(`${customerId}|${alias}`)?.delete(productId); } continue; }
    c.entries.push({ row, key: `${customerId} ${alias}`, action: exists ? "unchanged" : "create" });
    if (!exists) { creates.push({ id: data.id || `ALIAS-${sha(tripleOf(customerId, alias, productId)).slice(0, 12)}`, customer_id: customerId, alias, product_id: productId }); (perAlias.get(`${customerId}|${alias}`) ?? perAlias.set(`${customerId}|${alias}`, new Set()).get(`${customerId}|${alias}`)!).add(productId); }
  }
  for (const [k, set] of perAlias) if (set.size > 1) { const entryRow = rows.find((r) => `${r.data.customer_id}|${(r.data.alias ?? "").toUpperCase()}` === k)?.row ?? 1; c.warn(entryRow, "alias", `Alias ${k.split("|")[1]} maps to ${set.size} SKUs for ${k.split("|")[0]}; orders using it will need review`); }
  return finish(c, rows.length, async (tx) => {
    if (creates.length) await tx.query("INSERT INTO customer_aliases(id,customer_id,alias,product_id) SELECT x->>'id',x->>'customer_id',x->>'alias',x->>'product_id' FROM jsonb_array_elements($1::jsonb) x ON CONFLICT DO NOTHING", [JSON.stringify(creates)]);
    if (deletes.length) await tx.query("DELETE FROM customer_aliases a USING jsonb_array_elements($1::jsonb) x WHERE a.customer_id=x->>'customer_id' AND a.alias=x->>'alias' AND a.product_id=x->>'product_id'", [JSON.stringify(deletes)]);
  });
}

async function planStock(client: DbClient, rows: { row: number; data: Data }[]): Promise<Plan> {
  const c = new Collector(); const skus = await productIdsBySku(client, rows.map((r) => r.data.sku).filter(Boolean));
  const existing = new Map((await client.query("SELECT product_id,data FROM stock_snapshots WHERE product_id=ANY($1)", [[...skus.values()]])).rows.map((r) => [r.product_id, r.data]));
  const changes: { productId: string; availableQuantity: string; observedAt: string }[] = []; const now = new Date().toISOString();
  for (const { row, data } of rows) {
    const productId = data.sku ? skus.get(data.sku) : undefined; if (!data.sku) c.err(row, "sku", '"sku" is required'); else if (!productId) c.err(row, "sku", `Unknown SKU "${data.sku}"`);
    const available = quantityOf(data.available ?? ""); if (!available) c.err(row, "available", "available must be a non-negative number");
    let observedAt = now; if (data.as_of) { const t = new Date(data.as_of); if (Number.isNaN(t.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(data.as_of)) c.err(row, "as_of", "as_of must be an ISO date or datetime, e.g. 2026-10-28T09:00:00Z"); else observedAt = t.toISOString(); }
    if (c.bad.has(row) || !productId || !available || !c.unique(row, data.sku, "sku")) continue;
    const old = existing.get(productId);
    // Without as_of every re-import would "update" every row; treat equal quantity as unchanged.
    const same = old && new Decimal(old.availableQuantity).eq(available) && (!data.as_of || old.observedAt === observedAt);
    c.entries.push({ row, key: data.sku, action: !old ? "create" : same ? "unchanged" : "update", changed: old && !same ? changedFields({ availableQuantity: old.availableQuantity, observedAt: old.observedAt }, { availableQuantity: available, observedAt }) : [] });
    if (!same) changes.push({ productId, availableQuantity: available, observedAt });
  }
  return finish(c, rows.length, async (tx) => { if (changes.length) await tx.query("INSERT INTO stock_snapshots(product_id,data) SELECT x->>'productId',x FROM jsonb_array_elements($1::jsonb) x ON CONFLICT(product_id) DO UPDATE SET data=excluded.data", [JSON.stringify(changes)]); });
}

async function planSenderMappings(client: DbClient, rows: { row: number; data: Data }[]): Promise<Plan> {
  const c = new Collector(); const known = await customerIds(client, rows.map((r) => r.data.customer_id).filter(Boolean)); const valid: SenderMappingRow[] = [];
  for (const { row, data } of rows) {
    const pattern = (data.sender ?? "").toLowerCase();
    if (!pattern) c.err(row, "sender", '"sender" is required'); else if (!(EMAIL.test(pattern) || /^@[^\s@;,]+\.[^\s@;,]+$/.test(pattern))) c.err(row, "sender", "sender must be an email address or a domain written as @example.com");
    if (!data.customer_id) c.err(row, "customer_id", '"customer_id" is required'); else if (!known.has(data.customer_id)) c.err(row, "customer_id", `Unknown customer "${data.customer_id}"`);
    const trusted = boolean(data.trusted ?? "", false); if (trusted === null) c.err(row, "trusted", "trusted must be true or false");
    if (trusted && pattern.startsWith("@")) c.warn(row, "trusted", "Trusting a whole domain accepts any sender at that domain; email From headers can be forged");
    if (c.bad.has(row) || trusted === null || !c.unique(row, pattern, "sender")) continue;
    valid.push({ row, pattern, customerId: data.customer_id, trusted });
  }
  const adapter = senderAdapter ?? defaultSenderAdapter; const planned = await adapter.plan(client, valid);
  for (const issue of planned.issues ?? []) c.err(issue.row, issue.column, issue.message);
  // The adapter reports aggregate counts; spread them over valid rows for the preview.
  let create = planned.create, update = planned.update;
  for (const v of valid) { const action: ImportAction = create-- > 0 ? "create" : update-- > 0 ? "update" : "unchanged"; c.entries.push({ row: v.row, key: v.pattern, action }); }
  return finish(c, rows.length, (tx) => adapter.apply(tx, valid));
}

// ---------------------------------------------------------------------------------------------------------------- public API
async function buildPlan(client: DbClient, kind: ImportKind, csv: string, ctx: Ctx): Promise<Plan> {
  const parsed = parseCsv(csv, kind);
  if (parsed.issues.length) return { issues: parsed.issues, warnings: parsed.warnings, entries: [], totalRows: parsed.rows.length, validRows: 0, apply: async () => undefined };
  const planners: Record<ImportKind, () => Promise<Plan>> = {
    products: () => planProducts(client, parsed.rows, parsed.present, ctx), customers: () => planCustomers(client, parsed.rows, parsed.present, ctx), addresses: () => planAddresses(client, parsed.rows),
    price_agreements: () => planPrices(client, parsed.rows), aliases: () => planAliases(client, parsed.rows), stock: () => planStock(client, parsed.rows), sender_mappings: () => planSenderMappings(client, parsed.rows),
  };
  const plan = await planners[kind]();
  plan.warnings.unshift(...parsed.warnings);
  return plan;
}
function summarise(kind: ImportKind, plan: Plan, ctx: Ctx, dryRun: boolean, applied: boolean, batchId: string | null): ImportResult {
  const counts: Record<ImportAction, number> = { create: 0, update: 0, unchanged: 0, delete: 0 };
  for (const e of plan.entries) if (!plan.issues.some((i) => i.row === e.row)) counts[e.action]++;
  const errorRows = new Set(plan.issues.map((i) => i.row)).size;
  return { kind, dryRun, applied, batchId, totalRows: plan.totalRows, validRows: plan.validRows, errorRows, errors: plan.issues.slice(0, MAX_ISSUES), warnings: plan.warnings.slice(0, MAX_ISSUES), errorsTruncated: plan.issues.length > MAX_ISSUES,
    counts, bumpsCatalogueVersion: !!plan.bumps, catalogueVersion: ctx.version, newCatalogueVersion: plan.bumps ? ctx.newVersion : null,
    sample: plan.entries.slice(0, 25).map((e) => ({ row: e.row, key: e.key, action: e.action, ...(e.changed?.length ? { changedFields: e.changed } : {}) })) };
}
const newVersionLabel = () => `import-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${id("v").slice(-4)}`;

/** Dry run: validates every row and reports what would change. Writes nothing. */
export async function previewImport(actor: Session, input: ImportRequest): Promise<ImportResult> {
  requireAdmin(actor); const { kind, csv } = ImportRequestSchema.parse(input);
  const ctx = { version: await currentCatalogueVersion(pool), newVersion: newVersionLabel() };
  return summarise(kind, await buildPlan(pool, kind, csv, ctx), ctx, true, false, null);
}
/** All-or-nothing: any row error means nothing is written (applied=false) and the same per-row errors are returned. */
export async function applyImport(actor: Session, input: ImportRequest): Promise<ImportResult> {
  requireAdmin(actor); const { kind, csv, filename } = ImportRequestSchema.parse(input);
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [IMPORT_LOCK]);
    const ctx = { version: await currentCatalogueVersion(client), newVersion: newVersionLabel() };
    const plan = await buildPlan(client, kind, csv, ctx);
    if (plan.issues.length) return summarise(kind, plan, ctx, false, false, null);
    await plan.apply(client, ctx);
    const summary = summarise(kind, plan, ctx, false, true, id("import"));
    await client.query("INSERT INTO import_batches(id,kind,filename,created_by,total_rows,created_count,updated_count,unchanged_count,deleted_count,catalogue_version,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [summary.batchId, kind, filename ?? null, actor.userId, summary.totalRows, summary.counts.create, summary.counts.update, summary.counts.unchanged, summary.counts.delete, plan.bumps ? ctx.newVersion : ctx.version, sha(csv)]);
    if (plan.bumps) await client.query("UPDATE catalogue_versions SET batch_id=$2 WHERE version=$1", [ctx.newVersion, summary.batchId]);
    await audit(client, null, actor, "import.applied", null, { batchId: summary.batchId, kind, created: summary.counts.create, updated: summary.counts.update, deleted: summary.counts.delete });
    return summary;
  });
}
export type ImportBatch = { id: string; kind: string; filename: string | null; createdBy: string; createdAt: string; totalRows: number; created: number; updated: number; unchanged: number; deleted: number; catalogueVersion: string | null };
export async function listImportBatches(actor: Session, limit = 50): Promise<ImportBatch[]> {
  requireAdmin(actor);
  return (await pool.query("SELECT * FROM import_batches ORDER BY created_at DESC LIMIT $1", [Math.min(200, Math.max(1, limit))])).rows.map((r) => ({ id: r.id, kind: r.kind, filename: r.filename, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString(), totalRows: r.total_rows, created: r.created_count, updated: r.updated_count, unchanged: r.unchanged_count, deleted: r.deleted_count, catalogueVersion: r.catalogue_version }));
}
