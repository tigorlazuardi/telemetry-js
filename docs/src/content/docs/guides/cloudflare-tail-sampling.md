---
title: Tail sampling on Cloudflare Workers
description: Export only the spans that matter — errors, slow requests, or sampled traces — using the one-isolate-one-trace property of Cloudflare Workers.
---

Tail-based sampling defers the export decision to **after a trace completes**, so you can apply policies that require the full picture: keep all error traces, keep traces above a latency threshold, drop everything else.

This works naturally on Cloudflare Workers because one isolate handles exactly one request. Every span for a given `traceId` is in memory at once, making tail sampling both cheap and complete.

## Quick start

Pass a `sampling` block to `initSDK` (or to `instrument` / `traceHandler`):

```ts
import {
  instrument,
  keepOnError,
  keepOnSlow,
  multiTailSampler,
} from "@tigorhutasuhut/telemetry-js/cloudflare";

export default instrument(handler, (env) => ({
  serviceName: "my-worker",
  exporterEndpoint: env.OTEL_ENDPOINT,
  sampling: {
    tailSampler: multiTailSampler([keepOnError, keepOnSlow(2000)]),
  },
}));
```

The adapter:

1. Records **all spans** (head sampler never drops — see [record-all nuance](#the-record-all-nuance) below).
2. Buffers spans in memory keyed by `traceId`.
3. When the root span ends and all children finish, calls your `tailSampler`.
4. If the sampler returns `true`, exports the full trace. Otherwise drops it.
5. Runs the export in `ctx.waitUntil` — the response is never blocked.

## Built-in tail samplers

| Sampler | Keeps trace when… |
|---------|-------------------|
| `keepOnError` | Root span status is `ERROR` |
| `keepOnHeadSampled` | W3C `traceparent` has the `SAMPLED` flag |
| `keepAll` | Always (export everything) |
| `keepOnSlow(ms)` | Root span duration exceeds `ms` milliseconds |
| `multiTailSampler(fns)` | **Any** of the provided samplers returns `true` (OR) |

### keepOnError

```ts
import { keepOnError } from "@tigorhutasuhut/telemetry-js/cloudflare";

// sampling: { tailSampler: keepOnError }
```

Exports traces whose root span ended with `SpanStatusCode.ERROR`. Combines with `instrument()` / `traceHandler()` which automatically sets ERROR status on 5xx responses and thrown exceptions.

### keepOnSlow

```ts
import { keepOnSlow } from "@tigorhutasuhut/telemetry-js/cloudflare";

// Keep traces that took longer than 500 ms
const sampler = keepOnSlow(500);
```

Measures root-span wall-clock duration (end minus start, in milliseconds).

### multiTailSampler — combining policies

Use `multiTailSampler` to combine built-ins with OR logic — export when **any** condition is met:

```ts
import {
  keepOnError,
  keepOnSlow,
  keepOnHeadSampled,
  multiTailSampler,
} from "@tigorhutasuhut/telemetry-js/cloudflare";

const sampler = multiTailSampler([
  keepOnError,         // always export errors
  keepOnSlow(1000),    // export slow requests
  keepOnHeadSampled,   // follow upstream sampled decision
]);
```

### Custom tail sampler

Implement `TailSampleFn` for arbitrary logic:

```ts
import type { TailSampleFn } from "@tigorhutasuhut/telemetry-js/cloudflare";

const keepImportantRoutes: TailSampleFn = (trace) => {
  const rootAttrs = trace.rootSpan.attributes;
  // Keep checkout and payment traces regardless of outcome
  const path = rootAttrs["http.target"] as string | undefined;
  return path?.startsWith("/checkout") || path?.startsWith("/payment") || false;
};
```

`TailSampleFn` receives a [`LocalTrace`](#localtrace-type) containing every span in the request and the identified root span.

## Sampling configuration

```ts
sampling?: {
  tailSampler?: TailSampleFn;        // default: multiTailSampler([keepOnHeadSampled, keepOnError])
  headSampler?: Sampler;             // default: record-all + propagationRatio
  propagationRatio?: number;         // default: 1.0
  maxBufferedSpans?: number;         // default: 2048
}
```

### tailSampler

The function called once per completed trace to decide export. Default: `multiTailSampler([keepOnHeadSampled, keepOnError])` — keep on error OR when the upstream sampled the trace.

### headSampler

Advanced: replace the default head sampler entirely. **Must never return `NOT_RECORD`** — see [record-all nuance](#the-record-all-nuance).

### propagationRatio

Controls what fraction of traces are marked `SAMPLED` in the outgoing W3C `traceparent` header (0–1, default `1.0`). This affects:

- What downstream services see (they may themselves use `keepOnHeadSampled`).
- Whether `keepOnHeadSampled` fires at the tail.

It does **not** gate local span recording — all spans are always recorded regardless of this ratio. Set to `< 1` to reduce downstream telemetry volume while keeping the full tail-sampling guarantee for errors.

### maxBufferedSpans

Maximum total spans buffered across all in-flight traces (default 2048). When exceeded, the oldest incomplete trace is force-decided and exported early to prevent unbounded memory growth. Fine-tune based on your span volume and isolate memory budget.

## The record-all nuance

Tail sampling creates a correctness challenge: if the head sampler drops a span (returns `NOT_RECORD`), that span never reaches the tail. An errored trace whose first span was dropped cannot be retroactively exported.

This library's default head sampler solves this by **always returning at least `RECORD`** — spans are always recorded in memory, never dropped at the head. The `SAMPLED` flag in the W3C `traceparent` is still propagated at the given `propagationRatio`, but it only controls **downstream propagation**, not local recording.

```
Head decision:
  RECORD_AND_SAMPLED  →  span recorded + SAMPLED flag propagated to downstream
  RECORD              →  span recorded + no SAMPLED flag (dropped by downstream)
  NOT_RECORD (never)  →  span would be dropped — tail can't recover it
```

This means volume reduction happens **at the tail**, not the head. The tail policy gates what gets exported to your OTLP backend. Spans that are recorded but ultimately dropped by the tail sampler never leave the isolate.

## Propagation tension

The `SAMPLED` flag in `traceparent` is set at the **head** (when the root span starts) and propagated to all downstream services. Tail sampling in the library is a **local-only guarantee** — it can decide to export locally, but it cannot retroactively change what flag was sent to an upstream service that already recorded your decision.

Default behaviour with `propagationRatio: 1.0`: all traces propagate as `SAMPLED`. Downstream services (and their `keepOnHeadSampled` policies) treat every trace as worth exporting.

With `propagationRatio: 0.1`: 90% of traces are propagated without the `SAMPLED` flag. `keepOnHeadSampled` would not fire for those traces. `keepOnError` still fires — that is the local-only guarantee.

## Cloudflare native observability vs this library

Cloudflare Wrangler has an observability block:

```toml
[observability]
head_sampling_rate = 1   # 0.0–1.0, default 1
```

**This rate only gates Cloudflare's native Workers-Logs / dashboard pipeline.** It does not touch spans exported by this library. This library exports spans via a userland `fetch()` subrequest directly to your OTLP collector — completely independent of the CF dashboard pipeline.

Consequences:

- Setting `head_sampling_rate = 0.1` drops 90% of invocations from the CF dashboard. It **never** drops tail-sampled error traces from your OTLP collector.
- CF's native head sampling has **no error bias** — errored requests are just as likely to be dropped from the CF dashboard as non-errored ones.
- For a reliable CF-dashboard backup: keep `head_sampling_rate = 1`. The library's `keepOnError` tail policy handles volume reduction to your OTLP collector independently.

In short: the two pipelines are independent. Use this library's `tailSampler` for your OTLP backend. Use `head_sampling_rate` in `wrangler.toml` only if you want to reduce Workers-Logs ingestion in the CF dashboard.

## API reference

### `LocalTrace` type

```ts
interface LocalTrace {
  traceId: string;       // W3C hex trace ID
  spans: ReadableSpan[]; // all spans for this trace
  rootSpan: ReadableSpan; // span with no parentSpanContext
}
```

The `rootSpan` is the one without a `parentSpanContext`. In a Cloudflare Workers request instrumented via `instrument()` or `traceHandler()`, it is always the `SERVER` span wrapping the fetch handler.

### `createRecordAllHeadSampler(propagationRatio?)`

Creates the default head sampler. Useful when composing with a custom provider or when you want to inspect its behavior:

```ts
import { createRecordAllHeadSampler } from "@tigorhutasuhut/telemetry-js/cloudflare";

const headSampler = createRecordAllHeadSampler(0.5); // 50% propagated as SAMPLED
```

Always safe to pass as `sampling.headSampler` — it honors the record-all invariant.

## Non-breaking guarantee

With **no `sampling` config**, the adapter behaves exactly as before: `SimpleSpanProcessor` exports each span immediately when it ends, with no buffering. Add the `sampling` block to opt in; remove it to revert. No migration path required.
