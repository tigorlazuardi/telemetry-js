# @tigorhutasuhut/telemetry-js

OpenTelemetry SDK setup abstraction for multiple runtimes. Initialise tracing, metrics, and logging with a single function call — the library wires up the correct providers, exporters, and processors for your target runtime.

Each runtime has its own subpath export so bundlers can **tree-shake** unused runtimes completely.

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

## Subpath Exports

Import from the subpath that matches your runtime. Each subpath only bundles the adapter code for that runtime — the others are never pulled in.

| Subpath | Runtime | Exporters |
| --- | --- | --- |
| `@tigorhutasuhut/telemetry-js/cloudflare` | Cloudflare Workers | Fetch-based (browser-native) |
| `@tigorhutasuhut/telemetry-js/node` | Node.js / Bun | OTel HTTP (`@opentelemetry/exporter-*-otlp-http`) |
| `@tigorhutasuhut/telemetry-js/browser` | Browser (Vite, etc.) | Fetch-based (browser-native) |

> **Breaking change (v1.0.0):** The root import `@tigorhutasuhut/telemetry-js` is removed. Use a runtime-specific subpath instead.

## Quick Start — Node.js

```ts
import { initSDK } from "@tigorhutasuhut/telemetry-js/node";

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
import { instrument } from "@tigorhutasuhut/telemetry-js/cloudflare";

export default instrument(
  {
    async fetch(request, env, ctx) {
      return new Response("Hello from Workers!");
    },
  },
  {
    serviceName: "my-worker",
    exporterEndpoint: "https://otel.example.com",
  },
);
```

