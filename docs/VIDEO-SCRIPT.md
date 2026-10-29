# Pennbridge Order Desk: 2.5-minute screen recording script

Target length: 2:30. Record in QuickTime (File > New Screen Recording) or Loom. Synthetic data only.

This recording uses live Gemini, so the flags on the order come from the model and can differ from run to run. Do one full dry run with the exact email first, from the same sending account. If the flags differ on the day, change the words in Shot 5 and keep everything else.

## Before you record

- [ ] Gemini key already saved once: `python3 scripts/configure_ai.py` (the key stays in `runtime/ai/`). Do not show the key or the file.
- [ ] Mailbox receiver running: `bash scripts/start_mailbox.sh`. Then check for the `mailbox.ready` event: `docker compose -f infra/compose.yaml -f infra/mailbox.compose.yaml logs --tail 20 mailbox`
- [ ] Live mode on: `bash scripts/start_live_ai.sh`. The desk header badge reads "Extraction: Gemini live (gemini-3.5-flash-lite)".
- [ ] Odoo running with the push configured: `bash scripts/odoo_start.sh` (http://127.0.0.1:8067). Setup is in [ODOO-IMPORT.md](ODOO-IMPORT.md#direct-push). Have the fallback sentence in Shot 7 ready.
- [ ] Trusted sender mapping for the sending address, to C001 (Alderwick Engineering Ltd), added in the desk. Use an address you control. Check the test order's headers once: the receiving server should show SPF, DKIM and DMARC as pass. Without them, the customer will only be a suggestion.
- [ ] Desk healthy: `curl -s http://127.0.0.1:3087/api/health`, and `docker compose -f infra/compose.yaml ps` shows all services up.
- [ ] Clean desk data for this take: pick a PO number that has never been used, such as `DEMO-2611`. Search the Inbox for it first. Do not run `docker compose ... down -v` the day of the recording unless you want to lose all local data.
- [ ] Test inbox spam check: if earlier tests went to Spam, mark them **Not spam** before recording. The receiver reads only INBOX.
- [ ] Admin sign-in ready for Shot 9. Have a fictional user address ready. Do not show a password.
- [ ] Close other browser tabs and apps. Turn on Focus mode so no notifications appear. Hide the bookmarks bar.
- [ ] Set browser zoom to about 115%, so the desk text is readable on a phone.
- [ ] Hide personal email: send the test email from a separate, non-personal account, or from a clean browser profile. Crop the recording to the browser window. Do not show your personal inbox, contacts or sidebar.
- [ ] Do not show these on screen: `infra/odoo/.env.local`, anything under `runtime/`, app passwords, API keys, Odoo login details, terminal history with keys.
- [ ] Sign in to the desk as the reviewer (`reviewer@pennbridge.example`) for Shots 5 to 7. A viewer cannot approve or send to Odoo.
- [ ] Do a 10-second test recording. Check the audio level and that the desk text is sharp.
- [ ] After recording, return to mock mode if you want: `bash scripts/stop_live_ai.sh`.

## The email to send (Shot 3)

From: the trusted sending address.
To: the dedicated test inbox (see [TEST-INBOX.md](TEST-INBOX.md)).

Subject: `[PENNBRIDGE TEST] Purchase order DEMO-2611`

```text
Hi Pennbridge,

Please process purchase order DEMO-2611:
2 packs FB-0830-A2-100
6 each BR-6204-2RS

Deliver to MAIN.
This is a synthetic portfolio test, not a real purchase.
```

## Shot list

Read each "Say" line at a calm pace. Pause between sentences. The lines are short on purpose.

### Shot 1 · 0:00 to 0:10 · Intro

On screen: the desk home page, signed in as reviewer.

Say:
> "Hi. I'm Oscar. This is Pennbridge Order Desk. The company is made up, and all the data is synthetic."

### Shot 2 · 0:10 to 0:22 · The desk and the live badge

On screen: point at the header badge "Extraction: Gemini live (gemini-3.5-flash-lite)". Then the order queue.

Say:
> "Customers send orders by email. This desk reads them, checks each line, and can make a draft quotation in Odoo. The badge says Gemini live, so a real language model reads this email."

### Shot 3 · 0:22 to 0:36 · Send the email

On screen: the email compose window, from the trusted sending account. Show To, Subject and the body. Click Send.

Say:
> "I send one purchase order from an address the desk trusts. It is synthetic, with a new PO number. Sending now."

### Shot 4 · 0:36 to 0:46 · The wait (cut in editing)

On screen: the queue, showing the new order when it appears. Cut the waiting time in editing. Do not speed up the clock.

Say:
> "The mailbox checks once a minute. Here is the order."

Editing note: the poll can take up to about 75 seconds. Cut the wait so it fits in 10 seconds, and mark the cut in your notes.

### Shot 5 · 0:46 to 1:06 · The order, the customer and the flags

On screen: open the order. Point at the customer, which was set automatically. Point at the lines, the flags and the usage line at the bottom (tokens, cost, time).

Say:
> "The customer is set automatically. The desk trusts this sender, and the receiving server confirmed it with SPF, DKIM and DMARC. The model read the email. This order cost less than one cent. The desk flagged [say the flag in plain words]. I don't trust the model, so I check every line myself."

Replace the bracket with the real flag from the dry run, for example "the delivery address is not chosen yet". Change "cost less than one cent" only if the usage line on the dry run shows otherwise.

### Shot 6 · 1:06 to 1:16 · Review and approve

On screen: resolve the flag. Click Save. Click **Approve order**.

Say:
> "I resolve the flag, save, and approve this exact version. The model never approves."

### Shot 7 · 1:16 to 1:28 · Send to Odoo

On screen: click **Send to Odoo**. Wait until the export shows the push as done, with the quotation reference.

Say:
> "Now I send it to Odoo. The desk creates a draft quotation in Odoo. It is not confirmed."

Fallback if the push fails (the desk shows the reason):
> "The push did not complete, and the desk shows why. The CSV route still works. I download the file and import it by hand, with Test, then Import."

Then continue with the CSV steps from [DEMO.md](DEMO.md#scene-d-fallback-csv-export-and-manual-odoo-import-about-60-s) (Scene D) or cut to Shot 8 from the existing quotation.

### Shot 8 · 1:28 to 1:45 · The quotation in Odoo

On screen: switch to Odoo. Open the quotation from the link on the export, or go to **Sales > Quotations**. Show the customer, the PO reference, the two lines, the total and the status.

Say:
> "Here it is in Odoo. The customer, the PO number, the lines and the total match the approved version. It is a draft. Nothing is confirmed or invoiced."

### Shot 9 · 1:45 to 2:00 · Admin screen (15 s)

On screen: **Users**, then **Import**. Choose a file from `docs/import-templates/`, run the preview, and show the result. Do not apply.

Say:
> "An administrator adds users and loads price lists. Every import is a dry run first. Nothing is written until I apply it."

### Shot 10 · 2:00 to 2:30 · Close: what I learned

On screen: open `README.md` and scroll to the **Results** box at the top, then to **Known limits**. Keep it on screen while you speak.

Say:
> "What I learned. First, a model can fail quietly. It once turned minus two into two, so the desk checks the source itself and does not trust the model. Second, a sender needs proof. The desk trusts a customer only after the receiving server's SPF, DKIM and DMARC checks pass. Third, I wrote 36 test cases and did not tune on them. The model got 25 of 30 emails and 6 of 6 PDFs fully right. Every error went to review. Not yet tested: a real server with a public domain, and Microsoft 365 mail. Thank you."

If you run over time, drop the first sentence of the close and keep the sender and held-out lines.

## Check before you publish

- The timings add up to 2:30 if you read at the pace above. Time one full take. The close is the longest shot; check it first.
- Check the usage line cost in Shot 5 on the dry run before saying "less than one cent".
- Check the customer in Shot 5 is set automatically, not as a suggestion. If it is a suggestion, say so in the shot and confirm it on screen.
- The held-out numbers are the 36-case set from [EVALUATION.md](EVALUATION.md#held-out-results): 25 of 30 emails and 6 of 6 PDFs, one run, synthetic.
- Do not say "production", "accurate in general", "the AI approves" or "Odoo accepted it". Say "draft quotation in Odoo", and say it is a draft.
- The Shot 5 flag and the Shot 6 choices must match what the live run shows on the day.
