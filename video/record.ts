/**
 * Scripted, reproducible screen recording of the REAL Pennbridge Order Desk (silent, 1920x1080, H.264 MP4).
 *
 *   npx tsx video/record.ts --po <PO of the fresh order> [--dry-run]
 *
 * - Every scene is its own Playwright clip (new context + page, recordVideo 1920x1080). Waiting happens behind a cover
 *   that is lifted only when the scene is ready; the cover time is trimmed off in ffmpeg.
 * - ffmpeg runs in a pinned Docker image (the local Playwright ffmpeg is VP8-only).
 * - Real sender addresses are blurred on screen; no Gmail / Google Cloud / secrets are ever opened.
 * - Timing comes from the AI voiceover: run `npx tsx video/voiceover.ts --po <PO>` first. Each scene is held for
 *   voice duration + 0.8 s and the voice starts 0.4 s into the scene (video/out/voice-durations.json); without that file
 *   the hold is estimated from the word count.
 * - --dry-run: develops against an existing order. It never approves, exports or pushes anything; the Odoo clip then
 *   uses the existing exported order E2E-07 (or the --po order if it already has an Odoo quotation).
 */
import { chromium, request as pwRequest, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { centsInWords, fill, latencyInWords, sceneCopy, type Values } from "./copy.ts";

// ---------------------------------------------------------------------------------------------- config
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "video", "out");
const CLIPS = path.join(OUT, "clips");
const DESK = process.env.DESK_URL ?? "http://127.0.0.1:3087";
const ODOO = process.env.ODOO_BASE_URL ?? "http://127.0.0.1:8067";
const FFMPEG_IMAGE = "linuxserver/ffmpeg@sha256:6547359fac23a2747e606d380e10267b2923a38f68485d9cacefd039e74d3aa8"; // pinned (multi-arch index digest)
const W = 1920, H = 1080, FPS = 30, FADE = 0.2;
const DESK_ZOOM = 1.25, ODOO_ZOOM = 1.15; // bigger UI so it stays legible on a phone
const REVIEWER = { email: "reviewer@pennbridge.example", password: "reviewer-demo" };
const ADMIN = { email: "admin@pennbridge.example", password: "admin-demo" };
const INJECTION_PO = "E2E-05", PRICE_PO = "E2E-03", FALLBACK_QUOTE_PO = "E2E-07";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const PO = opt("po"); const DRY = flag("dry-run");
if (!PO) { console.error("Usage: npx tsx video/record.ts --po <PO number> [--dry-run]"); process.exit(2); }
const fail = (msg: string): never => { console.error(`\nFAILED: ${msg}\n`); process.exit(1); };

// ---------------------------------------------------------------------------------------------- helpers
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function findChromium(): string | undefined {
  const env = process.env.PW_CHROMIUM;
  if (env && existsSync(env)) return env;
  // Fallback: newest headless shell already in the Playwright cache (never downloads anything).
  const cache = path.join(homedir(), "Library/Caches/ms-playwright"), linux = path.join(homedir(), ".cache/ms-playwright");
  for (const dir of [cache, linux]) {
    if (!existsSync(dir)) continue;
    const shells = readdirSync(dir).filter(d => d.startsWith("chromium_headless_shell-")).sort().reverse();
    for (const s of shells) {
      const base = path.join(dir, s);
      for (const sub of readdirSync(base)) { const exe = path.join(base, sub, "chrome-headless-shell"); if (existsSync(exe)) return exe; }
    }
  }
  return undefined;
}
function odooCreds() {
  const file = path.join(ROOT, "infra/odoo/.env.local");
  if (!existsSync(file)) fail("infra/odoo/.env.local not found (Odoo demo credentials).");
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
  if (!env.ODOO_LOGIN || !env.ODOO_PASSWORD) fail("ODOO_LOGIN / ODOO_PASSWORD missing in infra/odoo/.env.local.");
  return { login: env.ODOO_LOGIN, password: env.ODOO_PASSWORD, db: env.ODOO_DATABASE };
}

