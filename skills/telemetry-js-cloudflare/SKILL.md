---
name: telemetry-js-cloudflare
description: Cloudflare Workers instrumentation best practices for telemetry-js — instrument(), traceHandler(), per-isolate init, no Node http
---

<!-- Canonical source — keep in sync with the embedded CF block in skills/telemetry-js/SKILL.md -->

# telemetry-js — Cloudflare Workers instrumentation

## Import path

**Always import from `@tigorhutasuhut/telemetry-js/cloudflare`** — not the bare package name.

```ts
import { instrument, traceHandler, withTrace, initSDK } from "@tigorhutasuhut/telemetry-js/cloudflare";
```

The bare package `@tigorhutasuhut/telemetry-js` has no default export; there is no bare entry point. The `package.json` exports map exposes `./cloudflare` as the subpath for all Cloudflare APIs.

## Two entry points

| API | Use case |
|-----|----------|
| `instrument()` | Cloudflare Workers — wraps a full `ExportedHandler` (`fetch`, `scheduled`, `queue`) |
| `traceHandler()` | SvelteKit / Remix / Cloudflare Pages — per-request tracing when you have `Request` + `ExecutionContext` but not `ExportedHandler` |

Both automatically:
- Create a `SERVER` span with HTTP attributes for every request
- Extract incoming W3C Trace Context (`traceparent` / `tracestate`) from request headers
- Inject `traceparent` / `tracestate` into response headers
- Flush spans via `ctx.waitUntil` — never blocks the response
- Set `ERROR` span status on 5xx responses or thrown exceptions

## `instrument()` — Cloudflare Worker

Wraps the full `ExportedHandler`. Static config object or per-request factory function.

**Static config (simple):**

```ts
// src/index.ts
import { instrument } from "@tigorhutasuhut/telemetry-js/cloudflare";

export default instrument(
  {
    async fetch(request, env, ctx) {
      return new Response("Hello from Worker");
    },
    async scheduled(controller, env, ctx) {
      // cron job logic
    },
  },
  { serviceName: "my-worker", exporterEndpoint: "https://otel.example.com" },
);
```

**Factory form — secrets from `env` (preferred for tokens):**

```ts
import { instrument } from "@tigorhutasuhut/telemetry-js/cloudflare";

export default instrument(
  { async fetch(request, env, ctx) { return new Response("Hello"); } },
  (env, trigger) => ({
    serviceName: "my-worker",
    exporterEndpoint: env.OTEL_ENDPOINT,
    exporterHeaders: { Authorization: `Bearer ${env.OTEL_TOKEN}` },
  }),
);
```

## `traceHandler()` — SvelteKit / Pages

For frameworks that provide `Request` + `ExecutionContext` but not the full `ExportedHandler` pattern.

```ts
import { traceHandler } from "@tigorhutasuhut/telemetry-js/cloudflare";

// Inside SvelteKit hooks.server.ts
export const handle: Handle = async ({ event, resolve }) => {
  return traceHandler({
    serviceName: "my-sveltekit-app",
    context: event.platform?.ctx,
    env: event.platform?.env ?? {},
    request: event.request,
    handler: () => resolve(event),
  });
};
```

## Initialize once per isolate — NOT per request

Cloudflare Workers run in isolates that are reused across many requests. Initialize the SDK once at module scope or via a singleton, not inside the request handler.

```ts
// src/lib/server/telemetry.ts
import { initSDK, type SDKResult } from "@tigorhutasuhut/telemetry-js/cloudflare";

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

Then in `hooks.server.ts`:

```ts
import { traceHandler } from "@tigorhutasuhut/telemetry-js/cloudflare";
import { ensureTelemetry } from "$lib/server/telemetry";

export const handle: Handle = async ({ event, resolve }) => {
  const sdk = ensureTelemetry();

  return traceHandler({
    serviceName: "my-sveltekit-app",
    context: event.platform?.ctx,
    env: event.platform?.env ?? {},
    request: event.request,
    handler: () => resolve(event),
    onFlush: () => sdk.forceFlush(),
  });
};
```

## `withTrace()` — inner spans

Wrap any async/sync function in a child span. Span name is auto-detected from the function name.

```ts
import { withTrace } from "@tigorhutasuhut/telemetry-js/cloudflare";

const result = await withTrace(async function fetchUser(span) {
  span.setAttribute("user.id", userId);
  return db.query(userId);
});

// Explicit name + attributes
const data = withTrace(
  (span) => compute(span),
  { name: "heavy-computation", attributes: { "input.size": "42" } },
);
```

**Workers caveat:** `performance.now()` only advances after I/O (Spectre mitigation). `withTrace` on pure CPU work will report 0 ms duration. Use it for operations that involve at least one I/O call.

## SvelteKit on Cloudflare Pages — full setup

### 1. Type `App.Platform` in `src/app.d.ts`

```ts
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

### 2. Singleton init helper

See "Initialize once per isolate" above — create `src/lib/server/telemetry.ts` with `ensureTelemetry()`.

### 3. Server hook

Use `traceHandler` inside `handle`. Place telemetry first in `sequence()` so every downstream hook is inside the span:

```ts
import { sequence } from "@sveltejs/kit/hooks";
import { traceHandler } from "@tigorhutasuhut/telemetry-js/cloudflare";
import { ensureTelemetry } from "$lib/server/telemetry";

const telemetry: Handle = async ({ event, resolve }) => {
  const sdk = ensureTelemetry();
  return traceHandler({
    serviceName: "my-sveltekit-app",
    context: event.platform?.ctx,
    env: event.platform?.env ?? {},
    request: event.request,
    handler: () => resolve(event),
    onFlush: () => sdk.forceFlush(),
  });
};

const auth: Handle = async ({ event, resolve }) => {
  // auth logic
  return resolve(event);
};

export const handle = sequence(telemetry, auth);
```

## Rules

- Never import `http` or `https` from Node.js — Cloudflare Workers do not support them
- Never block the response waiting for span export — `ctx.waitUntil` handles flushing
- Initialize SDK once per isolate, not per request
- `initSDK` / `instrument` / `traceHandler` never throw — they return noop results on failure
- Use `@tigorhutasuhut/telemetry-js/context` for context propagation helpers
- Use `@tigorhutasuhut/telemetry-js/error` for error recording helpers
- Use `@tigorhutasuhut/telemetry-js/db` for database span helpers

## References

- Full Cloudflare usage reference: https://tigorlazuardi.github.io/telemetry-js/_llms-txt/cloudflare-usage.txt
- Full SDK reference (all runtimes): https://tigorlazuardi.github.io/telemetry-js/llms.txt
