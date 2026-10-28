# Pennbridge Order Desk

A local purchase-order desk for a fictional UK industrial wholesaler. It reads emailed orders, checks every line against the catalogue and agreed prices, and prepares an Odoo quotation file only after a person approves the order.

> **Results** (held-out set: 36 synthetic cases, written separately from the prompt, never used for tuning)
>
> | | |
> |---|---|
> | Accuracy, live Gemini (`gemini-3.5-flash-lite`, one run) | **25 of 30 emails** and **6 of 6 PDFs** fully correct |
> | Cost | about **$0.004 per order** in live mode. The default mock mode makes no model calls. |
> | Speed | median 1.7 s per order, p95 13.4 s (live) |
> | Safety | The model never approves. Every email error from the chosen model on the held-out set carried a blocking flag, so it went to review, not to a draft. A person approves every order. |
> | Known gaps | Delivery-address extraction is the most common error. An invented unit that matches the catalogue selling unit passes the unit checks. |
>
> Development set (70 visible cases, prompt tuned on them): 37 of 42 emails and 18 of 20 PDFs. Full method, failures and limits: [docs/EVALUATION.md](docs/EVALUATION.md).

## What I'd say it demonstrates

- **AI with guardrails.** Model output must match a schema and is re-validated. Every product must match a catalogue SKU by lookup, and nothing is substituted. The default demo needs no model.
- **An idempotent workflow.** Intake dedupes on transport key and file hash. Approval binds to one version. Export is idempotent per approved version. Jobs use leases and retries.
- **Honest evaluation.** Development and held-out sets are reported separately, failures are listed, and a deterministic check was added after a silent model failure.
- **A real ERP export.** The CSV follows the format Odoo 19's own import accepts. It was verified in a local Odoo instance, not in a customer's ERP.

Architecture, the demo walkthrough and interview notes: [docs/DEMO.md](docs/DEMO.md).

## Quick start

Requirements: Docker Desktop and Node.js 24.

```sh
npm ci
docker compose -f infra/compose.yaml up --build -d
```

Open <http://127.0.0.1:3087>, sign in as `reviewer@pennbridge.example` / `reviewer-demo`, and choose **Try sample order**. The full run instructions are in [Run the local demo](#run-the-local-demo) below.

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

The local Mailpit UI is at <http://127.0.0.1:8027>. The proxy binds both ports to loopback. App, worker, and Postgres use a private Compose network. Live AI is disabled by default; to turn on Gemini extraction, see "Live AI in the desk" in [docs/TEST-INBOX.md](docs/TEST-INBOX.md).

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
- **Mailpit** captures the synthetic demo email locally. The app has no external mail relay. A dedicated test mailbox can also feed the desk through a small IMAP receiver (see below).
- **`parseInput`** reads MIME, plain text, sanitized HTML, CSV, and machine-generated PDF text. **`MockProvider`** is the default: deterministic rule-based extraction, not a language model. An optional Gemini adapter (off by default) is a language model; its reply must match a schema and is re-validated before use.
- **Domain validation** checks catalogue matches, customer-scoped aliases, effective prices, selling units, stock observations, addresses, flags, and approval requirements.
- **Synthetic history** is returned as a bounded, customer-scoped suggestion with provenance for reviewer confirmation. It is not sent to the extraction provider, and historical prices are not copied into current drafts.
- **CSV export** is version-bound and generated only after human approval. The optional Odoo test stack and verified mapping are documented in [docs/ODOO-IMPORT.md](docs/ODOO-IMPORT.md).

Generated scale fixtures contain 10,000 SKUs (8,000 active), 250 accounts, 500 addresses, 5,000 aliases, 15,000 price agreements, and 12,000 synthetic history records. A dated local Odoo 19 proof imported and reimported test quotations through Odoo's CSV import machinery. This does not connect to a customer's ERP, send customer mail, reserve inventory, or establish production readiness.

## Measured result and limitations

The 42-case stateless run passed all intent, route, required-flag, line-field, and customer checks; the separate real-PostgreSQL/services run passed all 8 stateful fixture cases. Together these account for the original 50 synthetic email cases, but they are different runs: the 42-case set uses fresh in-memory context, while the 8-case set exercises database state and replay behavior. The separate lifecycle suite passed 8 PostgreSQL checks; 12 domain checks run offline. All 20 machine-generated PDF cases passed 286/286 labelled line fields, including SKU, quantity, unit, quoted unit price, and page-backed evidence checks. The default `npm test` run passes 19 offline tests and skips 16 database-backed tests unless their dedicated environment variables are set. The offline evaluators use `MockProvider`, so these figures are not AI accuracy, production accuracy, or a customer outcome.

Live Gemini results are reported separately:

- **Held-out set (36 cases, one run per model):** gemini-3.5-flash-lite got 25/30 emails and 6/6 PDFs fully correct, at a median 1.7 s and about $0.0038 per order. gemini-3.8-flash got 24/30 emails and 3/6 PDFs; its three PDF timeouts at the 60 s request limit account for the gap. Failures, the safety property and the model comparison are in [docs/EVALUATION.md](docs/EVALUATION.md#held-out-results).
- **Development set (70 visible cases, prompt tuned on them):** run 2 got 37/42 emails and 18/20 PDFs with every line exact, but only 167/286 PDF lines. It silently omitted lines on two 60-line PDFs. A row-count check added afterwards (`INCOMPLETE_EXTRACTION`) now blocks that case. Details in [docs/EVALUATION.md](docs/EVALUATION.md#live-ai-results-gemini).

Scanned PDFs/OCR, real customer documents, hosted deployment, automated ERP posting, and live use on real customer orders are outside this prototype. Live mode sends email text to Google and should only be used with synthetic orders.

**CV-ready description:** Built a local purchase-order desk with Next.js, TypeScript, PostgreSQL, Docker Compose, deterministic extraction, optional live Gemini extraction (25/30 emails and 6/6 PDFs on a held-out set of 36 synthetic cases, about $0.004 per order), reviewer approval, and Odoo-compatible quotation export; verified a local Odoo 19 quotation import.

## Project references

- [Acceptance runbook and measured results (including held-out)](docs/EVALUATION.md)
- [Demo walkthrough and interview notes](docs/DEMO.md)
- [Screen-recording script](docs/VIDEO-SCRIPT.md)
- [Local system, permission, restore, and worker-recovery checks](docs/SYSTEM-CHECKS.md)
- [Local Odoo import proof and field mapping](docs/ODOO-IMPORT.md)
- [Business and technical specification](docs/PROJECT-SPEC.md)
- [Original 50 email scenarios](fixtures/SCENARIOS.md)
- [Synthetic PDF cases](fixtures/pdf/cases.json)
- [Held-out email and PDF cases](fixtures/holdout/cases.json)
- [Scale fixture manifest](fixtures/scale/manifest.json)

The completed local demo includes Odoo quotation **S00007** from PDF-001, checked at **£61.40** and recorded as import verified in the desk. A replay after review is held for amendment review and cannot be approved as another new order. The Odoo import-service proof and browser-upload limitation are documented in `docs/ODOO-IMPORT.md`.

## Receive email from a dedicated test mailbox

A dedicated Gmail test inbox is connected over IMAP and was verified end to end with a real email on 2026-10-28. Follow [TEST-INBOX.md](docs/TEST-INBOX.md) to connect your own. It runs locally without n8n or paid hosting, preserves the email and attachments, and keeps customer identity unresolved for review. Processing uses the mock extractor unless live AI is turned on; the live path is described in [TEST-INBOX.md](docs/TEST-INBOX.md#live-ai-in-the-desk).
