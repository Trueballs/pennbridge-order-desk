/**
 * Builds the voiced video: places each scene's AI voice clip (video/out/voice/scene-<id>.wav) 0.4 s into its scene
 * (from video/out/timings.json), light high-pass + gentle compression, loudness about -16 LUFS, no music, no room tone.
 * The video stream is copied from pennbridge-demo.mp4 (kept as the silent version).
 *   npx tsx video/mix.ts
 * Output: video/out/pennbridge-demo-voice.mp4
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "video", "out");
const IMAGE = "linuxserver/ffmpeg@sha256:6547359fac23a2747e606d380e10267b2923a38f68485d9cacefd039e74d3aa8"; // same pinned image as record.ts
const LEAD = 0.4;
const t = JSON.parse(readFileSync(path.join(OUT, "timings.json"), "utf8")) as { totalSeconds: number; scenes: { name: string; start: number; duration: number }[] };
const ins: string[] = [], chains: string[] = [], labels: string[] = [];
for (const s of t.scenes) {
  const id = s.name.split(" ")[0], f = path.join("voice", `scene-${id}.wav`);
  if (!existsSync(path.join(OUT, f))) { console.error(`Missing ${f}. Run: npx tsx video/voiceover.ts --po <PO>`); process.exit(2); }
  const k = ins.length / 2, ms = Math.round((s.start + LEAD) * 1000);
  ins.push("-i", f); chains.push(`[${k + 1}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${ms}:all=1[a${k}]`); labels.push(`[a${k}]`);
}
const pre = `${chains.join(";")};${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=longest,highpass=f=70,acompressor=threshold=-22dB:ratio=2:attack=20:release=300:makeup=2`;
const base = ["run", "--rm", "-v", `${OUT}:/work`, "-w", "/work", "--entrypoint", "ffmpeg", IMAGE, "-y", "-hide_banner", "-nostats"];
// pass 1: measure the mixed voice; pass 2: apply linear gain to land on -16 LUFS (true peak <= -2 dBFS)
const p1 = spawnSync("docker", [...base, "-i", "pennbridge-demo.mp4", ...ins, "-filter_complex", `${pre},loudnorm=I=-16:TP=-2:LRA=9:print_format=json[a]`, "-map", "[a]", "-f", "null", "-"], { encoding: "utf8" });
const j = JSON.parse((p1.stderr.match(/\{[^{}]*"input_i"[^{}]*\}/) ?? [])[0] ?? "null");
if (!j) { console.error("loudness measurement failed"); process.exit(1); }
const ln = `loudnorm=I=-16:TP=-2:LRA=9:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
const graph = `${pre},${ln},apad=whole_dur=${t.totalSeconds.toFixed(3)},aformat=channel_layouts=stereo[a]`;
execFileSync("docker", [...base, "-loglevel", "error", "-i", "pennbridge-demo.mp4", ...ins, "-filter_complex", graph, "-map", "0:v:0", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", t.totalSeconds.toFixed(3), "-movflags", "+faststart", "pennbridge-demo-voice.mp4"], { stdio: "inherit" });
console.log(`Voice loudness ${j.input_i} LUFS -> -16 LUFS. Wrote ${path.join(OUT, "pennbridge-demo-voice.mp4")}`);