// ---------------------------------------------------------------------------------------------- in-page overlay
// Runs in every page before its own scripts: cover, cursor + click ripple, caption bar, highlight boxes, privacy blur.
function overlayInit(cfg: { deskZoom: number; odooZoom: number; deskPort: string; odooPort: string }) {
  const ALLOWED = /(\.example|\.test|\.invalid)$|^pennbridgeorderstest@gmail\.com$/i;
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
  const w = window as any;
  const boot = () => {
    if (w.__ovReady || !document.documentElement) return; w.__ovReady = true;
    const root = document.documentElement;
    const st = document.createElement("style");
    const zoom = location.port === cfg.deskPort ? cfg.deskZoom : location.port === cfg.odooPort ? cfg.odooZoom : 1;
    st.textContent = `
      ${zoom !== 1 ? `body{zoom:${zoom}}` : ""}
      .ready-banner{display:none !important}
      #__ov{position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
      #__ov *{box-sizing:border-box}
      #__cover{position:absolute;inset:0;background:#0b2a30;transition:opacity .18s ease}
      #__cur{position:absolute;left:0;top:0;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;background:rgba(45,212,191,.55);border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);display:none}
      .__hl{position:absolute;border:3px solid #2dd4bf;border-radius:6px}
      #__cap{position:absolute;left:50%;bottom:58px;transform:translateX(-50%);max-width:1560px;padding:20px 40px;background:rgba(8,30,36,.94);color:#fff;border-radius:18px;
        border:1px solid rgba(255,255,255,.18);box-shadow:0 4px 16px rgba(0,0,0,.3);font-size:42px;line-height:1.22;font-weight:650;letter-spacing:-.01em;text-align:center;opacity:0;transition:opacity .25s ease}
      #__cap.on{opacity:1}`;
    root.appendChild(st);
    const ov = document.createElement("div"); ov.id = "__ov";
    ov.innerHTML = `<div id="__hls"></div><div id="__cap"></div><div id="__cur"></div><div id="__cover"></div>`;
    root.appendChild(ov);
    const $ = (id: string) => ov.querySelector("#" + id) as HTMLElement;
    const cur = $("__cur"), cap = $("__cap"), hls = $("__hls");
    let tx = -100, ty = -100, cx = -100, cy = -100, seen = false;
    addEventListener("mousemove", e => { tx = e.clientX; ty = e.clientY; if (!seen) { seen = true; cx = tx; cy = ty; cur.style.display = "block"; } }, true);
    // privacy blur: wrap real-looking addresses in a blurred span (moves with the content, so it can never lag behind a scroll).
    const scan = () => {
      if (!document.body) return;
      const todo: Text[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: n => (n.parentElement && n.parentElement.closest("#__ov,script,style,.__priv")) ? NodeFilter.FILTER_REJECT : (n.nodeValue && n.nodeValue.includes("@")) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) todo.push(n);
      for (const node of todo) {
        const text = node.nodeValue!; EMAIL.lastIndex = 0; const hits: { i: number; len: number }[] = []; let m: RegExpExecArray | null;
        while ((m = EMAIL.exec(text))) { const dom = m[0].split("@")[1]; if (ALLOWED.test(dom) || ALLOWED.test(m[0])) continue; hits.push({ i: m.index, len: m[0].length }); }
        let cur: Text = node, consumed = 0;
        for (const h of hits) {
          const mid = cur.splitText(h.i - consumed); const rest = mid.splitText(h.len);
          const span = document.createElement("span"); span.className = "__priv"; span.style.cssText = "filter:blur(6px);display:inline-block";
          mid.parentNode!.replaceChild(span, mid); span.appendChild(mid); cur = rest; consumed = h.i + h.len;
        }
      }
    };
    new MutationObserver(scan).observe(root, { childList: true, subtree: true, characterData: true });
    setInterval(scan, 100);
    const frame = () => { cx += (tx - cx) * 0.3; cy += (ty - cy) * 0.3; cur.style.transform = `translate(${cx}px,${cy}px)`; requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    scan();
    w.__cap = (t: string | null) => { if (!t) { cap.classList.remove("on"); return; } cap.textContent = t; cap.classList.add("on"); };
    w.__hl = (boxes: { x: number; y: number; w: number; h: number }[]) => { hls.innerHTML = ""; for (const b of boxes) { const d = document.createElement("div"); d.className = "__hl"; d.style.cssText = `left:${b.x - 6}px;top:${b.y - 6}px;width:${b.w + 12}px;height:${b.h + 12}px`; hls.appendChild(d); } };
    w.__reveal = () => { const c = $("__cover"); c.style.opacity = "0"; setTimeout(() => c.remove(), 250); };
  };
  boot(); document.addEventListener("readystatechange", boot); document.addEventListener("DOMContentLoaded", boot);
  if (!document.documentElement) new MutationObserver((_m, o) => { if (document.documentElement) { o.disconnect(); boot(); } }).observe(document, { childList: true });
}

// ---------------------------------------------------------------------------------------------- scene toolkit
let lastX = 1500, lastY = 950; // cursor memory across page loads
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const smoother = (t: number) => t * t * t * (t * (6 * t - 15) + 10);
/** Human-ish pointer: slightly curved path, ease in/out, a small overshoot that settles back. */
async function moveTo(page: Page, x: number, y: number) {
  const sx = lastX, sy = lastY, dx = x - sx, dy = y - sy, dist = Math.hypot(dx, dy);
  if (dist < 3) return;
  const ux = dx / dist, uy = dy / dist, bend = (Math.random() - 0.5) * Math.min(90, dist * 0.18);
  const ox = Math.min(14, dist * 0.03), px = x + ux * ox, py = y + uy * ox; // overshoot point
  const n = Math.max(20, Math.min(70, Math.round(dist / 11)));
  for (let i = 1; i <= n; i++) {
    const t = smoother(i / n), bx = -uy * bend * Math.sin(Math.PI * t), by = ux * bend * Math.sin(Math.PI * t);
    await page.mouse.move(sx + (px - sx) * t + bx, sy + (py - sy) * t + by, { steps: 2 }); await sleep(16);
  }
  if (ox > 2) for (let i = 1; i <= 8; i++) { const t = ease(i / 8); await page.mouse.move(px + (x - px) * t, py + (y - py) * t); await sleep(22); }
  lastX = x; lastY = y;
}
async function cap(page: Page, text: string | null) { await page.evaluate(t => (window as any).__cap(t), text); }
async function clearHl(page: Page) { await page.evaluate(() => (window as any).__hl([])); }
async function reveal(page: Page) { await page.evaluate(() => (window as any).__reveal()); }
async function bring(loc: Locator, tall = false) {
  await loc.first().evaluate((el, t) => { el.scrollIntoView({ block: t ? "start" : "center", behavior: "instant" as ScrollBehavior }); if (t) { let p: HTMLElement | null = el as HTMLElement; while (p) { if (p.scrollTop > 0 || p === document.scrollingElement) { p.scrollTop -= 130; break; } p = p.parentElement; } } }, tall);
  await sleep(250);
}
/** Smoothly scroll so the element is centred (animated, so viewers can follow). */
async function glide(page: Page, loc: Locator, block: "center" | "start" = "center") {
  const box = await loc.first().boundingBox(); if (!box) throw new Error("glide: element not visible");
  const target = block === "center" ? box.y + box.height / 2 - H / 2 : box.y - 150;
  if (Math.abs(target) < 40) return;
  await page.mouse.move(lastX, lastY); const steps = 30;
  for (let i = 1; i <= steps; i++) { await page.mouse.wheel(0, (target / steps) * (ease(i / steps) - ease((i - 1) / steps)) * steps); await sleep(26); }
  await sleep(400);
}
async function boxOf(loc: Locator) { const b = await loc.first().boundingBox(); if (!b) throw new Error("highlight: element has no box"); const y = Math.max(0, b.y), h = Math.min(H, b.y + b.height) - y; return { x: Math.max(0, b.x), y, w: Math.min(W, b.x + b.width) - Math.max(0, b.x), h }; }
async function highlight(page: Page, ...locs: Locator[]) { const boxes = []; for (const l of locs) boxes.push(await boxOf(l)); await page.evaluate(b => (window as any).__hl(b), boxes); }
async function pointAt(page: Page, loc: Locator, fx = 0.5, fy = 0.5) { const b = await loc.first().boundingBox(); if (!b) throw new Error("pointAt: element not visible"); await moveTo(page, b.x + b.width * fx, b.y + b.height * fy); }
async function click(page: Page, loc: Locator, fx = 0.5, fy = 0.5) {
  await loc.first().waitFor({ state: "visible" });
  let b = await loc.first().boundingBox(); if (!b || b.y < 80 || b.y + b.height > H - 140) { await bring(loc); b = await loc.first().boundingBox(); }
  await moveTo(page, b!.x + b!.width * fx, b!.y + b!.height * fy); await sleep(320);
  await page.mouse.down(); await sleep(110); await page.mouse.up(); await sleep(400);
}
async function typeSlow(page: Page, text: string) { await page.keyboard.type(text, { delay: 110 }); }
const holdUntil = async (t0: number, secs: number) => { const left = t0 + secs * 1000 - Date.now(); if (left > 0) await sleep(left); else console.warn(`   (scene overran its ${secs}s budget by ${(-left / 1000).toFixed(1)}s)`); };

// ---------------------------------------------------------------------------------------------- slides
const SLIDE_CSS = `
*{box-sizing:border-box;margin:0}html,body{width:100%;height:100%}
body{background:#10293a;color:#fff;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column;justify-content:center;padding:0 150px;overflow:hidden}
.brand{position:absolute;left:150px;top:70px;display:flex;align-items:center;gap:16px;font-size:34px;font-weight:700;letter-spacing:-.01em}
.mark{width:50px;height:50px;border-radius:13px;background:#0d8179;display:grid;place-items:center}.mark i{width:22px;height:22px;border:4px solid #fff;border-radius:6px;transform:rotate(45deg)}
.brand span{font-weight:400;opacity:.8}
.kick{color:#2dd4bf;font-size:30px;letter-spacing:.2em;font-weight:700;text-transform:uppercase;margin-bottom:34px}
h1{font-size:84px;line-height:1.1;font-weight:760;letter-spacing:-.025em;max-width:1500px}
h1 em{font-style:normal;color:#2dd4bf}
p.sub{font-size:48px;line-height:1.3;margin-top:40px;max-width:1450px;color:#cfe3e4;font-weight:450}
.stats{display:flex;gap:28px;margin-top:56px;flex-wrap:wrap}
.stat{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.2);border-radius:16px;padding:26px 36px;min-width:300px}
.stat b{display:block;font-size:72px;color:#2dd4bf;letter-spacing:-.02em;line-height:1}.stat span{display:block;font-size:28px;margin-top:12px;color:#cfe3e4}
.fx{opacity:0;animation:fx .8s ease-out forwards}
@keyframes fx{to{opacity:1}}
`;
const brand = `<div class="brand"><div class="mark"><i></i></div>Pennbridge <span>Order Desk</span></div>`;
const slide = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${SLIDE_CSS}</style></head><body>${brand}${body}</body></html>`;
const d = (i: number) => `style="animation-delay:${0.3 + i * 0.6}s"`;
const SLIDES = {
  title: slide(`<div class="kick fx" ${d(0)}>PORTFOLIO PROJECT</div><h1 class="fx" ${d(1)}>Pennbridge Order Desk</h1><p class="sub fx" ${d(2)}>I built a tool that reads purchase-order emails and turns them into quotes in Odoo.</p>`),
  problem: slide(`<h1 class="fx" ${d(0)}>Lots of wholesalers still get orders by email.</h1><p class="sub fx" ${d(2)}>Someone then types every line into the ERP by hand.</p>`),
  results: slide(`<div class="kick fx" ${d(0)}>RESULTS</div><h1 class="fx" ${d(1)} style="font-size:68px">Tested on 36 orders it had never seen</h1><div class="stats"><div class="stat fx" ${d(2)}><b>25 of 30</b><span>emails right</span></div><div class="stat fx" ${d(3)}><b>6 of 6</b><span>PDFs right</span></div><div class="stat fx" ${d(4)}><b>0.4&cent;</b><span>per order</span></div><div class="stat fx" ${d(5)}><b>Odoo 17&ndash;19</b></div><div class="stat fx" ${d(6)}><b>220+</b><span>tests</span></div></div>`),
  lesson: slide(`<div class="kick fx" ${d(0)}>WHAT I LEARNED</div><h1 class="fx" ${d(1)} style="font-size:70px">The AI once quietly turned <em>&minus;2</em> into <em>2.</em></h1><p class="sub fx" ${d(3)}>Since then, the system checks the AI's work instead of trusting it.</p>`),
  end: slide(`<h1 class="fx" ${d(0)} style="font-size:76px">Oscar Wold Skaarderud</h1><p class="sub fx" ${d(2)}>Built with AI coding agents. I planned it, reviewed it and tested it.</p>`),
};

