# Pennbridge Order Desk

Purchase-order intake for a fictional UK industrial wholesaler. It reads orders from email and PDF attachments, checks every line against the catalogue and agreed prices, and creates an Odoo draft quotation only after a person approves the order. It runs locally or on a single Linux server. All data is synthetic.

Built in October 2026 by directing AI coding agents (Codex and Claude Code). It is a portfolio prototype, not a customer system; every accuracy number below comes from runs documented in [docs/EVALUATION.md](docs/EVALUATION.md).

**Live end-to-end proof (2026-10-29):** a real Gmail order (PO E2E-07) from a trusted sender was read by Gemini, assigned to its customer, approved in the browser and pushed to Odoo as draft quotation **S00009** (£42.70).

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

## Production-ready features

Built for one Linux server. What was and was not exercised is listed in [docs/OPERATIONS.md](docs/OPERATIONS.md).

- **Install and TLS:** one install script, Caddy HTTPS, production Compose with restart policies and healthchecks.
- **Health:** a readiness endpoint (`/api/ready`) covering the database, worker heartbeat, queue age and mailbox polling, with a banner in the desk.
- **Backups:** nightly database and document backups, plus restore, restore-verify and upgrade (with rollback) scripts.
- **Accounts:** admin-managed users and roles, throttled login, password policy, session expiry, first-run admin CLI.
- **Master data:** CSV import wizard with a per-row dry run for products, customers, addresses, prices, aliases, stock and sender mappings.
- **Sender trust:** a trusted sender is assigned automatically only when SPF, DKIM and DMARC pass at the receiving server. Otherwise a person confirms the customer.
- **Cost and failure control:** monthly and per-order AI budgets, bounded job retries with dead-letter handling, manual entry when extraction fails.
- **Odoo and CI:** approved orders can be pushed to Odoo as idempotent draft quotations. GitHub Actions runs typecheck, the unit and PostgreSQL database suites and a dependency audit on every push. The 9 browser tests run locally, since they need a throwaway database.

## Known limits

Verified (2026-10-29):

- A fresh Ubuntu 24.04 install on a simulated server (privileged container with systemd; `install.sh` installed Docker from the Ubuntu repos): HTTPS, admin bootstrap, import, backup, verified and real restore, upgrade and rollback, reboot recovery. `scripts/test_install_ubuntu.sh`, 38/38.
- ACME certificate issuance and renewal against Pebble, Let's Encrypt's official test CA (http-01 and tls-alpn-01): `scripts/test_acme.sh`.
- Odoo 17, 18 and 19: CSV import and direct push, per version (`docs/ODOO-IMPORT.md`, `scripts/odoo_version_proof.sh`).
- Mailbox OAuth2 (XOAUTH2/OAUTHBEARER) against a real Dovecot with a mock identity provider, for Microsoft client credentials (secret and certificate), Google service-account JWT and refresh-token modes: `scripts/test_mailbox_oauth.sh`, 35/35. A real Gmail OAuth2 run also worked: the receiver used a refresh token, logged in to imap.gmail.com, and test order E2E-08 arrived and was auto-assigned. Setup: [docs/MAILBOX-SETUP.md](docs/MAILBOX-SETUP.md).

Still not verified:

