# Cloudflare OTel Parity — Config Factory + Binding Instrumentation

**Date:** 2026-06-12
**Status:** Design approved, pending spec review
**Package:** `@tigorhutasuhut/telemetry-js` (entry `./cloudflare`)
**Baseline:** v2.0.0

## Problem

`otel-cf-workers` (`@microlabs/otel-cf-workers`) covers many Cloudflare use cases telemetry-js does not. Question: adopt it, or reach feature parity in-house?

Findings (researched 2026-06-12):

- Latest `1.0.0-rc.52`, published 2025-05-19; last commit 2025-05-26. ~13 months stale.
- Perpetual RC — never shipped stable 1.0.0. 43 open issues. Effectively single-maintainer.
- **Traces only.** No metrics, no logs. telemetry-js already ships traces **+ metrics + logs** via custom `FetchTraceExporter` / `FetchMetricExporter` / `FetchLogExporter`.
- Its real edge = (a) `ResolveConfigFn` per-request config ergonomics, (b) auto-instrumentation of CF bindings (KV/D1/R2/Queues/DO/…).
- OTel deps compatible: it peers `@opentelemetry/api ~1.9`, core `^2.0`; telemetry-js uses api `^1.9`, core `^2.6`.

**Decision: do not depend on it.** Adopting it as the CF engine regresses metrics+logs and inherits a one-year-stale RC dependency. Instead replicate the two good ideas on the existing engine — no new OTel deps, no signal regression.

## Goals

1. **Config factory ergonomics** — per-request config resolution from `env` + `trigger`. Non-breaking additive overload.
2. **Binding instrumentation** — explicit wrappers for KV, D1, R2, Queues, DO storage. Child spans **+ a duration metric** per operation, reusing the existing tracer, meter, and exporters.

## Non-goals

- Adopting or wrapping `otel-cf-workers`.
- Auto-detecting bindings by proxying `env` (rejected — see "Rejected approaches").
- Per-binding **logs** in the first pass (spans + one duration histogram only).
- Tracing R2 streaming body consumption (span covers method-promise latency only).
- Any breaking change to existing `instrument()` / `traceHandler()` callers.

## Constraints

- **Additive only.** Old `instrument(handler, config)` and `traceHandler(opts)` keep working unchanged. Ships in a v2.x minor.
- No new runtime dependencies. Reuse existing tracer, `CloudflareContextManager`, `FetchTraceExporter`.
- Every slice ships its own Starlight guide page + TSDoc in the same PR (docs deploy on push to `main`).

---

## Feature A — Config factory (`ResolveConfigFn`)

### Why

On Cloudflare, secrets and bindings only exist **inside** a request (`env`), not at module top-level. Today config must be a literal passed at module load, so an exporter token in `env.OTEL_TOKEN` is unreachable. A factory `(env, trigger) => SDKConfig` resolves config per-invocation.

### API

New exported types:

```typescript
/** Trigger that started the current trace; passed to a config factory. */
export type Trigger =
  | Request
  | ScheduledController
  | MessageBatch
  | "do"; // Durable Object / non-event entry

/** Per-invocation config resolver. Receives the request-time env + trigger. */
export type ResolveConfigFn<Env = unknown> = (
  env: Env,
  trigger: Trigger,
) => InstrumentOptions;
```

Overloaded `instrument()`:

```typescript
export function instrument<Env = unknown>(
  handler: ExportedHandler<Env>,
  opts?: InstrumentOptions,
): ExportedHandler<Env>;
export function instrument<Env = unknown>(
  handler: ExportedHandler<Env>,
  resolveConfig: ResolveConfigFn<Env>,
): ExportedHandler<Env>;
```

Discrimination: `typeof secondArg === "function"`. When a factory is given, it is invoked **inside each handler** (`fetch`/`scheduled`/`queue`) with the live `env` and the event as `trigger`, producing the `InstrumentOptions` used for that invocation. The object form keeps today's behaviour exactly.

`traceHandler()` gains the same treatment: `TraceHandlerOptions.config` may be `InstrumentOptions | ResolveConfigFn`. (SvelteKit-style callers already have `env` + `request` in scope, so this is for symmetry.)

### Usage

