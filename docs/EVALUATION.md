# Evaluation and local runbook

## Start the demo

From the project root, with Docker Desktop running:

```sh
npm ci
docker compose -f infra/compose.yaml up --build -d
docker compose -f infra/compose.yaml ps
```

The first build downloads pinned images and dependencies. Open <http://127.0.0.1:3087> and sign in with `reviewer@pennbridge.example` / `reviewer-demo`. The app also seeds `admin@pennbridge.example` / `admin-demo` and `viewer@pennbridge.example` / `viewer-demo`. These are synthetic local demo credentials; an existing initialized database retains its original seeded passwords.

Choose **Try sample order** to send the included synthetic PDF email to the local Mailpit catcher and then process the captured message. In the inbox, open the resulting order, inspect document evidence and flagged lines, correct or acknowledge the review items, save, approve, and export. The export must still be imported and verified in Odoo separately. Mailpit is available at <http://127.0.0.1:8027>.

The Compose stack contains the web app, worker, Postgres, Mailpit, and a loopback-bound nginx proxy. Postgres and the worker are private to the Compose network. `LIVE_AI_ENABLED=false` is set by Compose, so this workflow makes no paid model calls. Stop the stack and keep its volumes with:

```sh
docker compose -f infra/compose.yaml stop
```

## Reproduce offline checks

```sh
npm run typecheck
npm test
npm run fixtures:check
npm run seed:check
npx tsx scripts/evaluate.ts
npx tsx scripts/evaluate_pdfs.ts
```

The two evaluators write ignored artifacts under `results/acceptance/`. The default `npm test` run currently passes 19 offline tests and skips 16 PostgreSQL-backed tests. The passing tests cover 12 domain checks, 2 harness-boundary checks, 3 PDF checks, and 2 ingestion-boundary checks. The skipped tests are 8 lifecycle checks in `tests/core-db.test.ts` and 8 stateful fixture checks in `tests/stateful-acceptance.test.ts`. Run the database suites against fresh isolated databases on the existing private Docker network:

```sh
bash scripts/test_db.sh
```

The verified runner creates unique test databases, mounts current source/tests read-only into the app image, runs eight lifecycle and eight stateful checks (16/16 passed, no skips), and retains the databases for inspection. It publishes no database port and never resets an existing database. Logs are saved under `results/acceptance/`.

The tests check their database name before initialization. The lifecycle suite passes eight PostgreSQL-backed checks for authorization, editing and approval invalidation, concurrent version checks, export idempotency, intake dedupe, duplicate-PO routing, job leases, and model-budget reservations. The stateful fixture suite passes eight original cases, with mock extraction and the real intake, job, order, and history services; it writes `results/acceptance/stateful.json`. It verifies duplicate-message replay, duplicate POs, customer-scoped duplicate handling, amendments, cancellation review, and history suggestion provenance. Historical orders are shown as bounded, customer-scoped suggestions in the order detail UI; they are not sent to the extraction provider and current prices are not copied from history. These suites use synthetic records and no paid model calls.

## Original email cases: measured result

The 50 `.eml` inputs and their manifest hashes are frozen. The harness reads expected labels only to score results after processing. Each case passes production `parseInput`, the deterministic offline `MockProvider`, and production domain `validate`, using fresh in-memory account/catalogue context built from `fixtures/context.json`.

Latest recorded stateless run:

- 42 of 42 cases passed intent, route, required-flag, line-field, and customer checks.
- There were no evaluator errors. The run reported median/p95 case latency of 0.82/3.48 ms on the machine used for that run; this is local harness timing, not a service performance claim.

The eight stateful cases are now separately scored through actual services and real PostgreSQL rather than excluded. The latest `results/acceptance/stateful.json` run passed 8/8 (PB-031–036, PB-038–039). It uses mock extraction with real persistence and service behavior, not AI. Taken together, all 50 original email fixtures have been checked across these two runs. They are not a single homogeneous end-to-end evaluation: the 42-case suite uses fresh in-memory domain context; the 8-case suite sets up database records and verifies replay/lifecycle outcomes.

