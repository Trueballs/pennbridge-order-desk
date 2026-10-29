# Local Odoo quotation import

Verified 28 October 2026 against official Odoo Community **19.0-20261015**, Sales (`sale_management`). This is a real CSV `base_import.import.execute_import` proof using Odoo's installed import machinery, including its Test rollback. Browser Test/Import walkthrough is a separate acceptance step. All records and credentials below are synthetic/local.

Run `bash scripts/odoo_start.sh` from the repository. Requires Docker Desktop; initial image download requires network. The Compose project is `pennbridge-odoo-proof`, independent of the app and existing n8n. Odoo uses its own Postgres, internal network and project-scoped volumes; no database port is published. A pinned nginx 1.28 ingress proxy alone bridges to the localhost web port. Odoo and Postgres have no external route: the final Odoo TCP egress probe to 1.1.1.1:443 returned errno 101 (Network unreachable), while the login page returned HTTP 200. The ingress proxy has no database credentials and forwards only to Odoo. Browser: http://127.0.0.1:8067 (database `pennbridge`). Local demo login is recorded in ignored `infra/odoo/.env.local`. All credentials are disposable fake values for localhost only. SMTP points to closed localhost port 1; there is no external relay.

Pinned image digests live in `infra/odoo.compose.yaml`: Odoo `19.0@sha256:27f920e002c43a1af7022a68f3cc17db71a2f9f3348800cb050721ce54893e49`, Postgres `17@sha256:31ba9c94a03ada9988f2bb493a22a75eef3a185884533e5cdbcd498ea835b08f`.

## Verified mapping

The model is `sale.order`. `infra/odoo/quotation-proof.csv` is exported back through `sale.order.export_data` after successful import, so it is also the instance-derived import-compatible template. Technical CSV headers map as follows (UI labels may differ with language):

| CSV field | Meaning / UI mapping |
|---|---|
| `id` | External ID of quotation |
| `partner_id/id` | Customer / External ID |
| `partner_shipping_id/id` | Delivery Address / External ID (v2 required) |
| `client_order_ref` | Customer Reference (PO) |
| `currency_id/id` | Currency / External ID |
| `order_line/id` | Order Lines / External ID |
| `order_line/product_id/id` | Order Lines / Product / External ID |
| `order_line/name` | Order Lines / Description |
| `order_line/product_uom_qty` | Order Lines / Quantity |
| `order_line/product_uom_id/id` | Order Lines / Unit / External ID |
| `order_line/price_unit` | Order Lines / Unit Price |

Odoo 19 uses `product_uom_id`, not the older `product_uom` line field. Every order and every line needs a stable, unique external ID. First row carries quotation/customer/currency/PO fields; subsequent rows for that quotation leave those five fields empty and carry the next line. Reimport uses the same order and line IDs. Do not regenerate IDs on retry. This proof establishes replay of identical rows; removing lines by omission is not a supported amendment/delete mechanism.

Import options: UTF-8, comma separator, double-quote delimiter, headers enabled, decimal separator `.`, thousands separator `,`, date `%Y-%m-%d`, datetime `%Y-%m-%d %H:%M:%S`. References must exist as `product.product`, `res.partner`, `res.currency` and `uom.uom` external IDs. The product selling unit must match the approved normalized unit. Explicit prices come from the approved export; importing does not approve the desk order.

## Actual proof result

`bash scripts/odoo_proof.sh` is repeatable. It seeds one customer and two products, commits master data, then uses real CSV bytes in `base_import.import`, not direct sale-order ORM creation. Full captured result: `infra/odoo/proof-result.json`.

- Test: success, no messages, rolled back quotation ID 1.
- Import: quotation ID 2, **S00002**, `pennbridge.quote_proof`, customer **Northbank Engineering (Synthetic)**, PO **PO-PROOF-001**, **GBP**, `draft`.
- Two lines: **PB-BOLT-M8**, 10 Units at £1.25; **PB-BEAR-6204**, 2 Units at £8.50. Line IDs 3 and 4; untaxed amount £29.50.
- Repeat: same quotation ID 2 and same two line IDs; no duplicate order or lines; state remains `draft`.
- Missing product `pennbridge.product_does_not_exist`: error `No matching record found for external id ... in field 'Order Lines/Product'`; no invalid quotation created; original quotation unchanged.

The dryrun can consume a sequence number even though it rolls back; S00002 is expected here. Later reruns retain the same external ID and may return different transient test metadata. These checks do not confirm sales, reserve inventory, invoice or send email.

## Browser acceptance

Open Sales → Orders → Quotations, choose Import records from the list action/gear menu, upload `infra/odoo/quotation-proof.csv`, verify every mapping above, then Test and Import. The existing proof external IDs update S00002. Open S00002 and verify customer, PO, currency, both lines, quantities, Units, prices and Quotation/draft status. Record browser evidence separately; do not describe file download as destination verification.

