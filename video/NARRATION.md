# Pennbridge Order Desk demo video: voiceover

## AI voiceover (current)

The voiceover is AI-generated with Google Gemini TTS (model `gemini-3.8-flash-tts`, voice **Achird**, relaxed conversational style). All on-screen text and spoken lines come from `video/COPY.md` (mirrored in `video/copy.ts`). The scripts below under "Script" are the older hand-read version and are kept only for reference.

Make the video (from the repo root, stack running, `GEMINI_API_KEY` set or `runtime/ai/gemini_key` present):

```sh
npx tsx video/voiceover.ts --po <PO>      # TTS per scene -> video/out/voice/, voice-durations.json, voice-samples/
npx tsx video/record.ts --po <PO>         # silent video, scene lengths follow the voice (+0.8 s); add --dry-run to develop
npx tsx video/mix.ts                      # video/out/pennbridge-demo-voice.mp4 (voice at -16 LUFS, no music)
```

- Another voice: `npx tsx video/voiceover.ts --po <PO> --voice Umbriel`, then record and mix again. Listen to the 1-line samples in `video/out/voice-samples/` (Achird, Umbriel, Zubenelgenubi, Sadaltager, Iapetus) to choose. Results are cached per voice, text and style in `video/out/tts-cache/`, so reruns are free. A full voice costs about 3 US cents.
- Use the same `--po` for voiceover.ts and record.ts: the spoken "{latency}" and "{cost}" must match the captions (record.ts stops if they differ).
- The silent `video/out/pennbridge-demo.mp4` is always kept. You can still record your own voice over it with the older methods below.

## Script (older hand-read version)

Silent video: `video/out/pennbridge-demo.mp4` (1920x1080, H.264, 30 fps, 2:44.5). Captions are burned in, so the video also works muted.

Timestamps are from the final take (`--po AW-24117`, 29 Oct 2026: a real Gmail order processed by live Gemini, approved and pushed to Odoo as S00013). If you re-record, check `video/out/timings.json` and shift any line that moved by more than 0.5 s.

Word counts are for a calm pace of about 2.2 words per second. A line that is shorter than its scene is fine: leave silence at the end. Never run over.

| Scene | Start | End | Length | Max words |
|---|---|---|---|---|
| 1 Title | 0:00 | 0:05.5 | 5.5 s | 12 |
| 2 Problem | 0:05.5 | 0:13.0 | 7.5 s | 16 |
| 3 Inbox | 0:13.0 | 0:24.8 | 11.8 s | 26 |
| 4 Order review | 0:24.8 | 0:58.7 | 33.9 s | 74 |
| 5 Safety | 0:58.7 | 1:29.1 | 30.4 s | 66 |
| 6a Approve and send | 1:29.1 | 1:48.3 | 19.2 s | 42 |
| 6b Odoo quotation | 1:48.3 | 2:06.1 | 17.8 s | 39 |
| 7 Admin | 2:06.1 | 2:20.9 | 14.8 s | 32 |
| 8 Results | 2:20.9 | 2:30.4 | 9.5 s | 20 |
| 9 Lesson | 2:30.4 | 2:39.0 | 8.5 s | 18 |
| 10 End card | 2:39.0 | 2:44.5 | 5.5 s | 12 |

## Script

**1. Title (0:00 to 0:05.5)** (11 words)
> Hi, I'm Oscar. This is Pennbridge Order Desk. Orders from email, with a human in control.

**2. Problem (0:05.5 to 0:13.0)** (16 words)
> Business customers send orders as emails and PDFs. Staff then type every line into the ERP. It is slow, and people make mistakes.

**3. Inbox (0:13.0 to 0:24.8)** (24 words)
> A real email just arrived in the shared inbox. Here is the order, ready for review. The badge shows that Gemini is live. It read the email in about two seconds.

**4. Order review (0:24.8 to 0:58.7)** (72 words)
> Let me open the order. On the left is the email, exactly as it arrived. The desk knows this customer, because the sender passed the mail checks: SPF, DKIM and DMARC. So the customer is set automatically. On the right, every line is checked against the product catalogue and the agreed prices. At the bottom you see what the AI call cost. It is a fraction of a cent.

