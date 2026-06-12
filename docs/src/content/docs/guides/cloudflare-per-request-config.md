---
title: Per-request config (ResolveConfigFn)
description: Use a factory function to resolve SDK config from request-time env bindings and secrets — required on Cloudflare Workers where secrets only exist inside a handler.
---

On Cloudflare Workers, secrets and KV/binding references live in the `env` object passed to each handler. They are **not** available at module load time, so a static config object cannot reference them.

`instrument()` and `traceHandler()` both accept a **factory function** as an alternative to a plain config object. The factory receives the live `env` and the event `trigger` and returns the `InstrumentOptions` used for that invocation.

## Object form (unchanged)

The original object form continues to work exactly as before — zero breaking change:

```ts
import { instrument } from "@tigorhutasuhut/telemetry-js/cloudflare";

export default instrument(
  { async fetch(req, env, ctx) { return new Response("hi"); } },
  {
    serviceName: "my-worker",
    exporterEndpoint: "https://otel.example.com",
    exporterHeaders: { Authorization: "Bearer STATIC_TOKEN" },
  },
);
```

## Factory form — reading secrets from `env`

Pass a function `(env, trigger) => InstrumentOptions` as the second argument:

```ts
import { instrument } from "@tigorhutasuhut/telemetry-js/cloudflare";

export default instrument(
  {
    async fetch(req, env, ctx) {
      return new Response("hi");
    },
  },
  (env, trigger) => ({
    serviceName: "my-worker",
    exporterEndpoint: env.OTEL_ENDPOINT,
    exporterHeaders: { Authorization: `Bearer ${env.OTEL_TOKEN}` },
  }),
);
```

The factory is invoked **once per handler invocation** (fetch / scheduled / queue) with:

- `env` — the Cloudflare `env` object for that invocation (typed as `Env`)
- `trigger` — the event that started the trace (see [Trigger type](#trigger-type))

### Generic `Env`

Type the factory for full inference on `env`:

```ts
import { instrument, type ResolveConfigFn } from "@tigorhutasuhut/telemetry-js/cloudflare";

interface Env {
  OTEL_ENDPOINT: string;
  OTEL_TOKEN: string;
}

const resolveConfig: ResolveConfigFn<Env> = (env, trigger) => ({
  serviceName: "my-worker",
  exporterEndpoint: env.OTEL_ENDPOINT,
  exporterHeaders: { Authorization: `Bearer ${env.OTEL_TOKEN}` },
});

export default instrument<Env>(myHandler, resolveConfig);
```

## `traceHandler` factory form

`TraceHandlerOptions.config` accepts the same factory shape — useful for SvelteKit where `env` is already in scope:

```ts
import { traceHandler, type ResolveConfigFn } from "@tigorhutasuhut/telemetry-js/cloudflare";
import type { Handle } from "@sveltejs/kit";

const resolveConfig: ResolveConfigFn<App.Platform["env"]> = (env) => ({
  serviceName: "my-sveltekit-app",
  exporterEndpoint: env.OTEL_ENDPOINT,
  exporterHeaders: { Authorization: `Bearer ${env.OTEL_TOKEN}` },
});

export const handle: Handle = async ({ event, resolve }) => {
  return traceHandler({
    config: resolveConfig,
    context: event.platform?.ctx,
    env: event.platform?.env ?? {},
    request: event.request,
    handler: () => resolve(event),
  });
};
```

## Trigger type

`trigger` identifies what started the current trace:

| Value | When |
| --- | --- |
| `Request` | `fetch` handler |
| `ScheduledController` | `scheduled` (cron) handler |
| `MessageBatch` | `queue` consumer handler |
| `"do"` | Durable Object or non-event entry |

```ts
import type { Trigger } from "@tigorhutasuhut/telemetry-js/cloudflare";
```

Use `trigger` to produce different service names or sampling decisions per event type:

```ts
(env, trigger) => ({
  serviceName: trigger instanceof Request ? "my-worker-http" : "my-worker-cron",
  exporterEndpoint: env.OTEL_ENDPOINT,
})
```

## Error handling

If the factory throws, the SDK falls back to a **no-op tracer** — the worker still runs and returns a response, but no telemetry is emitted. The error is logged once to the console.

This matches the existing fail-silent contract of the object form: a bad config never crashes your worker.