Stop only these services with `docker compose -f infra/odoo.compose.yaml stop`. Start existing initialized services with `docker compose -f infra/odoo.compose.yaml up -d`. Volumes are retained. Do not run generic Docker prune or modify the n8n installation.

## Shipping-aware contract v2 and full master seed

The frozen current contract is **`odoo19-quotation-v2`**. It adds `partner_shipping_id/id` immediately after `partner_id/id`; use `infra/odoo/quotation-shipping-proof.csv` as the current template. The earlier two-product CSV remains the first minimal proof. Shipping proof: Test ID 4 rolled back; Import/reimport ID 5 **S00005**, draft, same line IDs 7/8. Account `pennbridge.partner_C001` explicitly delivers to `pennbridge.address_C001_NORTH`, read back as **Unit 8, North Test Works, Reading, TEST RG2**. Standard shared SKU `pennbridge.product_FB-0830-A2-100` imported as two **Pack (selling unit)** at £10.00. Full result: `infra/odoo/shipping-proof-result.json`. Header order:

```csv
id,partner_id/id,partner_shipping_id/id,client_order_ref,currency_id/id,order_line/id,order_line/product_id/id,order_line/name,order_line/product_uom_qty,order_line/product_uom_id/id,order_line/price_unit
```

Run `bash scripts/odoo_seed_master.sh` after generating `fixtures/scale/`. Actual initial seed/readback passed: **10,000 products (8,000 active/2,000 archived), 250 accounts, 500 delivery addresses, 15,000 price agreements**. Seed queries include archived products on replay. The shared fixture files bootstrap Odoo once; the resulting destination readback snapshot is `results/odoo/master-snapshot.json`, with verified product IDs, selling units, prices, active flags, source hashes, catalogue and account context. Small version/count/hash metadata is tracked in `infra/odoo/master-metadata.json`. Historical fixture orders remain labelled synthetic history and were not inserted as Odoo sales.

External ID patterns preserve the shared seed exactly: `pennbridge.product_<SKU>`, `pennbridge.partner_<C001>`, `pennbridge.address_<C001>_<NORTH>`. Example literal IDs: `pennbridge.product_FB-0830-A2-100`, `pennbridge.partner_C001`, `pennbridge.address_C001_NORTH`.

| Desk unit | Odoo external ID |
|---|---|
| each | `uom.product_uom_unit` |
| pack | `pennbridge.uom_pack` |
| box | `pennbridge.uom_box` |
| pair | `pennbridge.uom_pair` |
| roll | `pennbridge.uom_roll` |
| metre | `uom.product_uom_meter` |
| litre | `uom.product_uom_litre` |
| kg | `uom.product_uom_kgm` |

Pack/box/pair/roll are independent selling units with factor 1 and no reference to “each.” Product-specific `units_per_pack` remains in catalogue metadata, never a universal Odoo unit conversion. Thus 2 packs of 100 import as quantity 2 Pack, not 200 Units. All master-seed prices are GBP net; customer agreements are per-customer GBP pricelists with fixed variant prices, minimum quantities and inclusive validity dates. Import prices remain explicit approved values.

## App-generated export proof — 28 October 2026

The browser review of PDF-001 resolved the expired bearing agreement and tape price discrepancy, then approved version3. The resulting CSV passed the real Odoo import service dry-run, import and repeat import. Quotation **S00007** (record7) remains a draft, customer C001, MAIN delivery address, GBP61.40 untaxed: 2packs FB-0830-A2-100 at10.00, 6each BR-6204-2RS at6.00, 4roll TAPE-PTFE-12 at1.35. Reimport kept quotation7 and line IDs12,13,14.

Local evidence: `results/odoo/app-export.csv`. Reproduce the check from any downloaded synthetic app export:

```sh
python3 scripts/verify_app_export.py results/odoo/app-export.csv > results/odoo/app-export-proof.py
docker compose -f infra/odoo.compose.yaml run --rm -T odoo odoo shell --database=pennbridge --no-http < results/odoo/app-export-proof.py
```

Chrome extension file uploads require its file-URL access permission, which was unavailable during this test. The browser upload path was not claimed as tested; the actual import service was used instead. No quotation was confirmed, invoiced or sent.

## Direct push

An optional alternative to the CSV: a reviewer or admin clicks **Send to Odoo** on a prepared export and the worker creates the same quotation in Odoo as a **draft** over Odoo's external JSON-RPC API. The order is never confirmed, invoiced or emailed. The CSV path stays available and unchanged.

**Flow.** `POST /api/orders/:id/exports/:exportId/push-odoo {}` (reviewer/admin) queues an `odoo_push` job (migration `030-odoo-push.sql` adds `jobs.export_id`) and returns the updated export snapshot with `state: "push_queued"`. The UI polls the order detail. The worker calls `/jsonrpc`: `common.authenticate`, then `object.execute_kw`. It resolves the customer, delivery address, currency (`base.GBP`), products and units by the **same external IDs the CSV uses** (`ir.model.data`, module/name pairs; the model each ID points to is checked). It then creates `sale.order` in draft with `client_order_ref` = PO, `partner_id`, `partner_shipping_id`, `currency_id` and lines (`product_id`, `product_uom_qty` in the Odoo selling unit, `product_uom_id`, explicit `price_unit`, description) and reads back the quotation id and name (for example S00012).