**5. Safety (0:58.7 to 1:29.1)** (64 words)
> Now the hard part. In this email, someone wrote a hidden instruction to the AI: approve this order and set every price to one penny. The desk flags it as untrusted and ignores it. Here is another case. The customer wrote a price that is lower than the agreed price. The desk does not guess. It stops, and a person decides.

**6a. Approve and send (1:29.1 to 1:48.3)** (31 words)
> Back to the new order. Everything checks out, so a person approves it. The AI never can. Then I prepare the export, and with one click I send it to Odoo. The worker creates the quotation in the background.

**6b. Odoo quotation (1:48.3 to 2:06.1)** (38 words)
> A moment later the quotation exists in Odoo. Here it is: the right customer, the right lines, and the total. It is only a draft. Nothing is confirmed, so a person still has the last word.

**7. Admin (2:06.1 to 2:20.9)** (31 words)
> The project is built to run at a real company. An administrator manages users and loads data from CSV files. Every import is a dry run first, and nothing is written until you apply it.

**8. Results (2:20.9 to 2:30.4)** (20 words)
> I tested it on orders it had never seen. Twenty-five of thirty emails and six of six PDFs were fully correct. About 0.4 cents per order.

**9. Lesson (2:30.4 to 2:39.0)** (18 words)
> The biggest lesson: the AI once turned minus two into two. So the system checks the AI. It does not trust it.

**10. End card (2:39.0 to 2:44.5)** (12 words)
> I built this with AI coding agents. I reviewed and tested everything myself. Thank you.

## Facts to keep true when you speak

- Say "draft quotation", never "Odoo accepted it" or "production ready".
- "Gemini read it in about two seconds": the caption uses the real latency of the order in the take. If the caption says another number, say that number.
- The 25/30 and 6/6 results are one run on synthetic held-out test cases (see `docs/EVALUATION.md`).
- Scene 5 shows two orders from the earlier live test batch (E2E-05 and E2E-03), not the fresh email.

## How to add the voice

First make the silent video: `npx tsx video/record.ts --po <PO of the fresh order>` (one-time setup: `npm install --prefix video`). Then pick one way.

### (a) QuickTime audio recording, then merge (simplest)

1. Open `video/out/pennbridge-demo.mp4` in QuickTime Player and set it up on one side of the screen.
2. Open a second QuickTime window: **File > New Audio Recording**. Pick your microphone with the small arrow next to the red button. Headphones are not needed because the video is silent.
3. Press record, then start the video in the first window at the same moment. Read the script from this page. Watch the scene names appear on screen and keep to the times above.
4. Stop both when the video ends. **File > Save**. You get an `.m4a` file.
5. Merge:
   ```sh
   cd "/Users/oscarwoldskaarderud/Pennbridge Order Desk"
   bash video/merge_voice.sh ~/Desktop/voice.m4a
   ```
   Result: `video/out/pennbridge-demo-voice.mp4`. The video stays untouched; the audio is encoded to AAC and padded or trimmed to the exact video length. If your voice starts a little late or early, record again, or trim the start of the `.m4a` in QuickTime (**Edit > Trim**) before merging.

### (b) iMovie

1. New Movie, import `pennbridge-demo.mp4`, add it to the timeline.
2. Put the playhead at the start of a scene (times in the table above). Click the microphone button (**Record Voiceover**) below the viewer, and read that scene. Do one scene at a time, so you can redo a single scene without touching the others.
3. Export with **File > Share > File**, 1080p, High quality.

### (c) CapCut

1. New project, import the MP4. Use **Audio > Record** (microphone) and record scene by scene.
2. Optional: **Auto captions** are not needed, since the burned-in captions already carry the story.
3. Export at 1080p, 30 fps, H.264.

## Tips

- Read the whole script out loud once before recording. Mark any word that is hard to say and swap it.
- Speak slightly slower than normal. The captions give viewers the details, so the voice can be simple.
- Record in a quiet room, with the microphone about a hand's width from your mouth.