// ---------------------------------------------------------------------------------------------- voice timing
const VOICE_LEAD = 0.4, VOICE_TAIL = 0.8;
let VALUES: Values = { latency: "2 seconds", cost: "a fraction of a cent" };
const voiceFile = path.join(OUT, "voice-durations.json");
const voiceDur: Record<string, number> = existsSync(voiceFile) ? (JSON.parse(readFileSync(voiceFile, "utf8")).durations ?? {}) : {};
const wordsOf = (t: string) => t.split(/\s+/).filter(Boolean).length;
type Plan = { secs: number; T: number[]; say: (page: Page, i: number) => Promise<void> };
function planFor(id: string, minSecs = 5): Plan {
  const segs = sceneCopy(id).segs.map(s => ({ text: fill(s.text, VALUES), cap: s.cap ? fill(s.cap, VALUES) : undefined }));
  const total = segs.reduce((n, s) => n + wordsOf(s.text), 0);
  const vd = voiceDur[id] ?? total / 2.7; // seconds of voice
  let before = 0; const T = segs.map(s => { const t = VOICE_LEAD + vd * (before / total); before += wordsOf(s.text); return t; });
  const secs = Math.max(minSecs, vd + VOICE_LEAD + VOICE_TAIL);
  return { secs, T, say: async (page, i) => { const w = revealedAt() + T[i] * 1000 - Date.now(); if (w > 0) await sleep(w); if (segs[i].cap) await cap(page, segs[i].cap!); } };
}
let _revealed = 0; const revealedAt = () => _revealed;

