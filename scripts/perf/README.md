# Client RAM and idle-CPU measurement

Scripts that put a number on what the desktop client costs while it sits
there, in the shape Task Manager reports it: the **private working set** of
every process in the tree (the Rust host plus WebView2's browser, GPU,
renderer, network, storage and crashpad processes), and CPU as a percentage of
one core. Working set and commit charge both read two to three times higher
than that and are not what the user sees.

Measure a build with embedded assets (`--features custom-protocol`, or
`cargo tauri build`). A `cargo tauri dev` instance carries the Vite dev server
and a debug host and measures roughly twice as much.

## Pieces

| File | What it does |
| --- | --- |
| `measure.ps1 -RootPid <pid> -Seconds 10 -Label x` | Samples the process tree under `<pid>`: CPU over the window, private working set, working set, commit, threads. |
| `threads.ps1 -ProcId <pid>` | Per-thread CPU of one process with thread names, to see which loop is awake. |
| `launch.sh <exe>` | Starts the client with a DevTools port on its WebView2 and its own profile under `.tmp/perf/`, prints the Windows pid. |
| `cdp.mjs <port> <cmd>` | DevTools Protocol client: `metrics N` (renderer task/layout time, JS heap, DOM nodes), `eval <js>`, `css <text>` / `uncss` (inject a stylesheet live), `shot <png>`, `gc`, `memdump` (memory-infra allocator breakdown per process; `MEMDUMP_DEPTH`, `MEMDUMP_MIN`, `MEMDUMP_TOP` widen it). |
| `heapsnap.mjs <port> [topN]` | V8 heap snapshot, summarised: self size by node type and by constructor, the biggest retained strings, and `NAME_GREP=<regex>` to total one class of object (e.g. `^blink::`). |
| `run-starling.mts` | Keeps a harness-configured Starling on 64738 until killed; prints its operator port. |
| `flood.mts [total] [perSecond] [bots] [channel]` | Bots post a realistic mix of messages - short, long, markdown, links, inline images - into the channel. |
| `realistic.sh <label>` | The whole scenario: launch, connect to the saved `localhost` server, sample idle, flood 3000 messages, sample idle twice, scroll the history, sample again. |

## A run

```
node --import tsx scripts/perf/run-starling.mts        # leave running
EXE=vendor/client/target/release/mumble-tauri.exe LINK_PORT=<operator port> \
  bash scripts/perf/realistic.sh before > .tmp/perf/before.log
```

Two instances of the client share one WebView2 browser process unless their
user data folders differ, which is why `launch.sh` gives its instance its own;
the Roaming config directory is still shared with any other running client.

## What the numbers looked like (2026-09-03, release-debug, 2592x1693 window at 150 %)

| State | Private working set | Idle CPU (one core) |
| --- | --- | --- |
| Connect screen | ~150 MB | ~0.2 % |
| Connected, empty channel | ~200 MB | 0.2-2 % (see below) |
| After 3000 messages with 150 inline images | ~305-330 MB (renderer 155-175 MB) | 0.16-0.31 % with the mic muted |
| Same, microphone open (voice activation, RNNoise) | ~330 MB | ~1.25-2.2 % |

Idle CPU is almost entirely the Rust host's audio threads. Before the gated
denoiser and the zero-fill output path, the outbound loop cost 109 ms per 10 s
and the output callback another 109 ms; after, 16 ms and 31 ms. What remains
with the mic open is the capture thread itself (`rodio-mic-reader` or
`cpal_wasapi_in`, 16-47 ms per 10 s depending on the device).

The renderer's share grows with the history it holds; the GPU process sits at
40-80 MB and tracks window size, not content. `--enable-low-end-device-mode`
and the `--force-gpu-mem-*` flags changed nothing measurable.

## The trap: working set is not a stable number

The same client, holding the same 3000 messages, measured **391 MB** thirty
seconds after a burst of scrolling and **63 MB** forty seconds later with
nothing touching it. Windows trims a process's working set when it goes
quiet, and WebView2 trims its own on top of that (`SetMemoryUsageTargetLevel`,
see `app/webview.rs`).

So a single before/after pair proves nothing: the reading depends mostly on
how recently the window was active. Run-to-run spread on nominally identical
configurations here was 302-391 MB. To compare two builds, hold the activity
pattern identical, take several samples, and treat anything under ~50 MB as
noise. Counts that do not fluctuate - mounted rows, DOM nodes, files in the
offload store - are far better evidence that a change did what it claims.

## Where a loaded renderer's memory actually is

From `memdump` on a client holding 3000 messages with 150 inline images:

| Allocator | Size | What it is |
| --- | --- | --- |
| `cc/tile_memory` | 55-79 MB | Compositor tiles. Scales with **window area**, not with the conversation. |
| `blink_gc` | 57 MB | The DOM and its layout/paint objects. Scales with mounted rows. |
| `v8` | 35-40 MB | The JS heap: the store's message array, React's tree. |
| `malloc` | 34-36 MB | Everything else Blink allocates outside its GC heap. |
| `web_cache` | 18 MB | Decoded images (10.8 MB) and script sources (6.4 MB). |

The JS heap itself is small next to those: a snapshot of the loaded page came
to 48 MB of self sizes, of which strings over 20 KB - the inline images still
held inline - were only 1.2 MB once the offloader had done its pass.

`content-visibility: auto` on the message rows was measured and **rejected**:
it moved the total by ~3 MB, inside the noise, because the render window
already keeps the mounted row count low.
