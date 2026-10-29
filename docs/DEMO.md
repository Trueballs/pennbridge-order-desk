# Pennbridge Order Desk: demo and interview notes

Refreshed 2026-10-29. Synthetic data only. Pennbridge is a fictional UK industrial wholesaler. Scenes were checked against the code, fixtures and project docs. The live email-to-Odoo path (Scene A) ran once end to end on 2026-10-29. Dry-run every scene once before presenting it (see the pre-demo checklist).

## 1. Pitch

Customers still send purchase orders as emails with PDF attachments, and someone retypes each line into the ERP. They check part numbers, pack sizes and agreed prices by hand, and the errors are expensive. Pennbridge Order Desk reads the email and its attachment, matches each line to the catalogue and the customer's agreed prices, and flags anything it cannot match or that disagrees with master data. The reviewer sees the source next to the draft. A person approves one exact version of the draft. Then the reviewer can send it to Odoo, a local test ERP, which creates a draft quotation. The desk can also prepare a CSV for a manual import.

Sender identity is checked where it can be. A trusted sender mapping assigns the customer automatically only when the receiving mail server's SPF, DKIM and DMARC checks pass. Otherwise the customer is a suggestion that a person confirms.

The language model is optional. The default demo uses a deterministic rule-based extractor and makes no model calls. Live mode uses Gemini (`gemini-3.5-flash-lite`) and is off by default. On a held-out set of 36 synthetic cases (30 emails, 6 PDFs), written separately from the prompt and never used for tuning, it got **25 of 30 emails and 6 of 6 PDFs fully right**, at about **$0.004 per order**. Every error it made carried a blocking flag, so it went to review rather than to a draft. The earlier development set (70 visible cases, the prompt was tuned on them) scored 37 of 42 emails and 18 of 20 PDFs. Treat those as development numbers only. Details: [EVALUATION.md](EVALUATION.md#held-out-results).

The repository also has a production path: an install script for one Linux server with HTTPS, backups, restore, user accounts and a CSV import wizard. It is tested locally and in CI, but not yet on a real server with a public domain. See "Is this production-ready?" in section 5.

## 2. Pre-demo checklist

Run once before the call, from the project folder:

```sh
cd "/Users/oscarwoldskaarderud/Pennbridge Order Desk"
npm ci
docker compose -f infra/compose.yaml up --build -d
docker compose -f infra/compose.yaml ps
curl -s http://127.0.0.1:3087/api/health
```

Expected: App, worker, Postgres, Mailpit and proxy are running. The health check returns `{"ok":true,"mode":"mock"}`. If the desk shows **502 Bad Gateway** after the app was rebuilt, run `docker compose -f infra/compose.yaml restart proxy`.

Which scenes need what:

- **Scene A (live):** the mailbox receiver, live Gemini, Odoo running with the push enabled, and a trusted sender mapping. This is the only scene that needs the network. Setup:
  - `python3 scripts/configure_ai.py` (once; hidden key prompt, stored only under ignored `runtime/ai/`), then `bash scripts/start_live_ai.sh`. The header badge should read "Extraction: Gemini live (gemini-3.5-flash-lite)". `scripts/start_live_ai.sh` also enables the Odoo push when it is configured.
  - `bash scripts/start_mailbox.sh`, then wait for the receiver log event `mailbox.ready`.
  - Odoo: `bash scripts/odoo_start.sh`. For the push, follow "Direct push" in [ODOO-IMPORT.md](ODOO-IMPORT.md#direct-push).
  - A trusted sender mapping for the address you send from, to C001 (Alderwick Engineering Ltd). Add it under sender mappings in the desk, or in `sender_mappings.csv` with `trusted=true`. Use an address you control. Trust the exact address only. A public domain such as gmail.com is rejected.
- **Scenes B and C:** mock mode is enough.
- **Scene D (CSV fallback):** Odoo running, no live AI needed.
- **Scene E (admin):** an administrator sign-in. Do not show passwords.

Stop live mode after the call with `bash scripts/stop_live_ai.sh` if you want to return to mock. The base `infra/compose.yaml` stays mock-only. Do not show live mode on the call unless it has been dry-run.

Only needed for the Odoo steps:

```sh
bash scripts/odoo_start.sh
```

Odoo runs at http://127.0.0.1:8067 (database `pennbridge`). Its login is in the git-ignored `infra/odoo/.env.local`. Do not paste it on screen. The master data was seeded during earlier runs. On a fresh Odoo volume, run `bash scripts/odoo_seed_master.sh` first.

Open these tabs:

| Tab | URL | Use |
|---|---|---|
| Order desk | http://127.0.0.1:3087 | Whole demo |
| Mailpit | http://127.0.0.1:8027 | Optional: show the captured email in Scene B |
| Odoo | http://127.0.0.1:8067 | Scenes A, D |
| Sending mail account | (your account) | Scene A: send from the trusted address |

Sign in as the reviewer: `reviewer@pennbridge.example` / `reviewer-demo`. A viewer account cannot upload, approve or export. The local demo also has an administrator (`admin@pennbridge.example`) for Scene E. The seeded demo users exist only in demo mode. On a real server, use the administrator created with `scripts/create_admin.ts`.

Before the call, search the Inbox for PO `PB-001` and for your Scene A PO number. An existing order with the same PO is treated as already received, so nothing new is created. Either use that order, or pick a new PO number. To reset the local desk data, run `docker compose -f infra/compose.yaml down -v`. That deletes the desk database and stored documents for this project. It does not touch the separate Odoo volumes or the n8n install. Run it only when you mean to lose local demo data.

Do one full dry run the day before. Re-check the warning text in Scene B and the flags in Scene A, because the exact wording and flags come from the live code, the seeded data and (in Scene A) the live model.

## 3. Scenes

Total target: about 3 minutes. Scene A is the core (about 90 s). Scene B, C or E can be cut to fit the time. Scene D is the fallback if the Odoo push or the mailbox is not available.

### Scene A: email from a trusted sender to an Odoo draft quotation (about 90 s, live)

Purpose: show a real email going through the desk, the sender check, the human approval and the Odoo push.

Email: from the trusted address, to the dedicated test inbox. Subject: `[PENNBRIDGE TEST] Purchase order <a PO number not used before>`. Body:

```text
Hi Pennbridge,

Please process purchase order <PO>:
2 packs FB-0830-A2-100
6 each BR-6204-2RS

Deliver to MAIN.
This is a synthetic portfolio test, not a real purchase.
```

Clicks:
1. Send the email. Wait for the order to appear. The mailbox polls every 60 seconds and the queue refreshes every 15 seconds, so allow up to about 75 seconds. Cut the wait in editing rather than speeding up the clock.
2. Open the new order. Point at the customer, which is assigned from the trusted sender mapping. Point at the header badge "Extraction: Gemini live (gemini-3.5-flash-lite)" and at the usage line under the source (tokens, cost, latency). The badge shows configuration, not a successful call, so the usage line is the evidence.
3. Check the lines and the delivery address against the source. Resolve any remaining flags, then click **Save changes**.
4. Click **Approve order**.
5. Click **Send to Odoo**. Wait until the export shows the push as done and gives the quotation reference.
6. Open the quotation in Odoo (from the link on the export, or Sales > Quotations). Check the customer, the PO reference, the two lines, the prices and that the status is draft.

Say: "The model reads the email and the desk checks every line. The model does not approve. I approve this exact version. Odoo gets a draft quotation. Nothing is confirmed or invoiced."

Viewer should see: the customer set from a trusted sender, the live badge with a usage line, approval as a separate human step, and a draft quotation in Odoo with the PO number.

Limits:
- The flags depend on the live model for that email. Dry-run the exact email first. If the flags differ on the day, say so and show the flags you get.
- The customer is set automatically only when the receiving server's SPF, DKIM and DMARC results pass. If it shows as a suggestion, say so and confirm it as the reviewer. This is the correct behaviour.
- Live mode sends email text to Google. Synthetic orders only.
- The mailbox receiver runs only while this Mac and Docker are awake.
- If the push fails, the export shows the reason. Continue with Scene D.

### Scene B: price discrepancy and reviewer resolution (about 50 s)

Fixture: the **Try sample order** button. It sends `fixtures/pdf/PDF-001.eml`, which has the machine-generated PDF `fixtures/pdf/PDF-001.pdf` attached. It is captured in Mailpit and then processed. The button always uses this fixture, so the demo does not choose a different one. This scene runs in mock mode.

Clicks:
1. Click **Try sample order**. The toast reads "Synthetic sample order submitted."
2. Optional: switch to Mailpit at http://127.0.0.1:8027 to show the captured email, then return to the desk.
3. In the queue, open the newest order (PO PDF-001).
4. Point at the source panel, the PDF preview and the line evidence.
5. Point at the warning cards. Expected on the seeded data:
   - **PRICE MISMATCH** on TAPE-PTFE-12: source price £1.50, current master price £1.35.
   - **EXPIRED PRICE AGREEMENT** on BR-6204-2RS: quoted £6.00 for 6 units. The only Alderwick tier for that bearing starts at 10 units, so the list price £6.00 is shown for review.
6. In each warning card, type a **Reviewer note** explaining the decision.
7. Click **Save changes**, then **Approve order**.

Say: "The desk does not decide the price. It shows which number disagrees with master data, where the number came from, and it records who accepted the difference."

Viewer should see: the quoted price and the master price side by side, evidence from the PDF, a reviewer note saved to the audit trail, and approval only after the note is saved.

Presenter note: the reason code is `EXPIRED_PRICE_AGREEMENT`, but the message explains the real cause: no agreement tier applies to 6 units, so the list price needs explicit review.

Backup if the flags differ on the day: use `fixtures/emails/PB-022.eml` (email for 2 packs at £8 each against a £10 agreement). Upload it under the same customer and expect `PRICE_MISMATCH`.

### Scene C: replayed order blocked (about 30 s)

Fixture: `fixtures/emails/PB-001.eml`. Use the same customer as Scene D. Run it after Scene D, or use a PO that has not been used yet.

Clicks:
1. Click **Upload order**.
2. Choose **Alderwick Engineering Ltd**.
3. Choose `fixtures/emails/PB-001.eml`.
4. Click **Submit order**.

Viewer should see: the toast "This document was already received. Showing its existing order." The queue count does not change, so no second order is created.

Say: "The same bytes for the same account are recognised and not processed again. A file with the same PO number but different content is handled as a separate case."

Limit: the same PO sent as a different file is covered by an automated test (`PB-032`, returns `DUPLICATE_PO`), not in the UI. The fixtures contain no second file with the same PO but different bytes, so do not show that case live.

### Scene D (fallback): CSV export and manual Odoo import (about 60 s)

Use this if the Odoo push or the mailbox is not working on the day. It is also the route for an Odoo without the push configured.

Fixture: `fixtures/emails/PB-001.eml`. Email body: "book PO PB-001: 2 packs of FB-0830-A2-100. Delivery to our MAIN address." Expected: no review flags, status `draft_ready`.

Clicks:
1. Click **Upload order**.
2. Under **Customer account**, choose **Alderwick Engineering Ltd** (C001).
3. Choose the file `fixtures/emails/PB-001.eml` from the project folder.
4. Click **Submit order**. The toast reads "Order received. Processing has started."
5. Refresh the queue if needed and open the new Alderwick row with PO PB-001.
6. Check the delivery address is MAIN, then click **Approve order**.
7. Click **Prepare export**. The toast says the approved export was downloaded, and **Export history** shows a CSV with a **Download** link.
8. Open Odoo, go to **Sales > Quotations**, choose **Import records**, upload the downloaded CSV, click **Test**, then **Import**.
9. Open the imported quotation: customer Alderwick, customer reference PB-001, one line of 2 packs of FB-0830-A2-100 at £10.00, status draft.
10. Back in the desk, in the export row, type the Odoo quotation number into **Record manual verification**.

Say: "The desk never writes to Odoo in this route. A person imports the file, and the desk records what the person verified."

Caveat: browser file upload into Odoo was not verified in our Chrome setup (Chrome's file-URL permission was off). If the file chooser fails, say so. The import was verified through Odoo's import service, using the shell route in `docs/ODOO-IMPORT.md` (`scripts/verify_app_export.py`), not a click path.

### Scene E: admin adds a user and imports a price list (about 20 s)

Purpose: show that administration is in the desk, and that imports are a dry run first.

Clicks:
1. Sign in as the administrator. Do not show the password.
2. Open **Users**. Add a user with a fictional address and the reviewer role. Point at the role. Do not show the temporary password.
3. Open **Import**. Choose a file from `docs/import-templates/` (for example `price_agreements.csv`). Run the preview. It lists what would be created or updated and any row errors, by row and column.
4. Do not apply. Say so.

Say: "An administrator adds users and loads master data. Every import is a dry run first. Nothing is written until I apply it, and one bad row blocks the whole file."

Viewer should see: a new user in the list, and a preview with counts and row-level errors.

## 4. Architecture

```
 Dedicated mailbox (IMAP)            Upload / Try sample (Mailpit)
   apps/mailbox receiver              apps/web desk (Next.js)
   (scoped token, no approval)        (reviewer session)
              \                        /
               v                      v
     +------------------------------------------+
     | Intake API  (packages/server: intake)    |
     | transport key + content hash dedupe     |
     | stores message, document, order, job     |
     +------------------------------------------+
                        |
                        v
     +------------------------------------------+
     | PostgreSQL job queue                     |
     | jobs with leases, retry, dead-letter     |
     +------------------------------------------+
                        |
                        v
     +------------------------------------------+
     | Worker (apps/worker)                     |
     |  parseInput: MIME, text, HTML, CSV, PDF  |
     |  extraction: Gemini (if configured),     |
     |     manual entry, or MockProvider (demo) |
     +------------------------------------------+
                        |
                        v
     +------------------------------------------+
     | Deterministic validation                 |
     | (packages/domain: validate)              |
     | SKU/alias lookup, units, prices,         |
     | addresses, stock, flags                  |
     +------------------------------------------+
                        |
                        v
     +------------------------------------------+
     | Reviewer approval                        |
     | edits invalidate approval; approval      |
     | binds version + content hash             |
     +------------------------------------------+
                        |
                        v
     +------------------------------------------+
     | Export (packages/server)                 |
     | idempotent snapshot per approved version |
     | Odoo CSV (odoo19-quotation-v2)           |
     | or Send to Odoo: draft via JSON-RPC     |
     +------------------------------------------+
                        |
                        v
     Odoo 19 Sales: draft quotation (push), or a human imports the CSV (Test, then Import)
```

## 5. Questions you'll be asked

**1. Why not n8n?**
Mailbox polling could be done in n8n. I kept the rules in the app because approval, de-duplication and pricing need the same tests as the rest of the code. The project plan keeps n8n as an optional transport only; it must not own approvals or business rules. The mailbox receiver is a small container with no n8n (see `docs/TEST-INBOX.md`).

**2. How do you contain errors from the model?**
On the held-out set, gemini-3.5-flash-lite got 25 of 30 emails and 6 of 6 PDFs fully right (one run, 36 synthetic cases). The five email failures each carried a blocking flag, so they went to review. The run file does not store the final status, so this is inferred from the flags (see EVALUATION). Containment is layered. A model reply must match a schema and is re-validated before use. Every product must match a catalogue SKU by lookup, and nothing is substituted. Prices and quantities are checked against master data. PDF lines keep the quoted source text with its page. Any unresolved reason on the order or a line blocks `draft_ready`, and a person approves the draft. The held-out run also found a gap: an invented unit that matches the catalogue selling unit passes the unit checks. So the main net is human review, not the model.

**3. How do you handle idempotency and retries?**
Three layers. Intake dedupes on the transport key and the file's SHA-256 hash, under advisory locks. Business duplicates are matched by customer and PO: identical content is marked duplicate, and changed content goes to amendment review. Approval binds to a version number and content hash, so any edit invalidates it. Export takes an idempotency key and writes one snapshot per approved version. The Odoo push creates its quotation under a fixed external ID and origin marker, so a retry or a crash after creation returns the same quotation and creates nothing. Jobs use leases, so a crashed worker's job is reclaimed. The worker-crash check in `docs/SYSTEM-CHECKS.md` is one local test of this.

**4. What does it cost to run?**
In the demo, nothing: no model is called and `LIVE_AI_ENABLED=false`. In live mode, the held-out run measured $0.0038 per order with gemini-3.5-flash-lite ($0.1355 for 36 cases). The development run 2 measured $0.0027 per order on 70 visible cases. The live caps are $5 per run and $0.25 per order in the local setup (`infra/live-ai.compose.yaml`). A server deployment has a monthly budget (`AI_RUN_BUDGET_USD`) and a per-order cap (`AI_ORDER_BUDGET_USD`). Each call reserves its worst-case cost before it is made. Measured live spend across all benchmark runs, from the result files, is about $0.94. These are measured on synthetic fixtures, not at production volume.

**5. What is not verified?**
- Accuracy on real customer orders. The held-out set is synthetic and small (36 cases, one run per model). The 25/30 figure has wide error bars.
- Delivery-address extraction is the most common remaining error for both models.
- The unit gap in H-016: an invented unit that matches the selling unit passes the checks.
- Why H-017 raised `MISSING_CUSTOMER` although a verified customer was supplied. Not investigated yet.
- Complete extraction of long PDFs. The row-count guard counts tabular rows only. Omitted lines in prose orders are left to the reviewer (see Q9).
- The Anthropic live path. No run is recorded.
- Scanned PDFs and OCR.
- On a real server: Let's Encrypt issuance on a public domain, `install.sh` on Ubuntu, Microsoft 365 / OAuth mailboxes (IMAP with an app password only), minimal permissions for the Odoo integration user, and Odoo versions other than 19. See the Known limits section in the README.
- Performance beyond one local sample and beyond one server.

**6. How do I change a business rule?**
Rules live in `packages/domain/index.ts` in the `validate` path. Examples: the £0.01 tolerance and `PRICE_MISMATCH` are around line 171; the 24-hour stock staleness check is around line 174; the total check is around line 182. Add a test in `tests/core-domain.test.ts`, then rerun `npx tsx scripts/evaluate.ts`. The `policies` block in `fixtures/context.json` is reference data. The domain code does not read it, so changing that block changes nothing.

**7. Why not post straight to Odoo?**
There is a push, but it is not automatic. A reviewer clicks **Send to Odoo** on an approved export. The push creates a draft quotation, never a confirmed order. An automatic post would skip the approval step, and approval must be a human decision on a fixed version. The CSV import stays as a fallback because it is a visible, reversible step: Odoo's Test button rolls back before anything is written.

**8. How do you know who sent the order?**
Not from the From header alone. A sender mapping suggests a customer. It is assigned automatically only when the sender is marked trusted and the receiving server's SPF, DKIM and DMARC checks pass (see Q12). Otherwise the desk shows the suggestion and a person confirms it. Unknown senders are flagged for review (`UNVERIFIED_SENDER` in the fixtures).

**9. What did the benchmarks teach you?**
Held-out first. On the 36-case held-out set, the most common remaining error for both models was delivery-address extraction: three of the five flash-lite email failures (H-018, H-020, H-021) and all six of the 3.8 email failures involve the address. The held-out set also showed the unit gap described in Q2.

The development-set runs (tuned on, so these are lessons, not estimates) taught four things. Details are in [EVALUATION.md](EVALUATION.md#live-ai-results-gemini).

- **A quietly changed sign.** In run 1 the model turned a quantity of `-2` into `2` (PB-049). A positive 2 looks like a valid line, so validation alone would not have caught it. The benchmark's field scoring did. The prompt now requires the exact sign, and PB-049 passed in run 2.
- **Field confusion.** Product codes went into `manufacturerReference` or `customerAlias` instead of `sku`, causing catalogue misses. Descriptions went into `sku`, which blocked description search. The prompt now states where each value belongs.
- **Truncation.** Four large multi-page PDFs hit the 8,192-token output limit in run 1. Raising the limit to 32,768 fixed PDF-010 and PDF-020, which now pass exactly. PDF-005 and PDF-015 no longer error, but they still return too few lines.
- **Silent line omission.** PDF-005 and PDF-015 are 60-line PDFs. In run 2 the model returned 1 and 0 lines, with no error. This is the most important open risk for the dev set.

What contained them: the reply is checked against a zod schema, and the one schema-invalid reply (PB-047) was rejected. Catalogue lookup does not substitute products. When PB-015's invented suffix `6204-2RS` matched nothing, no wrong product was chosen and the line was flagged. Human approval is still required for every order. The silent omission is different. The reply is valid and every returned line checks out, so validation passes and only a reviewer comparing the source PDF with the lines would notice. So I added a deterministic check that doesn't trust the model: it counts the order rows in the PDF text itself and blocks the order when the model returned fewer lines (`lineCoverage` in `packages/domain/index.ts`). Replayed on the run 2 outputs it catches both shortened PDFs, with no false alarms on the 70 development orders. The lesson: when a model fails quietly, add an independent check instead of a better prompt.

**10. Why the cheaper model?**
Because on this held-out set it was both more accurate and much cheaper. The comparison, same 36 cases, one run each:

| | gemini-3.5-flash-lite (default) | gemini-3.8-flash |
|---|---|---|
| Emails fully right (30) | 25 | 24 |
| PDFs fully right (6) | 6 | 3 (three timed out at the 60 s limit) |
| API latency p50 / p95 | 1.7 s / 13.4 s | 17.4 s / 43.8 s |
| Cost per order | $0.0038 | $0.0117 (33 completed orders) |

The 3.8 model's PDF gap comes entirely from the timeouts; the three PDFs it finished were exact. Its promotional price runs until 2026-12-31 and then roughly doubles. I did not rerun it with a longer timeout. A change now would turn the held-out set into a development set. Flash-Lite stays the default. The 3.8 model can still be chosen with `EXTRACTION_MODEL=gemini-3.8-flash`. The email difference is one case, and the sample is small, so treat this as one observation.

**11. Is this production-ready?**
Not yet for live customer orders. It is ready to pilot on synthetic or low-risk orders with a person reviewing every draft.

Done and checked:
- An install script, HTTPS through Caddy, production Compose with restart policies and healthchecks, and a readiness endpoint.
- Nightly backups, a restore that was tested into a scratch database, and an upgrade script with rollback.
- Admin-managed accounts, throttled login, a password policy, session expiry, and a first-run admin CLI.
- A CSV import wizard with a dry run for master data.
- Sender trust through SPF, DKIM and DMARC, human approval, and a direct Odoo draft push that is idempotent.
- GitHub Actions CI with typecheck, unit tests, database suites, a dependency audit, and 9 browser tests.
- A live run on 2026-10-29: a real Gmail order from a trusted sender became an Odoo draft quotation after human approval.

Not verified:
- Let's Encrypt on a real public domain. Only Caddy's internal CA was tested.
- `install.sh` on a real Ubuntu server. The test ran on macOS with Docker installation skipped.
- Microsoft 365 or OAuth mailboxes. Only IMAP with an app password was tested.
- Minimal permissions for the Odoo integration user, and Odoo versions other than 19.
- Offsite backups, high availability and sustained load are not provided or not tested.

Say: "It is ready for a pilot with a person checking every draft. It is not yet tested on a real server, or with a real customer's mail and ERP."

**12. How do you stop a forged email from getting a customer's prices?**
Three layers, and the human approval is the last one.

1. **The From header is never enough.** A sender mapping only suggests a customer, unless it is marked trusted.
2. **A trusted mapping needs a passing check at the receiving server.** The desk reads the `Authentication-Results` header that the receiving mail server added, and only the topmost one. That header is added by our own receiving server. Lower copies can be written by the sender, so they are ignored. The customer is assigned automatically only when SPF, DKIM and DMARC all pass. Otherwise it stays a suggestion for a reviewer to confirm.
3. **Public mail domains cannot be trusted.** A domain mapping for a large public provider (such as gmail.com or outlook.com) is rejected at import. Trust a specific address you control.

Then a person approves the exact version. Approval binds to a version and content hash, so any edit invalidates it. Nothing reaches Odoo without that approval.

Limits: a DMARC pass shows the message was authenticated for its From domain. It does not prove which person sent it. The mailbox receiver's token cannot assert a customer, so the receiver never picks one. The protection depends on the receiving server adding a correct header. The forged-header case is covered by `tests/workflow-db.test.ts` (a database suite). The live check used one Gmail account.

**13. What happens when the AI fails?**
- **A bad reply is rejected, not used.** The model's reply must match the schema. A schema-invalid reply is refused and the order gets a reason (`MODEL_OUTPUT_INVALID`).
- **Errors become reasons on the order.** Timeouts, unavailable service and a failed call show as `MODEL_TIMEOUT` or `MODEL_UNAVAILABLE`. The order goes to review. It is not silently approved.
- **The worker retries with backoff, then stops.** A failed job is retried a bounded number of times with growing delays, then moves to a dead-letter state. Dead-letter jobs appear in the readiness report.
- **A person can take over.** A reviewer can enter the customer and lines by hand (manual entry), add or remove lines with a reason, or reprocess the email. Reprocessing is limited per order. An administrator can allow more attempts.
- **Budgets stop the spend.** When the monthly or per-order cap is reached, the order shows `BUDGET_EXCEEDED` and waits. Nothing is sent to the model after the cap.
- **The desk shows it.** A readiness banner reports a stale worker, a queue that is backing up, or a mailbox that cannot poll.
- **Without a model at all**, the production default is manual entry: the order arrives with no lines and a clear reason.

Say: "When the model fails, the desk does not guess. The order waits for a person, and the reason is on screen."

## 6. Honest limitations

- **Mock mode by default in the demo.** The default extraction in the demo is a deterministic rule-based parser. Live Gemini extraction is off unless explicitly enabled and configured. On the held-out set, gemini-3.5-flash-lite got 25 of 30 emails and 6 of 6 PDFs fully right in one run. Development-set numbers (37 of 42 emails, 18 of 20 PDFs, tuned on) are secondary. See [EVALUATION](EVALUATION.md#held-out-results).
- **Local demo, and one server in production.** The demo runs with Docker Compose on this machine, bound to localhost. The production path (see [OPERATIONS.md](OPERATIONS.md)) is one Linux server with HTTPS. It is not verified on a real server with a public domain, and there is no high availability.
- **Synthetic data only.** Fictional customers, products and prices. The held-out set was written separately from the prompt and never used for tuning, but it is still synthetic and small (36 cases). Results are not production accuracy.
- **Sender identity is only partly proven.** A trusted mapping needs a passing SPF, DKIM and DMARC result at the receiving server. Other mail stays a suggestion that a person confirms.
- **Live mode sends email text to Google.** Use synthetic orders only while it is on.
- **Odoo has two routes.** The push creates draft quotations over JSON-RPC, and was verified on Odoo 19 only. The CSV import is still manual. Browser CSV upload was not verified; the import itself was verified through Odoo's import service.
- **Mailbox is a local poller in the demo.** A dedicated Gmail test inbox is connected over IMAP and was verified end to end on 2026-10-28 and 2026-10-29. Microsoft 365 / OAuth mailboxes were not tested. It polls every 60 seconds.
- **PDFs only machine-generated.** Scanned PDFs and OCR are not supported.
- **Current counts** (from `docs/EVALUATION.md`): 42 email cases stateless, 8 stateful cases with PostgreSQL, 20 PDF cases with 286 labelled lines (offline mock mode, development fixtures). Live held-out: 36 cases (30 email, 6 PDF, 133 lines), one run per model. Reported on 2026-10-29: 101 unit tests, 84 database tests (6 suites), 9 browser tests.
