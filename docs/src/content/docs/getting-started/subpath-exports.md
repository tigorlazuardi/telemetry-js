---
title: Subpath Exports
description: Which subpath to import for each runtime
sidebar:
  order: 2
---

Import from the subpath that matches your runtime. Each subpath only bundles the adapter code for that runtime — the others are never pulled in.

## Subpaths

| Subpath | Runtime | Description |
| --- | --- | --- |
| `@tigorhutasuhut/telemetry-js/cloudflare` | Cloudflare Workers | Full SDK with fetch-based exporters |
| `@tigorhutasuhut/telemetry-js/node` | Node.js / Bun | Full SDK with OTel HTTP exporters |
| `@tigorhutasuhut/telemetry-js/browser` | Browser (Vite, etc.) | Lazy facade — pure-JS eager chunk, heavy SDK loads on `initSDK()` |
| `@tigorhutasuhut/telemetry-js/browser/fetch` | Browser | Lightweight `instrumentFetch()` only (~2 KB, zero OTel deps at import time) |
| `@tigorhutasuhut/telemetry-js/error` | All | `AppError` class for structured application errors |
| `@tigorhutasuhut/telemetry-js/db` | All | `withQueryName` / `getQueryName` for query naming via OTel context |
| `@tigorhutasuhut/telemetry-js/context` | All | Go-style context: cancellation, timeouts, deadlines, values |

## Tree-shaking

Each subpath is self-contained. Importing from `/node` does not pull in the Cloudflare or browser adapters — and vice versa. Bundlers (Vite, esbuild, webpack, etc.) can eliminate any runtime you do not import.

The `/browser/fetch` subpath is especially lightweight: it is ~2 KB with zero `@opentelemetry` imports at the top level. The heavy OTel code loads lazily on first use.

## Breaking change — v1.0.0

The root import `@tigorhutasuhut/telemetry-js` is removed as of v1.0.0. Use a runtime-specific subpath instead:

```ts
// Before (no longer works)
import { initSDK } from "@tigorhutasuhut/telemetry-js";

// After
import { initSDK } from "@tigorhutasuhut/telemetry-js/node";
```

Also note: `FetchTraceExporter`, `FetchMetricExporter`, `FetchLogExporter`, `metrics`, and related logger utilities moved from `/browser` to `/browser/sdk` in v1.12. Update direct imports from `/browser` to `/browser/sdk`.
