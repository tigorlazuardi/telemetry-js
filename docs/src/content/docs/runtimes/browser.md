---
title: Browser
description: Using telemetry-js in the browser (Vite, React)
sidebar:
  order: 4
---

The browser runtime uses a **lazy facade pattern** to keep your initial bundle small. Heavy OTel SDK code loads only after `initSDK()` is called, not at import time.

## Subpaths

| Subpath | Purpose | Bundle cost |
| --- | --- | --- |
| `@tigorhutasuhut/telemetry-js/browser/fetch` | `instrumentFetch()` only — patches `globalThis.fetch` | ~2 KB, zero OTel deps at import time |
| `@tigorhutasuhut/telemetry-js/browser` | `initSDK()`, `withTrace()`, lazy facade | Pure JS; heavy chunk loads on `initSDK()` |
| `@tigorhutasuhut/telemetry-js/browser/react` | `useScopeAction()`, `useAction()` React hooks | Eagerly imports `react` only; OTel loads lazily on first render |
| `@tigorhutasuhut/telemetry-js/browser/sdk` | Direct exporter/provider access for power users | Full OTel weight |

The recommended API surface is `instrumentFetch` + `initSDK` + the React hooks. Import from `/browser/sdk` only when you need direct access to exporters or `StackContextManager`.

## Setup

### Two-phase initialisation

Libraries like Hono `hc`, better-auth, and TanStack Query may capture a reference to `globalThis.fetch` at **module load time**. If the SDK patches `fetch` after those modules load, outgoing requests bypass instrumentation silently.

The solution is to split initialisation into two phases:

1. **Eager phase** — call `instrumentFetch()` as the very first import in your entry point. This patches `globalThis.fetch` synchronously before any other module runs.
2. **Lazy phase** — call `initSDK()` via a dynamic `import()` so the heavy OTel chunk does not block the initial render.

### Environment variables

Define these in your `.env` file (Vite replaces `import.meta.env.VITE_*` at build time):

```env
VITE_OTEL_SERVICE_NAME=my-spa
VITE_OTLP_ENDPOINT=https://otel.example.com
VITE_OTEL_DEPLOYMENT_ENV=production
VITE_OTEL_SERVICE_NAMESPACE=my-team
```

### React hooks peer dependency

`browser/react` requires React 18+. Install it as a peer dependency if it is not already present:

```bash
pnpm add react
```

## Example

### `main.tsx` — entry point

```tsx
// main.tsx

// 1. EAGER — patch globalThis.fetch synchronously, before ANY other import.
//    ~2 KB, zero @opentelemetry deps at import time. OTel tracing code is
//    loaded lazily via dynamic import() on the first fetch() call — by then
//    the browser has cached all chunks, so tracing kicks in instantly.
import { instrumentFetch } from "@tigorhutasuhut/telemetry-js/browser/fetch";
instrumentFetch();

// 2. LAZY — full SDK setup, fire-and-forget.
//    Registers TracerProvider, propagators, and exporters.
//    Detects that instrumentFetch() was already called and skips re-patching.
import("./lib/telemetry").then(({ initTelemetry }) =>
  initTelemetry({
    endpoint: import.meta.env.VITE_OTLP_ENDPOINT,
    enabled: true,
  }),
);

// ... rest of your app (React root, router, etc.)
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
```

### `lib/telemetry.ts` — SDK wrapper

```ts
import { initSDK, type SDKConfig } from "@tigorhutasuhut/telemetry-js/browser";

export async function initTelemetry(config: { endpoint: string; enabled?: boolean }) {
  if (!config.enabled) return;

  await initSDK({
    serviceName: import.meta.env.VITE_OTEL_SERVICE_NAME ?? "my-spa",
    exporterEndpoint: config.endpoint,
    dev: import.meta.env.DEV, // console output in dev, silent in prod
    resourceAttributes: {
      "deployment.environment.name": import.meta.env.VITE_OTEL_DEPLOYMENT_ENV,
      "service.namespace": import.meta.env.VITE_OTEL_SERVICE_NAMESPACE,
    },
  });
}
```

Before `initSDK` resolves, the OTel API returns a noop tracer — `fetch` works normally, just without tracing. Once the provider is up, every subsequent `fetch` call produces real `CLIENT` spans with W3C `traceparent`/`tracestate` header injection.

### React hook usage — `useScopeAction`

`useScopeAction(scope)` returns an async scoped action pre-filled with page and component context:

```tsx
import { useScopeAction } from "@tigorhutasuhut/telemetry-js/browser/react";

function LoginForm() {
  // Pre-fills ui.page (from the router) and ui.component ("LoginForm")
  const action = useScopeAction("LoginForm");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);

    await action("user.login", async () => {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: data.get("email"), password: data.get("password") }),
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error("Login failed");
      return res.json();
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <input name="email" type="email" />
      <input name="password" type="password" />
      <button type="submit">Log in</button>
    </form>
  );
}
```

### `useAction` — ad-hoc one-off runner

When you do not have a fixed component scope, use `useAction()`:

```tsx
import { useAction } from "@tigorhutasuhut/telemetry-js/browser/react";

function FileUpload() {
  const runAction = useAction();

  async function handleUpload(file: File) {
    await runAction("file.upload", async () => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      if (!res.ok) throw new Error("Upload failed");
      return res.json();
    });
  }

  return <input type="file" onChange={(e) => e.target.files?.[0] && handleUpload(e.target.files[0])} />;
}
```

Both hooks load their underlying OTel code (`scopeAction` / `withAction`) lazily on first render. If an action fires before the lazy load completes, the call awaits it then runs — the React bundle stays minimal.

## Power users — `/browser/sdk`

Direct exporter and provider access is available from the dedicated heavy subpath:

```ts
import {
  FetchTraceExporter,
  FetchMetricExporter,
  FetchLogExporter,
  StackContextManager,
} from "@tigorhutasuhut/telemetry-js/browser/sdk";
```

:::note[v1.12 migration]
`FetchTraceExporter`, `FetchMetricExporter`, `FetchLogExporter`, `metrics`, and related logger utilities **moved from `/browser` to `/browser/sdk`** in v1.12. If you were importing them directly from `/browser`, update your imports to `/browser/sdk`.
:::

## UI action metrics

`useScopeAction` and `useAction` automatically emit two OTel metrics when a metrics endpoint is configured — no extra setup needed:

| Metric | Instrument | Unit | Description |
| --- | --- | --- | --- |
| `ui.action.duration` | Histogram | `s` | Time from action start to settle |
| `ui.action.active` | UpDownCounter | `{action}` | In-flight actions gauge |

When no metrics endpoint is configured, these go to a noop meter — always safe to leave in.

> **Cardinality:** use route **templates** for `ui.page` (e.g. `/users/:id`), never raw paths with user IDs or other high-cardinality values. Per-call free-form `attributes` are recorded on the span only and intentionally excluded from metrics.
