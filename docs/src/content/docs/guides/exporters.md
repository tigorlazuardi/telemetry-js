---
title: Fetch-Based Exporters
description: Custom fetch-based OTLP exporters used by Cloudflare Workers and browser subpaths, available for direct use.
---

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
