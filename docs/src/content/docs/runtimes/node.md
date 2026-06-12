---
title: Node.js
description: Using telemetry-js on Node.js
sidebar:
  order: 1
---

## Setup

Install the package and the optional pino peer dependency for structured JSON logging:

```bash
pnpm add @tigorhutasuhut/telemetry-js
pnpm add pino
```

Pino is optional. Without it the SDK falls back to a built-in JSON formatter writing to stderr.

Import from the `/node` subpath. This subpath bundles only the Node.js adapter (OTel HTTP exporters). Other runtimes are never pulled in.

```ts
import { initSDK } from "@tigorhutasuhut/telemetry-js/node";
```

## Recommended API

These are the recommended entry points for Node.js applications:

| Export | Description |
| --- | --- |
| `initSDK` | Initialize tracing, metrics, and logging in one call. Returns an `SDKResult` — never throws. |
| `withTrace` | Wrap any async or sync function in an OpenTelemetry span. |
| `traceHandler` | Trace a single request/handler with automatic HTTP logging and flush. |
| `logger` | Structured logger with dual output: stderr (pino / built-in) and OTLP log records. |
| `metrics` | OTel `MeterProvider` accessor — create meters and instruments after `initSDK`. |

## `initSDK`

`initSDK` wires up tracing, metrics, and logging for Node.js. It **never throws** — on any failure it returns a noop result so your application continues running.

```ts
const sdk = initSDK({
  serviceName: "my-api",
  exporterEndpoint: "https://otel.example.com",
});
```

### Configuration options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `serviceName` | `string` | `"unknown"` | Logical service name attached to every span |
| `exporterEndpoint` | `string` | — | Base OTLP endpoint; SDK appends `/v1/{signal}` |
| `exporterHeaders` | `Record<string, string>` | — | Headers for OTLP requests (e.g. auth tokens) |
| `resourceAttributes` | `Record<string, string>` | — | Extra OTel Resource attributes |
| `tracesExporterEndpoint` | `string` | — | Signal-specific traces endpoint (full URL) |
| `logsExporterEndpoint` | `string` | — | Signal-specific logs endpoint (full URL) |
| `metricsExporterEndpoint` | `string` | — | Signal-specific metrics endpoint (full URL) |
| `metricsExportIntervalMs` | `number` | `60000` | Metrics collection interval in milliseconds |
| `instrumentations` | `unknown[]` | `[]` | OpenTelemetry instrumentations (Node only) |

### Endpoint resolution

The SDK resolves endpoints per signal using this priority (highest first):

1. `OTEL_EXPORTER_OTLP_{SIGNAL}_ENDPOINT` env var (full URL)
2. `OTEL_EXPORTER_OTLP_ENDPOINT` env var + `/v1/{signal}`
3. `config.{signal}ExporterEndpoint` (full URL)
4. `config.exporterEndpoint` + `/v1/{signal}`

If no endpoint resolves for a signal, that signal is disabled.

### SDK result

`initSDK` returns an object with:

