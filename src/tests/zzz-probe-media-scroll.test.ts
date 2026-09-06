/**
 * Scratch probe: why does a text-heavy Nebula chat with multi-MB media
 * scroll badly?  Posts long text plus images and videos - as canon file
 * attachments (PROBE_MODE=attach, what Nebula's composer sends) or as
 * inline data URLs (PROBE_MODE=inline) - then drives the scroller and
 * records frame gaps and every media/messages IPC round-trip.
 *
 * Run:
 *   E2E_XVFB=1 E2E_UI_DESIGN=nebula E2E_DRIVER_PORT=4700 \
 *   E2E_APP_BIN=$PWD/vendor/client/target/debug/mumble-tauri \
 *   node --import tsx scripts/e2e.mts src/tests/zzz-probe-media-scroll.test.ts
 */

import { describe, it, before, after } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";

const PICS = "/home/sebastian/Pictures";
const OUT = process.env.PROBE_OUT ?? "/tmp/probe-media-scroll.json";
const MODE = process.env.PROBE_MODE ?? "attach";
const TEXT_COUNT = Number(process.env.PROBE_TEXT ?? "120");

const IMAGES = [
  "Screenshots/Screenshot From 2026-08-21 21-09-37.png", // 5.3 MB
  "8405963.png", // 0.76 MB
  "Screenshots/Screenshot From 2026-09-06 00-34-16.png", // 1.4 MB
  "56OKOPl5_o.jpg", // 0.26 MB
  "Screenshots/Screenshot From 2026-08-30 01-34-31.png", // 1.25 MB
  "Screenshots/Screenshot From 2026-09-06 00-34-03.png", // 1.16 MB
  "Screenshots/Screenshot From 2026-08-29 22-31-54.png", // 1.0 MB
  "Screenshots/Screenshot From 2026-09-06 00-14-25.png", // 1.0 MB
];
const VIDEOS = [
  "shiroko-with-hoshino-blue-archive.1920x1080.mp4", // 3.2 MB
  "shiroko-memorial-lobby.1920x1080.mp4", // 5.6 MB
  "misaki-on-a-rainy-day-blue-archive-moewalls-com.mp4", // 10 MB
  "iochi-mari-smoking-midnight-blue-archive-moewalls-com.mp4", // 22 MB
];
/** Inline bodies over ~4 MB take Starling's text service down, so the
 *  inline variant only gets what fits. */
const INLINE_MAX_BYTES = 2_500_000;
const INLINE_VIDEO = process.env.PROBE_INLINE_VIDEO ?? "";

function mimeFor(rel: string): string {
  const ext = rel.split(".").pop()!.toLowerCase();
  return ext === "png" ? "image/png" : ext === "jpg" ? "image/jpeg" : "video/mp4";
}

function dataUrl(file: string): string {
  return `data:${mimeFor(file)};base64,${readFileSync(file).toString("base64")}`;
}

const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. ";

function textBody(i: number): string {
  const paras = 1 + (i % 4);
  return Array.from({ length: paras }, (_, p) => `<p>#${i}.${p} ${LOREM.repeat(1 + ((i + p) % 3))}</p>`).join("");
}

async function setServerConfig(values: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${config.operatorApiUrl}/v1/config`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.operatorToken}` },
    body: JSON.stringify(values),
  });
  if (!response.ok) throw new Error(`POST /v1/config -> ${response.status} ${await response.text()}`);
}

