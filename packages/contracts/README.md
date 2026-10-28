# Contracts v1

Import runtime Zod schemas and inferred TypeScript types from `@pennbridge/contracts`.
All request objects reject unknown keys. The API must parse schemas before use and
must independently authenticate, authorize and apply domain validation.

## Scalar and scope rules

- IDs are opaque strings; do not assume UUIDs because synthetic and ERP external IDs are stable human-readable keys.
- Timestamps contain an explicit timezone. Delivery dates are calendar dates, not timestamps or promises.
- Quantity/price values are decimal **strings**. Quantity precision is at most six decimals; extracted raw quantities preserve negative/zero values for review, while normalized/export quantities must be positive. Money is nonnegative GBP net with exactly two decimals. Compute using decimal/integer arithmetic, round line totals half-up to pennies, then sum rounded line totals.
- Retain ordered `quantity`/`unit` and `originalUnit`; `normalizedQuantity`/`normalizedUnit` describes physical quantity. Selling quantity and export quantity remain in the catalogue selling unit. Incompatible or ambiguous packaging blocks approval.
- Decimal strings are normalized by the domain before hashing: remove insignificant fractional zeros from quantities; money retains two decimal places. Hash canonical, key-sorted JSON of business content, excluding mutable status, approval, audits and processing timestamps.
- `null` means unknown/unresolved, not an empty string or guessed value. Unknown quantities and products remain in the draft so no line is silently omitted.
- From headers and document text cannot establish customer identity. Only the authenticated server can set `trustedCustomerId`/`identitySource`. For a reviewer upload this comes from their explicit account selection; an ingestion token must be separately authorized to use trusted synthetic context. Unknown identity cannot search account aliases/history.
- All master records carry stable Odoo external IDs; prices/units/catalogue versions come from synchronized master data. New addresses remain in review until master-approved.
- `Reason.resolved` is a reviewer acknowledgement record. Domain rules still reject unsafe unresolved products, invalid quantities, account holds, missing current prices and incompatible units; a free-text acknowledgement cannot bypass these invariants.

## REST v1

Routes return JSON except protected document/export downloads. Session cookies are HttpOnly, SameSite=Lax and server validated. Viewer/reviewer/admin can inspect; reviewer/admin can review; only reviewer/admin can approve/export; only admin can retry dead-letter jobs or submit trusted harness identity. Ingestion tokens can submit intake and cannot approve/export.

| Method / route | Request | Success |
| --- | --- | --- |
| GET `/api/session` | — | `Session` or 401 |
| POST `/api/auth/login` | `LoginRequest` | `Session` + session cookie |
| POST `/api/auth/logout` | — | `{ok:true}` |
| GET `/api/orders` | `OrderListQuery` query | `OrderListResponse` |
| GET `/api/orders/:id` | — | `OrderDetail` |
| PATCH `/api/orders/:id` | `EditOrderRequest` | `OrderDetail` |
| POST `/api/orders/:id/approve` | `ApproveRequest` | `OrderDetail` |
| POST `/api/orders/:id/export` | `ExportRequest` | `ExportSnapshot` |
| GET `/api/orders/:id/exports/:exportId/download` | — | immutable CSV attachment |
| POST `/api/orders/:id/exports/:exportId/verify` | `VerifyExportRequest` | `ExportSnapshot` |
| POST `/api/orders/:id/cancel` | `CancelRequest` | `OrderDetail` |
| POST `/api/orders/:id/amendments` | `AmendmentRequest` | `OrderDetail` of related amendment |
| POST `/api/intake` | `IntakeRequest` | 202 `IntakeResponse` (duplicate returns original IDs) |
| GET `/api/documents/:id` | — | protected original/download or bounded text preview |
| GET `/api/catalogue?q=&customerId=` | bounded query | `{products: Product[]}` |
| GET `/api/customers` | — | `{customers: Customer[], addresses: Address[]}` |
| GET `/api/jobs` | — | `{jobs: Job[]}` |
| POST `/api/jobs/:id/retry` | — | `Job` |
| GET `/api/metrics` | — | measured job/model aggregates, explicitly labelled mock/live |

Errors use `ApiError`; 400 invalid request, 401 unauthenticated, 403 forbidden,
404 missing resource, 409 stale version/approval/idempotency conflict, 422 business
validation, 413 oversized input, 415 unsupported format. Intake quarantines a source
with a useful reason where possible. Never echo submitted passwords or whole documents.

Edits, approval, cancellation and amendment linking compare `expectedVersion` inside
the database transaction. An edit creates a new immutable order version and clears
approval. Approvals bind both version and content hash. Export rechecks those values,
then stores a snapshot/artifact atomically; a retry with the same idempotency key
returns the same snapshot. Export prepared/downloaded/import_verified states are
separate, and manual verification records an operator and quotation reference.
Quotes stay in quote review and must be explicitly handled; cancellations/amendments
link to a prior order and cannot silently become new orders or mutate an imported
quotation. All actions create server-written audit events.

## Durable jobs and model records

Workers claim jobs transactionally with a lease owner/expiry; only the current owner
may complete a lease. Expired work may be reclaimed. Side effects use unique transport,
content and business dedupe keys rather than trusting a job to run once. Attempts have
bounded retries and end in dead_letter. The public Job contains no arbitrary credentials,
raw content or SQL job payload.

Model usage distinguishes `mock` and `live`, actual cost from reserved cost, and
unknown provider outcomes. Mock usage cannot count as model accuracy or paid cost
savings. Budget reservations must commit before provider requests and be reconciled
transactionally; a process crash cannot free an unknown already-spent reservation.

The export mapping version is not frozen until the local Odoo import proof succeeds.
These contracts do not claim a generic CSV was imported into Odoo.
