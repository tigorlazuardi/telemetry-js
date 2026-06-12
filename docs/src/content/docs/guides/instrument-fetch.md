---
title: instrumentFetch
description: Manually patch globalThis.fetch for OTel tracing in browser and Cloudflare Workers, with getOriginalFetch for untraced export calls.
---

> **Note:** You do NOT need to call `instrumentFetch` manually in most cases.
> - **Node.js**: Use auto-instrumentation packages like `@opentelemetry/instrumentation-http`.
> - **Cloudflare Workers**: `instrument()` and `traceHandler()` automatically monkey-patch `globalThis.fetch`.
> - **Browser**: Call `instrumentFetch()` from `browser/fetch` as early as possible in your entry point (see [Quick Start — Browser](/runtimes/browser)).

## Browser

```ts
// main.tsx — FIRST import
import { instrumentFetch } from "@tigorhutasuhut/telemetry-js/browser/fetch";
instrumentFetch();
```

The `browser/fetch` subpath is ~2 KB with zero `@opentelemetry` imports at the top level. OTel tracing code is loaded lazily on first `fetch()` call. If `initSDK` is called later, it detects the existing patch and skips re-patching.

## Cloudflare Workers

For manual use outside of `instrument()` / `traceHandler()`:

```ts
import { instrumentFetch } from "@tigorhutasuhut/telemetry-js/cloudflare";

instrumentFetch(); // Patches globalThis.fetch
```

## `getOriginalFetch`

Use `getOriginalFetch()` to access the unpatched fetch (e.g. for OTLP export calls that should not be traced):

```ts
import { getOriginalFetch } from "@tigorhutasuhut/telemetry-js/cloudflare";

const originalFetch = getOriginalFetch();
await originalFetch("https://otel.example.com/v1/traces", { ... });
```
