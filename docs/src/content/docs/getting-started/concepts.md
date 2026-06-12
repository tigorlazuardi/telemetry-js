---
title: Core Concepts
description: Key design concepts in telemetry-js
sidebar:
  order: 3
---

## Never throws — SDKResult

The SDK never throws. Every entry point (`initSDK`, `instrument`, `traceHandler`) returns an `SDKResult`. On failure, the result is a structured noop — your application keeps running and all SDK calls become safe no-ops.

You do not need try/catch around SDK initialization.

## Runtime-specific subpaths

There is no single root import. Each runtime has its own subpath:

- `/node` — Node.js / Bun, OTel HTTP exporters
- `/cloudflare` — Cloudflare Workers, fetch-based exporters
- `/browser` — Browser (Vite etc.), lazy facade
- `/browser/fetch` — browser fetch patch only (~2 KB)

This design lets bundlers tree-shake unused runtimes completely. See [Subpath Exports](/getting-started/subpath-exports) for the full table.

## Two initialization patterns

Which pattern you use depends on the runtime.

### `initSDK` — explicit setup

Used on Node.js and Browser. You call `initSDK` once at startup, get back an `SDKResult`, and use it directly.

```ts
import { initSDK } from "@tigorhutasuhut/telemetry-js/node";

const sdk = initSDK({
  serviceName: "my-api",
  exporterEndpoint: "https://otel.example.com",
});

sdk.logger.info("server started", { port: 3000 });
process.on("SIGTERM", () => sdk.shutdown());
```

### `instrument` / `traceHandler` — wrapping pattern

Used on Cloudflare Workers. Instead of calling `initSDK` yourself, you wrap your handler. The SDK initializes per-request and flushes via `ctx.waitUntil`.

```ts
import { instrument } from "@tigorhutasuhut/telemetry-js/cloudflare";

export default instrument(
  {
    async fetch(request, env, ctx) {
      return new Response("Hello from Workers!");
    },
  },
  { serviceName: "my-worker", exporterEndpoint: "https://otel.example.com" },
);
```

`traceHandler` is the lower-level variant for frameworks (e.g. SvelteKit) that don't use the standard `ExportedHandler` pattern.

## Browser lazy facade

The `/browser` entry point is a **pure-JS lazy facade**. It has zero OTel dependencies at import time. The heavy OTel SDK chunk loads only when `initSDK()` is awaited, keeping initial bundle weight minimal.

The `/browser/fetch` subpath is an even lighter entry point (~2 KB, zero OTel deps). It patches `globalThis.fetch` synchronously so libraries that capture `fetch` at module load time are still instrumented. The heavy SDK loads lazily on the first `fetch()` call.

The recommended browser setup uses both in sequence — `browser/fetch` first (eager, synchronous patch), then `browser` via dynamic `import()` (lazy SDK setup):

```ts
// main.tsx — FIRST import
import { instrumentFetch } from "@tigorhutasuhut/telemetry-js/browser/fetch";
instrumentFetch();

// Lazy SDK setup, fire-and-forget
import("./lib/telemetry").then(({ initTelemetry }) =>
  initTelemetry({ endpoint: import.meta.env.VITE_OTLP_ENDPOINT, enabled: true }),
);
```

## Go-style context

The `/context` subpath provides Go-style context utilities built on `AbortSignal` and OTel context propagation: cancellation, timeouts, deadlines, value propagation, and signal nesting.

```ts
import { withTimeout, getSignal } from "@tigorhutasuhut/telemetry-js/context";

await withTimeout(5000, async () => {
  const signal = getSignal();
  const res = await fetch("/api/data", { signal });
  return res.json();
});
```

Key primitives:

- `withCancel` — manual cancellation via a `cancel()` callback
- `withTimeout` — auto-cancel after a duration (ms)
- `withDeadline` — auto-cancel at an absolute `Date`
- `withAbortSignal` — propagate an external `AbortSignal` into the context
- `withoutCancel` — detach from the parent signal (like Go's `context.WithoutCancel`)
- `withValue` / `getValue` — store and retrieve arbitrary values through the context
- `getSignal` / `isCanceled` — read current signal state

Signals are derived: a child signal aborts when either the parent or the child aborts, but cancelling a child does not affect the parent.

Requires Node 20+, Cloudflare Workers, or modern browsers with `AbortSignal.any()` support.
