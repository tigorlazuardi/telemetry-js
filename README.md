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

| Subpath | Runtime | Description |
| --- | --- | --- |
| `@tigorhutasuhut/telemetry-js/cloudflare` | Cloudflare Workers | Full SDK with fetch-based exporters |
| `@tigorhutasuhut/telemetry-js/node` | Node.js / Bun | Full SDK with OTel HTTP exporters |
| `@tigorhutasuhut/telemetry-js/browser` | Browser (Vite, etc.) | Full SDK with fetch-based exporters |
| `@tigorhutasuhut/telemetry-js/browser/fetch` | Browser | Lightweight `instrumentFetch()` only (~2 KB, zero OTel deps at import time) |
| `@tigorhutasuhut/telemetry-js/error` | All | `AppError` class for structured application errors |
| `@tigorhutasuhut/telemetry-js/db` | All | `withQueryName` / `getQueryName` for query naming via OTel context |
| `@tigorhutasuhut/telemetry-js/context` | All | Go-style context: cancellation, timeouts, deadlines, values |

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

Libraries like Hono `hc`, better-auth, and TanStack Query may capture a reference to `globalThis.fetch` at **module load time**. If the SDK patches `fetch` after those modules load, outgoing requests will bypass instrumentation silently.

Split initialisation into two phases to guarantee every `fetch` call is traced:

```ts
// main.tsx

// 1. EAGER — patch globalThis.fetch synchronously, before ANY other import.
//    This subpath is lightweight (~2 KB) and has zero @opentelemetry deps
//    at import time. OTel tracing code is loaded lazily via dynamic import()
//    on the first fetch() call — by then the browser has already cached all
//    chunks, so tracing kicks in instantly.
import { instrumentFetch } from "@tigorhutasuhut/telemetry-js/browser/fetch";
instrumentFetch();

// 2. LAZY — full SDK setup, fire-and-forget.
//    Registers TracerProvider, propagators, and exporters.
//    Detects that instrumentFetch() was already called and skips a
//    redundant patch.
import("./lib/telemetry").then(({ initTelemetry }) =>
  initTelemetry({
    endpoint: import.meta.env.VITE_OTLP_ENDPOINT,
    enabled: true,
  }),
);

// ... rest of your app (React root, router, etc.)
```

Then in your telemetry wrapper (`lib/telemetry.ts`):

```ts
import { initSDK, type SDKConfig } from "@tigorhutasuhut/telemetry-js/browser";

export function initTelemetry(config: { endpoint: string; enabled?: boolean }) {
  if (!config.enabled) return;

  initSDK({
    serviceName: import.meta.env.VITE_OTEL_SERVICE_NAME ?? "my-spa",
    exporterEndpoint: config.endpoint,
    resourceAttributes: {
      "deployment.environment.name": import.meta.env.VITE_OTEL_DEPLOYMENT_ENV,
      "service.namespace": import.meta.env.VITE_OTEL_SERVICE_NAMESPACE,
    },
  });
}
```

Vite replaces `import.meta.env.VITE_*` with string literals at build time, so these values are baked into the bundle — no runtime env lookup needed.

Define the variables in your `.env` file:

```env
VITE_OTEL_SERVICE_NAME=my-spa
VITE_OTLP_ENDPOINT=https://otel.example.com
VITE_OTEL_DEPLOYMENT_ENV=production
VITE_OTEL_SERVICE_NAMESPACE=my-team
```

Before the `TracerProvider` is registered by `initSDK`, the OTel API returns a noop tracer — `fetch` works normally, just without tracing. Once the provider is up, every subsequent `fetch` call produces real CLIENT spans with W3C `traceparent`/`tracestate` header injection.

## `withTrace` — Manual Span Creation

`withTrace` wraps a function in an OpenTelemetry span. It is re-exported from every runtime subpath (`/cloudflare`, `/node`, `/browser`).

```ts
import { withTrace } from "@tigorhutasuhut/telemetry-js/node";

const user = await withTrace(async function fetchUser(span) {
  span.setAttribute("user.id", id);
  return db.users.find(id);
});
```

The span name is auto-detected from the function name (or caller file:line for anonymous functions). Override it with `opts.name`.

### Options

