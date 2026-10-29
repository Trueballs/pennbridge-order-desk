/**
 * Helpers for scripts/odoo_version_proof.sh (synthetic data only).
 *   tsx scripts/odoo_version_tools.ts csv  <major> <out.csv>      desk CSV (renderOdooCsv) for the fixture order, header adapted to the version
 *   tsx scripts/odoo_version_tools.ts push <major> <url> <db> <user> <keyFile>   pushQuotation twice, prints JSON
 * The fixture is the approved PDF-001 order from results/odoo/app-export.csv (2 pack, 6 each, 4 roll; GBP 61.40).
 */
import { writeFileSync } from "node:fs";
import { renderOdooCsv } from "../packages/server";
import { odooConfigFromEnv, odooCsvForVersion, pushQuotation, pushExternalId, quotationUrl, type PushInput } from "../packages/server/odoo";

const UNITS = { each: "uom.product_uom_unit", pack: "pennbridge.uom_pack", box: "pennbridge.uom_box", pair: "pennbridge.uom_pair", roll: "pennbridge.uom_roll", metre: "uom.product_uom_meter", litre: "uom.product_uom_litre", kg: "uom.product_uom_kgm" };
const fixture = (major: string, kind: "csv" | "push"): PushInput => ({
  orderId: `versionproof_${kind}_${major}`, orderVersion: 1, externalId: `pennbridge.quote_versionproof_${kind}_${major}`,
  customerExternalId: "pennbridge.partner_C001", shippingAddressExternalId: "pennbridge.address_C001_MAIN", poNumber: `VERPROOF-${kind.toUpperCase()}-${major}`, currency: "GBP", total: "61.40",
  lines: [
    { lineId: "L1", productExternalId: "pennbridge.product_FB-0830-A2-100", sku: "FB-0830-A2-100", description: "FB-0830-A2-100   2   pack   10.00", quantity: "2", unit: "pack", unitPrice: "10.00" },
    { lineId: "L2", productExternalId: "pennbridge.product_BR-6204-2RS", sku: "BR-6204-2RS", description: "BR-6204-2RS   6   each   6.00", quantity: "6", unit: "each", unitPrice: "6.00" },
    { lineId: "L3", productExternalId: "pennbridge.product_TAPE-PTFE-12", sku: "TAPE-PTFE-12", description: "TAPE-PTFE-12   4   roll   1.50", quantity: "4", unit: "roll", unitPrice: "1.35" },
  ],
});
const [cmd, major, ...rest] = process.argv.slice(2);
if (cmd === "csv") {
  writeFileSync(rest[0], odooCsvForVersion(renderOdooCsv(fixture(major, "csv")), Number(major)));
} else if (cmd === "push") {
  const [url, db, user, keyFile] = rest;
  const cfg = odooConfigFromEnv({ ODOO_URL: url, ODOO_DB: db, ODOO_USER: user, ODOO_API_KEY_FILE: keyFile });
  const input = fixture(major, "push");
  const first = await pushQuotation(cfg, input, UNITS), second = await pushQuotation(cfg, input, UNITS);
  console.log(JSON.stringify({ externalId: pushExternalId(input), first, second, link: quotationUrl(cfg, first.id, first.serverMajor) }));
} else { console.error("usage: csv|push"); process.exit(2); }
process.exit(0);
