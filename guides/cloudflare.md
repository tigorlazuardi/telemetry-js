# Cloudflare

`@tigorhutasuhut/telemetry-js` provides two entry points for tracing on Cloudflare:

| API | Use case |
|-----|----------|
| [`instrument()`](#instrument) | Cloudflare Workers (`ExportedHandler`) |
| [`traceHandler()`](#tracehandler) | SvelteKit, Remix, or any framework on Cloudflare Pages |

Both automatically:

- Create a `SERVER` span with HTTP attributes for every request
- Propagate W3C Trace Context (`traceparent` / `tracestate`) — incoming headers are extracted, and the response includes the outgoing headers
- Flush spans via `ctx.waitUntil` so they never block the response
- Set `ERROR` status on 5xx responses or thrown exceptions

---

## `instrument()`

Wraps a full Cloudflare Worker `ExportedHandler`. Supports `fetch`, `scheduled`, and `queue` handlers.

```ts
// src/index.ts (Cloudflare Worker)
import { instrument } from "@tigorhutasuhut/telemetry-js";

export default instrument({
  serviceName: "my-worker",
  exporterEndpoint: "https://otel.example.com",
  handler: {
    async fetch(request, env, ctx) {
      return new Response("Hello from Worker");
    },
    async scheduled(controller, env, ctx) {
      // cron job logic
    },
  },
});
```

### Configuration

`instrument()` accepts an [`InstrumentConfig`](../interfaces/InstrumentConfig.html) object:

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `serviceName` | `string` | Yes | OpenTelemetry service name |
| `handler` | `ExportedHandler` | Yes | The Worker handler to wrap |
| `exporterEndpoint` | `string` | No | OTLP HTTP endpoint base URL |
| `exporterHeaders` | `Record<string, string>` | No | Extra headers for the OTLP exporter (e.g. auth tokens) |
| `resourceAttributes` | `Record<string, string>` | No | Additional resource attributes |

---

## `traceHandler()`

A standalone function for frameworks that give you a `Request` + `ExecutionContext` but not the full `ExportedHandler` pattern — most commonly **SvelteKit on Cloudflare Pages**.

```ts
function traceHandler(
  ctx: ExecutionContext,
  request: Request,
  opts: TraceHandlerOptions,
): Promise<Response>;
```

### `TraceHandlerOptions`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `serviceName` | `string` | Yes | OpenTelemetry service name |
| `handler` | `() => Response \| Promise<Response>` | Yes | The handler to call inside the traced span |
| `onFlush` | `() => Promise<void>` | No | Called via `ctx.waitUntil` after the span ends (e.g. to flush the SDK) |

---

## SvelteKit on Cloudflare Pages

### 1. Install

```bash
pnpm add @tigorhutasuhut/telemetry-js
```

### 2. Set up `app.d.ts`

Ensure `App.Platform` is typed so `event.platform` has `env` and `ctx`:

```ts
// src/app.d.ts
declare global {
  namespace App {
    interface Platform {
      env: {
        // your KV / D1 / Durable Object bindings
      };
      ctx: ExecutionContext;
    }
  }
}

export {};
```

### 3. Initialize the SDK

Create a one-time SDK init helper. This should run once per isolate — not on every request.

```ts
// src/lib/server/telemetry.ts
import { initSDK, type SDKResult } from "@tigorhutasuhut/telemetry-js";

let sdk: SDKResult | null = null;

export function ensureTelemetry(): SDKResult {
  if (!sdk) {
    sdk = initSDK({
      serviceName: "my-sveltekit-app",
      runtime: "cloudflare-worker",
      exporterEndpoint: "https://otel.example.com",
    });
  }
  return sdk;
}
```

### 4. Add the server hook

```ts
// src/hooks.server.ts
import type { Handle } from "@sveltejs/kit";
import { traceHandler } from "@tigorhutasuhut/telemetry-js";
import { ensureTelemetry } from "$lib/server/telemetry";

export const handle: Handle = async ({ event, resolve }) => {
  const sdk = ensureTelemetry();

  return traceHandler(event.platform!.ctx, event.request, {
    serviceName: "my-sveltekit-app",
    handler: () => resolve(event),
    onFlush: () => sdk.forceFlush(),
  });
};
```

Every request now produces a span like:

```
GET /dashboard
  http.method   = GET
  http.url      = https://my-app.pages.dev/dashboard?tab=metrics
  http.target   = /dashboard?tab=metrics
  http.host     = my-app.pages.dev
  http.status_code = 200
```

The response will also carry `traceparent` and `tracestate` headers, allowing downstream services or browser clients to continue the trace.

### 5. (Optional) Combine with other hooks

If you use `sequence()` from `@sveltejs/kit/hooks`, place telemetry first so every downstream hook is inside the span:

```ts
// src/hooks.server.ts
import { sequence } from "@sveltejs/kit/hooks";
import type { Handle } from "@sveltejs/kit";
import { traceHandler } from "@tigorhutasuhut/telemetry-js";
import { ensureTelemetry } from "$lib/server/telemetry";

const telemetry: Handle = async ({ event, resolve }) => {
  const sdk = ensureTelemetry();

  return traceHandler(event.platform!.ctx, event.request, {
    serviceName: "my-sveltekit-app",
    handler: () => resolve(event),
    onFlush: () => sdk.forceFlush(),
  });
};

const auth: Handle = async ({ event, resolve }) => {
  // auth logic ...
  return resolve(event);
};

export const handle = sequence(telemetry, auth);
```

---

## Trace Context Propagation

Both `instrument()` and `traceHandler()` support W3C Trace Context propagation out of the box.

**Incoming:** If the request contains a `traceparent` header (and optionally `tracestate`), the created span will be a child of that remote trace. This lets you correlate traces across services — for example, a frontend → API gateway → SvelteKit app.

**Outgoing:** The response will have `traceparent` and `tracestate` headers injected automatically, so the caller can see which span handled their request.

No additional configuration is required — the SDK registers `W3CTraceContextPropagator` and `W3CBaggagePropagator` globally during initialization.
