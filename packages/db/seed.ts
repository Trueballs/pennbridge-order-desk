import { readFile } from "node:fs/promises";
import path from "node:path";
import { hash } from "bcryptjs";
import { transaction } from "./index";
import type { Address, Customer, Product, PriceAgreement } from "@pennbridge/contracts";

export const CATALOGUE_VERSION = "synthetic-master-2026-10-28-v1";
const root = process.env.PROJECT_ROOT ?? process.cwd();
async function json(file: string) { return JSON.parse(await readFile(path.join(root, file), "utf8")); }
async function optional(file: string, fallback: unknown) { try { return await json(file); } catch (e: any) { if (e.code === "ENOENT") return fallback; throw e; } }
export async function seedDatabase(): Promise<void> {
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(57282102)");
    for (const [role, name] of [["admin","Demo administrator"],["reviewer","Demo reviewer"],["viewer","Demo viewer"]]) {
      const password = process.env[`DEMO_${role.toUpperCase()}_PASSWORD`] ?? `${role}-demo`;
      await client.query("INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(email) DO NOTHING", [role,`${role}@pennbridge.example`,name,role,await hash(password,10)]);
    }
    if (Number((await client.query("SELECT count(*) FROM products")).rows[0].count) > 0) return;
    // Only source master data is loaded. Runtime never opens cases.json or expected labels.
    const reference = await json("fixtures/context.json");
    const rawProducts = await optional("fixtures/scale/catalogue.json", reference.products);
    const rawAccounts = await optional("fixtures/scale/accounts.json", reference.customers);
    const rawAliases = await optional("fixtures/scale/aliases.json", reference.aliases);
    const rawPrices = await optional("fixtures/scale/price_agreements.json", reference.price_agreements);
    const rawHistory = await optional("fixtures/scale/history_orders.json", []);
    const products: Product[] = rawProducts.map((p: any) => ({
      id: p.sku, externalId: p.external_id ?? `pennbridge.product_${p.sku}`, sku: p.sku,
      manufacturerReference: p.manufacturer_reference ?? p.attributes.manufacturer_reference ?? null, description: p.description,
      category: p.category ?? p.family.split("_")[0], family: p.family, attributes: p.attributes,
      active: p.active, sellingUnit: p.selling_unit, unitsPerPack: String(p.units_per_pack),
      physicalUnit: ["pack","box"].includes(p.selling_unit) ? "each" : p.selling_unit,
      allowsFractionalQuantity: !!p.attributes.decimal_quantity || ["metre","litre","kg"].includes(p.selling_unit),
      listPrice: p.price_gbp, currency: "GBP", catalogueVersion: CATALOGUE_VERSION,
    }));
    const customers: Customer[] = rawAccounts.map((a: any) => ({ id:a.id, externalId:a.external_id ?? `pennbridge.partner_${a.id}`, name:a.name,onHold:a.status === "credit_hold",approvedSenders:a.approved_senders,catalogueVersion:CATALOGUE_VERSION }));
    const defaultAddresses: Address[] = rawAccounts.flatMap((a: any) => Object.entries(a.addresses).map(([label,formatted]) => ({id:`ADDR-${a.id}-${label}`,customerId:a.id,externalId:`pennbridge.address_${a.id}_${label}`,label,formatted,approved:true})));
    const rawAddresses = await optional("fixtures/scale/addresses.json", null);
    const addresses: Address[] = rawAddresses ? rawAddresses.map((a: any) => ({id:a.id,customerId:a.customer_id,externalId:a.external_id,label:a.code,formatted:a.address,approved:true})) : defaultAddresses;
    const prices: PriceAgreement[] = rawPrices.map((p: any,i: number) => ({ id:p.id ?? `PRICE-${i+1}`,customerId:p.customer_id,productId:p.sku,version:p.id ?? `reference-price-${i+1}`,validFrom:p.valid_from,validTo:p.valid_to ?? null,minimumQuantity:String(p.minimum_quantity),unitPrice:p.unit_price_gbp,currency:"GBP" }));
    await client.query("INSERT INTO customers(id,data) SELECT x->>'id',x FROM jsonb_array_elements($1::jsonb) x", [JSON.stringify(customers)]);
    await client.query("INSERT INTO addresses(id,customer_id,data) SELECT x->>'id',x->>'customerId',x FROM jsonb_array_elements($1::jsonb) x", [JSON.stringify(addresses)]);
    await client.query("INSERT INTO products(id,sku,manufacturer_reference,family,description,active,data) SELECT x->>'id',x->>'sku',x->>'manufacturerReference',x->>'family',x->>'description',(x->>'active')::boolean,x FROM jsonb_array_elements($1::jsonb) x", [JSON.stringify(products)]);
    await client.query("INSERT INTO customer_aliases(id,customer_id,alias,product_id) SELECT COALESCE(x->>'id','ALIAS-'||ord),x->>'customer_id',upper(x->>'alias'),x->>'sku' FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS r(x,ord)", [JSON.stringify(rawAliases)]);
    await client.query("INSERT INTO price_agreements(id,customer_id,product_id,valid_from,valid_to,minimum_quantity,data) SELECT x->>'id',x->>'customerId',x->>'productId',(x->>'validFrom')::date,(x->>'validTo')::date,(x->>'minimumQuantity')::numeric,x FROM jsonb_array_elements($1::jsonb) x", [JSON.stringify(prices)]);
    const stock = Object.entries(reference.stock).map(([productId,v]:[string,any]) => ({productId,availableQuantity:String(v.available),observedAt:new Date(v.as_of).toISOString()}));
    await client.query("INSERT INTO stock_snapshots(product_id,data) SELECT x->>'productId',x FROM jsonb_array_elements($1::jsonb) x", [JSON.stringify(stock)]);
    if (rawHistory.length) await client.query("INSERT INTO synthetic_history(id,customer_id,ordered_at,data) SELECT x->>'id',x->>'customer_id',(x->>'ordered_at')::date,x FROM jsonb_array_elements($1::jsonb) x", [JSON.stringify(rawHistory)]);
  });
}
