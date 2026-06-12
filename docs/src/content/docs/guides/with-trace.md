---
title: withTrace — Manual Span Creation
description: Wrap any function in an OpenTelemetry span using withTrace, with auto-detected span names and signal integration.
---

`withTrace` wraps a function in an OpenTelemetry span. It is re-exported from every runtime subpath (`/cloudflare`, `/node`, `/browser`).

```ts
import { withTrace } from "@tigorhutasuhut/telemetry-js/node";

const user = await withTrace(async function fetchUser(span) {
  span.setAttribute("user.id", id);
  return db.users.find(id);
});
```

The span name is auto-detected from the function name (or caller file:line for anonymous functions). Override it with `opts.name`.

## Options

| Option | Type | Description |
| --- | --- | --- |
| `name` | `string` | Override auto-detected span name |
| `kind` | `SpanKind` | Span kind (default: `INTERNAL`) |
| `attributes` | `Record<string, string>` | Initial span attributes |
| `component` | `string` | Prefix span name with component (also sets `ui.component`) |
| `parent` | `Span \| string` | Parent span or W3C `traceparent` string |
| `carrier` | `unknown` | Opaque carrier for textmap propagation (e.g. incoming headers) |
| `signal` | `AbortSignal` | AbortSignal to propagate through the OTel context |

## Signal Integration

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
