# Handoff: finish the e2e failures against `vendor/server`

Self-contained. Everything below has been verified on this machine today
(2026-07-31); nothing is assumed.

## 0. What this task is

The e2e suite is being fixed **against `vendor/server`, the gold standard**,
before it is pointed at Starling. A test that fails against the reference server
is not evidence about Starling, so it must be fixed or gated first.

Current state after today's work: **~75 passing / ~14 failing**, from 46/54.

## 1. Environment — get this right or every result is noise

Three faults invalidated an entire previous sweep. Check all three.

**Docker must be running**, and the server must be **built from `vendor/server`**,
not pulled. The published `ghcr.io/fancy-mumble/mumble-server:latest` is **six
weeks and 60 commits stale** and silently breaks every Fancy feature, because the
client renumbered its protobuf fields in between.

```sh
cd vendor/docker
DOCKER_BUILDKIT=1 docker buildx build -f Dockerfile.dev -t fancy-mumble-server:e2e \
  --build-context mumble-src=../server \
  --build-context fancy-plugins-src=<abs path to>/Mumble/fancy-plugin \
  .
cd ../..
E2E_SERVER_IMAGE=fancy-mumble-server:e2e \
  docker compose -f fixtures/docker-compose.e2e.yml up -d --wait
MSYS_NO_PATHCONV=1 docker exec fancy-e2e-mumble \
  mumble-server --ini /config/mumble-server.ini --set-su-pw testpassword
```

`MSYS_NO_PATHCONV=1` matters: without it Git Bash rewrites `/config/...` to
`C:/Program Files/Git/config/...`. Node is unaffected; only hand-run commands.

**The client binary must be current.** The harness drives
`vendor/client/target/release/mumble-tauri.exe`. A stale one invalidates
everything — the last sweep was measured against a 13-day-old build.

```sh
cd vendor/client/crates/mumble-tauri && SKIP_QT6UI=1 cargo tauri build --no-bundle
```

**Verify the server owns 64738.** The connect wizard only shows a port field in
expert mode; in normal mode it *always* dials 64738 and `E2E_SERVER_PORT` is
ignored. Anything else on that port silently becomes the system under test.

## 2. Running

```sh
bash scripts/run-per-file.sh                 # all 41 files
bash scripts/run-per-file.sh audit-log pchat # a subset, by substring
```

One node process per file, drivers reaped between, `.tools` (msedgedriver) put on
PATH by the script. Do **not** use `npm run test:e2e`: it runs everything in one
process with no timeout, so one hang blocks the run and one leaked driver port
cascades into every later file.

Logs land in `.tmp/per-file/<name>.log`.

## 3. What is already fixed — do not redo these

| Fix | Was |
|---|---|
| `waitLoaded` answers the plugin trust prompt | 35 of 41 files hit `ElementClickIntercepted` several steps later |
| `sendMessage` scripts astral chars and newlines | msedgedriver refuses >U+FFFF; a newline pressed Enter and split the message |
| `waitForText` normalises the needle | `normalize-space()` collapsed the haystack only, so multi-line never matched |
| `createPoll` uses `role=menuitem` | `KebabMenu` sets `key={item.id}`, a React key that never reaches the DOM |
| `votePoll` targets `<button>` | `PollCard` renders no `<label>` and no `<input>` |
| `Dockerfile.dev` builds `libmumble_audit.so` | named plugins explicitly and omitted audit in all three places; `audit-log` 1/9 → 7/9 |
| `starling-voice` opt-in via `E2E_SERVER_IMPL=starling` | ran against murmur and asserted Starling's cipher |
| `forums` skipped | `chat-header-kebab` exists nowhere in the client |
| `vendor/channelviewer` registered as a submodule | was an empty, unregistered gitlink |

## 4. What is left

### 4a. `channelviewer` — should pass now, unverified

`vendor/channelviewer` was an empty gitlink with no `.gitmodules` entry. It is
now registered against **`https://github.com/SetZero/channelviewer.git`**, branch
`feat/starling-source` (the recorded commit `2f5da4a0` is that branch's tip). It
is a **private repo under a personal account**, which is why an org-wide search
missed it.

The suite has been un-skipped but **not run**. Start the container and verify:

```sh
E2E_SERVER_IMAGE=fancy-mumble-server:e2e \
  docker compose -f fixtures/docker-compose.e2e.yml --profile channelviewer up -d --wait
bash scripts/run-per-file.sh channelviewer
```

Note the file's own header: the viewer's Ice slice must match the server's
`Channel` struct. Ice marshals positionally with no versioning, so a stale slice
mis-unmarshals every `getChannels` reply. If it fails on marshalling, that is the
drift the test exists to catch — not a harness bug.

### 4b. Genuine product failures — the real target

These fail against a **current** server built from `vendor/server`, past all the
harness bugs above. Each needs its own investigation. They are the trustworthy
list.

| Suite | Symptom |
|---|---|
| `server-compatibility` | `expected exactly 8 messages from "e2e-compat-A-…"` — fan-out count |
| `server-compatibility` | multi-line message never renders, even with the needle fixed |
| `fancy-control-plane` | poll is created and delivered, but `1 vote` never appears after voting |
| `pchat-control-plane` | `togglePin` → `ElementNotInteractableError` (pin control likely hover-revealed) |
| `registration` | `lets the registered user act as themselves` times out on the message |
| `friend-chat-tree-visibility` | `user "SuperUser" never appeared under a channel in the sidebar tree` |
| `audit-log` 7/9 | `audit.mute_deafen_suppress` and `audit.register` still not recorded |

For each: decide **test bug or product bug**. The method that worked all day is
to probe the live DOM rather than reason from source — a temporary
`src/tests/zz-probe.test.ts` that connects and dumps
`document.querySelectorAll("button")` with `aria-label`/`id`/`data-testid`
settled three selector questions in minutes and disproved one confident wrong
guess. Delete it afterwards.

### 4c. Cannot be fixed here

`camera-share` (0/3) needs a physical camera.

## 5. Traps, in the order they bite

* **`audit-log` is flaky.** One run died in `before` on the connect wizard and
  reported 0/0; an unchanged re-run gave 7/9. Do not read a single run as proof
  in either direction.
* **A skipped suite reports `pass 0 fail 0`** — identical to a suite that
  crashed before running anything. Check the log, not the summary.
* **`grep -P` is unavailable** in this Git Bash locale, and the spec reporter
  prefixes its summary with a multibyte glyph, so `^.` matches one *byte*. Both
  produce a silent "ran no test". The runner uses `awk` on the last field.
* **Aurora is inert.** `DEFAULT_UI_DESIGN` is `"standard"` and the harness sets
  no `?ui=`, so anything blamed on the Aurora rework is misattributed. The suite
  drives `ui/standard/`.
