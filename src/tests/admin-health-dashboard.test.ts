import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { adminUiMissing } from "../util/preconditions";

/**
 * The admin UI's Health page, from the browser's side of the wire.
 *
 * This guards a bug that no unit test could see and no server-side check could
 * either, because both halves were individually correct: Starling served
 * `/v1/health` fine, and the page fetched the URL it had been given. The URL
 * was `http://host.docker.internal:8081` - a name that resolves *inside a
 * container* and never in a browser, baked into a bundle that runs only in a
 * browser. The page said "Failed to fetch" against a server that was up.
 *
 * So the assertions here are deliberately made from the outside:
 *
 *   1. The shipped bundle addresses Starling by a **relative** path. An
 *      absolute host in a browser bundle is the whole defect, and it is
 *      invisible until somebody opens the page.
 *   2. That path really is proxied, and answers with a health document.
 *   3. No service is reported unreachable - the collector once dialled
 *      `operator-api`, which serves REST and has no gRPC surface, and called
 *      the failure an outage. The overview's state is the worst state present,
 *      so that one false row painted the whole dashboard red.
 *
 * Setup:
 *   docker compose -f fixtures/docker-compose.e2e.yml --profile channelviewer \
 *     up -d --wait --build
 *
 * and a Starling with its admin plane on, which the compose file does not
 * start - it is a host process here:
 *   cd vendor/starling
 *   $env:STARLING_ADMIN_TOKEN = 'e2e-token'
 *   target/release/starling.exe --all-in-one \
 *     --config ../../fixtures/starling.local.toml
 */

const ADMIN_URL =
  process.env.E2E_ADMIN_UI_URL ?? `http://127.0.0.1:${process.env.E2E_ADMIN_UI_PORT ?? "5007"}`;

/** The states the collector can report. Mirrors `HEALTH_STATES` in the UI. */
type HealthState = "ready" | "warming" | "warning" | "unreachable";

/** One bounded queue's occupancy. `capacity: 0` means nothing declares a limit. */
interface Load {
  readonly name: string;
  readonly used: number;
  readonly peak: number;
  readonly capacity: number;
  readonly rejected: number;
}

interface ServiceHealth {
  readonly service: string;
  readonly state: HealthState;
  readonly latency_us: number;
  readonly error: string;
  readonly load: Load[];
}

interface Sample {
  readonly observed_at_ms: number;
  readonly ready: number;
  readonly unreachable: number;
  readonly worst_latency_us: number;
  readonly busiest_percent: number;
  readonly busiest: string;
  readonly rejected: number;
}

interface HealthDoc {
  readonly state: HealthState;
  readonly services: ServiceHealth[];
  readonly disabled: string[];
  readonly history: Sample[];
  readonly interval_ms: number;
}

/**
 * GET a path or absolute URL from the admin UI, waiting for it to come up.
 *
 * Resolved through `new URL` rather than string concatenation because the UI is
 * built with an **absolute** `BASE_URL`, so its own index.html refers to its
 * chunks by full URL. Concatenating produced
 * `http://127.0.0.1:5007http://127.0.0.1:5007/assets/…`.
 */
async function fetchText(path: string, timeoutMs = 30000): Promise<string> {
  const url = new URL(path, ADMIN_URL).toString();
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.text();
      lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `admin UI not serving ${path} at ${ADMIN_URL} (${lastErr}). Start it with:\n` +
      `  docker compose -f fixtures/docker-compose.e2e.yml --profile channelviewer up -d --wait --build`,
  );
}