// ---------------------------------------------------------------------------------------------- clip runner
type Clip = { n: number; name: string; file: string; trim: number; seconds: number };
const clips: Clip[] = [];
let browser: Browser; let reviewerState: Awaited<ReturnType<BrowserContext["storageState"]>>; let adminState: typeof reviewerState;

async function scene(n: number, name: string, id: string, state: typeof reviewerState | undefined, fn: (page: Page, plan: Plan) => Promise<void>, minSecs = 5) {
  const plan = planFor(id, minSecs); const secs = plan.secs;
  console.log(`\n[scene ${n}] ${name}  (hold ${secs.toFixed(1)}s, voice ${(voiceDur[id] ?? 0).toFixed(1)}s)`);
  const dir = path.join(CLIPS, String(n).padStart(2, "0"));
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir, size: { width: W, height: H } }, storageState: state, acceptDownloads: true });
  const cfg = { deskZoom: DESK_ZOOM, odooZoom: ODOO_ZOOM, deskPort: new URL(DESK).port, odooPort: new URL(ODOO).port };
  await ctx.addInitScript(`window.__name=window.__name||(f=>f);(${overlayInit.toString()})(${JSON.stringify(cfg)});`); // __name: tsx/esbuild helper the page does not have
  const created = Date.now(); const page = await ctx.newPage(); let revealed = 0; _revealed = 0;
  page.on("pageerror", e => console.warn("   page error:", e.message.slice(0, 120)));
  try {
    // inside fn, `begin()` must be called once the scene is ready; it lifts the cover and starts the scene clock.
    (page as any).begin = async (noMouse = false) => { if (!noMouse) await page.mouse.move(lastX, lastY); await sleep(120); await reveal(page); revealed = Date.now(); _revealed = revealed; await sleep(250); };
    await fn(page, plan);
    if (!revealed) throw new Error("scene never called begin()");
    await holdUntil(revealed, secs);
    await leakCheck(page, name);
  } finally { await cap(page, null).catch(() => {}); await ctx.close(); }
  const files = readdirSync(dir).filter(f => f.endsWith(".webm")); if (files.length !== 1) throw new Error(`expected 1 video in ${dir}, got ${files.length}`);
  clips.push({ n, name, file: path.join(dir, files[0]), trim: Math.max(0, (revealed - created) / 1000 + 0.04), seconds: secs });
}
/** Privacy safety net: abort if any real-looking address is visible on the page without the blur wrapper. */
async function leakCheck(page: Page, name: string) {
  const bad = await page.evaluate(() => {
    const ok = /(\.example|\.test|\.invalid)$|^pennbridgeorderstest@gmail\.com$/i, out: string[] = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) { const m = (n.nodeValue ?? "").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g); if (m && !n.parentElement?.closest(".__priv")) for (const a of m) if (!ok.test(a)) out.push(a.replace(/^.{2}/, "**")); }
    return out;
  });
  if (bad.length) fail(`Privacy check: unblurred address on screen in scene "${name}" (${bad.join(", ")}). Aborting before encoding.`);
}
async function slideScene(n: number, name: string, id: string, html: string, minSecs = 5) {
  await scene(n, name, id, undefined, async page => { await page.route("http://slides.local/**", r => r.fulfill({ contentType: "text/html", body: html })); await page.goto("http://slides.local/s"); await sleep(200); await (page as any).begin(true); }, minSecs);
}

