# Server services

All authoritative HTTP handlers call `initialiseDatabase()` and obtain the actor
from `session(cookieToken)` or the restricted `ingestionSession(bearerToken)`.
Never accept a Session, role, approval or audit field from JSON input.

The exported functions are the implementation contract in
`packages/contracts/README.md`. Errors carry `.code` and `.status` for the shared
JSON error response. All draft mutations compare versions under PostgreSQL row
locks. `createAmendment` links a separately processed amendment to its existing
order without changing an imported quotation.

Additional adapter functions:

- `downloadExport(actor,orderId,exportId)` returns `{filename,content:Buffer}` and records the download.
- `getDocument(actor,id)` returns `{document,content:Buffer|null}`. Serve original files as attachments with `nosniff`; HTML/text previews use React escaping, never raw source HTML.
- `stats(actor)` returns `{counts,totalOrders,catalogueCount,pendingJobs,mode,modelCalls,modelUsage}`. Counts key by order status. Mock/live labels are explicit; zero usage is not a cost-savings measurement.
- `processMessage(job,leaseOwner,{parse,provider})` is injectable so worker infrastructure and HTTP intake share one transactional workflow. It verifies the lease before writing results. Parser files are private and evidence quotes/references are checked against source documents.
- `processingFailed(job,owner,error)` applies bounded retry/backoff/dead-letter state and preserves a useful failed draft after the final attempt.

Set `DATABASE_URL`, `PROJECT_ROOT` (defaults current working directory) and
`STORAGE_ROOT` (defaults `runtime/storage`). Postgres is private in Compose; run
application/database integration checks inside that network. Seeded fake users:
`reviewer@pennbridge.example` / `reviewer-demo`, `admin@pennbridge.example` /
`admin-demo`, and `viewer@pennbridge.example` / `viewer-demo`. Optional
`DEMO_REVIEWER_PASSWORD`, `DEMO_ADMIN_PASSWORD`, `DEMO_VIEWER_PASSWORD` configure
first initialization only. An optional `INGESTION_TOKEN` enables authenticated
synthetic intake; it grants no approval/export authority.

Run `npm test` for offline checks. Real database tests require
`CORE_DB_TEST=true` and a `DATABASE_URL` whose database name contains `test`.
Those tests create synthetic records and should use an isolated test database.

Odoo CSV uses the A2-verified `base_import.import` field mapping and `base.GBP`.
`ODOO_UNIT_EXTERNAL_IDS` is a JSON unit-to-external-ID map; unconfigured units
block export. Every export keeps a stable quotation external ID and stable line
IDs. Prepared, downloaded and manually import-verified states remain separate.
The instance-verified v2 mapping includes `partner_shipping_id/id`; the approved
address external ID is exported explicitly, including alternate delivery sites.
