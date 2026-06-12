---
title: Endpoint Resolution
description: How the SDK resolves OTLP endpoints per signal using environment variables and configuration options.
---

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
