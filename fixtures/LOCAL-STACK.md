# Running the viewer, its UI, and the admin UI locally

Four processes, and only three of them are in Compose. The fourth - Starling -
runs on the host, which is the thing that is easy to get wrong and the reason
this file exists.

| Piece | Where | Host address |
|---|---|---|
| channelviewer (Flask API) | Compose, `channelviewer` profile | `http://127.0.0.1:5005` |
| channelviewer UI | Compose, `channelviewer` profile | `http://127.0.0.1:5006` |
| admin UI | Compose, `channelviewer` profile | `http://127.0.0.1:5007` |
| Starling | **host process** | `127.0.0.1:64738`, admin plane on `:8081` |

Compose does **not** start a Mumble server. The `mumble-server` fixture sits
behind its own `server` profile, so add `--profile server` if you want murmur
too.

## 1. Starling, with its admin plane on

The admin UI's Health page reads Starling's operator API, which is off by
default and has to be switched on by config - `enabled`/`listen` are not
environment-overridable.

```powershell
cd vendor/starling
cargo build --release -p starling
$env:STARLING_ADMIN_TOKEN = "e2e-token"
./target/release/starling.exe --all-in-one --config ../../fixtures/starling.local.toml
```

`fixtures/starling.local.toml` names only the delta: all-in-one, and the
operator API on `0.0.0.0:8081` with token auth.

**A config file overlays the defaults rather than replacing them**
(`Config::load` builds `with_defaults` and then `merge::overlay`s the file over
it), so everything the file does not mention - the service map, the routing
table, the rate-limit buckets - still comes from the defaults. It used to be a
full copy of `starling.example.toml`, back when `--config` replaced the defaults
outright and a partial file produced a server with an empty service map. There
is nothing to regenerate now.

## 2. The containers

```powershell
$env:CHANNELVIEWER_TEST_LOGIN = "1"
docker compose -f fixtures/docker-compose.e2e.yml --profile channelviewer up -d --wait --build
```

`CHANNELVIEWER_TEST_LOGIN=1` is what makes the admin UI's login work with no
username or password. Without it the login page has nothing to submit to: the
username/password route was removed with the Keycloak migration, so the form
posts to a 404 and reports "Login failed", which reads as "wrong password" and
is the one thing it is not.

The bypass only accepts requests that came from this machine.

## 3. Open it

- Viewer UI - <http://127.0.0.1:5006>
- Admin UI - <http://127.0.0.1:5007>, Health page at `/health`

## Teardown

```powershell
docker compose -f fixtures/docker-compose.e2e.yml --profile "*" down -v
```

`--profile "*"` is not optional: `down -v` without a profile matches only the
default services and silently leaves the profiled containers and their volumes
running.

## How the Health page reaches Starling

Not directly. The bundle is built with a **relative** base (`/starling`) and the
admin UI's nginx proxies it to `host.docker.internal:8081`, because a direct
browser call fails twice over:

- `operator-api` sends no `Access-Control-Allow-Origin` at all, so the browser
  blocks the cross-origin call before Starling sees it;
- `host.docker.internal` resolves inside containers and never in a browser.
  Baking it into the bundle produced "Failed to fetch" against a server that was
  up - the bug `src/tests/admin-health-dashboard.test.ts` now guards.

nginx also injects `Authorization: Bearer e2e-token`, because the test-login
bypass mints no token for the page to send. That token must match
`STARLING_ADMIN_TOKEN` from step 1. It is a fixture convenience and safe only
because the proxy is loopback-bound - do not copy the pattern anywhere public.

The rest of the admin UI is deliberately *not* proxied: those calls go straight
from the browser to `:5005`, because routing them through nginx would make them
arrive from the container and the test-login fence would refuse them.

## Checking it works without opening a browser

```powershell
node --import tsx --test src/tests/admin-health-dashboard.test.ts
```

Or by hand - this is the exact request the page makes:

```powershell
Invoke-WebRequest http://127.0.0.1:5007/starling/v1/health -UseBasicParsing
```

A healthy server answers 200 with `"state":"ready"` and one row per gRPC
service. `operator-api` is deliberately absent from that list: it speaks REST
and has no gRPC surface to poll, and its liveness is implied by the fact that it
served the document.
