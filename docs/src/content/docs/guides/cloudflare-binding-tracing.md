---
title: Tracing Cloudflare bindings
description: Wrap KV, D1, R2, Queue, and Durable Object storage bindings to produce spans and duration metrics for every operation.
---

The `@tigorhutasuhut/telemetry-js/cloudflare` subpath exports explicit wrapper functions for the main Cloudflare binding types. Each wrapper is a **transparent proxy** — same type, same interface, one extra line in your handler.

```ts
import {
  instrument,
  instrumentKV,
  instrumentD1,
  instrumentR2,
  instrumentQueue,
  instrumentDOStorage,
} from "@tigorhutasuhut/telemetry-js/cloudflare";
```

Wrapping is **opt-in and additive** — existing `instrument()` / `traceHandler()` callers are unchanged.

## Shared concepts

### Trace continuity

Every wrapped op opens a child span under the **current active context**. Inside a `traceHandler` or `instrument()` handler, that context is the root request span — so the binding span inherits the same `traceId`.

If a binding is called **outside** a traced scope (module top-level, a detached `ctx.waitUntil` callback), the default behaviour is `"skip"`: the duration metric is recorded but no span is emitted. This prevents "different trace ID for the same operation." Override with `orphanBindingSpans: "root"` to emit a root span instead.

```ts
// config option (default: "skip")
orphanBindingSpans?: "skip" | "root"
```

### Duration metric

Every wrapped op records a histogram:

```
cloudflare.binding.operation.duration   (ms)
  cloudflare.binding.type   kv | d1 | r2 | queue | do_storage
  cloudflare.binding.name   <name passed to wrapper>
  operation                 get | put | first | send | …
  status                    ok | error
```

Explicit bucket boundaries (ms) are used — never the SDK default buckets:

```
[1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000]
```

Override via `bindingHistogramBoundaries` in your SDK config:

```ts
instrument(handler, {
  serviceName: "my-worker",
  bindingHistogramBoundaries: [5, 10, 25, 50, 100, 250, 500, 1000],
});
```

Metric attributes are bounded (type / name / operation / status only). High-cardinality values like KV keys, R2 keys, or SQL statements are **never** metric labels — they appear in span attributes only.

### Key redaction

KV keys, R2 object keys, and DO storage keys may carry PII. They are **omitted from span attributes by default**. Set `bindingCaptureKeys: true` to opt in:

```ts
instrument(handler, {
  serviceName: "my-worker",
  bindingCaptureKeys: true, // adds *.key attrs to spans — review PII implications
});
```

Attributes marked with `*` in the tables below are subject to this redaction.

---

## KV — `instrumentKV`

```ts
const kv = instrumentKV(env.SESSIONS, "SESSIONS");

await kv.get("user:123");          // span: "KV SESSIONS get"
await kv.put("user:123", value);   // span: "KV SESSIONS put"
await kv.delete("user:123");       // span: "KV SESSIONS delete"
await kv.list({ prefix: "user:" });// span: "KV SESSIONS list"
```

**Span name:** `KV <name> <op>`

| Attribute | Value |
| --- | --- |
| `cloudflare.binding.type` | `kv` |
| `cloudflare.binding.name` | value of `name` |
| `cloudflare.kv.operation` | `get` / `getWithMetadata` / `put` / `delete` / `list` |
| `cloudflare.kv.key` * | key argument (redacted by default) |

---

## D1 — `instrumentD1`

```ts
const db = instrumentD1(env.DB, "DB");

const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
// span: "D1 DB SELECT"

const rows = await db.prepare("SELECT * FROM users").all();
// span: "D1 DB SELECT"

await db.prepare("INSERT INTO events (type) VALUES (?)").bind("login").run();
// span: "D1 DB INSERT"

await db.exec("PRAGMA journal_mode=WAL");
// span: "D1 DB PRAGMA"
```

`prepare()` returns a wrapped `D1PreparedStatement`. The span opens at the terminal op (`.first()` / `.all()` / `.run()` / `.raw()`) — where actual latency lives — while the SQL text from `prepare()` is captured as `db.statement`.

`batch()` and `exec()` are spanned directly.

**Span name:** `D1 <name> <SQL-VERB>` (first token of the SQL, upper-cased)