// ---------------------------------------------------------------------------------------------- desk helpers
const review = (page: Page) => page.getByRole("region", { name: "Order review" });
const rowFor = (page: Page, po: string) => page.locator("table.order-table tbody tr", { hasText: po });
async function loginState(email: string, password: string, withOdoo: boolean) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(DESK + "/"); await page.getByLabel("Email address").fill(email); await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click(); await page.getByRole("heading", { name: "Inbox" }).waitFor();
  if (withOdoo) {
    const c = odooCreds();
    await page.goto(`${ODOO}/web/login${c.db ? `?db=${encodeURIComponent(c.db)}` : ""}`);
    await page.locator("input[name=login]").fill(c.login); await page.locator("input[name=password]").fill(c.password);
    await page.locator("form.oe_login_form button[type=submit], form button[type=submit]").first().click();
    await page.waitForURL(u => !/\/web\/login/.test(u.pathname), { timeout: 30_000 });
  }
  const s = await ctx.storageState(); await ctx.close(); return s;
}
async function openDesk(page: Page) { await page.goto(DESK + "/"); await page.getByRole("heading", { name: "Inbox" }).waitFor(); await rowFor(page, "").first().waitFor(); await sleep(500); }
async function searchAndOpen(page: Page, po: string) {
  const box = page.getByLabel("Search orders"); await click(page, box); await box.fill(""); await typeSlow(page, po);
  await rowFor(page, po).first().waitFor(); await expectOnly(page, po); await sleep(500);
  await click(page, rowFor(page, po).first(), 0.3);
  await review(page).getByRole("heading", { name: po }).first().waitFor(); await sleep(600);
}
async function expectOnly(page: Page, po: string) { await page.waitForFunction(p => Array.from(document.querySelectorAll("table.order-table tbody tr")).every(r => (r.textContent ?? "").includes(p)), po, { timeout: 10_000 }); }

