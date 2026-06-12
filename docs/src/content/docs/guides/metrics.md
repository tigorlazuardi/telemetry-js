---
title: Metrics
description: Enable OTel metrics with a configured metrics endpoint and use the metrics API to create instruments.
---

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
