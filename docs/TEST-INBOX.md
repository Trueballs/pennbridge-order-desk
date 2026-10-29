# Dedicated test inbox

Status: **connected and verified end to end on 2026-10-28** with the dedicated Gmail account `pennbridgeorderstest@gmail.com` (app password, IMAP). A real email sent from another account arrived, was submitted by the receiver and processed by the worker into a `needs_review` order (customer selection is left to the reviewer by design). No paid services or AI calls were used. This is a small IMAP receiver in its own Docker container, not an n8n workflow. Existing n8n services are untouched.

## Connect a mailbox

Use a separate account containing only this project's synthetic mail. Gmail is supported through IMAP with an app password when the account offers that feature. Google requires 2-Step Verification for app passwords; eligibility can depend on account policy. Do not use the normal account password or share a credential in chat. An Outlook/Microsoft account that requires OAuth needs a different authentication setup; this password-based connector is not claimed to support it.

Create/sign in to the dedicated account yourself. Then configure it in Terminal:

```sh
cd '/Users/oscarwoldskaarderud/Pennbridge Order Desk'
python3 scripts/configure_mailbox.py
bash scripts/start_mailbox.sh
```

The setup prompts for the email address, IMAP host (Gmail: `imap.gmail.com`), folder (`INBOX`), an optional **subject prefix**, an optional first-run start date and the hidden app password. Secrets are stored only under ignored `runtime/mailbox/`. Its directory is owner-only (0700); individual files are readable inside their read-only Docker mounts. They are not put in images, command-line arguments or logs. Existing configuration is never silently overwritten.

Wait for the receiver log event **`mailbox.ready`** before sending a new test:

```sh
docker compose -f infra/compose.yaml -f infra/mailbox.compose.yaml logs --tail 20 mailbox
```

The first successful connection deliberately starts after existing mail. It does not import your backlog. If a test arrived before readiness, send another one afterward with a fresh PO number.

## Send a test from your usual email account

To: the dedicated test address you configured

Subject: `[PENNBRIDGE TEST] Purchase order DEMO-1001` (only needed if you set the prefix `[PENNBRIDGE TEST]` during setup; with the default blank prefix any subject is ingested)

```text
Hi Pennbridge,

Please process purchase order DEMO-1001:
2 packs FB-0830-A2-100
6 each BR-6204-2RS

Deliver to MAIN.
This is a synthetic portfolio test, not a real purchase.
```

Optionally attach a PDF from `fixtures/pdf/`. Send one consistent order per message. Polling runs every 60 seconds; the desk refreshes its queue every 15 seconds. Open http://127.0.0.1:3087 and review the new email. The connector does not authenticate the sender as a customer: select the appropriate synthetic customer (e.g. Alderwick/C001), select its delivery address, save and review validation. Do not treat the email's From header as authority.

Processing uses the deterministic mock parser unless you enable live mode (see "Live AI in the desk"). This step tests real email transport; it does not establish live AI accuracy.

Gmail spam: a new account may file the first test emails as Spam. The receiver reads only `INBOX`; mark the email **Not spam** and it is picked up on the next poll (moving it gives it a new INBOX UID above the checkpoint).

## Live AI in the desk

Opt-in, off by default. Real emails arriving through the receiver can be extracted by Gemini instead of the mock parser.

```sh
python3 scripts/configure_ai.py      # hidden key prompt -> runtime/ai/gemini_key (git-ignored)
bash scripts/start_live_ai.sh        # optional: EXTRACTION_MODEL=gemini-3.8-flash
bash scripts/stop_live_ai.sh         # back to mock mode
```

The key reaches only the worker, as a read-only Docker secret (`GEMINI_API_KEY_FILE`). Only the worker gets an extra egress network (`infra/live-ai.compose.yaml`); the app stays offline. Calls are capped at `AI_RUN_BUDGET_USD` (5.00) and `AI_ORDER_BUDGET_USD` (0.25) and cost real money. The desk header shows "Extraction: Mock" or "Extraction: Gemini live (model)", and each processed order shows its tokens, cost and latency. The header reflects configuration, not a successful call: check the order's usage line or the worker log. Email content is sent to Google while live mode is on, so use synthetic orders only.

## Behavior and isolation

