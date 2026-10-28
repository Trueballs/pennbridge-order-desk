# Pennbridge Order Desk: 3-minute demo and interview notes

Synthetic data only. Pennbridge is a fictional UK industrial wholesaler. Scenes and fixtures below were checked against the code, fixtures and project docs. The app was not run for this document, so confirm each scene once before presenting it (see the pre-demo dry run).

## 1. Pitch

Customers still send purchase orders as emails with PDF attachments, and someone retypes each line into the ERP. They check part numbers, pack sizes and agreed prices by hand, and the errors are expensive. Pennbridge Order Desk reads the email and its attachment, matches each line to the catalogue and the customer's agreed prices, and flags anything it cannot match or that disagrees with master data. The reviewer sees the source next to the draft. Nothing is approved automatically: a person approves one exact version of the draft, and only then does the desk produce a CSV for a quotation import into Odoo, a local test ERP. The demo uses a deterministic rule-based extractor, not a language model. A Claude adapter exists behind a flag, is off by default, and has not been benchmarked.

## 2. Pre-demo checklist

Run once before the call, from the project folder:

```sh
cd "/Users/oscarwoldskaarderud/Pennbridge Order Desk"
npm ci
docker compose -f infra/compose.yaml up --build -d
docker compose -f infra/compose.yaml ps
curl -s http://127.0.0.1:3087/api/health
```

Expected: App, worker, Postgres, Mailpit and proxy are running. The health check returns `{"ok":true,"mode":"mock"}`.

Only needed for the Odoo step in Scene A:

```sh
bash scripts/odoo_start.sh
```

Odoo runs at http://127.0.0.1:8067 (database `pennbridge`). Its login is in the git-ignored `infra/odoo/.env.local`. Do not paste it on screen. The master data was seeded during earlier runs. On a fresh Odoo volume, run `bash scripts/odoo_seed_master.sh` first.

Open these tabs:

| Tab | URL | Use |
|---|---|---|
| Order desk | http://127.0.0.1:3087 | Whole demo |
| Mailpit | http://127.0.0.1:8027 | Optional: show the captured email in Scene B |
| Odoo | http://127.0.0.1:8067 | Scene A, import step |

Sign in as the reviewer: `reviewer@pennbridge.example` / `reviewer-demo`. A viewer account cannot upload, approve or export.

Before the call, check the Inbox for an existing order with PO `PB-001` (use the search box). If one exists, Scene A's upload is treated as already received and nothing new is created. Either use that order, or reset the local desk data with `docker compose -f infra/compose.yaml down -v`. That command deletes the desk database and stored documents for this project. It does not touch the separate Odoo volumes or the n8n install. Run it only when you mean to lose local demo data.

Do one full dry run the day before. Re-check the warning text in Scene B, because the exact wording comes from the live code and seeded data, not from this document.

## 3. Three scenes

Total target: about 3 minutes. Scene A is the core; Scene B and C can be cut to fit the time.

### Scene A: clean order to Odoo quotation (about 70 s)

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

Say: "The desk never writes to Odoo. A person imports the file, and the desk records what the person verified."

Viewer should see: a draft from a PO with no warnings, a named approver and the approval time, a CSV that matches the approved version, and an Odoo quotation that is still a draft.

