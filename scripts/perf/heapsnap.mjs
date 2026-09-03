// Take a V8 heap snapshot of the WebView2 page over CDP and summarise it:
// self size by constructor / node type, the biggest strings, and DOM-ish
// retainer classes. Usage: node heapsnap.mjs <port> [topN]
const [port, topArg] = process.argv.slice(2);
const TOP = Number(topArg ?? 30);
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find((t) => t.type === "page" && !/devtools/.test(t.url));
if (!page) { console.error("no page target"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const chunks = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "HeapProfiler.addHeapSnapshotChunk") chunks.push(m.params.chunk);
  else if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await send("HeapProfiler.enable");
await send("HeapProfiler.collectGarbage");
await send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, treatGlobalObjectsAsRoots: true, captureNumericValue: false });
ws.close();
const snap = JSON.parse(chunks.join(""));
const meta = snap.snapshot.meta;
const nf = meta.node_fields;
const nodeTypes = meta.node_types[0];
const iType = nf.indexOf("type"), iName = nf.indexOf("name"), iSelf = nf.indexOf("self_size");
const stride = nf.length;
const nodes = snap.nodes, strings = snap.strings;
const byClass = new Map();
const grep = process.env.NAME_GREP ? new RegExp(process.env.NAME_GREP) : null; const grepped = new Map();
const byType = new Map();
const bigStrings = [];
let total = 0;
for (let i = 0; i < nodes.length; i += stride) {
  const type = nodeTypes[nodes[i + iType]];
  const name = strings[nodes[i + iName]];
  const self = nodes[i + iSelf];
  total += self;
  if (grep && grep.test(name)) { const g = grepped.get(name) ?? { size: 0, count: 0 }; g.size += self; g.count++; grepped.set(name, g); }
  byType.set(type, (byType.get(type) ?? 0) + self);
  const key = type === "object" || type === "closure" ? `${type}:${name}` : type === "string" || type === "concatenated string" || type === "sliced string" ? `string` : `${type}:${name.slice(0, 40)}`;
  const e = byClass.get(key) ?? { size: 0, count: 0 };
  e.size += self; e.count++;
  byClass.set(key, e);
  if ((type === "string" || type === "concatenated string") && self > 20_000) bigStrings.push({ size: self, head: name.slice(0, 80).replace(/\s+/g, " ") });
}
const mb = (b) => (b / 1048576).toFixed(2) + " MB";
console.log("heap total (self sizes):", mb(total), "nodes:", nodes.length / stride);
console.log("\nby node type:");
for (const [t, s] of [...byType].sort((a, b) => b[1] - a[1])) console.log("  ", mb(s).padStart(10), t);
console.log(`\ntop ${TOP} by class/name:`);
for (const [k, e] of [...byClass].sort((a, b) => b[1].size - a[1].size).slice(0, TOP)) console.log("  ", mb(e.size).padStart(10), String(e.count).padStart(7), k);
if (grep) {
  console.log("\nnodes matching " + grep + ":");
  for (const [n, g] of [...grepped].sort((a, b) => b[1].size - a[1].size).slice(0, 25)) console.log("  ", mb(g.size).padStart(10), String(g.count).padStart(7), n);
}
bigStrings.sort((a, b) => b.size - a.size);
console.log(`\nstrings > 20 KB: ${bigStrings.length}, total ${mb(bigStrings.reduce((s, x) => s + x.size, 0))}`);
for (const s of bigStrings.slice(0, 12)) console.log("  ", mb(s.size).padStart(10), s.head);