- A real Microsoft 365 tenant (Entra app permission plus Exchange service principal).
- Google Workspace domain-wide delegation with a real service account.
- Let's Encrypt on a real public domain (no public DNS was available). The docs give a staging-first procedure.
- A real VM or cloud server (firewall, cloud networking). The Ubuntu test used a simulated server.
- Odoo Online or Enterprise, and a non-admin Odoo integration user.
- Offsite backups (backups stay on the server's disk unless you copy them) and load testing.

Note: refresh tokens of Google apps in "Testing" status expire after 7 days. Renewal is documented in `docs/MAILBOX-SETUP.md`.

Also not covered: high availability, scanned PDFs, and accuracy on real customer orders. The held-out set is 36 synthetic cases.

## What I'd say it demonstrates

- **AI with guardrails.** Model output must match a schema and is re-validated. Every product must match a catalogue SKU by lookup, and nothing is substituted. The default demo needs no model.
- **An idempotent workflow.** Intake dedupes on transport key and file hash. Approval binds to one version. Export is idempotent per approved version. Jobs use leases and retries.
- **Honest evaluation.** Development and held-out sets are reported separately, failures are listed, and a deterministic check was added after a silent model failure.
- **A real ERP hand-off.** The CSV follows the format Odoo 19's own import accepts. Approved orders can also be pushed to Odoo as draft quotations over its JSON-RPC API. Both were verified in local Odoo 17, 18 and 19 instances, not in a customer's ERP.

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

GitHub Actions runs typecheck, unit tests, the database suites on PostgreSQL 17, a Compose config check and a production dependency audit on every push to `main` and every pull request. Browser tests (`npm run test:browser`) need a throwaway database; see the header of `tests/e2e/desk.spec.ts`.

The 50 original email fixtures and 20 generated PDF fixtures are synthetic and visible development data. Current acceptance artifacts are in ignored `results/acceptance/`; methodology, results, and limits are in [docs/EVALUATION.md](docs/EVALUATION.md). All 50 email cases are now accounted for across two separate mock-mode runs: 42 stateless parser/domain cases and 8 stateful cases through real PostgreSQL/services. The stateful suite checks duplicates, amendments, cancellations, and history suggestions. This is not one end-to-end AI run. Database-backed lifecycle checks use separate isolated test databases; commands are in the evaluation guide.

## Architecture and scope

- **Next.js and TypeScript** provide the desk and authenticated API.
- **PostgreSQL** stores jobs, orders, documents, evidence, catalogue, audit history, and export snapshots. **A separate worker** claims leased jobs and applies bounded retry/dead-letter handling.
- **Mailpit** captures the synthetic demo email locally (demo only). The app has no outbound mail relay. A dedicated mailbox, such as a shared `orders@` address, feeds the desk through a small IMAP receiver (see below).
- **`parseInput`** reads MIME, plain text, sanitized HTML, CSV, and machine-generated PDF text. **`MockProvider`** is the default in the demo: deterministic rule-based extraction, not a language model. Outside demo mode the desk uses Gemini when it is configured, and otherwise a manual-entry provider that leaves the order for a reviewer. A Gemini reply must match a schema and is re-validated before use.
- **Domain validation** checks catalogue matches, customer-scoped aliases, effective prices, selling units, stock observations, addresses, flags, and approval requirements.
- **Synthetic history** is returned as a bounded, customer-scoped suggestion with provenance for reviewer confirmation. It is not sent to the extraction provider, and historical prices are not copied into current drafts.
- **Odoo** has two routes, both producing drafts. The CSV is version-bound and generated only after human approval; a person imports it (Test, then Import). **Send to Odoo** creates the same quotation over Odoo's JSON-RPC API, idempotent on retry. See [docs/ODOO-IMPORT.md](docs/ODOO-IMPORT.md).
- **Accounts and master data.** Users with roles, throttled login and session expiry. The CSV import wizard runs a dry run first and writes nothing if any row fails.
- **Sender trust.** A sender mapping suggests a customer. It is assigned automatically only for a trusted mapping whose receiving-server SPF, DKIM and DMARC results pass.

Generated scale fixtures contain 10,000 SKUs (8,000 active), 250 accounts, 500 addresses, 5,000 aliases, 15,000 price agreements, and 12,000 synthetic history records. A dated local Odoo 19 proof imported and reimported test quotations through Odoo's CSV import machinery. The Odoo push creates draft quotations only. It does not confirm, invoice, email or reserve stock. Nothing here is connected to a customer's ERP.

## Measured result and limitations

The 42-case stateless run passed all intent, route, required-flag, line-field, and customer checks; the separate real-PostgreSQL/services run passed all 8 stateful fixture cases. Together these account for the original 50 synthetic email cases, but they are different runs: the 42-case set uses fresh in-memory context, while the 8-case set exercises database state and replay behavior. The separate lifecycle suite passed 8 PostgreSQL checks; 12 domain checks run offline. All 20 machine-generated PDF cases passed 286/286 labelled line fields, including SKU, quantity, unit, quoted unit price, and page-backed evidence checks. Database-backed suites run only when their dedicated environment variables are set. CI runs them against PostgreSQL 17. The offline evaluators use `MockProvider`, so these figures are not AI accuracy, production accuracy, or a customer outcome.

Live Gemini results are reported separately:

- **Held-out set (36 cases, one run per model):** gemini-3.5-flash-lite got 25/30 emails and 6/6 PDFs fully correct, at a median 1.7 s and about $0.0038 per order. gemini-3.8-flash got 24/30 emails and 3/6 PDFs; its three PDF timeouts at the 60 s request limit account for the gap. Failures, the safety property and the model comparison are in [docs/EVALUATION.md](docs/EVALUATION.md#held-out-results).
- **Development set (70 visible cases, prompt tuned on them):** run 2 got 37/42 emails and 18/20 PDFs with every line exact, but only 167/286 PDF lines. It silently omitted lines on two 60-line PDFs. A row-count check added afterwards (`INCOMPLETE_EXTRACTION`) now blocks that case. Details in [docs/EVALUATION.md](docs/EVALUATION.md#live-ai-results-gemini).

Scanned PDFs/OCR and live use on real customer orders are outside this prototype. A single-server deployment path exists ([docs/OPERATIONS.md](docs/OPERATIONS.md)) but is not verified on a real server or public domain. Live mode sends email text to Google; use synthetic orders unless you have decided that is acceptable for your data.

## Project references

- [Acceptance runbook and measured results (including held-out)](docs/EVALUATION.md)
- [Demo walkthrough](docs/DEMO.md)
- [Screen-recording script](docs/VIDEO-SCRIPT.md)
- [Install, TLS, backups, upgrade and monitoring (one Linux server)](docs/OPERATIONS.md)
- [CSV import templates](docs/import-templates/README.md)
- [Local system, permission, restore, and worker-recovery checks](docs/SYSTEM-CHECKS.md)
- [Local Odoo import proof and field mapping](docs/ODOO-IMPORT.md)
- [Business and technical specification](docs/PROJECT-SPEC.md)
- [Original 50 email scenarios](fixtures/SCENARIOS.md)
- [Synthetic PDF cases](fixtures/pdf/cases.json)
- [Held-out email and PDF cases](fixtures/holdout/cases.json)
- [Scale fixture manifest](fixtures/scale/manifest.json)

The completed local demo includes Odoo quotation **S00007** from PDF-001, checked at **£61.40** and recorded as import verified in the desk. A replay after review is held for amendment review and cannot be approved as another new order. The Odoo import-service proof and browser-upload limitation are documented in `docs/ODOO-IMPORT.md`.

## Receive email from a dedicated test mailbox

A dedicated Gmail test inbox is connected over IMAP. It was verified end to end with a real email on 2026-10-28, and again on 2026-10-29 with a trusted sender through live Gemini and the Odoo push. Follow [TEST-INBOX.md](docs/TEST-INBOX.md) to connect your own. It runs without n8n or paid hosting, preserves the email and attachments, and keeps customer identity unresolved for review unless a trusted sender mapping passes SPF, DKIM and DMARC. Processing uses the mock extractor unless live AI is turned on; the live path is described in [TEST-INBOX.md](docs/TEST-INBOX.md#live-ai-in-the-desk).
