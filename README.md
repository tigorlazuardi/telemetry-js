# @tigorhutasuhut/telemetry-js

**EXPERIMENTAL** - This library is under active development with minimal test coverage. It is intended for personal use and the API may change without notice.

---

OpenTelemetry SDK setup abstraction for multiple runtimes. Initialise tracing, metrics, and logging with a single function call — the library auto-detects your runtime and wires up the correct providers, exporters, and processors.

The SDK **never throws** — on any failure it returns a noop result so your application keeps running.

## API Reference

Full auto-generated API docs are available on [GitHub Pages](https://tigorlazuardi.github.io/telemetry-js/).

## Install

```bash
pnpm add @tigorhutasuhut/telemetry-js
```

On Node.js (or compatible runtimes like Bun), install [pino](https://github.com/pinojs/pino) for structured JSON logging to stderr:

```bash
pnpm add pino
```

Pino is an optional peer dependency — the SDK falls back to a built-in formatter if pino is not installed.

## Quick Start — Node.js

```ts
import { initSDK } from "@tigorhutasuhut/telemetry-js";

const sdk = initSDK({
  serviceName: "my-api",
  exporterEndpoint: "https://otel.example.com",
});

sdk.logger.info("server started", { port: 3000 });

// Graceful shutdown
process.on("SIGTERM", () => sdk.shutdown());
```

## Quick Start — Cloudflare Workers

```ts
import { instrument } from "@tigorhutasuhut/telemetry-js";

export default instrument({
  async fetch(request, env, ctx) {
    return new Response("Hello from Workers!");
  },
}, {
  serviceName: "my-worker",
  exporterEndpoint: "https://otel.example.com",
});
```

## `traceHandler` — Non-Standard Entrypoints

For frameworks like SvelteKit on Cloudflare that don't use the standard `ExportedHandler` pattern, use `traceHandler` directly. It wraps a single request with a traced span and handles SDK initialization, W3C trace context propagation, and flushing.

### SvelteKit (`src/hooks.server.ts`)

```ts
import { traceHandler } from "@tigorhutasuhut/telemetry-js";
import type { Handle } from "@sveltejs/kit";

export const handle: Handle = async ({ event, resolve }) => {
  return traceHandler({
    serviceName: "my-sveltekit-app",
    exporterEndpoint: "https://otel.example.com",
    context: event.platform!.ctx,
    env: event.platform!.env,
    request: event.request,
    handler: () => resolve(event),
  });
};
```

`traceHandler` accepts all `InstrumentOptions` (same as `instrument()`) plus:

| Option    | Type                      | Required | Description                                          |
| --------- | ------------------------- | -------- | ---------------------------------------------------- |
| `context` | `MinimalExecutionContext` | Yes      | Execution context (only `waitUntil` is required)     |
| `env`     | `Record<string, string>`  | Yes      | Environment variable map forwarded to the SDK        |
| `request` | `Request`                 | Yes      | The incoming request to trace                        |
| `handler` | `() => T \| Promise<T>`  | Yes      | The handler to call inside the traced span           |
| `onFlush` | `() => void`              | No       | Callback invoked via `ctx.waitUntil` after span ends |

The return type matches whatever `handler` returns. When `handler` returns a `Response`, the SDK automatically sets `http.status_code`, marks 5xx as errors, and injects trace context into response headers.

## Endpoint Resolution

The SDK resolves OTLP endpoints per signal (`traces`, `metrics`, `logs`) using this priority (highest first):

1. `OTEL_EXPORTER_OTLP_{SIGNAL}_ENDPOINT` env var (full URL)
2. `OTEL_EXPORTER_OTLP_ENDPOINT` env var + `/v1/{signal}`
3. `config.{signal}ExporterEndpoint` (full URL)
4. `config.exporterEndpoint` + `/v1/{signal}`

If no endpoint resolves for a signal, that signal is disabled.

URLs without a protocol are normalized with `https://`. Trailing slashes are stripped.

```ts
const sdk = initSDK({
  serviceName: "my-api",
  // Base endpoint — SDK appends /v1/traces, /v1/metrics, /v1/logs
  exporterEndpoint: "https://otel.example.com",
  // Or override per signal:
  tracesExporterEndpoint: "https://traces.example.com/v1/traces",
  logsExporterEndpoint: "https://logs.example.com/v1/logs",
});
```

For Cloudflare Workers where `process.env` is unavailable, pass `env`:

```ts
initSDK({
  serviceName: "my-worker",
  env: { OTEL_EXPORTER_OTLP_ENDPOINT: env.OTEL_ENDPOINT },
});
```

## Logger

Every `SDKResult` includes a structured `logger` with dual output:

- **stderr** — pino (if installed), built-in JSON formatter, or `console[level]` (Cloudflare)
- **OTLP** — emits log records via the global `LoggerProvider` when a logs endpoint resolves

```ts
const { logger } = initSDK({
  serviceName: "my-api",
  exporterEndpoint: "https://otel.example.com",
});

logger.info("request handled", { method: "GET", path: "/api/users" });
logger.error("database connection failed", { host: "db.example.com" });
logger.debug("cache miss", { key: "user:123" }, { timestamp: Date.now() });
```

Log-trace correlation is automatic — `traceId` and `spanId` from the active span are included in every log record.

## Metrics

Metrics are enabled automatically when a metrics endpoint resolves:

```ts
import { initSDK, metrics } from "@tigorhutasuhut/telemetry-js";

const sdk = initSDK({
  serviceName: "my-api",
  exporterEndpoint: "https://otel.example.com",
  metricsExportIntervalMs: 30_000,
});

const meter = metrics.getMeter("my-api");
const counter = meter.createCounter("http.requests");
counter.add(1, { method: "GET" });
```

## Configuration Options

| Option                    | Type                     | Default        | Description                                    |
| ------------------------- | ------------------------ | -------------- | ---------------------------------------------- |
| `serviceName`             | `string`                 | `"unknown"`    | Logical service name in every span             |
| `runtime`                 | `RuntimeName`            | auto-detect    | `"node"`, `"cloudflare-worker"`, or custom     |
| `exporterEndpoint`        | `string`                 | —              | Base OTLP endpoint; SDK appends `/v1/{signal}` |
| `exporterHeaders`         | `Record<string, string>` | —              | Headers for OTLP requests (e.g. auth)          |
| `resourceAttributes`      | `Record<string, string>` | —              | Extra Resource attributes                      |
| `tracesExporterEndpoint`  | `string`                 | —              | Signal-specific traces endpoint (full URL)     |
| `logsExporterEndpoint`    | `string`                 | —              | Signal-specific logs endpoint (full URL)       |
| `metricsExporterEndpoint` | `string`                 | —              | Signal-specific metrics endpoint (full URL)    |
| `metricsExportIntervalMs` | `number`                 | `60000`        | Metrics collection interval (ms)               |
| `instrumentations`        | `unknown[]`              | `[]`           | OpenTelemetry instrumentations (Node only)     |
| `env`                     | `Record<string, string>` | `process.env`  | Env var map (for Cloudflare Workers)           |

## Custom Runtime Adapters

Register a custom adapter for runtimes that aren't built-in:

```ts
import { register, initSDK, noopLogger } from "@tigorhutasuhut/telemetry-js";
import type { RuntimeAdapter } from "@tigorhutasuhut/telemetry-js";

const denoAdapter: RuntimeAdapter = {
  name: "deno",
  detect: () => "Deno" in globalThis,
  setup(config) {
    // Return { provider, logger, shutdown, forceFlush } ...
  },
};

register(denoAdapter);

const sdk = initSDK({ serviceName: "deno-app" });
```

## License

[Apache-2.0](LICENSE)
