---
title: Logger
description: Structured logger with dual output to stderr and OTLP, included in every SDKResult with automatic log-trace correlation.
---

Every `SDKResult` includes a structured `logger` with dual output:

- **stderr** — pino (if installed), built-in JSON formatter, or `console[level]` (Cloudflare / Browser)
- **OTLP** — emits log records via the global `LoggerProvider` when a logs endpoint resolves

```ts
import { initSDK } from "@tigorhutasuhut/telemetry-js/node";

const { logger } = initSDK({
  serviceName: "my-api",
  exporterEndpoint: "https://otel.example.com",
});

logger.info("request handled", { method: "GET", path: "/api/users" });
logger.error("database connection failed", { host: "db.example.com" });
logger.debug("cache miss", { key: "user:123" }, { timestamp: Date.now() });
```

Log-trace correlation is automatic — `traceId` and `spanId` from the active span are included in every log record.