Run `npx tsx scripts/evaluate.ts` to refresh `results/acceptance/run.json` and `run.md`. It stops if an input hash differs from `fixtures/manifest.json`. Outputs include actual intent, route, flags, customer, line IDs, raw and selected SKUs, quantities, units, per-check numerators/denominators, and latency.

## PDF cases: measured result

The separate 20-case suite uses the synthetic machine-generated PDFs and the production MIME/PDF text parser. Each parsed result then goes through the same offline `MockProvider`. Latest recorded run:

- 20 of 20 cases passed exact-line matching.
- 286 of 286 expected SKU, quantity, unit, and quoted-price fields matched.
- 286 of 286 expected line values appeared together in page-backed source evidence, and all 286 extracted line references were page-backed by their parsed PDF.
- There were no evaluator errors. The run reported median/p95 case latency of 7.85/68.14 ms on the machine used for that run.

Run `npx tsx scripts/evaluate_pdfs.ts` to refresh `results/acceptance/pdf-run.json` and `pdf-run.md`. It verifies the PDF content hash declared in `fixtures/pdf/cases.json`. Missing quoted prices count as misses; labels are not supplied to the parser. Page evidence is checked separately from line-field correctness.

## What these results establish

These are visible synthetic development cases, not an untouched holdout. The 42-case email run is a parser/domain acceptance diagnostic; the separate 8-case run measures stateful service behavior with mock extraction and PostgreSQL; the PDF run measures machine-generated PDF text extraction plus deterministic mock parsing and source evidence references. None is AI accuracy, a production accuracy estimate, or a real-customer outcome. Scanned PDFs/OCR are not evaluated. No live AI call or paid API usage is included.

## Local system checks

The separate [system-check report](SYSTEM-CHECKS.md) records authenticated catalogue requests against the 10,000-product database, viewer write-permission rejection, backup/restore fingerprint checks for all 22 database tables and document storage, and an isolated worker crash/lease-recovery run. It also records network probes from the worker container. The 100-query catalogue sample reported a 257.36 ms p95; this was a brief localhost sample over ten repeated SKUs, not a performance target or capacity claim. The recovery check used a restored copy and did not interrupt the running demo worker. Full methods, artifacts, and limits are in that report.

## Optional local Odoo proof

The app and Odoo use separate Compose projects and databases. To start the optional Odoo 19 proof stack and rerun its minimal real CSV import proof:

```sh
bash scripts/odoo_start.sh
```

The local Odoo UI is at <http://127.0.0.1:8067>. The proof imports and reimports a synthetic quotation through Odoo's `base_import.import` machinery. The shipping-aware proof and verified mapping are documented in [ODOO-IMPORT.md](ODOO-IMPORT.md); run `bash scripts/odoo_shipping_proof.sh` for its separate alternate-address check. This proves the documented synthetic CSV mapping against the pinned local Odoo version. It is not automatic posting from the desk, a customer ERP integration, or evidence that stock is reserved or orders are fulfilled.

## Browser and destination smoke check

The final local build was exercised in Chrome: reviewer sign-in, Mailpit sample injection, PDF/source preview, visible line-level price exceptions, reviewer notes, save, approval, CSV export, and manual destination verification. Selling quantities remained 2 packs / 6 each / 4 rolls through save and export. Odoo's real import service accepted that CSV in Test/Import/reimport, preserving record and line IDs; its resulting draft quotation S00007 was inspected in the browser at GBP61.40. The app's export history now records manual verification against S00007. Screenshots are in `results/screenshots/`.

The Chrome extension file chooser could not upload because file-URL permission was disabled. That browser upload path remains unverified; the actual Odoo import service was tested instead. No browser permission was changed. Build/typecheck pass; Next's dynamic-filesystem tracing warnings remain and should be addressed before optimizing a hosted image.
