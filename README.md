# fancy-mumble-e2e

Fully-automated **end-to-end** tests for [FancyMumble](https://github.com/Fancy-Mumble/FancyMumbleNext):
launch the real packaged desktop client, drive the actual React UI with
**Selenium + tauri-driver**, and talk to a **real Fancy Mumble server** in
Docker - proving the whole stack (UI → Tauri commands → mumble-protocol →
server → back to UI) works together.

This repo contains **only** the e2e harness and fixtures. The three projects
under test are pulled in as git submodules:

| Submodule        | Repo                                   | Role |
|------------------|----------------------------------------|------|
| `vendor/client`  | `Fancy-Mumble/FancyMumbleNext`         | The desktop client (built to a binary, driven by the tests) |
| `vendor/server`  | `Fancy-Mumble/mumble-server`           | The Mumble server fork (source/reference) |
| `vendor/docker`  | `Fancy-Mumble/mumble-docker`           | Builds the server image (file-server, live-doc, pchat, plugins) |

```
 ┌─ docker compose (fixtures/docker-compose.e2e.yml) ─┐
 │  fancy mumble-server  :64738  (control/voice)       │
 │  file-server plugin   :64739  (HTTP uploads)        │
 │  live-doc plugin       :64740  (collab WS)          │
 └─────────────────────────────────────────────────────┘
        ▲ TLS (self-signed; client accepts invalid certs)
 ┌─ built client binary ─┐   ┌─ built client binary ─┐   (2nd instance for
 │ vendor/client/target  │…  │ isolated HOME/appdata │    multi-user tests)
 └──────────▲────────────┘   └──────────▲────────────┘
       WebKit / WebView2            WebKit
       │ WebDriver                  │ WebDriver
 ┌─ tauri-driver :4445 ─┐     ┌─ tauri-driver :4446 ─┐
 └──────────▲───────────┘     └──────────▲───────────┘
        └─────── node:test + selenium-webdriver (src/) ──────┘
```

## Layout

```
src/
  config.ts           env-driven config (binary path, ports, timeouts)
  selectors.ts        re-exports the client's data-testid registry (no drift)
  driver.ts           spawn tauri-driver + open a WebDriver session
  app.ts              TauriApp: one launched client + isolated data dir
  pages/              page objects (connect, chat, …)
  tests/              the actual *.test.ts specs
  util/               proc/kill, http wait, xpath helpers
fixtures/
  docker-compose.e2e.yml   the server under test
  mumble-server.ini        relaxed test config (pchat + file-server on)
vendor/{client,server,docker}   git submodules (see table above)
```

## Prerequisites

- **Docker** (for the server fixture)
- **Node.js 22+**
- **Rust + Tauri CLI** to build the client binary (`cargo install tauri-cli`)
- **tauri-driver**: `cargo install tauri-driver --locked`
- A native WebDriver on `PATH`:
  - **Linux**: `WebKitWebDriver` (Ubuntu: `apt-get install webkit2gtk-driver`), plus `xvfb` for headless
  - **Windows**: `msedgedriver` matching the installed WebView2/Edge
  - **macOS**: not supported by tauri-driver

## Setup

```bash
git clone --recurse-submodules git@github.com:Fancy-Mumble/fancy-mumble-e2e.git
cd fancy-mumble-e2e
npm install
```

> **Submodule access.** This repo is public, but several of the systems it
> drives are not: `channelviewer`, `channelviewer-frontend`,
> `mumble-admin-frontend`, `mumble-user-manager*` and `wren` are private, so
> `--recurse-submodules` only resolves them for accounts with access. The client
> and Starling are public, and the suites that need the private services gate
> themselves on those services being reachable - so a partial checkout runs, it
> just measures less.

```bash
# Build the client binary with embedded assets (run inside the submodule)
( cd vendor/client/crates/mumble-tauri/ui && npm ci && npm run build )
( cd vendor/client && cargo tauri build )   # or: cargo build --release --features custom-protocol
```

> ⚠️ **Client submodule commit.** The `vendor/client` submodule is pinned to the
> `feature/e2e-testability` branch of FancyMumbleNext, which adds the shared
> `data-testid` registry (`crates/mumble-tauri/ui/src/testids.ts`) and the
> localStorage-driven e2e test mode that `src/selectors.ts` imports. **That
> branch must be pushed to the client's GitHub remote** for a fresh
> `git submodule update --init` (and CI) to resolve the pinned commit. Until
> then the submodule only resolves from a local clone of the client repo.

## Running

```bash
# 1. start the server
docker compose -f fixtures/docker-compose.e2e.yml --profile server up -d --wait

# 2. run the suite (Linux: wrap in xvfb-run for headless)
npm run test:e2e
xvfb-run -a npm run test:e2e        # Linux headless

# 3. tear down
docker compose -f fixtures/docker-compose.e2e.yml --profile "*" down -v
```

### Headed (local) run - watch it drive the real window

The suite is never headless by itself; headlessness is purely environmental
(CI wraps it in `xvfb-run`). For a local run with a **visible** app window, use
the helper scripts, which build the binary if needed, bring the server up, run
the suite headed (visible window), and tear down:

```powershell
# Windows (PowerShell) - drives the Edge WebView2 window via msedgedriver
./scripts/run-local.ps1 -Build           # build + run everything
./scripts/run-local.ps1 -Grep "smoke"    # just the smoke test, reusing an existing build
```

```bash
# Linux/macOS - Linux shows a real window when $DISPLAY is set (no xvfb)
./scripts/run-local.sh --build
./scripts/run-local.sh --grep "voice"
```

Extra prerequisite for headed runs: the native WebDriver must be available -
`msedgedriver` (Windows, matching your Edge/WebView2 version) or
`WebKitWebDriver` (Linux). macOS isn't supported by tauri-driver.

On Windows, grab the matching `msedgedriver` once:

```powershell
./scripts/install-msedgedriver.ps1   # downloads it into .tools/ (auto-used by run-local.ps1)
```

`run-local.ps1` fails fast with this hint if the driver is missing, and uses
`.tools/msedgedriver.exe` or `$env:E2E_NATIVE_DRIVER` when present.

### Configuration (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `E2E_APP_BIN` | `vendor/client/target/release/mumble-tauri[.exe]` | Built client binary |
| `E2E_TAURI_DRIVER` | `tauri-driver` | tauri-driver executable |
| `E2E_NATIVE_DRIVER` | _(auto)_ | Explicit WebKitWebDriver/msedgedriver path |
| `E2E_DRIVER_PORT` | `4445` | Base WebDriver port (instance N → base+N) |
| `E2E_SERVER_HOST` / `E2E_SERVER_PORT` | `127.0.0.1` / `64738` | Server to connect to |
| `E2E_UI_DESIGN` | `standard` | Client design pack the suite drives (`?ui=`) - `standard` or `nebula`. See [Design packs](#design-packs) |
| `E2E_SERVER_IMAGE` | `ghcr.io/fancy-mumble/mumble-server:latest` | Server image for the compose fixture |
| `E2E_CONNECT_TIMEOUT` | `45000` | Connect + bootstrap timeout (ms) |

## Design packs

The client ships three UI design packs, and a green run only says something
about the one it drove. `E2E_UI_DESIGN` picks it, and the harness passes it to
every client it launches as the `?ui=` launch override, which beats whatever a
fresh profile would default to:

```bash
E2E_UI_DESIGN=nebula npm run e2e         # the pack new profiles now get
npm run e2e                              # standard, still the default here
```

`standard` and `nebula` are the two the suite drives. `aurora` carries no test
ids at all, so pointing the suite at it is refused at start-up rather than
failing later as 40 timed-out waits.

The page objects are shared. Where the two packs are only styled differently
they need nothing: both carry the same ids from the client's registry
(`core/testids.ts`). Where they genuinely differ - Nebula has no connect wizard,
no sidebar tabs, and words its context menus differently - the page objects
branch on `src/ui-flavour.ts`, and what is pack-specific lives in
`src/util/nebula.ts` rather than spreading through nine page objects.

Some features exist in one pack and not the other. `featureMissing()` in
`src/ui-flavour.ts` holds that matrix and returns the same `Gate` shape as the
server-side preconditions, so a suite for a feature the running pack has not
built skips with a reason instead of timing out:

```ts
describe("calendar: ...", { skip: featureMissing("calendar") || pluginMissing("fancy-calendar") }, ...)
```

Nebula currently ships no calendar, scheduled messages, forums or role wizard.
When it grows one, add it to `SUPPORTED` in that file and the suites run.

## How test mode works

The harness can't pass process env into the webview, so it drives test mode via
`localStorage` (see `vendor/client/.../utils/e2e.ts`): on launch it sets
`fancy-e2e=1` (skip the first-run welcome flow) and `mumble-language=en`
(deterministic, language-stable selectors), then navigates to `/`. Test mode
only relaxes non-functional UX; it never changes connection/protocol behaviour.

Selectors come from the client's shared `data-testid` registry (imported in
`src/selectors.ts`), never from translated text or hashed CSS-module classes.

## CI

[`.github/workflows/nightly.yml`](.github/workflows/nightly.yml) runs the sweep
at 02:23 UTC, but only when there is something new to measure. A cheap `detect`
job asks each watched submodule's remote for its tracked branch tip and compares
that against the tips of the last run, recorded as `state.json` on the
`nightly-state` branch. If nothing moved, the sweep is skipped; the pinned
gitlinks are irrelevant to this - the nightly tests branch tips, not pins.

Tips are recorded whether the sweep passed or failed, so one red night does not
re-run the same code every night. To re-run anyway, dispatch it with `force`:

```bash
gh workflow run nightly.yml -f force=true
```

**Setup.** Four watched submodules are private, so `detect` and the checkout
need a `SUBMODULE_TOKEN` repo secret - a classic PAT with `repo` scope, from an
account that can read both the `Fancy-Mumble` and `SetZero` repos (a
fine-grained PAT is single-owner and would need two). Without it, `detect` fails
loudly rather than silently testing less:

```bash
gh secret set SUBMODULE_TOKEN
```

Set `NIGHTLY_RUNNER` as a repo variable to move the heavy job to a self-hosted
runner; it defaults to `ubuntu-latest`.

Two suites are excluded via `E2E_SKIP`: `screenshare.gpu` and
`screenshare.performance` assert an fps floor against a live 60 Hz source, which
a software-rendered Xvfb desktop fails on merit.

## Roadmap

- [x] **Phase 1** – harness + connect/chat **smoke test** (de-risk tauri-driver)
- [x] **Phase 3 (partial)** – **multi-client** presence + bidirectional messaging
- [ ] **Phase 2** – publish/pin the server image; verify file-server/live-doc ini keys
- [ ] **Phase 3 (rest)** – cert connect, channels, voice-UI state (mute/deafen, talking indicators)
- [ ] **Phase 4** – Fancy features: pchat history, file-server upload, live-doc sync, reactions
- [ ] **Phase 5** – get the nightly workflow (see above) green

Voice **fidelity** is intentionally out of scope (covered by the client's
`mumble-protocol` integration + `audio_quality` tests); the suite asserts voice
**UI state** only.
