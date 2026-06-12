---
title: traceHandler — Non-Standard Entrypoints
description: Use traceHandler to wrap a single request with a traced span for frameworks like SvelteKit that don't use the standard ExportedHandler pattern.
---

For frameworks like SvelteKit on Cloudflare that don't use the standard `ExportedHandler` pattern, use `traceHandler` directly. It wraps a single request with a traced span and handles SDK initialization, W3C trace context propagation, automatic HTTP request/response logging, and flushing.

## SvelteKit (`src/hooks.server.ts`)

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

## Automatic HTTP Logging

`traceHandler` logs every HTTP request/response by default (`logger: true`). Logs include:

- Request method, path, query, headers, body (if loggable content type)
- Response status, headers, body, size, duration
- Log level: `info` for 2xx-3xx, `warn` for 4xx, `error` for 5xx

Logs are emitted **inside the span context**, so they include `span_id` and `trace_id` for correlation in your observability backend.