- `logger` — structured logger (see [Logger](#logger))
- `shutdown()` — flushes and shuts down all providers; call on process exit

### Graceful shutdown

Register a `SIGTERM` handler to flush spans, metrics, and logs before the process exits:

```ts
process.on("SIGTERM", () => sdk.shutdown());
```

### Resource validation

The SDK validates OTel resource attributes and warns on missing ones:

| Attribute | Status | Fallback |
| --- | --- | --- |
| `service.name` | Required | Warns if missing or `unknown_service` |
| `deployment.environment.name` | Recommended | Auto-set to `"local"` when stderr is a TTY |
| `service.namespace` | Recommended | Auto-set to `"local"` when stderr is a TTY |

Set these via environment variable or config:

```env
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production,service.namespace=my-team
```

## `withTrace`

Wraps a function in an OpenTelemetry span. The span name is auto-detected from the function name; override with `opts.name`.

```ts
import { withTrace } from "@tigorhutasuhut/telemetry-js/node";

const user = await withTrace(async function fetchUser(span) {
  span.setAttribute("user.id", id);
  return db.users.find(id);
});
```

### Options

| Option | Type | Description |
| --- | --- | --- |
| `name` | `string` | Override auto-detected span name |
| `kind` | `SpanKind` | Span kind (default: `INTERNAL`) |
| `attributes` | `Record<string, string>` | Initial span attributes |
| `component` | `string` | Prefix span name with component (also sets `ui.component`) |
| `parent` | `Span \| string` | Parent span or W3C `traceparent` string |
| `carrier` | `unknown` | Opaque carrier for textmap propagation |
| `signal` | `AbortSignal` | AbortSignal propagated through OTel context |

## `traceHandler`

Traces a single handler invocation with automatic HTTP request/response logging and provider flush. Useful for non-standard entrypoints (e.g. custom HTTP servers, job runners).

```ts
import { traceHandler } from "@tigorhutasuhut/telemetry-js/node";

const result = await traceHandler({
  serviceName: "my-api",
  exporterEndpoint: "https://otel.example.com",
  request: incomingRequest,
  handler: () => handleRequest(incomingRequest),
});
```

HTTP logging is on by default (`logger: true`). Logs include method, path, headers, body, response status, duration, and are emitted inside the span context for automatic trace correlation.

## Logger

Every `SDKResult` exposes a structured `logger`:

- **stderr** — pino (if installed) or built-in JSON formatter
- **OTLP** — emits log records to the configured logs endpoint

```ts
const { logger } = initSDK({ ... });

logger.info("server started", { port: 3000 });
logger.warn("slow query", { duration_ms: 420 });
logger.error("connection refused", { host: "db.example.com" });
```

Log-trace correlation is automatic — `traceId` and `spanId` from the active span are included in every log record.

## Metrics

Metrics are enabled when a metrics endpoint resolves. Use the `metrics` export to get a meter after `initSDK`:

```ts
import { initSDK, metrics } from "@tigorhutasuhut/telemetry-js/node";

const sdk = initSDK({
  serviceName: "my-api",
  exporterEndpoint: "https://otel.example.com",
  metricsExportIntervalMs: 30_000,
});

const meter = metrics.getMeter("my-api");
const requestCounter = meter.createCounter("http.requests");
requestCounter.add(1, { method: "GET", route: "/api/users" });
```

## Example

Complete runnable example with `initSDK`, `withTrace`, `traceHandler`, logger, and graceful shutdown:

```ts
import { initSDK, withTrace, traceHandler, metrics } from "@tigorhutasuhut/telemetry-js/node";

// Initialize the SDK. Never throws — on failure returns a noop result.
const sdk = initSDK({
  serviceName: "my-api",
  exporterEndpoint: "https://otel.example.com",
  resourceAttributes: {
    "deployment.environment.name": process.env.NODE_ENV ?? "local",
    "service.namespace": "my-team",
  },
  metricsExportIntervalMs: 30_000,
});

const { logger } = sdk;

// Metrics
const meter = metrics.getMeter("my-api");
const requestCounter = meter.createCounter("http.requests");

// Span wrapping a business operation
async function getUser(id: string) {
  return withTrace(async function fetchUser(span) {
    span.setAttribute("user.id", id);
    // db call here
    return { id, name: "Alice" };
  });
}

// Handler traced with automatic HTTP logging
async function handleRequest(req: Request): Promise<Response> {
  return traceHandler({
    serviceName: "my-api",
    exporterEndpoint: "https://otel.example.com",
    request: req,
    handler: async () => {
      requestCounter.add(1, { method: req.method });

      const url = new URL(req.url);
      const id = url.searchParams.get("id") ?? "unknown";
      const user = await getUser(id);

      logger.info("user fetched", { userId: user.id });
      return new Response(JSON.stringify(user), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
}

// Graceful shutdown — flush spans, metrics, and logs before exit
process.on("SIGTERM", async () => {
  logger.info("shutting down");
  await sdk.shutdown();
  process.exit(0);
});

logger.info("server started", { port: 3000 });
```
