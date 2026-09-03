// Minimal Chrome DevTools Protocol client for the WebView2 renderer.
// Usage: node cdp.mjs <port> <command> [args]
//   metrics [seconds]   -> Performance.getMetrics delta over N seconds
//   eval <js>           -> Runtime.evaluate (awaits promises), prints JSON
//   heap                -> JS heap usage + DOM counters
//   css <cssText>       -> inject a <style> into the page
//   uncss               -> remove injected style
import fs from "node:fs";
const [port, cmd, ...rest] = process.argv.slice(2);
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find((t) => t.type === "page" && !/devtools/.test(t.url));
if (!page) { console.error("no page target", list); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.error || r.result?.exceptionDetails) return { error: r.error ?? r.result.exceptionDetails.text };
  return r.result.result.value;
};
const metricsMap = async () => {
  const r = await send("Performance.getMetrics");
  return Object.fromEntries(r.result.metrics.map((m) => [m.name, m.value]));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (cmd === "metrics") {
  const secs = Number(rest[0] ?? 10);
  await send("Performance.enable");
  const a = await metricsMap();
  await sleep(secs * 1000);
  const b = await metricsMap();
  const keys = ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "V8CompileDuration"];
  const out = {};
  for (const k of keys) out[k + "_ms/s"] = Math.round(((b[k] - a[k]) * 1000) / secs * 100) / 100;
  out.LayoutCount_per_s = Math.round((b.LayoutCount - a.LayoutCount) / secs * 100) / 100;
  out.RecalcStyleCount_per_s = Math.round((b.RecalcStyleCount - a.RecalcStyleCount) / secs * 100) / 100;
  out.JSHeapUsed_MB = Math.round(b.JSHeapUsedSize / 1048576 * 10) / 10;
  out.JSHeapTotal_MB = Math.round(b.JSHeapTotalSize / 1048576 * 10) / 10;
  out.Nodes = b.Nodes; out.JSEventListeners = b.JSEventListeners; out.LayoutObjects = b.LayoutObjects;
  out.Frames = b.Frames; out.Documents = b.Documents;
  console.log(JSON.stringify(out, null, 1));
} else if (cmd === "eval") {
  console.log(JSON.stringify(await evaluate(rest.join(" ")), null, 1));
} else if (cmd === "heap") {
  const m = await metricsMap();
  console.log(JSON.stringify({ JSHeapUsed_MB: m.JSHeapUsedSize / 1048576, JSHeapTotal_MB: m.JSHeapTotalSize / 1048576, Nodes: m.Nodes, Listeners: m.JSEventListeners, LayoutObjects: m.LayoutObjects, Documents: m.Documents, Frames: m.Frames }, null, 1));
} else if (cmd === "css") {
  const css = rest.join(" ");
  console.log(await evaluate(`(() => { let s = document.getElementById('__cdp_css'); if (!s) { s = document.createElement('style'); s.id = '__cdp_css'; document.head.appendChild(s); } s.textContent = ${JSON.stringify(css)}; return 'ok'; })()`));
} else if (cmd === "uncss") {
  console.log(await evaluate(`(() => { document.getElementById('__cdp_css')?.remove(); return 'ok'; })()`));
} else if (cmd === "shot") {
  const r = await send("Page.captureScreenshot", { format: "png" });
  const out = rest[0] ?? "shot.png";
  fs.writeFileSync(out, Buffer.from(r.result.data, "base64"));
  console.log("wrote " + out);
} else if (cmd === "memdump") {
  // Chromium memory-infra: one detailed dump, per-process allocator breakdown.
  const chunks = [];
  let done;
  const finished = new Promise((r) => (done = r));
  const prev = ws.onmessage;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Tracing.dataCollected") chunks.push(...m.params.value);
    else if (m.method === "Tracing.tracingComplete") done();
    else prev(ev);
  };
  await send("Tracing.start", { categories: "disabled-by-default-memory-infra", transferMode: "ReportEvents", options: "record-until-full" });
  await sleep(500);
  const dump = await send("Tracing.requestMemoryDump", { deterministic: false, levelOfDetail: "detailed" });
  await sleep(1500);
  await send("Tracing.end");
  await finished;
  const names = {};
  for (const e of chunks) if (e.ph === "M" && e.name === "process_name") names[e.pid] = e.args.name;
  const byPid = {};
  for (const e of chunks) {
    if (e.ph !== "v" || !e.args?.dumps?.allocators) continue;
    const allocs = e.args.dumps.allocators;
    const totals = e.args.dumps.process_totals ?? {};
    const rows = [];
    for (const [name, a] of Object.entries(allocs)) {
      const size = a.attrs?.effective_size ?? a.attrs?.size;
      if (!size) continue;
      const v = parseInt(size.value, 16);
      // Only top-level and second-level nodes, to keep it readable.
      if (name.split("/").length <= 2 && v > 1_000_000) rows.push([name, v]);
    }
    rows.sort((x, y) => y[1] - x[1]);
    byPid[e.pid] = { name: names[e.pid] ?? "?", resident_MB: totals.resident_set_bytes ? (parseInt(totals.resident_set_bytes, 16) / 1048576).toFixed(1) : "?", private_MB: totals.private_footprint_bytes ? (parseInt(totals.private_footprint_bytes, 16) / 1048576).toFixed(1) : "?", top: rows.slice(0, 18).map(([n, v]) => n + " " + (v / 1048576).toFixed(1) + "MB") };
  }
  console.log(JSON.stringify({ dumpOk: dump.result?.success, processes: byPid }, null, 1));
} else if (cmd === "gc") {
  await send("HeapProfiler.enable");
  await send("HeapProfiler.collectGarbage");
  console.log("gc done");
} else {
  console.error("unknown command");
}
ws.close();
