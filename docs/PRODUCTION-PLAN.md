# Production hardening plan (2026-10-28)

## Status (2026-10-29)

Current status. The work sections below are the plan as written on 2026-10-28; they are kept for reference, not as a to-do list.

- **Wave 1 (ops, infra, database): done.** Install script, production Compose with Caddy HTTPS, restart policies and healthchecks, readiness endpoint, env validation, migration runner, backup/restore/upgrade scripts, monthly AI budget, security headers, GitHub Actions CI. See [OPERATIONS.md](OPERATIONS.md).
- **Wave 2 (order workflow, admin UI, Odoo push, E2E): done.** Sender mappings with SPF/DKIM/DMARC gating, manual path (add/remove line, reprocess, manual entry), search and paging, accounts and CSV import, direct Odoo push of approved orders, 9 Playwright browser tests, live Gmail end-to-end run (2026-10-29).
- **Not yet verified:**
  - Let's Encrypt issuance on a real public domain (only Caddy's internal CA tested)
  - `scripts/install.sh` on a real Ubuntu server (macOS test, Docker install skipped)
  - Microsoft 365 / OAuth mailboxes (IMAP with app password only)
  - Minimal permissions for the Odoo integration user
  - Odoo versions other than 19
  - Offsite backup copies (not provided), high availability and sustained load (not tested)

## Plan (2026-10-28)

Goal: a wholesaler (10–50 staff, a few reviewers, Odoo, one shared orders@ mailbox, one Linux server) can install and run this with their own data. Source: code audit (IDs P0-x/P1-x/P2-x below) plus a live end-to-end email run.

## Rules for every worker
- Work only in your owned paths. `apps/web/app/api/[...path]/route.ts` is shared: make small additive edits and re-read it right before each edit.
- Migrations: numbered files `packages/db/migrations/NNN-name.sql` (W1 builds the runner and moves `001-initial.sql` there; W2/W3 add 002+ with distinct numbers: W2 uses 010–019, W3 uses 020–029).
- Every fix gets a test. Keep existing tests green: `npm run typecheck`, `npx vitest run`, and `bash scripts/test_db.sh` (creates fresh uniquely named databases, safe in parallel; if you need a rebuilt image, build your own tag and pass `PB_TEST_IMAGE=pennbridge-app:<you>`). Don't restart or rebuild the running `pennbridge-dev` stack — the coordinator does that.
- Don't commit. Return a handoff: changed files, fixed IDs, tests added, checks run, anything unverified.
- Match the existing terse code style. Demo mode must keep working (`DEMO_MODE=true` keeps fixture seed, demo users, /api/demo, Mailpit, mock provider) so the portfolio demo and existing tests still run.

## Wave 1
- **W1 Ops/infra/db** — owns `infra/`, `apps/worker/`, `packages/db/` (except new migration files of others), `apps/web/next.config.ts`, `.github/`, `scripts/backup*.sh`, `scripts/restore*.sh`, `.env.example`, `docs/OPERATIONS.md` (new).
  P0-7 restart policies, healthchecks, pool error handler, worker loop resilience · P0-8 TLS profile (Caddy or nginx with certs), Secure cookies by default in production, X-Forwarded-Proto from scheme, security headers/CSP (P1-20), Mailpit and demo out of production compose · P1-15 nginx per-request DNS · P1-14 env validation with zod at startup, no default DB password in production · P1-13 migration runner · P1-18 resource limits, nightly backup + restore script, session purge · P0-4 budget part: budgets per calendar month, release timed-out reservations after a grace period, admin reprocess allowance · P2-5 multi-stage Dockerfile, HEALTHCHECK, GitHub Actions CI (typecheck, unit tests, npm audit) · P1-16 readiness endpoint data (DB ping, oldest queued job age, last mailbox poll — expose a function in packages/db, W3 wires UI).
  Production compose = `infra/compose.prod.yaml` (or a profile) + `.env` produced by an install script `scripts/install.sh` that generates strong secrets.
- **W2 Order workflow core** — owns `packages/server/index.ts`, `packages/domain/`, `packages/contracts/`, `packages/ingestion/`, `packages/ai/`, migrations 010–019, tests for these.
  P0-6 sender→customer mapping (table, resolution from parsed From/domain, shown as *suggested* customer requiring confirmation unless the admin marks the mapping trusted; spoofing note) · P0-4 manual path: add line, remove line (audited, reason), reprocess (re-run extraction) and manual entry on failed/no-line orders; revalidate when customer is assigned so agreement prices/addresses apply · P1-3 · P1-4 retryable vs permanent errors · P1-1 order list by created_at with composite cursor · P1-2 server-side search (PO, customer, sender, SKU, date range) · P1-10 pricing date in Europe/London stored on order · P1-11 CSV formula-injection guard + currency from data · P1-12 export state machine · P1-17 safe user-facing error messages · P2-1 · P2-4 · duplicate reason codes deduped (live run: QUOTE_REQUEST appeared twice) · non-orders shouldn't get order-only flags (MISSING_PO_REFERENCE/SHIPPING_ADDRESS_AMBIGUOUS on a quote request) · P0-2: production default provider = live if configured, otherwise a "manual entry" provider (no lines, clear reason); MockProvider only in DEMO_MODE.
- **W3 Accounts, data import, mailbox** — owns `packages/server/admin.ts` and `packages/server/auth.ts` (new; move login/session code here if needed, coordinate exports), `packages/mailbox/`, `apps/mailbox/`, `packages/db/seed.ts`, migrations 020–029, `scripts/configure_mailbox.py`, tests for these.
  P0-3 no demo users outside DEMO_MODE; first-run admin bootstrap (CLI `scripts/create_admin.ts`); user CRUD, change password, deactivate, role change (admin only) · P0-9 login throttling per IP+account, dummy hash compare, password policy (≥12 chars), bcrypt cost 12, session expiry/revocation + purge · P0-5 admin CSV import (products, customers, addresses, price agreements, aliases, stock, sender mappings) with dry-run preview, validation errors per row, versioned catalogue; templates in `docs/import-templates/` · P0-1 subject prefix optional (empty = ingest all) · P1-5 pre-filter auto-replies/bulk (Auto-Submitted, List-Unsubscribe, Precedence, mailer-daemon) into a skipped log, per-sender rate limit · P1-6 poison message quarantine after N failures and alert on 401/403 · P1-7 checkpoint in Postgres or explicit start-date on baseline, loud log.

## Wave 2 (after wave 1 review)
- UI for all new features (users/admin, import wizard, sender mappings, add/remove line, reprocess, search, paging, health banner), Playwright E2E suite, Odoo JSON-RPC push of approved quotations (replaces manual CSV import as an option), live Gmail E2E battery.
