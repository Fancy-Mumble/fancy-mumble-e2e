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
| `cdp.mjs <port> <cmd>` | DevTools Protocol client: `metrics N` (renderer task/layout time, JS heap, DOM nodes), `eval <js>`, `css <text>` / `uncss` (inject a stylesheet live), `shot <png>`, `memdump` (memory-infra allocator breakdown per process). |
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