| Option | Type | Description |
| --- | --- | --- |
| `name` | `string` | Override auto-detected span name |
| `kind` | `SpanKind` | Span kind (default: `INTERNAL`) |
| `attributes` | `Record<string, string>` | Initial span attributes |
| `component` | `string` | Prefix span name with component (also sets `ui.component`) |
| `parent` | `Span \| string` | Parent span or W3C `traceparent` string |
| `carrier` | `unknown` | Opaque carrier for textmap propagation (e.g. incoming headers) |
| `signal` | `AbortSignal` | AbortSignal to propagate through the OTel context |

### Signal Integration

The `signal` option propagates an `AbortSignal` through the OTel context, making it readable via `getSignal()` from `@tigorhutasuhut/telemetry-js/context`. If a parent signal already exists, they are merged via `AbortSignal.any()`:

```ts
import { withTrace } from "@tigorhutasuhut/telemetry-js/node";
import { getSignal } from "@tigorhutasuhut/telemetry-js/context";

const ac = new AbortController();

await withTrace(
  async (span) => {
    const signal = getSignal(); // the AbortSignal from opts
    const res = await fetch("/api/data", { signal });
    return res.json();
  },
  { signal: ac.signal },
);
```

This also composes with the context module — a `withTrace` with `signal` nests cleanly inside `withCancel` / `withTimeout` / `withAbortSignal`:

```ts
import { withTrace } from "@tigorhutasuhut/telemetry-js/cloudflare";
import { withTimeout, getSignal } from "@tigorhutasuhut/telemetry-js/context";

// Timeout applies to the entire traced operation
await withTimeout(5000, async () => {
  await withTrace(async function processOrder(span) {
    const signal = getSignal(); // derived from withTimeout's signal
    const order = await createOrder({ signal });
    span.setAttribute("order.id", order.id);
    return order;
  });
});
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

## Context — Cancellation, Timeouts & Deadlines

Go-style context utilities built on `AbortSignal` and OTel context propagation. Requires Node 20+, Cloudflare Workers, or modern browsers (`AbortSignal.any()` support).

```ts
import {
  withValue, getValue,
  withCancel, withTimeout, withDeadline,
  withAbortSignal, withoutCancel,
  getSignal, isCanceled,
  ContextCanceledError, DeadlineExceededError,
} from "@tigorhutasuhut/telemetry-js/context";
```

### Values

Store and retrieve arbitrary values through the OTel context using symbol keys:

```ts
const USER_KEY = Symbol("user");

withValue(USER_KEY, { id: "alice" }, () => {
  const user = getValue(USER_KEY); // { id: "alice" }
});
```

Values are scoped — inner calls shadow outer ones with the same key, and the outer value is restored when the inner scope exits.

### Cancellation

`withCancel` provides a `cancel()` function. Downstream code reads the signal via `getSignal()`:

```ts
await withCancel(async (cancel) => {
  const signal = getSignal();
  const res = await fetch("/api/data", { signal });
  cancel(); // abort the signal
});
```

`withTimeout` and `withDeadline` auto-cancel after a duration or at an absolute time:

```ts
// Auto-cancel after 5 seconds
await withTimeout(5000, async () => {
  const signal = getSignal();
  const res = await fetch("/api/slow", { signal });
  return res.json();
});