```typescript
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

### Edge cases

- Factory throws → caught, fall back to `noopSDKResult()` (matches existing fail-silent contract). Error logged once.
- Factory returns config without `serviceName` → existing `?? "unknown"` default applies.
- Object form unchanged — zero behavioural diff.

---

## Feature B — Binding instrumentation (explicit wrappers)

### Mechanism

One wrapper per binding type. Signature shape:

```typescript
export function instrumentKV<T extends KVNamespace>(kv: T, name: string): T;
export function instrumentD1<T extends D1Database>(db: T, name: string): T;
export function instrumentR2<T extends R2Bucket>(bucket: T, name: string): T;
export function instrumentQueue<T extends Queue>(q: T, name: string): T;
export function instrumentDOStorage<T extends DurableObjectStorage>(s: T, name: string): T;
```

Each returns the **same type** (transparent Proxy) so consumer code is unchanged after the one wrapping line. No detection, no `env` proxying — types flow through, `instanceof` on the original is the caller's concern. Wrapping is opt-in and explicit:

```typescript
const kv = instrumentKV(env.SESSIONS, "SESSIONS");
const db = instrumentD1(env.DB, "DB");
await kv.get("token");                       // span: "KV SESSIONS get"
await db.prepare("SELECT 1").first();        // span: "D1 DB SELECT"
```

### Shared helper

A single internal `traceBinding()` opens a `CLIENT`/`PRODUCER` span under the **current active context** via `tracer.startActiveSpan`, runs the wrapped method, records status/exception, ends the span, returns the result. Called with no active span → span still created best-effort, never throws. Reuses the existing tracer and `FetchTraceExporter`; no new deps.

```
tracer.startActiveSpan(name, { kind, attributes }, async (span) => {
  try { return await original.apply(target, args); }
  catch (e) { span.recordException(e); span.setStatus({ code: ERROR }); throw e; }
  finally { span.end(); }
});
```

### Return-value wrapping (intrinsic complexity)

Two bindings need wrapped return values — this is inherent to their API, not a consequence of the approach:

- **D1**: `prepare(sql)` returns a `D1PreparedStatement`. The wrapper returns a wrapped statement so the span opens at the terminal op (`.first()/.all()/.run()/.raw()`), where latency lives, while capturing `sql` from `prepare`. `.bind()` returns a wrapped statement too (chainable). `batch()` and `exec()` are spanned directly. Surface is ~6 methods — bounded.
- **R2**: `get()` returns `R2ObjectBody` with a streaming `body`. The span covers the `get()` promise latency only; stream drain is **not** traced (tracing it would mis-time span end). Documented limitation.

KV, Queue, DO storage need no return wrapping (flat method calls).

### Metrics (one histogram)

`traceBinding()` records a span **and** one duration histogram in the same place — every wrapper inherits both, no per-wrapper metric code. Reuses the meter from the CF adapter.

```
cloudflare.binding.operation.duration   (histogram, unit: ms)
  cloudflare.binding.type   kv | d1 | r2 | queue | do_storage
  cloudflare.binding.name   SESSIONS, DB, …
  operation                 get | put | first | send | …
  status                    ok | error
```

One histogram yields call count (= histogram count), error rate (filter `status=error`), and latency percentiles — no separate counters. **Cardinality rule:** metric attributes carry ONLY the four bounded dimensions above. High-cardinality values (`kv.key`, `db.statement`, `r2.key`) stay **span-only**, never a metric label. D1-semconv alias (`db.client.operation.duration`) deferred.

**Explicit buckets (required).** The histogram is created with explicit boundaries via OTel `advice.explicitBucketBoundaries` — never rely on the SDK default buckets. Configurable, with a default tuned for edge-storage latencies (ms):

```typescript
// SDKConfig additions
bindingHistogramBoundaries?: number[];  // default below
// default (ms):
[1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000]
```

Created as `meter.createHistogram("cloudflare.binding.operation.duration", { unit: "ms", advice: { explicitBucketBoundaries: boundaries } })`. Using `advice` (not a MeterProvider View) keeps boundaries at instrument-creation and avoids touching the adapter's provider setup.

### Semantic conventions

Lean on `@opentelemetry/semantic-conventions` where it maps; custom `cloudflare.*` namespace otherwise.

| Binding | SpanKind | Span name | Attributes |
|---|---|---|---|
| KV | CLIENT | `KV <name> <op>` | `cloudflare.binding.type=kv`, `cloudflare.binding.name`, `cloudflare.kv.operation`, `cloudflare.kv.key`* |
| D1 | CLIENT | `D1 <name> <verb>` | `db.system=cloudflare-d1`, `db.statement`, `db.operation`, `cloudflare.binding.name` |
| R2 | CLIENT | `R2 <name> <op>` | `cloudflare.r2.bucket`, `cloudflare.r2.operation`, `cloudflare.r2.key`* |
| Queue | PRODUCER | `Queue <name> send` | `messaging.system=cloudflare-queues`, `messaging.destination.name`, `messaging.operation=send`, `messaging.batch.message_count` |
| DO storage | CLIENT | `DO storage <op>` | `cloudflare.do.storage.operation`, `cloudflare.do.storage.key`* |

\* **Key redaction.** KV/R2/DO keys may carry PII. Keys (`*.key`) are **omitted by default**. New config flag `bindingCaptureKeys?: boolean` (default `false`) opts in. `db.statement` captures SQL text but never bound parameters.

### Trace continuity (one trace ID per operation)

The engine already guarantees a single connected trace, by the same four mechanisms `otel-cf-workers` uses:

1. `CloudflareContextManager` (ALS-backed, `node:async_hooks`) registered globally — `context.active()` survives `await` (`adapter.ts:121`).
2. `traceHandler` runs the user handler inside a root `startActiveSpan` — root context active for the whole request (`instrument.ts:339`).
3. Child spans start with `context.active()` as parent → same `traceId`.
4. Incoming `traceparent` extracted → joins the upstream distributed trace.

A span only splinters into a **new** trace ID when started where `context.active() == ROOT_CONTEXT` — i.e. outside the handler's active scope (module top-level, a detached promise, an unbound `ctx.waitUntil` callback). Binding wrappers must not become that source:

- The wrapper opens its child span via `tracer.startActiveSpan` (implicit parent = `context.active()`) — inside the handler it inherits the root `traceId`.
- **Orphan guard:** if there is no recording active span at call time, do NOT mint a disconnected root span (that is precisely the "different trace ID for the same operation" bug). Behaviour is configurable:

```typescript
orphanBindingSpans?: "skip" | "root";  // default "skip"
```

  `"skip"` (default) → record the metric, emit no span. `"root"` → emit a root span (opt-in, for code that genuinely runs top-level work and wants a trace anyway).
- Acceptance: a test asserts a wrapped binding op called inside `traceHandler` produces a span whose `traceId` equals the root span's `traceId`.

### Module layout

```
src/cloudflare/bindings/
  trace-binding.ts   # shared traceBinding() helper + span attr builders
  kv.ts              # instrumentKV
  d1.ts              # instrumentD1 (+ statement wrapping)
  r2.ts              # instrumentR2
  queue.ts           # instrumentQueue
  do-storage.ts      # instrumentDOStorage
  index.ts           # re-exports