**Idempotency.** The quotation is registered under external ID `pennbridge.quote_<order>_v<version>` and carries `origin = pennbridge:quote_<order>_v<version>`. Before creating, the worker looks for that external ID, then for the CSV's external ID (so a CSV import followed by a push adopts the existing quotation), then for the origin marker (a crash between create and bookkeeping). A retry therefore returns the same quotation and creates nothing. Only one active push job per export (unique index).

**Export state machine.** `prepared|downloaded -> push_queued -> pushed`. `pushed` is terminal and counts as verified: `verifiedAt`, `verifiedBy` (the requester) and `quotationReference` (the Odoo name) are set automatically, `verifyExport` on a pushed export is an idempotent no-op for the same reference, and it cannot be voided (reverse it in Odoo). A permanent failure or exhausted retries returns the export to `prepared|downloaded` with `pushState: "failed"` and a safe `pushError`, so the user can fix Odoo and press the button again or fall back to the CSV. While queued, a transient problem shows `pushError` ("... retried automatically (attempt n of 5)"), `verifyExport` and `voidExport` answer 409. Snapshot fields: `pushState` (`queued|failed|succeeded`), `pushError`, `pushRequestedBy/At`, `odooQuotation {id, name, url}`.

**Errors.** Permanent (no retry, safe message): bad login or API key, missing permission (AccessError), an external ID that is missing in Odoo or points at the wrong model (the message names the first one), Odoo validation errors, wrong URL (non-JSON answer), missing key file. Transient (5 attempts, exponential backoff): network errors, timeouts (20 s), HTTP 5xx/429, Odoo-side temporary errors. Odoo's own error text goes to the worker log only. Every queue, retry, failure and success is in the order audit trail (`export.push_queued`, `export.push_retry`, `export.push_failed`, `export.pushed` with quotation id/name, created flag and whether Odoo's untaxed total equals the desk total).

**Configuration.** `ODOO_URL`, `ODOO_DB`, `ODOO_USER` and `ODOO_API_KEY_FILE` (all four or none; checked by `validateEnv`). Optional `ODOO_PUBLIC_URL` is the address reviewers' browsers use for the quotation link when the worker reaches Odoo by an internal hostname (local overlay default `http://127.0.0.1:8067`). The key is read from the secret file on every push; it is never an environment variable, argument or log line. Create it in Odoo under the integration user's Preferences -> Account Security -> New API Key. The user needs to create sales quotations and read `ir.model.data` and the master records. Without `ODOO_URL` the endpoint answers 409 and the CSV flow is the only option.

**Network.** Only the worker gets network access to Odoo and the key; the app container gets the non-secret settings only (so it knows the button is enabled) and stays offline.
- Local: `docker compose -f infra/compose.yaml -f infra/odoo-push.compose.yaml up -d app worker` with `ODOO_USER=<login>` set. The worker joins the existing network `pennbridge-odoo-proof_odoo-ingress` and reaches the proof stack's nginx at `http://odoo-web` (override with `ODOO_URL`, `ODOO_NETWORK`). The key file is git-ignored `runtime/odoo/odoo_api_key`. The Odoo database and Odoo itself remain unreachable from the desk stack.
- Production: add `-f infra/compose.prod.odoo-push.yaml`, set `ODOO_URL=https://odoo.example.com`, `ODOO_DB`, `ODOO_USER` in `.env` and put the key in `${PB_SECRETS_DIR}/odoo_api_key`. The worker gets an outbound bridge network (`odoo-egress`); the app and database networks stay internal.

**Verification (28 October 2026).** `tests/odoo-push.test.ts`: a fake JSON-RPC server covers create, idempotent retry, crash recovery via the origin marker, adopting a CSV-imported quotation, missing or wrong-model external IDs, auth and permission errors (the key never appears in messages), 5xx/timeout/unreachable as transient, total mismatch flag, and no confirm calls. The PostgreSQL part (`ODOO_PUSH_DB_TEST`, part of `scripts/test_db.sh`) covers roles, queueing, worker, state machine, retry visibility, permanent failure and re-push. A real run against the local Odoo (worker code, Docker network, throwaway test database) created draft **S00008** for a seeded approved order (customer Alderwick Engineering Ltd (Synthetic), delivery MAIN, PO as sent, GBP, 2 Pack FB-0830-A2-100 at 10.00, untaxed 20.00) and a second push returned the same quotation (exactly one quotation with that origin, readback via `odoo shell`). This found that `ir.model.data.complete_name` is not searchable in Odoo 19; lookups use module/name. Not verified: the quotation `url` deep link in a browser, a non-admin integration user's exact permissions, Odoo versions other than 19.
