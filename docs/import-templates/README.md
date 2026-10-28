# CSV import templates

Administrators load master data from CSV (Users and Import in the desk, or the `/api/admin/import/*` API). Every import is a **dry run first**: the preview validates every row, lists errors by row and column, and shows how many records would be created, updated or left unchanged. Nothing is written until you apply, and **an import with any row error writes nothing** (fix the file and run it again).

Rules for all files:

- UTF-8 CSV with a header row; commas, quotes and CRLF line endings are fine (an Excel BOM is accepted). Column names are case-insensitive. Unknown columns are ignored with a warning. Max 100,000 rows per file.
- Row numbers in error messages match the spreadsheet row (header is row 1).
- Imports upsert by key and never delete, except `aliases` (use `delete=yes`). Retire a product with `active=false`; end a price with `valid_to`.
- Re-importing an unchanged file changes nothing. Applying is serialised and recorded in the import history with the user and a content hash.
- Import in dependency order: **products, customers, addresses, price_agreements, aliases, stock, sender_mappings**.

## Versioned catalogue

Orders remember the catalogue version they were validated against. A `products` import that really changes something (new or changed product) creates a new catalogue version (`import-YYYYMMDDHHMMSS-xxxx`) and moves the whole catalogue to it, so orders approved earlier but not yet exported must be revalidated before export. Unchanged re-imports, and every other file type, do not change the version. Price agreements carry their own version that changes with their content.

## Files

| File | Required columns | Optional columns |
|---|---|---|
| `products.csv` | `sku`, `description`, `selling_unit` (each, pack, box, pair, roll, metre, litre, kg), `list_price` (GBP, max 2 decimals) | `family` (default general), `category`, `units_per_pack` (default 1), `manufacturer_reference`, `active` (default true), `attributes` (`key=value;key=value` or JSON), `external_id` |
| `customers.csv` | `id`, `name` | `status` (active or credit_hold), `approved_senders` (`;` separated emails; if the column is present a blank cell clears them), `external_id` |
| `addresses.csv` | `customer_id` (must exist), `code`, `address` | `id`, `approved` (default true), `external_id` |
| `price_agreements.csv` | `customer_id`, `sku`, `unit_price` (max 2 decimals), `valid_from` (YYYY-MM-DD) | `minimum_quantity` (default 1), `valid_to`, `id` |
| `aliases.csv` | `customer_id`, `alias`, `sku` | `delete` (yes removes the alias), `id` |
| `stock.csv` | `sku`, `available` | `as_of` (ISO date or datetime; default now) |
| `sender_mappings.csv` | `sender` (an email, or `@domain.com`), `customer_id` | `trusted` (default false) |

Notes:

- Price agreements for the same customer, SKU and minimum quantity must not overlap in time, within the file or against stored agreements. Without an `id` the agreement id is derived from customer, SKU, start date and minimum quantity, so re-importing with a new `valid_to` updates the same agreement.
- An alias that maps to more than one SKU for a customer is accepted with a warning; orders using it will be sent to review.
- A sender mapping only *suggests* the customer. Mark `trusted=true` only for a specific address you control or know; an email From header can be forged. Trusting a public mail domain such as gmail.com is rejected.
- `external_id` defaults to `pennbridge.<kind>_<key>`; set the `ODOO_EXTERNAL_ID_PREFIX` environment variable to change `pennbridge`.
- The example rows use fictional data (customer `CUST100`).

## API (administrator session required)

- `GET /api/admin/import/templates` lists kinds and columns; `GET /api/admin/import/templates/{kind}` downloads the CSV template.
- `POST /api/admin/import/preview` and `POST /api/admin/import/apply` with `{ "kind": "products", "csv": "<file text>", "filename": "products.csv" }`. Both return the same result shape; `apply` answers HTTP 422 with `applied:false` when any row has an error.
- `GET /api/admin/import/batches` lists the import history.
