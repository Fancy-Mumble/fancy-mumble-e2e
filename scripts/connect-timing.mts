/**
 * Where does a connect spend its time?
 *
 * Launches the real Tauri client, wraps `__TAURI_INTERNALS__.invoke` so every
 * backend call is stamped, drives the connect page as a user would, and polls
 * the visible loading text. The frontend's own bootstrap-stage names sit
 * between `ServerSync` and the chat view, so a long stage names the culprit
 * instead of implying it; the invoke log separates "the backend was slow" from
 * "the frontend waited".
 *
 * Not part of the suite: a measurement, run by hand against whatever server is
 * on `E2E_SERVER_HOST:E2E_SERVER_PORT`.
 *
 *   npx tsx scripts/connect-timing.mts [username] [password]
 */

import { TauriApp } from "../src/app";
import { config } from "../src/config";

const user = process.argv[2] ?? `timing-${Date.now() % 100000}`;
const password = process.argv[3];

const app = await TauriApp.launch({ instance: 0 });

// Stamp every Tauri command. `invoke` is an ES import in the bundle, but it
// forwards to this one object, so wrapping it here catches them all.
await app.driver.executeScript(`
  window.__INVOKE_LOG__ = [];
  const internals = window.__TAURI_INTERNALS__;
  if (internals && !internals.__wrapped) {
    const original = internals.invoke.bind(internals);
    internals.invoke = function (cmd, args, opts) {
      const started = performance.now();
      const record = { cmd, started, ended: null };
      window.__INVOKE_LOG__.push(record);
      const done = () => { record.ended = performance.now(); };
      try {
        const out = original(cmd, args, opts);
        if (out && typeof out.then === "function") {
          return out.then((v) => { done(); return v; }, (e) => { done(); throw e; });
        }
        done();
        return out;
      } catch (e) { done(); throw e; }
    };
    internals.__wrapped = true;
  }
  window.__T0__ = performance.now();
`);

const t0 = Date.now();
const at = () => String(Date.now() - t0).padStart(6);

/** The visible loading text and route, which is what the user is waiting on. */
async function probe(): Promise<string> {
  const raw = await app.driver.executeScript(`
    const chat = document.querySelector('[data-testid="chat-header-title"]');
    const text = (document.body.innerText || "")
      .split("\\n").map((l) => l.trim()).filter(Boolean).slice(0, 4).join(" | ");
    return JSON.stringify({ route: location.hash || location.pathname, chat: !!chat, text });
  `);
  return String(raw);
}

console.log(`connecting to ${config.serverHost}:${config.serverPort} as ${user}`);

let last = "";
const poll = setInterval(() => {
  probe()
    .then((now) => {
      if (now !== last) {
        console.log(`${at()} ms  ${now}`);
        last = now;
      }
    })
    .catch(() => {});
}, 25);

await app.connect.connect(config.serverHost, user, {
  port: config.serverPort,
  ...(password ? { password } : {}),
});
console.log(`${at()} ms  connect form submitted`);

try {
  await app.chat.waitLoaded(60_000);
  console.log(`${at()} ms  chat view loaded`);
} catch (e) {
  console.log(`${at()} ms  chat view never loaded: ${(e as Error).message}`);
}

await new Promise((r) => setTimeout(r, 3000));
clearInterval(poll);

const log = JSON.parse(
  String(
    await app.driver.executeScript(`
      const t0 = window.__T0__ ?? 0;
      return JSON.stringify((window.__INVOKE_LOG__ || []).map((r) => ({
        cmd: r.cmd,
        at: Math.round(r.started - t0),
        ms: r.ended === null ? null : Math.round(r.ended - r.started),
      })));
    `),
  ),
) as { cmd: string; at: number; ms: number | null }[];

console.log("\n--- tauri invokes (at = ms since page instrumented) ---");
for (const r of log) {
  const dur = r.ms === null ? "PENDING" : `${r.ms} ms`;
  console.log(`${String(r.at).padStart(7)}  ${dur.padStart(9)}  ${r.cmd}`);
}

await app.close();
process.exit(0);