Caveat: browser file upload into Odoo was not verified in our Chrome setup (Chrome's file-URL permission was off). If the file chooser fails, say so. The import was verified through Odoo's import service, using the shell route in `docs/ODOO-IMPORT.md` (`scripts/verify_app_export.py`), not a click path.

### Scene B: price discrepancy and reviewer resolution (about 50 s)

Fixture: the **Try sample order** button. It sends `fixtures/pdf/PDF-001.eml`, which has the machine-generated PDF `fixtures/pdf/PDF-001.pdf` attached. It is captured in Mailpit and then processed. The button always uses this fixture, so the demo does not choose a different one.

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

Fixture: `fixtures/emails/PB-001.eml`, the same file as Scene A. Use the same customer.

Clicks:
1. Click **Upload order**.
2. Choose **Alderwick Engineering Ltd**.
3. Choose `fixtures/emails/PB-001.eml` again.
4. Click **Submit order**.

Viewer should see: the toast "This document was already received. Showing its existing order." The queue count does not change, so no second order is created.

Say: "The same bytes for the same account are recognised and not processed again. A file with the same PO number but different content is handled as a separate case."

Limit: the same PO sent as a different file is covered by an automated test (`PB-032`, returns `DUPLICATE_PO`), not in the UI. The fixtures contain no second file with the same PO but different bytes, so do not show that case live.

## 4. Architecture

```
 Dedicated test inbox (IMAP)        Upload / Try sample (Mailpit)
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
     |  extraction: MockProvider (default)      |
     |     or LiveProvider (off, unbenchmarked) |
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
     | idempotent snapshot, Odoo CSV            |
     | odoo19-quotation-v2                      |
     +------------------------------------------+
                        |
                        v
     Odoo 19 Sales: human imports the CSV (Test, then Import)
```

## 5. Questions you'll be asked

**1. Why not n8n?**
Mailbox polling could be done in n8n. I kept the rules in the app because approval, de-duplication and pricing need the same tests as the rest of the code. The project plan keeps n8n as an optional transport only; it must not own approvals or business rules. The mailbox receiver is a small container with no n8n (see `docs/TEST-INBOX.md`). The live mailbox is not connected yet.

**2. How do you contain hallucinations?**
The demo has no language model in the loop. The mock extractor is rule-based. If the live adapter is enabled, its reply must match a schema and is re-validated before use. Every product must match a catalogue SKU through lookup. Nothing is silently substituted. Prices and quantities are checked against master data, and PDF lines keep the quoted source text with its page. A person approves the draft. The live adapter has no benchmark yet, so I cannot quote its accuracy.

**3. How do you handle idempotency and retries?**
Three layers. Intake dedupes on the transport key and the file's SHA-256 hash, under advisory locks. Business duplicates are matched by customer and PO: identical content is marked duplicate, and changed content goes to amendment review. Approval binds to a version number and content hash, so any edit invalidates it. Export takes an idempotency key and writes one snapshot per approved version. Jobs use leases, so a crashed worker's job is reclaimed. The worker-crash check in `docs/SYSTEM-CHECKS.md` is one local test of this.

**4. What does it cost to run?**
In the demo, nothing: no model is called and `LIVE_AI_ENABLED=false`. For live runs, the code reserves the worst-case cost before each call, against a run cap and a per-order cap. The defaults in the plan are $5 per run and $0.10 per order. Pricing must be entered explicitly. No live benchmark has run, so I have no measured cost per order and will not quote one.

**5. What is not verified?**
Live model accuracy. Odoo browser file upload. Sender authentication. A real external mailbox end to end. Scanned PDFs. Odoo posting from the desk (the desk only produces a file). Performance beyond one local sample. Production readiness.

**6. How do I change a business rule?**
Rules live in `packages/domain/index.ts` in the `validate` path. Examples: the £0.01 tolerance and `PRICE_MISMATCH` are around line 171; the 24-hour stock staleness check is around line 174; the total check is around line 182. Add a test in `tests/core-domain.test.ts`, then rerun `npx tsx scripts/evaluate.ts`. The `policies` block in `fixtures/context.json` is reference data. The domain code does not read it, so changing that block changes nothing.

**7. Why not post straight to Odoo?**
Approval must be a human decision on a fixed version, and an automatic post would bypass that. Posting also needs an API integration and error handling against a real customer ERP, which is out of scope. The CSV is already in the format Odoo's own import accepts, so the import is a visible, reversible step. Odoo's Test button rolls back before anything is written.

**8. How do you know who sent the order?**
You don't, from the email alone. The From header is not treated as proof. The account is chosen by a person (or the test harness for synthetic cases), and the desk shows the account on the draft. Unknown or unverified senders are flagged for review (`UNVERIFIED_SENDER` in the fixtures).

## 6. Honest limitations

- **Mock mode.** Extraction is a deterministic rule-based parser. Live AI is off unless explicitly enabled and configured, and no live benchmark has been run.
- **Local only.** It runs on Docker Desktop on this machine, bound to localhost. There is no hosting and no public access.
- **Synthetic data only.** Fictional customers, products and prices. The 50 email and 20 PDF cases are development fixtures, not a held-out test. Results are not production accuracy.
- **Sender not authenticated.** The desk does not prove who sent an email. A person selects the account.
- **Odoo step is manual.** The desk produces a CSV. A person imports it into Odoo. Browser upload was not verified. The import itself was verified through Odoo's import service.
- **Mailbox not live.** The IMAP receiver is built and tested against simulated transport. It is not connected to a real account.
- **PDFs only machine-generated.** Scanned PDFs and OCR are not supported.
- **Current counts** (from `docs/EVALUATION.md`): 42 email cases stateless, 8 stateful cases with PostgreSQL, 20 PDF cases with 286 labelled lines. These are offline mock-mode results on the same fixtures the code was built against.
