---
title: Bun
description: Using telemetry-js on Bun
sidebar:
  order: 2
---

Bun is compatible with the Node.js subpath export. Use `@tigorhutasuhut/telemetry-js/node` — the same OTel HTTP exporters that work on Node.js work on Bun without any changes.

## Setup

### Install

```bash
bun add @tigorhutasuhut/telemetry-js
```

Optionally install [pino](https://github.com/pinojs/pino) for structured JSON logging to stderr. Pino is an optional peer dependency — the SDK falls back to a built-in JSON formatter if it is not installed.

```bash
bun add pino
```

### Import

Use the `/node` subpath:

```ts
import { initSDK, withTrace, traceHandler, logger, metrics } from "@tigorhutasuhut/telemetry-js/node";
```

Bun's runtime is compatible with Node.js-style OTel HTTP exporters, so the `/node` subpath works without polyfills or shimming.

### Recommended API

The recommended API surface on Bun is identical to Node.js:

| Export | Purpose |
| --- | --- |
| `initSDK` | Initialize tracing, metrics, and logging in one call — **recommended** entry point |
| `withTrace` | Wrap a function in a named OTel span |
| `traceHandler` | Trace a single HTTP request — recommended for custom server frameworks |
| `logger` | Structured logger with OTLP + stderr dual output |
| `metrics` | Access the global `MeterProvider` for custom metrics |

Call `initSDK` once at startup. It is recommended to do this before any route or handler setup so the `TracerProvider` is registered before requests arrive.

```ts
import { initSDK } from "@tigorhutasuhut/telemetry-js/node";

const sdk = initSDK({
  serviceName: "my-bun-api",
  exporterEndpoint: "https://otel.example.com",
});

// Graceful shutdown
process.on("SIGTERM", () => sdk.shutdown());
```

### Environment Variables

Endpoints can also be configured via env vars — the SDK resolves per-signal endpoints using this priority:

1. `OTEL_EXPORTER_OTLP_{SIGNAL}_ENDPOINT`
2. `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/{signal}`
3. `config.{signal}ExporterEndpoint`
4. `config.exporterEndpoint` + `/v1/{signal}`

```env
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.com
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production,service.namespace=my-team
```

## Example

A complete runnable `Bun.serve` server with `traceHandler` for per-request tracing:

```ts
import { initSDK, traceHandler, withTrace, metrics } from "@tigorhutasuhut/telemetry-js/node";

const sdk = initSDK({
  serviceName: "my-bun-api",
  exporterEndpoint: "https://otel.example.com",
  metricsExportIntervalMs: 30_000,
});

const meter = metrics.getMeter("my-bun-api");
const requestCounter = meter.createCounter("http.requests");

Bun.serve({
  port: 3000,
  async fetch(request) {
    return traceHandler({
      serviceName: "my-bun-api",
      exporterEndpoint: "https://otel.example.com",
      request,
      handler: async () => {
        requestCounter.add(1, { method: request.method });

        const url = new URL(request.url);

        if (url.pathname === "/users") {
          const users = await withTrace(async function fetchUsers(span) {
            span.setAttribute("db.system", "postgres");
            // replace with real DB call
            return [{ id: 1, name: "Alice" }];
          });

          sdk.logger.info("users fetched", { count: users.length });

          return Response.json(users);
        }

        return new Response("Not Found", { status: 404 });
      },
    });
  },
});

sdk.logger.info("server started", { port: 3000 });

process.on("SIGTERM", () => sdk.shutdown());
```

`traceHandler` handles W3C `traceparent`/`tracestate` propagation from incoming headers, sets `http.status_code` on the span, marks 5xx responses as errors, and logs request/response details automatically.