const MEASURE = `
const done = arguments[arguments.length - 1];
const plan = arguments[0];
(async () => {
  const row = document.querySelector('[data-message-id]');
  if (!row) { done(JSON.stringify({ error: 'no rows' })); return; }
  let sc = row.parentElement;
  while (sc && !(sc.scrollHeight > sc.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
  if (!sc) { done(JSON.stringify({ error: 'no scroller' })); return; }

  let internals = window.__TAURI_INTERNALS__;
  const orig = internals.invoke;
  const calls = [];
  const t0 = performance.now();
  let wrapMode = 'assign';
  const wrapped = function (cmd, args, opts) {
    const ts = performance.now();
    const p = orig.call(this, cmd, args, opts);
    if (/get_messages|offload|get_dm_messages|starling_download_to_base64|starling_media_url/.test(cmd)) {
      p.then((v) => {
        let bytes = 0, n = 0;
        if (typeof v === 'string') bytes = v.length;
        else if (Array.isArray(v)) { n = v.length; for (const m of v) bytes += (m.body || '').length; }
        else if (v && typeof v === 'object') { for (const k in v) bytes += (v[k] || '').length; n = Object.keys(v).length; }
        calls.push({ cmd, at: Math.round(ts - t0), ms: Math.round(performance.now() - ts), n, bytes });
      }, () => {});
    }
    return p;
  };
  try {
    Object.defineProperty(internals, 'invoke', { value: wrapped, writable: true, configurable: true });
    wrapMode = 'defineProperty';
  } catch (e) {
    try {
      const proxy = new Proxy(internals, { get: (t, k) => (k === 'invoke' ? wrapped : t[k]) });
      Object.defineProperty(window, '__TAURI_INTERNALS__', { value: proxy, writable: true, configurable: true });
      wrapMode = 'proxy';
    } catch (e2) { wrapMode = 'failed: ' + e + ' / ' + e2; }
  }
  const installed = window.__TAURI_INTERNALS__.invoke === wrapped;

  const phases = [];
  let frames = [];
  let last = performance.now();
  let running = true;
  const tick = (now) => { frames.push(now - last); last = now; if (running) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);

  const stats = (name, fr) => {
    const s = [...fr].sort((a, b) => a - b);
    const p = (q) => s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]) : 0;
    const over = fr.filter((f) => f > 50);
    return { name, frames: fr.length, meanMs: Math.round(fr.reduce((a, b) => a + b, 0) / Math.max(1, fr.length)), p50: p(0.5), p95: p(0.95), max: Math.round(Math.max(0, ...fr)), hitches: over.length, hitchMs: Math.round(over.reduce((a, b) => a + b, 0)) };
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const phase = async (name, fn) => { frames = []; last = performance.now(); drift = { growPx: 0, growEvents: 0, driftPx: 0, driftEvents: 0 }; const start = performance.now(); await fn(); phases.push({ ...stats(name, frames), ...drift, startAt: Math.round(start - t0), wallMs: Math.round(performance.now() - start) }); };

  // Content growth vs. scroll corrections while scrolling: growth above the
  // viewport that no correction pays for is a visible jump.
  let drift = { growPx: 0, growEvents: 0, driftPx: 0, driftEvents: 0 };
  const scrollTo = async (target, stepPx, ms) => {
    await new Promise((resolve) => {
      const dir = Math.sign(target - sc.scrollTop);
      let expected = sc.scrollTop, lastHeight = sc.scrollHeight;
      const id = setInterval(() => {
        const d = sc.scrollTop - expected;
        if (Math.abs(d) > 0.5) { drift.driftPx += Math.abs(d); drift.driftEvents++; }
        const h = sc.scrollHeight - lastHeight;
        if (h !== 0) { drift.growPx += Math.abs(h); drift.growEvents++; lastHeight = sc.scrollHeight; }
        const next = sc.scrollTop + dir * stepPx;
        if ((dir < 0 && next <= target) || (dir > 0 && next >= target)) { sc.scrollTop = target; clearInterval(id); resolve(); return; }
        sc.scrollTop = next; expected = sc.scrollTop;
      }, ms);
    });
  };

  const top = 0, bottom = () => sc.scrollHeight - sc.clientHeight;
  sc.scrollTop = bottom();
  await sleep(500);
  const height0 = sc.scrollHeight;
  const rows0 = document.querySelectorAll('[data-message-id]').length;
  await phase('up', () => scrollTo(top, plan.stepPx, plan.stepMs));
  await phase('idle-top', () => sleep(plan.idleMs));
  await phase('down', () => scrollTo(bottom(), plan.stepPx, plan.stepMs));
  await phase('idle-bottom', () => sleep(plan.idleMs));
  await phase('up2', () => scrollTo(top, plan.stepPx, plan.stepMs));
  await phase('down2', () => scrollTo(bottom(), plan.stepPx, plan.stepMs));
  running = false;
  try { Object.defineProperty(internals, 'invoke', { value: orig, writable: true, configurable: true }); } catch (e) {}
  try { Object.defineProperty(window, '__TAURI_INTERNALS__', { value: internals, writable: true, configurable: true }); } catch (e) {}

  const imgs = [...document.querySelectorAll('img')];
  const vids = [...document.querySelectorAll('video')];
  done(JSON.stringify({
    scrollHeight: height0, scrollHeightEnd: sc.scrollHeight, clientHeight: sc.clientHeight, rows0, rows: document.querySelectorAll('[data-message-id]').length,
    imgs: imgs.length, imgData: imgs.filter((i) => (i.getAttribute('src') || '').startsWith('data:')).length,
    imgBlob: imgs.filter((i) => (i.getAttribute('src') || '').startsWith('blob:')).length,
    vids: vids.length,
    wrapMode, installed, phases, calls,
  }));
})().catch((e) => done(JSON.stringify({ error: String(e && e.stack || e) })));
`;

