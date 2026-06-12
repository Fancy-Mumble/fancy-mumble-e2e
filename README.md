# fancy-mumble-e2e

Fully-automated **end-to-end** tests for [FancyMumble](https://github.com/Fancy-Mumble/FancyMumbleNext):
launch the real packaged desktop client, drive the actual React UI with
**Selenium + tauri-driver**, and talk to a **real Fancy Mumble server** in
Docker — proving the whole stack (UI → Tauri commands → mumble-protocol →
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
        └──────── Mocha + selenium-webdriver (src/) ────────┘
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
docker compose -f fixtures/docker-compose.e2e.yml up -d --wait

# 2. run the suite (Linux: wrap in xvfb-run for headless)
npm run test:e2e
xvfb-run -a npm run test:e2e        # Linux headless

# 3. tear down
docker compose -f fixtures/docker-compose.e2e.yml down -v
```

### Configuration (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `E2E_APP_BIN` | `vendor/client/target/release/mumble-tauri[.exe]` | Built client binary |
| `E2E_TAURI_DRIVER` | `tauri-driver` | tauri-driver executable |
| `E2E_NATIVE_DRIVER` | _(auto)_ | Explicit WebKitWebDriver/msedgedriver path |
| `E2E_DRIVER_PORT` | `4445` | Base WebDriver port (instance N → base+N) |
| `E2E_SERVER_HOST` / `E2E_SERVER_PORT` | `127.0.0.1` / `64738` | Server to connect to |
| `E2E_SERVER_IMAGE` | `ghcr.io/setzero/mumble-server:latest` | Server image for the compose fixture |
| `E2E_CONNECT_TIMEOUT` | `45000` | Connect + bootstrap timeout (ms) |

## How test mode works

The harness can't pass process env into the webview, so it drives test mode via
`localStorage` (see `vendor/client/.../utils/e2e.ts`): on launch it sets
`fancy-e2e=1` (skip the first-run welcome flow) and `mumble-language=en`
(deterministic, language-stable selectors), then navigates to `/`. Test mode
only relaxes non-functional UX; it never changes connection/protocol behaviour.

Selectors come from the client's shared `data-testid` registry (imported in
`src/selectors.ts`), never from translated text or hashed CSS-module classes.

## Roadmap

- [x] **Phase 1** – harness + connect/chat **smoke test** (de-risk tauri-driver)
- [ ] **Phase 2** – publish/pin the server image; verify file-server/live-doc ini keys
- [ ] **Phase 3** – core scenarios: cert connect, channels, **multi-client** messaging, presence, voice-UI state (mute/deafen, talking indicators)
- [ ] **Phase 4** – Fancy features: pchat history, file-server upload, live-doc sync, reactions
- [ ] **Phase 5** – headless CI (`.github/workflows/e2e.yml`) once the client branch is pushed

Voice **fidelity** is intentionally out of scope (covered by the client's
`mumble-protocol` integration + `audio_quality` tests); the suite asserts voice
**UI state** only.