| Attribute | Value |
| --- | --- |
| `db.system` | `cloudflare-d1` |
| `cloudflare.binding.name` | value of `name` |
| `db.operation` | SQL verb (`SELECT`, `INSERT`, …) |
| `db.statement` | full SQL text from `prepare()` |

`db.statement` captures the SQL template. **Bound parameters (`.bind(...)`) are never captured** — they may contain sensitive data.

---

## R2 — `instrumentR2`

```ts
const bucket = instrumentR2(env.ASSETS, "ASSETS");

const obj = await bucket.get("images/logo.png");  // span: "R2 ASSETS get"
await bucket.put("images/logo.png", body);         // span: "R2 ASSETS put"
await bucket.head("images/logo.png");              // span: "R2 ASSETS head"
await bucket.delete("images/logo.png");            // span: "R2 ASSETS delete"
await bucket.list({ prefix: "images/" });          // span: "R2 ASSETS list"
```

**Span name:** `R2 <name> <op>`

| Attribute | Value |
| --- | --- |
| `cloudflare.r2.bucket` | value of `name` |
| `cloudflare.r2.operation` | `get` / `put` / `head` / `delete` / `list` / `createMultipartUpload` |
| `cloudflare.r2.key` * | key argument (redacted by default) |

**Streaming caveat:** the span covers the `get()` promise latency only — the time until `R2ObjectBody` is resolved. The returned body stream is **not** consumed or traced. You can read `obj.body` normally; the span is already ended.

---

## Queue (producer) — `instrumentQueue`

```ts
const queue = instrumentQueue(env.JOBS, "JOBS");

await queue.send({ type: "email", to: "user@example.com" });
// span: "QUEUE JOBS send"

await queue.sendBatch([
  { body: { type: "email", to: "a@example.com" } },
  { body: { type: "sms",   to: "+1555…" } },
]);
// span: "QUEUE JOBS sendBatch"
```

**Span name:** `QUEUE <name> send` or `QUEUE <name> sendBatch`

| Attribute | Value |
| --- | --- |
| `messaging.system` | `cloudflare-queues` |
| `messaging.destination.name` | value of `name` |
| `messaging.operation` | `send` / `sendBatch` |
| `messaging.batch.message_count` | number of messages (`sendBatch` only) |

This wraps the **producer** side only. Consumer-side tracing (the `queue` handler) is handled automatically by `instrument()`.

---

## Durable Object storage — `instrumentDOStorage`

Wrap `state.storage` inside the Durable Object constructor:

```ts
import { instrumentDOStorage } from "@tigorhutasuhut/telemetry-js/cloudflare";

export class MyDO implements DurableObject {
  private storage: DurableObjectStorage;

  constructor(private state: DurableObjectState, private env: Env) {
    this.storage = instrumentDOStorage(state.storage, "MyDO");
  }

  async fetch(request: Request) {
    await this.storage.put("last-seen", Date.now());
    // span: "DO MyDO put"
    const count = await this.storage.get<number>("visit-count") ?? 0;
    // span: "DO MyDO get"
    await this.storage.put("visit-count", count + 1);
    return new Response(`Visits: ${count + 1}`);
  }
}
```

**Span name:** `DO <name> <op>`

| Attribute | Value |
| --- | --- |
| `cloudflare.do.storage.operation` | `get` / `put` / `delete` / `list` / `deleteAll` |
| `cloudflare.do.key` * | key argument (redacted by default) |

---

## Full example — combining wrappers

```ts
import { instrument, instrumentKV, instrumentD1 } from "@tigorhutasuhut/telemetry-js/cloudflare";

export default instrument(
  {
    async fetch(request, env, ctx) {
      const kv = instrumentKV(env.SESSIONS, "SESSIONS");
      const db = instrumentD1(env.DB, "DB");

      const session = await kv.get("session:abc");
      // span: "KV SESSIONS get" → child of root request span

      const user = await db
        .prepare("SELECT id, name FROM users WHERE session = ?")
        .bind(session)
        .first();
      // span: "D1 DB SELECT" → child of root request span

      return Response.json(user);
    },
  },
  (env, trigger) => ({
    serviceName: "my-worker",
    exporterEndpoint: env.OTEL_ENDPOINT,
    exporterHeaders: { Authorization: `Bearer ${env.OTEL_TOKEN}` },
  }),
);
```

Both binding spans appear as children of the root `fetch` span — same trace ID, full distributed trace.
