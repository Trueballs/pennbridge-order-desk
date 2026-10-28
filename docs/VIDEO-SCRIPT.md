# Pennbridge Order Desk: 2.5-minute screen recording script

Target length: 2:30. Record in QuickTime (File > New Screen Recording) or Loom. Synthetic data only.

This recording uses live Gemini, so the flags on the order come from the model and can differ from run to run. Do one full dry run with the exact email first. If the flags differ on the day, change the flag words in Shot 5 and keep everything else.

## Before you record

- [ ] Gemini key already saved once: `python3 scripts/configure_ai.py` (the key stays in `runtime/ai/`). Do not show the key or the file.
- [ ] Mailbox receiver running: `bash scripts/start_mailbox.sh`. Then check for the `mailbox.ready` event: `docker compose -f infra/compose.yaml -f infra/mailbox.compose.yaml logs --tail 20 mailbox`
- [ ] Live mode on: `bash scripts/start_live_ai.sh`. The desk header badge reads "Extraction: Gemini live (gemini-3.5-flash-lite)".
- [ ] Desk healthy: `curl -s http://127.0.0.1:3087/api/health`, and `docker compose -f infra/compose.yaml ps` shows all services up.
- [ ] Clean desk data for this take: pick a PO number that has never been used, such as `DEMO-2611`. Search the Inbox for it first. Do not run `docker compose ... down -v` the day of the recording unless you want to lose all local data.
- [ ] Test inbox spam check: if earlier tests went to Spam, mark them **Not spam** before recording. The receiver reads only INBOX.
- [ ] Close other browser tabs and apps. Turn on Focus mode so no notifications appear. Hide the bookmarks bar.
- [ ] Set browser zoom to about 115%, so the desk text is readable on a phone.
- [ ] Hide personal email: send the test email from a separate, non-personal account, or from a clean browser profile. Crop the recording to the browser window. Do not show your personal inbox, contacts or sidebar.
- [ ] Do not show these on screen: `infra/odoo/.env.local`, anything under `runtime/`, app passwords, Odoo login details, terminal history with keys.
- [ ] Sign in to the desk as the reviewer (`reviewer@pennbridge.example`). A viewer cannot approve or export.
- [ ] Odoo running: `bash scripts/odoo_start.sh` (http://127.0.0.1:8067). Browser file upload into Odoo was not verified in our setup. Have the fallback sentence in Shot 8 ready.
- [ ] Do a 10-second test recording. Check the audio level and that the desk text is sharp.
- [ ] After recording, return to mock mode if you want: `bash scripts/stop_live_ai.sh`.

## The email to send (Shot 3)

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
> "Hi. I'm Oscar. This is Pennbridge Order Desk. It is a local project. The company is made up, and all the data is synthetic."

### Shot 2 · 0:10 to 0:22 · The desk and the live badge

On screen: point at the header badge "Extraction: Gemini live (gemini-3.5-flash-lite)". Then the order queue.

Say:
> "Customers send orders by email. This desk reads them and checks each line. The badge says Gemini live. So a real language model is reading this email."

### Shot 3 · 0:22 to 0:38 · Send a real email

On screen: the email compose window, from the separate account. Show To, Subject and the body. Click Send.

Say:
> "I send one purchase order to the test inbox. It is synthetic. It has a new PO number. Sending now."

### Shot 4 · 0:38 to 0:48 · The wait (cut in editing)

On screen: the queue, showing the new order when it appears. Cut the waiting time in editing. Do not speed up the clock.

Say:
> "The mailbox checks once a minute. Here is the order."

Editing note: the poll can take up to about 75 seconds. Cut the wait so it fits in 10 seconds, and mark the cut in your notes.

### Shot 5 · 0:48 to 1:08 · The order, the flags and the usage line

On screen: open the order. Point at the email on the left, the lines on the right, the flags, and the usage line at the bottom (tokens, cost, time).

Say:
> "On the left is the email. On the right are the lines the model found. At the bottom: tokens, cost and time. This order cost less than one cent. The desk flagged [say the flag in plain words]. I do not trust the model. So I check every line myself."

Replace the bracket with the real flag from the dry run, for example "the delivery address is not chosen yet".

### Shot 6 · 1:08 to 1:23 · Reviewer choices

On screen: choose the customer. Choose the delivery address. Click Save. Show the flag as resolved.

Say:
> "The email does not name the customer. So I choose it. I choose the delivery address. Then I save. The flag is now resolved."

### Shot 7 · 1:23 to 1:33 · Approve and export

On screen: click **Approve order**. Then **Prepare export**. Show the CSV download link.

Say:
> "I approve this exact version. The model never approves. Now I prepare the export file for Odoo."

### Shot 8 · 1:33 to 2:08 · Odoo import and the quotation

On screen: switch to Odoo. Go to **Sales > Quotations**, then **Import records**. Upload the downloaded CSV. Click **Test**, then **Import**. Open the imported quotation. Go back to the desk and type the quotation number into **Record manual verification**.

Say:
> "Now Odoo. The desk never writes to Odoo. I import the file myself. First I click Test. Test does not save anything. Then Import. Here is the quotation. It is a draft, with the customer and the PO number. Back in the desk, I record the quotation number."

Fallback if the browser file chooser fails (it was not verified in our Chrome setup):
> "The file chooser did not work in my browser. I ran the same import with Odoo's import service from the terminal. The steps are in the project docs."

Then show `docs/ODOO-IMPORT.md` on screen for a few seconds, and continue.

### Shot 9 · 2:08 to 2:30 · Close: what I learned (slide-free)

On screen: open `README.md` and scroll to the **Results** box at the top. Keep it on screen while you speak.

Say:
> "What I learned. First, a model can fail quietly. It once changed minus two into two. A positive two looks valid, so I added a check that counts the order rows in the PDF text itself, and does not trust the model. Second, I wrote 36 test cases and did not tune on them. The model got 25 of 30 emails and 6 of 6 PDFs fully right. Every error went to review. Thank you."

If you run over time, drop the first two sentences of the close and keep the held-out numbers.

## Check before you publish

- The timings add up to 2:30 if you read at the pace above. Time one full take.
- Check the usage line cost in Shot 5 on the dry run. If it is not under one cent, change the words "cost less than one cent".
- The held-out numbers are the 36-case set from [EVALUATION.md](EVALUATION.md#held-out-results): 25 of 30 emails and 6 of 6 PDFs, one run, synthetic.
- Do not say "production", "accurate in general", "the AI approves" or "Odoo accepted it". Odoo accepts the file only when the import is done and confirmed on screen.
- The Shot 5 flag and the Shot 6 choices must match what the live run shows on the day.