- Reads new emails over certificate-verified TLS, preserving full MIME and attachments; does not send, delete, move or mark emails read.
- **Subject prefix is optional** (`subjectPrefix` in `runtime/mailbox/config.json`). Blank, the default for new setups, ingests every message in the folder. Set a prefix (e.g. `[PENNBRIDGE TEST]`) on a shared or test inbox to ingest only matching subjects. An existing config keeps its prefix. The receiver logs `mailbox.config` at start showing which mode is active.
- **Auto-replies and bulk mail are skipped before the body is fetched**: `Auto-Submitted` other than `no`, `Precedence: bulk/list/junk/auto_reply`, `List-Unsubscribe`/`List-Id`, `X-Auto-Response-Suppress`, `X-Autoreply`, a null `Return-Path`, delivery-status reports, mailer-daemon/postmaster senders, "Automatic reply/Out of office/Undeliverable" subjects and mail from the mailbox's own address. `noreply@` senders are not filtered (many ERP systems send purchase orders that way). Each skip is appended to `skipped.jsonl` in the state volume (uid, sender, subject, reason, time) and the checkpoint advances.
- **Per-sender rate limit**: `senderRateLimitPerHour` (default 30, 0 = off). Excess messages from one sender are logged to `skipped.jsonl` as `sender_rate_limited` with a `mailbox.alert` log line; other senders are unaffected. The window is in memory and resets on restart.
- **Poison messages**: a message whose failure is specific to it (desk answered 4xx other than 401/403/408/429, the body could not be fetched, size changed) is counted persistently in `failures.json`. After `maxAttemptsPerMessage` (default 5) it is quarantined (metadata plus failure code in `quarantine/`, no body) with a `poison_message_quarantined` alert and the queue moves on. Outages, 5xx, timeouts and credential errors never count, so a desk restart cannot quarantine good mail. A message that makes the desk return HTTP 500 every time is not counted and will still hold the queue; watch `mailbox_poll_failed` repeats.
- **Credential alerts**: HTTP 401/403 from the desk (`intake_unauthorized`) or a rejected IMAP login (`imap_auth_failed`) writes `alert.json` in the state volume and logs a `mailbox.alert` error that says mail is not being ingested. The alert clears itself after the next successful poll. `status.json` records the last poll (time, ok, processed, consecutive failures, error code) for health checks.
- **Checkpoint durability**: every checkpoint write is fsynced and atomic and the previous good copy is kept as `checkpoint.json.prev`, which is used if the main file is damaged. If both are unreadable the receiver stops with `invalid_checkpoint` instead of starting over. If the state volume is ever lost, the first connection creates a new baseline and logs `mailbox.baseline_created` ("Mail already in the mailbox was NOT imported"). Set `"ingestSince": "YYYY-MM-DD"` in `config.json` before restarting to baseline from a date instead; the desk ignores messages it already has (transport IDs include mailbox, UIDVALIDITY and UID). Back up the `mailbox-state` volume with the rest of the data.
- Saves a durable checkpoint after accepted intake. Retries the same UID on failure; transport IDs include mailbox identity, UIDVALIDITY and UID. The app's deduplication prevents duplicate intake after a crash between acceptance and checkpointing.
- Maximum 20 messages per poll and 10 MiB per email. Oversize messages create local metadata-only records under the receiver state volume's `quarantine/`; they do not appear as successfully imported orders.
- On mailbox identity or UIDVALIDITY change, stops advancing and logs a reset-required error rather than silently starting over. Preserve the checkpoint and investigate before deliberately resetting it.
- Only the receiver has an internet network. App and worker retain private networks. The receiver reaches the intake endpoint on a separate internal network and has no database credentials. Its token cannot approve orders, export, or assert a customer identity.
- Receiver egress is a normal Docker bridge, not a destination allowlist. The app/worker offline-network claim does not apply to this opt-in receiver.
- Your Mac must be awake and Docker running. Once started, the receiver restarts with Docker; it does not require a public webhook, domain or paid hosting.

Inspect receiver state (read-only):

```sh
docker compose -f infra/compose.yaml -f infra/mailbox.compose.yaml exec mailbox sh -c 'ls /app/runtime/mailbox-state /app/runtime/mailbox-state/quarantine; tail -5 /app/runtime/mailbox-state/skipped.jsonl; cat /app/runtime/mailbox-state/status.json /app/runtime/mailbox-state/alert.json'
```

Stop receiving without deleting state:

```sh
docker compose -f infra/compose.yaml -f infra/mailbox.compose.yaml stop mailbox
```

## Verified so far

The receiver tests (`tests/mailbox.test.ts`, `tests/mailbox-auth.test.ts`, `tests/mailbox-hardening.test.ts`) cover first-connect baseline (including `ingestSince`), sequential retry, crash replay, optional subject filtering, oversized messages, identity/UIDVALIDITY changes, TLS/read-only fetching, header-based auto-reply/bulk detection, sender rate limiting, poison quarantine, 401/403 alerting, checkpoint recovery from a torn write and HTTP acceptance. Two additional token tests cover separate mailbox authority and rejection of asserted customer identity or alternate channels. These are simulated transport/adapter tests, not proof of a real Gmail connection. Re-verified with real Gmail messages on 2026-10-29 after the pre-filter, rate limit and poison handling landed (7 emails incl. a PDF attachment and a trusted-sender order that went on to Odoo; see `results/e2e/2026-10-29-live-email.md`).

Sources checked 28 October 2026: [Google app passwords](https://support.google.com/mail/answer/185833?hl=en), [ImapFlow client API](https://imapflow.com/docs/api/imapflow-client/).
