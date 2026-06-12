---
title: Cloudflare Workers
description: Using telemetry-js on Cloudflare Workers
sidebar:
  order: 3
---

`@tigorhutasuhut/telemetry-js/cloudflare` provides full OpenTelemetry tracing for Cloudflare Workers using **fetch-based OTLP exporters** — no Node.js `http`/`https` modules required (and they are not available in Workers, even with `nodejs_compat`).

## Setup

Install the package:

```bash
pnpm add @tigorhutasuhut/telemetry-js
```

Import from the Cloudflare subpath:

```ts
import { instrument, traceHandler } from "@tigorhutasuhut/telemetry-js/cloudflare";
```

The subpath only bundles Cloudflare-specific adapter code — other runtimes are tree-shaken out entirely.

## Recommended API

The recommended API surface is **`instrument`** and **`traceHandler`**.

| API | Use case |
|-----|----------|
| `instrument()` | Standard Cloudflare Workers (`ExportedHandler`) — recommended for most Workers |
| `traceHandler()` | Frameworks that expose `Request` + `ExecutionContext` directly (SvelteKit, Hono on Pages, Remix) |

Both automatically:

- Create a `SERVER` span with HTTP attributes for every request
- Extract incoming W3C `traceparent` / `tracestate` headers and propagate to outgoing responses
- Flush spans via `ctx.waitUntil` so telemetry never blocks the response
- Set `ERROR` span status on 5xx responses or thrown exceptions
- Monkey-patch `globalThis.fetch` so outgoing fetch calls are traced

### `instrument()`

Wraps a full `ExportedHandler`. Pass your handler object as the first argument and SDK config as the second:

```ts
instrument(handler: ExportedHandler, config: InstrumentOptions): ExportedHandler
```

Supports `fetch`, `scheduled`, and `queue` handlers on the same object.

### `traceHandler()`

A standalone function for frameworks that hand you a `Request` and `ExecutionContext` but do not use the `ExportedHandler` shape:

```ts
traceHandler<T>(opts: TraceHandlerOptions<T>): Promise<T>
```

`TraceHandlerOptions` extends all `InstrumentOptions` fields plus:

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `context` | `MinimalExecutionContext \| undefined` | Yes | Execution context (`waitUntil` required). Pass `undefined` during SSG/prerender. |
| `env` | `Record<string, string>` | Yes | Environment variable map forwarded to the SDK |
| `request` | `Request` | Yes | Incoming request to trace |
| `handler` | `() => T \| Promise<T>` | Yes | Handler to call inside the traced span |
| `logger` | `Logger \| boolean` | No | `true` (default): auto-log HTTP request/response. `false`: disable. |
| `sensitiveHeaders` | `string[]` | No | Header names to redact in logs (defaults: `authorization`, `cookie`, `set-cookie`) |
| `maxBodyLogSize` | `number` | No | Max bytes to log from request/response body (default: `32768`) |
| `onFlush` | `() => void` | No | Callback invoked via `ctx.waitUntil` after span ends |

When `handler` returns a `Response`, the SDK automatically sets `http.status_code`, marks 5xx as errors, and injects trace context into response headers.

## Fetch Monkey-Patching

`instrument()` and `traceHandler()` both automatically monkey-patch `globalThis.fetch` so outgoing fetch calls inside the Worker are traced as CLIENT spans with W3C `traceparent` header injection.

The fetch-based OTLP exporters use the **original unpatched fetch** internally to avoid infinite loops — telemetry export traffic is never self-traced.

If you need the original fetch directly (for example, to make an untraced export call manually):

```ts
import { getOriginalFetch } from "@tigorhutasuhut/telemetry-js/cloudflare";

const originalFetch = getOriginalFetch();
await originalFetch("https://otel.example.com/v1/traces", { ... });
```

## Endpoint Resolution

`process.env` is unavailable in Workers. Pass `env` explicitly:

```ts
import { instrument } from "@tigorhutasuhut/telemetry-js/cloudflare";

export default instrument(
  { async fetch(request, env, ctx) { /* ... */ } },
  {
    serviceName: "my-worker",
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: env.OTEL_ENDPOINT },
  },
);
```

The SDK resolves OTLP endpoints per signal using this priority (highest first):

1. `OTEL_EXPORTER_OTLP_{SIGNAL}_ENDPOINT` in `env` (full URL)
2. `OTEL_EXPORTER_OTLP_ENDPOINT` in `env` + `/v1/{signal}`
3. `config.{signal}ExporterEndpoint` (full URL)
4. `config.exporterEndpoint` + `/v1/{signal}`

## Example

### Standard Worker with `instrument()`

The recommended pattern for most Workers:

```ts
// src/index.ts
import { instrument } from "@tigorhutasuhut/telemetry-js/cloudflare";

export default instrument(
  {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);

      if (url.pathname === "/api/hello") {
        const data = await fetch("https://api.example.com/data");
        const json = await data.json();
        return Response.json(json);
      }

      return new Response("Not Found", { status: 404 });
    },

    async scheduled(controller, env, ctx) {
      // Cron job — also traced automatically
      await fetch("https://api.example.com/refresh-cache");
    },
  },
  {
    serviceName: "my-worker",
    exporterEndpoint: "https://otel.example.com",
    exporterHeaders: { Authorization: "Bearer YOUR_TOKEN" },
    resourceAttributes: {
      "deployment.environment.name": "production",
      "service.namespace": "my-team",
    },
  },
);
```

The inner `fetch("https://api.example.com/data")` call is traced as a CLIENT span — W3C `traceparent` is injected automatically. Telemetry is flushed via `ctx.waitUntil` after the response is sent.

### SvelteKit on Cloudflare Pages with `traceHandler()`

```ts
// src/hooks.server.ts
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

Every request produces a span with `http.method`, `http.url`, `http.status_code`, and `trace_id` / `span_id` for log correlation. The response carries `traceparent` / `tracestate` headers automatically.

### Manual Span Creation with `withTrace`

`withTrace` is re-exported from the Cloudflare subpath:

```ts
import { instrument, withTrace } from "@tigorhutasuhut/telemetry-js/cloudflare";

export default instrument(
  {
    async fetch(request, env, ctx) {
      const result = await withTrace(async function processRequest(span) {
        span.setAttribute("request.path", new URL(request.url).pathname);
        const data = await fetch("https://api.example.com/items");
        return data.json();
      });

      return Response.json(result);
    },
  },
  {
    serviceName: "my-worker",
    exporterEndpoint: "https://otel.example.com",
  },
);
```

## Fetch-Based Exporters

The Cloudflare subpath ships custom fetch-based OTLP exporters instead of the standard `@opentelemetry/exporter-*-otlp-http` packages (which depend on Node.js `http`/`https` modules). These are available for direct use if needed:

```ts
import {
  FetchTraceExporter,
  FetchLogExporter,
  FetchMetricExporter,
} from "@tigorhutasuhut/telemetry-js/cloudflare";
```

For most use cases, `instrument()` and `traceHandler()` wire these up automatically — direct access is only needed for custom provider setups.