describe("probe: media-heavy chat scroll", { concurrency: 1 }, () => {
  let app: TauriApp;

  before(async () => {
    await setServerConfig({
      image_message_length: 4_000_000,
      text_message_length: 0,
      message_limit: 1000,
      message_burst: 1000,
    });
    app = await TauriApp.launch();
    await app.driver.manage().setTimeouts({ script: 300_000 });
  });

  after(async () => {
    await app?.close();
  });

  it("posts the conversation and measures scrolling", async () => {
    setSuperUserPassword("testpassword");
    await app.connect.connect(config.serverHost, "SuperUser", { port: config.serverPort, password: "testpassword" });
    await app.chat.waitLoaded(config.connectTimeout);
    const channelId = 0;

    // Media bodies, built per mode.
    const mediaBody = async (rel: string): Promise<string | null> => {
      const file = path.join(PICS, rel);
      if (MODE === "inline") {
        const size = readFileSync(file).length;
        if (size > INLINE_MAX_BYTES) return null;
        const url = dataUrl(file);
        return mimeFor(rel).startsWith("video")
          ? `<video src="${url}" controls>${path.basename(rel)}</video>`
          : `<img src="${url}" alt="${path.basename(rel)}" />`;
      }
      const shared = await app.invoke<{ key: string; size: number; shareUrl: string; expiresAt: number }>(
        "starling_upload_file",
        { filePath: file, channelId, mimeType: mimeFor(rel), uploadId: `probe-${Date.now()}`, mode: "session" },
      );
      const info = {
        url: shared.shareUrl,
        key: shared.key,
        filename: path.basename(rel),
        sizeBytes: shared.size,
        mode: "session",
        expiresAt: shared.expiresAt > 0 ? shared.expiresAt : null,
      };
      return `<!-- FANCY_FILE:${Buffer.from(JSON.stringify(info)).toString("base64")} -->`;
    };

    const bodies: string[] = [];
    let img = 0, vid = 0, imgSent = 0, vidSent = 0;
    for (let i = 0; i < TEXT_COUNT; i++) {
      bodies.push(textBody(i));
      if (i % 10 === 9 && img < IMAGES.length) {
        const body = await mediaBody(IMAGES[img++]);
        if (body) { bodies.push(body); imgSent++; }
      }
      if (i % 30 === 29 && vid < VIDEOS.length) {
        const rel = MODE === "inline" ? INLINE_VIDEO : VIDEOS[vid];
        vid++;
        if (rel) {
          const body = MODE === "inline" ? `<video src="${dataUrl(rel)}" controls>${path.basename(rel)}</video>` : await mediaBody(rel);
          if (body) { bodies.push(body); vidSent++; }
        }
      }
    }
    console.log(`PROBE mode=${MODE} sending ${bodies.length} messages (${imgSent} images, ${vidSent} videos), ${Math.round(bodies.reduce((a, b) => a + b.length, 0) / 1e6)} MB of bodies`);
    const tSend = Date.now();
    // The gateway's chat bucket is murmur's: 1/s, burst 5.
    let sent = 0;
    for (const body of bodies) {
      if (sent >= 4) await new Promise((r) => setTimeout(r, 1050));
      await app.invoke("send_message", { channelId, body });
      sent++;
    }
    console.log(`PROBE sent in ${Date.now() - tSend} ms`);
    // A raw send_message never refreshes the sender's own view (the store's
    // action refetches after each send); one composer send pulls it all in.
    await app.chat.sendMessage("probe-done");
    await app.chat.waitForText("probe-done", 30_000);
    const expectRows = Math.min(100, bodies.length);
    let rows = 0;
    await app.driver.wait(async () => {
      rows = await app.driver.executeScript<number>("return document.querySelectorAll('[data-message-id]').length");
      return rows >= expectRows;
    }, 30_000, "rows never mounted").catch(() => console.log(`PROBE only ${rows} rows mounted`));
    const dom = await app.driver.executeScript<string>(`
      const t = document.querySelector('[data-testid="chat-header-title"]');
      return JSON.stringify({ title: t ? t.textContent : null,
        idRows: document.querySelectorAll('[data-message-id]').length,
        msgRows: document.querySelectorAll('[data-msg-id]').length,
        senders: document.querySelectorAll('[data-sender-name]').length,
        text: (document.body.innerText || '').slice(0, 400) });
    `);
    console.log("PROBE dom", dom);
    writeFileSync(OUT.replace(/\.json$/, ".png"), Buffer.from(await app.driver.takeScreenshot(), "base64"));
    // Let the settle timers and any offload run.
    await new Promise((r) => setTimeout(r, 8000));

    const raw = await app.driver.executeAsyncScript<string>(MEASURE, { stepPx: 60, stepMs: 16, idleMs: 7000 });
    const result = JSON.parse(raw);
    writeFileSync(OUT, JSON.stringify(result, null, 2));
    console.log("PROBE result written to", OUT);
    if (result.error) throw new Error(result.error);
    const { phases, calls, ...rest } = result;
    console.log("PROBE", JSON.stringify(rest));
    for (const p of phases) console.log("PROBE phase", JSON.stringify(p));
    const byCmd: Record<string, { n: number; ms: number; bytes: number }> = {};
    for (const c of calls) {
      const e = (byCmd[c.cmd] ??= { n: 0, ms: 0, bytes: 0 });
      e.n++; e.ms += c.ms; e.bytes += c.bytes;
    }
    console.log("PROBE ipc", JSON.stringify(byCmd));
  });
});