// ---------------------------------------------------------------------------------------------- API (pre-checks, polling)
type Detail = { order: { id: string; poNumber: string; status: string; reasons: { code: string }[] }; exports: { id: string; state: string; pushState?: string; pushError?: string; odooQuotation?: { name: string; url: string | null } | null }[]; modelUsage?: { latencyMs: number; costUsd: string | null }[] };
async function api() {
  const rc = await pwRequest.newContext({ baseURL: DESK });
  const login = await rc.post("/api/auth/login", { data: REVIEWER }); if (!login.ok()) fail(`Cannot sign in to the desk at ${DESK} (${login.status()}). Is the stack running?`);
  const find = async (po: string): Promise<Detail | null> => {
    const list = await (await rc.get(`/api/orders?limit=10&q=${encodeURIComponent(po)}`)).json() as { orders: { id: string; poNumber: string | null }[] };
    const hit = list.orders.find(o => o.poNumber === po); if (!hit) return null;
    return await (await rc.get(`/api/orders/${encodeURIComponent(hit.id)}`)).json() as Detail;
  };
  return { find, dispose: () => rc.dispose() };
}

// ---------------------------------------------------------------------------------------------- ffmpeg (pinned Docker image)
const docker = (entry: "ffmpeg" | "ffprobe", args: string[]) => execFileSync("docker", ["run", "--rm", "-v", `${OUT}:/work`, "-w", "/work", "--entrypoint", entry, FFMPEG_IMAGE, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
const rel = (p: string) => path.relative(OUT, p).split(path.sep).join("/");
function encode(): { name: string; start: number; duration: number }[] {
  console.log("\n[ffmpeg] trimming clips (H.264, 30 fps) ...");
  const segs: { clip: Clip; mp4: string; dur: number }[] = [];
  for (const c of clips.sort((a, b) => a.n - b.n)) {
    const mp4 = path.join(CLIPS, `seg${String(c.n).padStart(2, "0")}.mp4`);
    docker("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", c.trim.toFixed(3), "-i", rel(c.file), "-vf", `fps=${FPS},scale=${W}:${H}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-an", rel(mp4)]);
    const dur = parseFloat(docker("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", rel(mp4)]).trim());
    segs.push({ clip: c, mp4, dur });
  }
  console.log("[ffmpeg] joining with short fades and encoding final MP4 ...");
  const inputs = segs.flatMap(s => ["-i", rel(s.mp4)]);
  const filters = segs.map((s, i) => `[${i}:v]fade=t=in:st=0:d=${FADE},fade=t=out:st=${(s.dur - FADE).toFixed(3)}:d=${FADE}[v${i}]`).join(";");
  const graph = `${filters};${segs.map((_, i) => `[v${i}]`).join("")}concat=n=${segs.length}:v=1:a=0[v]`;
  docker("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...inputs, "-filter_complex", graph, "-map", "[v]", "-r", String(FPS), "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "pennbridge-demo.mp4"]);
  let t = 0; return segs.map(s => { const r = { name: s.clip.name, start: t, duration: s.dur }; t += s.dur; return r; });
}
const mmss = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

// ---------------------------------------------------------------------------------------------- main
async function main() {
  mkdirSync(CLIPS, { recursive: true });
  // pre-flight
  const a = await api(); const order = await a.find(PO!);
  if (!order) fail(`Order with PO "${PO}" was not found in the desk (${DESK}).${DRY ? "" : " Has the email been received and processed yet?"}`);
  if (!DRY && order!.order.status !== "draft_ready") fail(`Order ${PO} has status "${order!.order.status}", expected "draft_ready". Not recording (use --dry-run to develop against it).`);
  console.log(`Order ${PO}: status ${order!.order.status}${DRY ? "  [DRY RUN: no approve / export / push]" : ""}`);
  const injection = await a.find(INJECTION_PO), pricing = await a.find(PRICE_PO);
  if (!injection || !pricing) fail(`Safety-scene orders ${INJECTION_PO} and ${PRICE_PO} must exist in the desk.`);
  const usage = order!.modelUsage?.[order!.modelUsage.length - 1];
  VALUES = { latency: latencyInWords(usage?.latencyMs), cost: centsInWords(usage?.costUsd) };
  console.log(`On-screen values: "${VALUES.latency}", "${VALUES.cost}"; voice durations: ${Object.keys(voiceDur).length ? "loaded" : "NOT found (estimating; run video/voiceover.ts first)"}`);
  const vd = existsSync(voiceFile) ? JSON.parse(readFileSync(voiceFile, "utf8")) : null;
  if (vd && (vd.latency !== VALUES.latency || vd.cost !== VALUES.cost)) fail(`voice-durations.json was made with "${vd.latency}" / "${vd.cost}" but this order gives "${VALUES.latency}" / "${VALUES.cost}". Re-run: npx tsx video/voiceover.ts --po ${PO}`);
  let quotePo = PO!; if (DRY && !order!.exports.some(e => e.odooQuotation)) { quotePo = FALLBACK_QUOTE_PO; if (!(await a.find(quotePo))?.exports.some(e => e.odooQuotation)) fail(`Dry run needs an order with an Odoo quotation (${quotePo}).`); }

  const exe = findChromium();
  browser = await chromium.launch({ executablePath: exe, args: ["--hide-scrollbars", "--force-color-profile=srgb", "--disable-features=Translate"] });
  console.log(`Browser: ${exe ?? "Playwright default"}`);
  try {
    console.log("Signing in off-camera (reviewer + Odoo, admin) ...");
    reviewerState = await loginState(REVIEWER.email, REVIEWER.password, true); adminState = await loginState(ADMIN.email, ADMIN.password, false);
    const begin = (page: Page) => (page as any).begin();

    await slideScene(1, "1 Title", "1", SLIDES.title);
    await slideScene(2, "2 Problem", "2", SLIDES.problem);

    // 3 - inbox
    await scene(3, "3 Inbox", "3", reviewerState, async (page, plan) => {
      await openDesk(page); await rowFor(page, PO!).first().waitFor(); await begin(page);
      const row = rowFor(page, PO!).first();
      await plan.say(page, 0); await pointAt(page, row, 0.88); await highlight(page, row);
      const badge = page.locator(".mode-pill");
      await plan.say(page, 1); await pointAt(page, badge, 0.97, 1.5); await highlight(page, badge);
    });

    // 4 - order review (the order is opened behind the cover, so the first caption lands on the finished screen)
    await scene(4, "4 Order review", "4", reviewerState, async (page, plan) => {
      await openDesk(page); await rowFor(page, PO!).first().waitFor();
      await click(page, rowFor(page, PO!).first(), 0.3); await review(page).getByRole("heading", { name: PO! }).first().waitFor(); await sleep(400);
      await glide(page, review(page).locator(".review-head"), "start");
      await begin(page);
      const paper = review(page).locator(".source-paper").first();
      await plan.say(page, 0); await highlight(page, paper); await pointAt(page, paper, 0.5, 0.3);
      const meta = review(page).locator(".source-meta");
      await plan.say(page, 1); await highlight(page, meta, review(page).locator(".review-head > div").first()); await pointAt(page, meta, 0.3);
      const lines = review(page).locator(".line-list");
      await plan.say(page, 2); await clearHl(page); await glide(page, lines, "start");
      await highlight(page, lines); await pointAt(page, review(page).locator(".line-card").first().locator("label", { hasText: "Unit price" }), 0.5, 0.7);
      const note = review(page).locator(".evidence-note", { hasText: "Extraction:" }).first();
      await plan.say(page, 3); await clearHl(page); await glide(page, note); await highlight(page, note); await pointAt(page, note, 0.5);
    });

    // 5 - safety
    await scene(5, "5 Safety", "5", reviewerState, async (page, plan) => {
      await openDesk(page); await searchAndOpen(page, INJECTION_PO);
      await glide(page, review(page).locator(".review-head"), "start");
      const warn = review(page).locator(".warning-card", { hasText: /untrusted instruction/i }).first(); await warn.waitFor();
      await glide(page, warn); const paper = review(page).locator(".source-paper").first();
      await begin(page);
      await plan.say(page, 0); await highlight(page, warn, paper); await pointAt(page, warn, 0.4);
      await plan.say(page, 1);
      await sleep(1200); await clearHl(page);
      await glide(page, page.getByLabel("Search orders"), "start");
      await searchAndOpen(page, PRICE_PO);
      const mismatch = review(page).locator(".warning-card", { hasText: /price mismatch/i }).first(); await mismatch.waitFor();
      await glide(page, mismatch);
      await plan.say(page, 2); await highlight(page, mismatch, review(page).locator(".line-card").first()); await pointAt(page, mismatch, 0.4);
      await plan.say(page, 3);
    });

    // 6a - approve, export, send
    await scene(6, "6a Approve and send", "6a", reviewerState, async (page, plan) => {
      await openDesk(page); await searchAndOpen(page, PO!);
      const actions = review(page).locator(".review-actions"); await glide(page, actions);
      await begin(page);
      await plan.say(page, 0); await highlight(page, actions); await pointAt(page, actions, 0.8);
      if (DRY) {
        await plan.say(page, 1); await sleep(600); await clearHl(page);
        await plan.say(page, 2); const ex = review(page).locator(".export-history"); if (await ex.count()) { await glide(page, ex); await highlight(page, ex); } return;
      }
      await clearHl(page);
      await click(page, review(page).getByRole("button", { name: /Approve order/ })); await review(page).getByText(/Approved by/).first().waitFor({ timeout: 30_000 }); await sleep(900);
      await plan.say(page, 1);
      await click(page, review(page).getByRole("button", { name: /Prepare export/ })); await review(page).locator(".export-item").first().waitFor({ timeout: 30_000 }); await sleep(900);
      const ex = review(page).locator(".export-history"); await glide(page, ex);
      await plan.say(page, 2);
      await click(page, review(page).getByRole("button", { name: /Send to Odoo/ })); await sleep(1500);
    });

    // off-camera: wait for the worker to create the quotation
    let quoteUrl = ""; const a2 = a;
    if (!DRY) {
      console.log("Waiting off-camera for the Odoo push ...");
      const deadline = Date.now() + 240_000;
      for (;;) {
        const o = await a2.find(PO!); const ex = o!.exports.find(e => e.odooQuotation) ?? null;
        if (ex?.odooQuotation) { console.log(`   quotation ${ex.odooQuotation.name}`); quoteUrl = ex.odooQuotation.url ?? ""; break; }
        if (o!.exports.some(e => e.pushState === "failed")) fail(`The Odoo push failed: ${o!.exports.find(e => e.pushError)?.pushError ?? "unknown"}`);
        if (Date.now() > deadline) fail("Timed out waiting for the Odoo quotation.");
        await sleep(2000);
      }
    }
    void quoteUrl;

    // 6b - Odoo quotation
    await scene(7, "6b Odoo quotation", "6b", reviewerState, async (page, plan) => {
      await openDesk(page); await searchAndOpen(page, quotePo);
      const quote = review(page).locator(".odoo-quote"); await quote.waitFor(); await glide(page, quote);
      await begin(page);
      await plan.say(page, 0); await highlight(page, quote); await pointAt(page, quote, 0.3); await sleep(1200);
      // open in the same tab (so it is one clip); rewrite the worker's internal hostname if the stored link has it.
      const link = quote.locator("a"); await link.evaluate((el, base) => { const a = el as HTMLAnchorElement; a.removeAttribute("target"); const u = new URL(a.href); if (!/^(127\.0\.0\.1|localhost)$/.test(u.hostname)) { a.href = base + u.pathname + u.search + u.hash; } }, ODOO);
      await clearHl(page); await click(page, link); await page.waitForURL(/\/odoo\//, { timeout: 30_000 });
      await page.locator(".o_form_sheet, .o_form_view").first().waitFor({ timeout: 30_000 }); await page.locator(".o_field_x2many_list_row_add, table.o_list_table").first().waitFor({ timeout: 30_000 }).catch(() => {}); await sleep(800);
      await page.mouse.move(lastX, lastY); await reveal(page);
      await plan.say(page, 1); const sheet = page.locator(".o_form_sheet").first(); if (await sheet.count()) { await highlight(page, sheet).catch(() => {}); }
      await plan.say(page, 2); await clearHl(page);
      await page.mouse.move(960, 700); for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, 24); await sleep(60); }
    });

    // 7 (admin)
    await scene(8, "7 Admin", "7", adminState, async (page, plan) => {
      await openDesk(page); await begin(page);
      await plan.say(page, 0);
      await click(page, page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Settings" }));
      await page.getByRole("tab", { name: "Users" }).waitFor(); await sleep(600);
      const tbl = page.locator("table.settings-table, table.order-table").first(); await tbl.waitFor(); await highlight(page, tbl);
      await plan.say(page, 1); await clearHl(page);
      await click(page, page.getByRole("tab", { name: "Data import" }));
      const file = page.locator("input[type=file]"); await file.waitFor(); await pointAt(page, file, 0.2);
      await file.setInputFiles(path.join(ROOT, "docs/import-templates/products.csv")); await sleep(700);
      const prev = page.getByRole("button", { name: /Preview \(dry run\)/ }); await click(page, prev);
      const result = page.locator(".import-result"); await result.waitFor({ timeout: 15_000 }); await sleep(500);
      await glide(page, result); await highlight(page, result);
    });

    await slideScene(9, "8 Results", "8", SLIDES.results);
    await slideScene(10, "9 Lesson", "9", SLIDES.lesson);
    await slideScene(11, "10 End card", "10", SLIDES.end, 7);
  } finally { await browser.close(); await a.dispose(); }

  const timings = encode();
  const total = timings.reduce((s, t) => s + t.duration, 0);
  writeFileSync(path.join(OUT, "timings.json"), JSON.stringify({ po: PO, dryRun: DRY, voiceLead: VOICE_LEAD, recordedAt: new Date().toISOString(), totalSeconds: total, scenes: timings.map(t => ({ ...t, end: t.start + t.duration })) }, null, 2));
  console.log("\nScene timings (final video):");
  for (const t of timings) console.log(`  ${mmss(t.start)} - ${mmss(t.start + t.duration)}  (${t.duration.toFixed(1)}s)  ${t.name}`);
  console.log(`\nTotal ${mmss(total)}  ->  ${path.join(OUT, "pennbridge-demo.mp4")}`);
}
main().catch(e => { console.error(e); process.exit(1); });