```

Re-exported from `src/cloudflare/index.ts`. Each wrapper is a focused, independently testable unit.

---

## Rejected approaches

- **Adopt `otel-cf-workers`** — regresses metrics+logs (traces-only), inherits a 13-month-stale RC dependency, gives up control of the CF engine.
- **Auto-detect via `env` Proxy (otel-cf-workers style)** — duck-typing CF bindings is guesswork (no class brand; KV/R2 share `get`/`put`; CF adds binding types over time → mis-detection and an endless maintenance tax — the very reason otel-cf-workers stayed in RC for a year). Proxying `env` also breaks `instanceof`, risks `this`-binding loss on destructure, and forces deep recursive wrapping. Explicit wrappers quarantine all of this: one opt-in line per binding, zero false positives. Auto-detect sugar may be revisited later as an optional layer built **on top of** the explicit wrappers, never as the foundation.

---

## Slicing

Additive, each independently shippable with its docs.

| # | Slice | Ships |
|---|---|---|
| 1 | Config factory | `ResolveConfigFn`/`Trigger` types, `instrument()` overload, `traceHandler` factory support, guide page |
| 2 | Binding core + KV | `traceBinding()` helper, `instrumentKV`, `bindingCaptureKeys` flag, guide page |
| 3 | D1 | `instrumentD1` + prepared-statement wrapping, guide section |
| 4 | R2 | `instrumentR2`, guide section |
| 5 | Queues | `instrumentQueue` (producer spans), guide section |
| 6 | DO storage | `instrumentDOStorage` (+ DO access path), guide section |

---

## Testing

No miniflare required — bindings are interfaces, fakes suffice.

- **Unit per wrapper**: hand-rolled fake binding (`{ get: async () => "v", ... }`), an in-memory span exporter (or spy on `startActiveSpan`), assert span name/kind/attributes/status, error path records exception + re-throws, key omitted unless `bindingCaptureKeys`.
- **D1**: assert `prepare().bind().first()` opens exactly one span carrying the SQL; `batch()` spanned; statement chaining preserved.
- **R2**: assert `get()` span ends on promise resolve, body still streamable (not consumed by instrumentation).
- **Type tests**: wrapper return type assignable to original binding type (`expectType<KVNamespace>(instrumentKV(kv, "x"))`).
- **Overload (A)**: object form unchanged; function form invoked per request with live `env`+`trigger`; factory throw → noop fallback.
- Run existing suite (`vitest`), typecheck, biome lint, bundle-size check (cloudflare entry must not pull new deps).

---

## Documentation (emphasis)

Stack: Astro + Starlight, per-runtime guides, TypeDoc prebuild buckets, per-runtime `llms-txt`.

Each slice's PR must include:

1. **Guide page / section** under the Cloudflare runtime guide:
   - Slice 1: new page *"Per-request config (ResolveConfigFn)"* — why env-at-request, object vs factory, secrets/headers example, fallback behaviour.
   - Slices 2–6: a *"Tracing Cloudflare bindings"* page, one section per binding — wrap-one-line example, resulting span name/attrs, key-redaction note, R2 streaming caveat, D1 statement-capture note.
2. **TSDoc** on every exported wrapper + type (`@param`, `@returns`, `@example`) so TypeDoc auto-generates the `cloudflare` API bucket. Mirror the depth of existing `instrument()` docs.
3. **`llms-txt`**: cloudflare custom-set selectors auto-include the new pages — verify the generated bucket contains binding docs after build.
4. **Migration note**: explicitly state non-breaking; object-form `instrument()` unchanged; binding wrapping is opt-in.

Docs deploy automatically on push to `main` (`deploy-docs.yml`), independent of npm release.