// Auto-cancel at a specific time
const deadline = new Date(Date.now() + 10_000);
await withDeadline(deadline, async () => {
  const signal = getSignal();
  return await longRunningTask({ signal });
});
```

### Async Race Semantics

When the callback is async, its promise is **raced** against the signal:

- If the signal aborts before `fn` settles, the returned promise rejects immediately.
- `withTimeout` / `withDeadline` reject with `DeadlineExceededError` on timer expiry.
- `cancel()` rejects with `ContextCanceledError`.
- Sync callbacks always return normally — the timer cannot fire during synchronous execution.

```ts
try {
  await withTimeout(1000, async () => {
    await verySlowOperation(); // takes 5 seconds
  });
} catch (err) {
  if (err instanceof DeadlineExceededError) {
    // timeout fired before verySlowOperation() settled
  }
}
```

### Signal Nesting

Signals are **derived** — a child signal aborts when either the parent or the child aborts, but a child cancel does not affect the parent:

```ts
withCancel((parentCancel) => {
  withTimeout(1000, () => {
    // getSignal() returns a derived signal that aborts if:
    // - the 1s timer fires, OR
    // - parentCancel() is called
  });
  // parent signal is unaffected by child timeout
});
```

### External Signals — `withAbortSignal`

Propagate an external `AbortSignal` (e.g. from Hono's `Request.signal`) into the context:

```ts
// Hono handler
app.get("/users/:id", (c) => {
  return withAbortSignal(c.req.raw.signal, async () => {
    // getSignal() now returns request.signal (or derived if nested)
    const signal = getSignal();
    const user = await db.users.find(c.req.param("id"), { signal });
    return c.json(user);
  });
});
```

If a parent signal already exists in the context, the signals are merged via `AbortSignal.any()`.

### Detaching — `withoutCancel`

Like Go's `context.WithoutCancel` — run code that must survive parent cancellation:

```ts
await withTimeout(5000, async (cancel) => {
  const data = await fetchData();

  // Audit log must complete even if parent times out
  withoutCancel(async () => {
    await auditLog("fetched", data);
  });

  return data;
});
```

Inside `withoutCancel`, `getSignal()` returns `undefined` and `isCanceled()` returns `false`. Context values from `withValue` are preserved.

### Cloudflare `waitUntil` Caveat

The telemetry flush (`ctx.waitUntil` in `traceHandler` / `instrument`) always runs — it lives in a `finally` block outside user code.

However, **your own** `ctx.waitUntil` calls inside a `withTimeout` / `withCancel` scope will not execute if the signal fires first (the promise rejects, skipping subsequent code). Wrap them in `withoutCancel`:

```ts
export default instrument({
  async fetch(request, env, ctx) {
    return withTimeout(5000, async () => {
      const data = await processRequest(request);

      // BAD — won't run if timeout fires first
      // ctx.waitUntil(sendAnalytics(data));

      // GOOD — survives timeout
      withoutCancel(() => {
        ctx.waitUntil(sendAnalytics(data));
      });

      return new Response(JSON.stringify(data));
    });
  },
});
```

### `isCanceled` / `getSignal`

Quick checks without catching errors:

```ts
withCancel((cancel) => {
  console.log(isCanceled()); // false
  cancel();
  console.log(isCanceled()); // true

  const signal = getSignal();
  console.log(signal?.reason); // ContextCanceledError
});
```

## Database Query Naming

The `/db` subpath provides `withQueryName` / `getQueryName` for naming database queries via the OTel context. `withQueryName` creates a `CLIENT` span and stores the name so your DB driver wrapper can read it.

```ts
import { withQueryName, getQueryName } from "@tigorhutasuhut/telemetry-js/db";

// Application code — name the query
const user = await withQueryName("getUser", () =>
  db.query("SELECT * FROM users WHERE id = $1", [id]),
);
```

Inside your DB driver wrapper, read the name:

```ts
import { getQueryName } from "@tigorhutasuhut/telemetry-js/db";

function query(sql: string, params: unknown[]) {
  const name = getQueryName(); // "getUser" (or undefined if not set)
  // Use name for logging, pg prepared statements, etc.
  return pool.query({ text: sql, values: params, name });
}
```

`withQueryName` creates a span named `db.{name}` with `db.query.name` attribute. It composes with `withTrace` and the context module — the query name propagates through nested OTel contexts:

```ts
await withTrace(async function handleRequest(span) {
  // Query name is available inside the traced scope
  const user = await withQueryName("getUser", () => db.findUser(id));
  const orders = await withQueryName("listOrders", () => db.findOrders(user.id));
  return { user, orders };
});
```

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
> - **Browser**: Call `instrumentFetch()` from `browser/fetch` as early as possible in your entry point (see [Quick Start — Browser](#quick-start--browser)).

### Browser

```ts
// main.tsx — FIRST import
import { instrumentFetch } from "@tigorhutasuhut/telemetry-js/browser/fetch";
instrumentFetch();
```

The `browser/fetch` subpath is ~2 KB with zero `@opentelemetry` imports at the top level. OTel tracing code is loaded lazily on first `fetch()` call. If `initSDK` is called later, it detects the existing patch and skips re-patching.

### Cloudflare Workers

For manual use outside of `instrument()` / `traceHandler()`:

```ts
import { instrumentFetch } from "@tigorhutasuhut/telemetry-js/cloudflare";

instrumentFetch(); // Patches globalThis.fetch
```

### `getOriginalFetch`

Use `getOriginalFetch()` to access the unpatched fetch (e.g. for OTLP export calls that should not be traced):

```ts
import { getOriginalFetch } from "@tigorhutasuhut/telemetry-js/cloudflare";

const originalFetch = getOriginalFetch();
await originalFetch("https://otel.example.com/v1/traces", { ... });
```

## License

[Apache-2.0](LICENSE)
