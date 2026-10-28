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

The setup prompts for the email address, IMAP host (Gmail: `imap.gmail.com`), folder (`INBOX`) and hidden app password. Secrets are stored only under ignored `runtime/mailbox/`. Its directory is owner-only (0700); individual files are readable inside their read-only Docker mounts. They are not put in images, command-line arguments or logs. Existing configuration is never silently overwritten.

Wait for the receiver log event **`mailbox.ready`** before sending a new test:

```sh
docker compose -f infra/compose.yaml -f infra/mailbox.compose.yaml logs --tail 20 mailbox
```

The first successful connection deliberately starts after existing mail. It does not import your backlog. If a test arrived before readiness, send another one afterward with a fresh PO number.

## Send a test from your usual email account

To: the dedicated test address you configured

Subject: `[PENNBRIDGE TEST] Purchase order DEMO-1001`

```text
Hi Pennbridge,

Please process purchase order DEMO-1001:
2 packs FB-0830-A2-100
6 each BR-6204-2RS

Deliver to MAIN.
This is a synthetic portfolio test, not a real purchase.
```

Optionally attach a PDF from `fixtures/pdf/`. Send one consistent order per message. Polling runs every 60 seconds; the desk refreshes its queue every 15 seconds. Open http://127.0.0.1:3087 and review the new email. The connector does not authenticate the sender as a customer: select the appropriate synthetic customer (e.g. Alderwick/C001), select its delivery address, save and review validation. Do not treat the email's From header as authority.

Processing still uses the deterministic mock parser. This step tests real email transport; it does not establish live AI accuracy.

Gmail spam: a new account may file the first test emails as Spam. The receiver reads only `INBOX`; mark the email **Not spam** and it is picked up on the next poll (moving it gives it a new INBOX UID above the checkpoint).

## Behavior and isolation

- Reads new matching-subject emails over certificate-verified TLS, preserving full MIME and attachments; does not send, delete, move or mark emails read.
- Saves a durable checkpoint after accepted intake. Retries the same UID on failure; transport IDs include mailbox identity, UIDVALIDITY and UID. The app's deduplication prevents duplicate intake after a crash between acceptance and checkpointing.
- Maximum 20 messages per poll and 10 MiB per email. Oversize messages create local metadata-only records under the receiver state volume's `quarantine/`; they do not appear as successfully imported orders.
- On mailbox identity or UIDVALIDITY change, stops advancing and logs a reset-required error rather than silently starting over. Preserve the checkpoint and investigate before deliberately resetting it.
- Only the receiver has an internet network. App and worker retain private networks. The receiver reaches the intake endpoint on a separate internal network and has no database credentials. Its token cannot approve orders, export, or assert a customer identity.
- Receiver egress is a normal Docker bridge, not a destination allowlist. The app/worker offline-network claim does not apply to this opt-in receiver.
- Your Mac must be awake and Docker running. Once started, the receiver restarts with Docker; it does not require a public webhook, domain or paid hosting.

Stop receiving without deleting state:

```sh
docker compose -f infra/compose.yaml -f infra/mailbox.compose.yaml stop mailbox
```

## Verified so far

15 receiver tests cover first-connect baseline, sequential retry, crash replay, subject filtering, oversized messages, identity/UIDVALIDITY changes, TLS/read-only fetching and HTTP acceptance. Two additional token tests cover separate mailbox authority and rejection of asserted customer identity or alternate channels. Type checking and the existing offline suite pass. These are simulated transport/adapter tests, not proof of a real Gmail connection. Complete that proof only after authentication and an actual received test email.

Sources checked 28 October 2026: [Google app passwords](https://support.google.com/mail/answer/185833?hl=en), [ImapFlow client API](https://imapflow.com/docs/api/imapflow-client/).
