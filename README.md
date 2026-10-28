# Pennbridge Order Desk

Local portfolio prototype for a fictional UK industrial wholesaler. It turns synthetic emailed purchase orders into reviewable drafts, checks catalogue and account data, records human approval, and prepares a CSV for quotation import into a local Odoo test instance.

## Run the local demo

Requirements: Docker Desktop and Node.js 24. The first Compose build downloads pinned images and dependencies.

```sh
npm ci
docker compose -f infra/compose.yaml up --build -d
docker compose -f infra/compose.yaml ps
```

Open the desk at <http://127.0.0.1:3087>. The default seeded sign-ins are:

| Role | Email | Password |
|---|---|---|
| Reviewer | `reviewer@pennbridge.example` | `reviewer-demo` |
| Administrator | `admin@pennbridge.example` | `admin-demo` |
| Read-only viewer | `viewer@pennbridge.example` | `viewer-demo` |

Use **Try sample order** to replay a synthetic PDF purchase order through local Mailpit, background processing, the mock extractor, validation, and the inbox. From the order detail, inspect its evidence, resolve review items, save, approve, and create an export. Approval is human-controlled. A downloaded CSV is prepared for import; it does not mean Odoo accepted it.

The local Mailpit UI is at <http://127.0.0.1:8027>. The proxy binds both ports to loopback. App, worker, and Postgres use a private Compose network. Live AI is disabled by default.

Stop the services while retaining their local data:

```sh
docker compose -f infra/compose.yaml stop
```

## Verify the build

```sh
npm run typecheck
npm test
npm run fixtures:check
npm run seed:check
bash scripts/test_db.sh
npx tsx scripts/evaluate.ts
npx tsx scripts/evaluate_pdfs.ts
```

The 50 original email fixtures and 20 generated PDF fixtures are synthetic and visible development data. Current acceptance artifacts are in ignored `results/acceptance/`; methodology, results, and limits are in [docs/EVALUATION.md](docs/EVALUATION.md). All 50 email cases are now accounted for across two separate mock-mode runs: 42 stateless parser/domain cases and 8 stateful cases through real PostgreSQL/services. The stateful suite checks duplicates, amendments, cancellations, and history suggestions. This is not one end-to-end AI run. Database-backed lifecycle checks use separate isolated test databases; commands are in the evaluation guide.

## Architecture and scope

- **Next.js and TypeScript** provide the desk and authenticated API.
- **PostgreSQL** stores jobs, orders, documents, evidence, catalogue, audit history, and export snapshots. **A separate worker** claims leased jobs and applies bounded retry/dead-letter handling.
- **Mailpit** captures the synthetic demo email locally. The app has no external mail relay.
- **`parseInput`** reads MIME, plain text, sanitized HTML, CSV, and machine-generated PDF text. **`MockProvider`** is deterministic rule-based extraction, not a language model.
- **Domain validation** checks catalogue matches, customer-scoped aliases, effective prices, selling units, stock observations, addresses, flags, and approval requirements.
- **Synthetic history** is returned as a bounded, customer-scoped suggestion with provenance for reviewer confirmation. It is not sent to the extraction provider, and historical prices are not copied into current drafts.
- **CSV export** is version-bound and generated only after human approval. The optional Odoo test stack and verified mapping are documented in [docs/ODOO-IMPORT.md](docs/ODOO-IMPORT.md).

Generated scale fixtures contain 10,000 SKUs (8,000 active), 250 accounts, 500 addresses, 5,000 aliases, 15,000 price agreements, and 12,000 synthetic history records. A dated local Odoo 19 proof imported and reimported test quotations through Odoo's CSV import machinery. This does not connect to a customer's ERP, send customer mail, reserve inventory, or establish production readiness.

## Measured result and limitations

The 42-case stateless run passed all intent, route, required-flag, line-field, and customer checks; the separate real-PostgreSQL/services run passed all 8 stateful fixture cases. Together these account for the original 50 synthetic email cases, but they are different runs: the 42-case set uses fresh in-memory context, while the 8-case set exercises database state and replay behavior. The separate lifecycle suite passed 8 PostgreSQL checks; 12 domain checks run offline. All 20 machine-generated PDF cases passed 286/286 labelled line fields, including SKU, quantity, unit, quoted unit price, and page-backed evidence checks. The default `npm test` run passes 19 offline tests and skips 16 database-backed tests unless their dedicated environment variables are set. All evaluators use `MockProvider`; these figures are not AI accuracy, production accuracy, or a customer outcome. Scanned PDFs/OCR, real customer documents, live model benchmarking, inbox account connections, hosted deployment, and automated ERP posting are outside this prototype.

**CV-ready description:** Built a local purchase-order desk with Next.js, TypeScript, PostgreSQL, Docker Compose, deterministic extraction, reviewer approval, and Odoo-compatible quotation export; evaluated in mock mode on 42 stateless and 8 PostgreSQL-backed synthetic email cases plus 20 generated PDFs (286 labelled lines), and verified a local Odoo 19 quotation import proof.

## Project references

- [Acceptance runbook and measured results](docs/EVALUATION.md)
- [Local system, permission, restore, and worker-recovery checks](docs/SYSTEM-CHECKS.md)
- [Local Odoo import proof and field mapping](docs/ODOO-IMPORT.md)
- [Business and technical specification](docs/PROJECT-SPEC.md)
- [Original 50 email scenarios](fixtures/SCENARIOS.md)
- [Synthetic PDF cases](fixtures/pdf/cases.json)
- [Scale fixture manifest](fixtures/scale/manifest.json)

The completed local demo includes Odoo quotation **S00007** from PDF-001, checked at **£61.40** and recorded as import verified in the desk. A replay after review is held for amendment review and cannot be approved as another new order. The Odoo import-service proof and browser-upload limitation are documented in `docs/ODOO-IMPORT.md`.