Cloudflare Workers use fetch-based OTLP exporters that bypass Node.js `http`/`https` modules (which aren't available in Workers, even with `nodejs_compat`).

`globalThis.fetch` is automatically monkey-patched by `instrument()` / `traceHandler()` so outgoing fetch calls are traced. The exporters use the **original unpatched** fetch internally to avoid infinite loops.

## Quick Start — Browser

```ts
import { initSDK } from "@tigorhutasuhut/telemetry-js/browser";

const sdk = initSDK({
  serviceName: import.meta.env.VITE_OTEL_SERVICE_NAME,
  exporterEndpoint: import.meta.env.VITE_OTEL_EXPORTER_OTLP_ENDPOINT,
  resourceAttributes: {
    "deployment.environment.name": import.meta.env.VITE_OTEL_DEPLOYMENT_ENV,
    "service.namespace": import.meta.env.VITE_OTEL_SERVICE_NAMESPACE,
  },
});
```

Vite replaces `import.meta.env.VITE_*` with string literals at build time, so these values are baked into the bundle — no runtime env lookup needed.

Define the variables in your `.env` file:

```env
VITE_OTEL_SERVICE_NAME=my-spa
VITE_OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.com
VITE_OTEL_DEPLOYMENT_ENV=production
VITE_OTEL_SERVICE_NAMESPACE=my-team
```

## `traceHandler` — Non-Standard Entrypoints

For frameworks like SvelteKit on Cloudflare that don't use the standard `ExportedHandler` pattern, use `traceHandler` directly. It wraps a single request with a traced span and handles SDK initialization, W3C trace context propagation, automatic HTTP request/response logging, and flushing.

### SvelteKit (`src/hooks.server.ts`)

```ts
import { traceHandler } from "@tigorhutasuhut/telemetry-js/cloudflare";
import type { Handle } from "@sveltejs/kit";

export const handle: Handle = async ({ event, resolve }) => {
  return traceHandler({
    serviceName: "my-sveltekit-app",
    exporterEndpoint: "https://otel.example.com",
    context: event.platform?.ctx,
    env: event.platform?.env ?? {},
    request: event.request,
    handler: () => resolve(event),
  });
};
```

`traceHandler` accepts all `InstrumentOptions` (same as `instrument()`) plus:

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `context` | `MinimalExecutionContext \| undefined` | Yes | Execution context (only `waitUntil` is required). Pass `undefined` during SSG/prerender. |
| `env` | `Record<string, string>` | Yes | Environment variable map forwarded to the SDK |
| `request` | `Request` | Yes | The incoming request to trace |
| `handler` | `() => T \| Promise<T>` | Yes | The handler to call inside the traced span |
| `logger` | `Logger \| boolean` | No | `true` (default): auto-log HTTP request/response. `false`: disable. `Logger`: use custom logger. |
| `sensitiveHeaders` | `string[]` | No | Header names to redact in logs (defaults: `authorization`, `cookie`, `set-cookie`). |
| `maxBodyLogSize` | `number` | No | Max bytes to log from request/response body (default: `32768`). |
| `onFlush` | `() => void` | No | Callback invoked via `ctx.waitUntil` after span ends |

The return type matches whatever `handler` returns. When `handler` returns a `Response`, the SDK automatically sets `http.status_code`, marks 5xx as errors, and injects trace context into response headers.

### Automatic HTTP Logging

`traceHandler` logs every HTTP request/response by default (`logger: true`). Logs include:

- Request method, path, query, headers, body (if loggable content type)
- Response status, headers, body, size, duration
- Log level: `info` for 2xx-3xx, `warn` for 4xx, `error` for 5xx

Logs are emitted **inside the span context**, so they include `span_id` and `trace_id` for correlation in your observability backend.

## Endpoint Resolution

The SDK resolves OTLP endpoints per signal (`traces`, `metrics`, `logs`) using this priority (highest first):

1. `OTEL_EXPORTER_OTLP_{SIGNAL}_ENDPOINT` env var (full URL)
2. `OTEL_EXPORTER_OTLP_ENDPOINT` env var + `/v1/{signal}`
3. `config.{signal}ExporterEndpoint` (full URL)
4. `config.exporterEndpoint` + `/v1/{signal}`

If no endpoint resolves for a signal, that signal is disabled.

URLs without a protocol are normalized with `https://`. Trailing slashes are stripped.

```ts
import { initSDK } from "@tigorhutasuhut/telemetry-js/node";

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
import { initSDK } from "@tigorhutasuhut/telemetry-js/cloudflare";

initSDK({
  serviceName: "my-worker",
  env: { OTEL_EXPORTER_OTLP_ENDPOINT: env.OTEL_ENDPOINT },
});
```

## Logger

Every `SDKResult` includes a structured `logger` with dual output:

- **stderr** — pino (if installed), built-in JSON formatter, or `console[level]` (Cloudflare / Browser)
- **OTLP** — emits log records via the global `LoggerProvider` when a logs endpoint resolves

```ts
import { initSDK } from "@tigorhutasuhut/telemetry-js/node";

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
import { initSDK, metrics } from "@tigorhutasuhut/telemetry-js/node";

const sdk = initSDK({
  serviceName: "my-api",
  exporterEndpoint: "https://otel.example.com",
  metricsExportIntervalMs: 30_000,
});

const meter = metrics.getMeter("my-api");
const counter = meter.createCounter("http.requests");
counter.add(1, { method: "GET" });
```

## Fetch-Based Exporters

Cloudflare Workers and browser subpaths use custom fetch-based OTLP exporters instead of the standard `@opentelemetry/exporter-*-otlp-http` packages (which depend on Node.js `http`/`https` modules).

These exporters are also available for direct use:

```ts
import {
  FetchTraceExporter,
  FetchLogExporter,
  FetchMetricExporter,
} from "@tigorhutasuhut/telemetry-js/cloudflare";
```

The log exporter applies a monotonic timestamp bump (+1ms) when multiple log records in the same batch share the same millisecond timestamp, preserving ordering at the collector.

## Configuration Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `serviceName` | `string` | `"unknown"` | Logical service name in every span |
| `exporterEndpoint` | `string` | — | Base OTLP endpoint; SDK appends `/v1/{signal}` |
| `exporterHeaders` | `Record<string, string>` | — | Headers for OTLP requests (e.g. auth) |
| `resourceAttributes` | `Record<string, string>` | — | Extra Resource attributes |
| `tracesExporterEndpoint` | `string` | — | Signal-specific traces endpoint (full URL) |
| `logsExporterEndpoint` | `string` | — | Signal-specific logs endpoint (full URL) |
| `metricsExporterEndpoint` | `string` | — | Signal-specific metrics endpoint (full URL) |
| `metricsExportIntervalMs` | `number` | `60000` | Metrics collection interval (ms) |
| `instrumentations` | `unknown[]` | `[]` | OpenTelemetry instrumentations (Node only) |
| `env` | `Record<string, unknown>` | `process.env` | Env var map (for Cloudflare Workers) |

## Resource Validation

The SDK validates the OpenTelemetry `Resource` and emits warnings for missing attributes:

| Attribute | Required | Fallback |
| --- | --- | --- |
| `service.name` | Yes | Warns if missing or `unknown_service` |
| `deployment.environment.name` | Recommended | Auto-set to `"local"` when stderr is a TTY |
| `service.namespace` | Recommended | Auto-set to `"local"` when stderr is a TTY |

Set these via `OTEL_RESOURCE_ATTRIBUTES` or `config.resourceAttributes`:

```env
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production,service.namespace=my-team
```

## `instrumentFetch`

> **Note:** You do NOT need to call `instrumentFetch` manually in most cases.
> - **Node.js**: Use auto-instrumentation packages like `@opentelemetry/instrumentation-http`.
> - **Cloudflare Workers**: `instrument()` and `traceHandler()` automatically monkey-patch `globalThis.fetch`.

For manual use in other runtimes:

```ts
import { instrumentFetch } from "@tigorhutasuhut/telemetry-js/cloudflare";

instrumentFetch(); // Patches globalThis.fetch
```

Use `getOriginalFetch()` to access the unpatched fetch (e.g. for OTLP export calls that should not be traced):

```ts
import { getOriginalFetch } from "@tigorhutasuhut/telemetry-js/cloudflare";

const originalFetch = getOriginalFetch();
await originalFetch("https://otel.example.com/v1/traces", { ... });
```

## License

[Apache-2.0](LICENSE)
