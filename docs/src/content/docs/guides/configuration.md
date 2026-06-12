---
title: Configuration Options
description: Full reference for all SDK configuration options accepted by initSDK and instrument across all runtimes.
---

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `serviceName` | `string` | `"unknown"` | Logical service name in every span |
| `exporterEndpoint` | `string` | — | Base OTLP endpoint; SDK appends `/v1/{signal}` |
| `exporterHeaders` | `Record<string, string>` | — | Headers for OTLP requests (e.g. auth) |
| `resourceAttributes` | `Record<string, string>` | — | Extra Resource attributes |
| `tracesExporterEndpoint` | `string` | — | Signal-specific traces endpoint (full URL) |
| `logsExporterEndpoint` | `string` | — | Signal-specific logs endpoint (full URL) |
| `metricsExporterEndpoint` | `string` | — | Signal-specific metrics endpoint (full URL) |
| `metricsExportIntervalMs` | `number` | `60000` | Metrics collection interval (ms) |
| `instrumentations` | `unknown[]` | `[]` | OpenTelemetry instrumentations (Node only) |
| `env` | `Record<string, unknown>` | `process.env` | Env var map (for Cloudflare Workers) |
