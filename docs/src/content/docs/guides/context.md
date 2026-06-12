---
title: Context — Cancellation, Timeouts & Deadlines
description: Go-style context utilities built on AbortSignal and OTel context propagation for cancellation, timeouts, deadlines, and value passing.
---

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

## Values

Store and retrieve arbitrary values through the OTel context using symbol keys:

```ts
const USER_KEY = Symbol("user");

withValue(USER_KEY, { id: "alice" }, () => {
  const user = getValue(USER_KEY); // { id: "alice" }
});
```

Values are scoped — inner calls shadow outer ones with the same key, and the outer value is restored when the inner scope exits.

## Cancellation

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

## Async Race Semantics

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

## Signal Nesting

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

## External Signals — `withAbortSignal`

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

## Detaching — `withoutCancel`

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

## Cloudflare `waitUntil` Caveat

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

## `isCanceled` / `getSignal`

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