describe("admin UI health dashboard", { skip: adminUiMissing() }, () => {
  let bundle = "";

  before(async () => {
    // The entry HTML names its own hashed chunk, so the bundle is found the
    // way a browser finds it rather than by a filename this test would have to
    // keep in step with Vite.
    const html = await fetchText("/");
    const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0, "the admin UI's index.html loads no script at all");
    const sources = await Promise.all(scripts.map((src) => fetchText(src)));
    bundle = sources.join("\n");
  });

  it("addresses Starling by a relative path, not a container hostname", () => {
    // `host.docker.internal` is the specific name that broke this, and it is
    // worth naming: it resolves in every container in this compose file, which
    // is exactly why it looked right in every place it was tested.
    assert.ok(
      !bundle.includes("host.docker.internal"),
      "the browser bundle contains `host.docker.internal`, which a browser cannot resolve - " +
        "build the admin UI with a relative STARLING_URL (e.g. /starling) and let nginx proxy it",
    );
    assert.ok(
      bundle.includes('"/starling"'),
      "the browser bundle does not use the relative Starling base `/starling`",
    );
  });

  it("serves the client-side /health route from the SPA entry", async () => {
    // A deep link into a client-side route must reach index.html, or the page
    // 404s for anybody who bookmarks it or refreshes on it.
    const html = await fetchText("/health");
    assert.match(html, /<div id="root"/, "the /health deep link did not fall back to the SPA");
  });

  it("proxies /starling to the operator API and returns a health document", async () => {
    const body = await fetchText("/starling/v1/health");
    const doc = JSON.parse(body) as HealthDoc;

    assert.ok(Array.isArray(doc.services), "the health document carries no service list");
    assert.ok(doc.services.length > 0, "the health document lists no services at all");
    // The dashboard plots its time series straight out of this response rather
    // than accumulating polls in the tab, so an empty history is a blank chart.
    assert.ok(Array.isArray(doc.history), "the health document carries no history");
    assert.ok(doc.interval_ms > 0, "the health document declares no poll interval");
  });

  it("reports no service as unreachable on a healthy server", async () => {
    const doc = JSON.parse(await fetchText("/starling/v1/health")) as HealthDoc;

    const unreachable = doc.services.filter((s) => s.state === "unreachable");
    assert.deepEqual(
      unreachable.map((s) => `${s.service}: ${s.error}`),
      [],
      "services reported unreachable on a server that is up",
    );
    // Checked separately from the rows: the headline is the worst state
    // present, so this catches a state the per-service list does not explain.
    assert.equal(doc.state, "ready", "the overall state is not ready");
  });

  it("reports latency with enough resolution to be non-zero", async () => {
    // The bug this guards is a column of zeroes that looks like working
    // instrumentation. Every service shares one process under `--all-in-one`,
    // so a check takes tens of microseconds and *every* honest measurement
    // truncated to `0 ms` - the figure was not wrong so much as absent, and
    // nothing about it said so.
    const doc = JSON.parse(await fetchText("/starling/v1/health")) as HealthDoc;

    for (const service of doc.services) {
      assert.equal(
        typeof service.latency_us,
        "number",
        `${service.service} reports no latency_us - is the API still on milliseconds?`,
      );
    }
    assert.ok(
      doc.services.some((s) => s.latency_us > 0),
      "every service reported 0µs, which means the resolution is still too coarse to measure anything",
    );
  });

  it("reports what each service has queued", async () => {
    const doc = JSON.parse(await fetchText("/starling/v1/health")) as HealthDoc;

    // The runtime counts in-flight requests for every service through a tower
    // layer, so this needs no per-service instrumentation and a service with
    // no gauges at all means the layer stopped being applied.
    for (const service of doc.services) {
      assert.ok(
        Array.isArray(service.load),
        `${service.service} carries no load array`,
      );
      assert.ok(
        service.load.some((load) => load.name === "requests in flight"),
        `${service.service} reports no in-flight gauge - the runtime layer is not wrapping it`,
      );
    }
  });

  it("includes the gateway, which holds the queues that actually fill", async () => {
    // The gateway served no gRPC and so answered no health check, which left
    // the one process every client connects to - holding every control queue
    // and every audio buffer in the server - absent from the health page.
    const doc = JSON.parse(await fetchText("/starling/v1/health")) as HealthDoc;

    const gateway = doc.services.find((s) => s.service === "gateway");
    assert.ok(gateway, "the gateway is missing from the health overview");
    const control = gateway.load.find((load) => load.name.startsWith("control queue"));
    assert.ok(control, "the gateway reports no control-queue gauge");
    assert.ok(
      control.capacity > 0,
      "the control queue declares no capacity, so no percentage can be shown for it",
    );
  });

  it("carries the pressure aggregate a plot needs", async () => {
    const doc = JSON.parse(await fetchText("/starling/v1/health")) as HealthDoc;
    const sample = doc.history.at(-1);
    assert.ok(sample, "no history sample to read");

    // 0-100 and never above: a chart with a fixed axis draws nothing sensible
    // for 140%, and a percentage over a capacity that was lowered afterwards
    // can otherwise produce one.
    assert.ok(
      sample.busiest_percent >= 0 && sample.busiest_percent <= 100,
      `busiest_percent out of range: ${sample.busiest_percent}`,
    );
    assert.equal(typeof sample.rejected, "number", "no cumulative refusal count");
    assert.ok(sample.worst_latency_us >= 0, "no worst-latency figure");
  });

  it("does not dial services that serve no gRPC", async () => {
    const doc = JSON.parse(await fetchText("/starling/v1/health")) as HealthDoc;

    // `operator-api` speaks REST on `listen` and has no endpoint to dial. Its
    // liveness needs no row anyway: it served the document being read.
    const names = doc.services.map((s) => s.service);
    assert.ok(
      !names.includes("operator-api"),
      "`operator-api` has no gRPC surface, so a row for it can only ever say unreachable",
    );
    assert.ok(names.includes("voice"), "the sweep skipped a service that does serve gRPC");
  });
});
