---
title: Resource Validation
description: The SDK validates OTel Resource attributes and emits warnings for missing or default service.name, deployment environment, and service namespace.
---

The SDK validates the OpenTelemetry `Resource` and emits warnings for missing attributes:

| Attribute | Required | Fallback |
| --- | --- | --- |
| `service.name` | Yes | Warns if missing or `unknown_service` |
| `deployment.environment.name` | Recommended | Auto-set to `"local"` when stderr is a TTY |
| `service.namespace` | Recommended | Auto-set to `"local"` when stderr is a TTY |

Set these via `OTEL_RESOURCE_ATTRIBUTES` or `config.resourceAttributes`:

```env
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production,service.namespace=my-team
```
