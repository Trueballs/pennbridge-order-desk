/**
 * AI voiceover with Gemini TTS (Interactions API). Run from the repo root:
 *   npx tsx video/voiceover.ts --po <PO> [--voice Achird] [--samples] [--only 3,4]
 * Writes video/out/voice/scene-<id>.wav + voice-durations.json. Results are cached per (model, voice, text, style) in
 * video/out/tts-cache/, so reruns cost nothing. The API key is read from GEMINI_API_KEY or runtime/ai/gemini_key and never printed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COPY, fill, sceneCopy, valuesForPo } from "./copy.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "video", "out");
const VOICE_DIR = path.join(OUT, "voice"), CACHE = path.join(OUT, "tts-cache"), SAMPLES = path.join(OUT, "voice-samples");
const STYLE = "relaxed, conversational, like a young professional casually walking a colleague through his own project; natural pace, not salesy, not like an announcer";
const MODELS = ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"];
const PRICE_PER_SEC = { "gemini-3.8-flash-tts": 9 / 1e6 * 25, "gemini-3.8-flash-lite-tts": 6 / 1e6 * 25 } as Record<string, number>; // audio output $/s (25 tokens/s)
const SAMPLE_VOICES = ["Achird", "Umbriel", "Zubenelgenubi", "Sadaltager", "Iapetus"];
const BUDGET_USD = 1;

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const VOICE = opt("voice") ?? "Achird"; const PO = opt("po"); const ONLY = opt("only")?.split(",");
const die = (m: string): never => { console.error(`FAILED: ${m}`); process.exit(1); };

function apiKey(): string {
  const env = process.env.GEMINI_API_KEY?.trim(); if (env) return env;
  const f = path.join(ROOT, "runtime/ai/gemini_key");
  if (existsSync(f)) { const k = readFileSync(f, "utf8").trim(); if (k) return k; }
  return die("No Gemini key: set GEMINI_API_KEY or create runtime/ai/gemini_key.");
}
const KEY = apiKey();
let spent = 0, billedSecs = 0, activeModel = MODELS[0];

function wavSeconds(buf: Buffer): number {
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("response is not WAV");
  let p = 12, rate = 24000, ch = 1, bits = 16;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4), size = buf.readUInt32LE(p + 4);
    if (id === "fmt ") { ch = buf.readUInt16LE(p + 10); rate = buf.readUInt32LE(p + 12); bits = buf.readUInt16LE(p + 22); }
    if (id === "data") { const n = Math.min(size, buf.length - p - 8); return n / (rate * ch * (bits / 8)); }
    p += 8 + size + (size & 1);
  }
  throw new Error("no data chunk in WAV");
}

async function synth(text: string, voice: string): Promise<Buffer> {
  for (let mi = MODELS.indexOf(activeModel); mi < MODELS.length; mi++) {
    const model = MODELS[mi];
    const hash = createHash("sha256").update(JSON.stringify([model, voice, text, STYLE])).digest("hex").slice(0, 24);
    const cached = path.join(CACHE, `${hash}.wav`);
    if (existsSync(cached)) return readFileSync(cached);
    if (spent >= BUDGET_USD) die(`TTS budget of $${BUDGET_USD} reached.`);
    const body = { model, input: [{ type: "user_input", content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style: STYLE }] }] }], response_format: { type: "audio" }, generation_config: { speech_config: [{ voice }] } };
    let res: Response | undefined, lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": KEY }, body: JSON.stringify(body) });
      if (res.ok || (res.status < 500 && res.status !== 429)) break;
      lastErr = `HTTP ${res.status}`; await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
    if (!res!.ok) {
      const msg = (await res!.text()).replace(KEY, "***").slice(0, 300);
      if ((res!.status === 404 || res!.status === 400) && mi + 1 < MODELS.length) { console.warn(`   ${model} unavailable (${res!.status}), falling back to ${MODELS[mi + 1]}`); activeModel = MODELS[mi + 1]; continue; }
      die(`TTS request failed (${res!.status}${lastErr ? ", " + lastErr : ""}): ${msg}`);
    }
    const json = await res!.json() as { steps?: { type?: string; content?: { type?: string; data?: string }[] }[] };
    const out = json.steps?.filter(s => s.type === "model_output").flatMap(s => s.content ?? []).find(c => c.data);
    if (!out?.data) die("No audio in TTS response.");
    const wav = Buffer.from(out!.data!, "base64"); const secs = wavSeconds(wav);
    spent += secs * PRICE_PER_SEC[model]; billedSecs += secs;
    mkdirSync(CACHE, { recursive: true }); writeFileSync(cached, wav);
    return wav;
  }
  return die("No TTS model available.");
}

async function main() {
  mkdirSync(VOICE_DIR, { recursive: true }); mkdirSync(SAMPLES, { recursive: true });
  if (!PO) die("Usage: npx tsx video/voiceover.ts --po <PO> [--voice Achird]");
  const vals = await valuesForPo(PO!);
  console.log(`Values for ${PO}: latency "${vals.latency}", cost "${vals.cost}"`);

  // voice samples (scene 3 line, short)
  if (!opt("no-samples")) {
    const line = fill(sceneCopy("3").segs.map(s => s.text).join(" "), vals);
    for (const v of SAMPLE_VOICES) { const wav = await synth(line, v); writeFileSync(path.join(SAMPLES, `${v}.wav`), wav); console.log(`sample ${v}: ${wavSeconds(wav).toFixed(1)}s`); }
  }

  const durations: Record<string, number> = {}; const prev = existsSync(path.join(OUT, "voice-durations.json")) ? JSON.parse(readFileSync(path.join(OUT, "voice-durations.json"), "utf8")) : null;
  if (prev && prev.voice === VOICE && prev.durations) Object.assign(durations, prev.durations);
  for (const sc of COPY) {
    if (ONLY && !ONLY.includes(sc.id)) continue;
    const text = fill(sc.segs.map(s => s.text).join(" "), vals);
    const wav = await synth(text, VOICE); const secs = wavSeconds(wav);
    writeFileSync(path.join(VOICE_DIR, `scene-${sc.id}.wav`), wav); durations[sc.id] = Math.round(secs * 1000) / 1000;
    const words = text.split(/\s+/).length;
    console.log(`scene ${sc.id.padEnd(3)} ${secs.toFixed(1).padStart(5)}s  ${(words / secs).toFixed(2)} words/s`);
  }
  writeFileSync(path.join(OUT, "voice-durations.json"), JSON.stringify({ voice: VOICE, model: activeModel, style: STYLE, po: PO, latency: vals.latency, cost: vals.cost, durations }, null, 2));
  void copyFileSync;
  console.log(`\nTTS billed this run: ${billedSecs.toFixed(0)} s of audio, about $${spent.toFixed(3)} (${activeModel}; cached clips are free). Voice: ${VOICE}`);
}
main().catch(e => die(String(e?.message ?? e).replace(KEY, "***")));
