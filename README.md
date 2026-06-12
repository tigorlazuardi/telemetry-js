# @tigorhutasuhut/telemetry-js

OpenTelemetry SDK setup abstraction for Node.js, Bun, Cloudflare Workers, and Browser.
One function call — tracing, metrics, and logging wired up for your runtime.

Each runtime has its own subpath export so bundlers can tree-shake unused runtimes completely.

The SDK **never throws** — on any failure it returns a noop result so your application keeps running.

## Install

```bash
pnpm add @tigorhutasuhut/telemetry-js
```

## Quick Start

```ts
import { initSDK } from "@tigorhutasuhut/telemetry-js/node";

const sdk = initSDK({
  serviceName: "my-api",
  exporterEndpoint: "https://otel.example.com",
});

sdk.logger.info("server started", { port: 3000 });
process.on("SIGTERM", () => sdk.shutdown());
```

## Subpath Exports

| Subpath | Runtime |
| --- | --- |
| `/node` | Node.js / Bun |
| `/bun` | Bun (alias for /node) |
| `/cloudflare` | Cloudflare Workers |
| `/browser` | Browser — lazy facade |
| `/browser/fetch` | Browser — lightweight fetch instrumentation only |
| `/browser/react` | React hooks |
| `/browser/sdk` | Browser — heavy SDK (exporters, providers) |
| `/error` | All — AppError |
| `/db` | All — query naming |
| `/context` | All — Go-style context (cancel/timeout/deadline) |

## Documentation

Full docs, per-runtime guides, and API reference:
**https://tigorlazuardi.github.io/telemetry-js**

### LLM-friendly docs

Use with Claude, ChatGPT, Cursor, or any AI assistant:
```
https://tigorlazuardi.github.io/telemetry-js/llms.txt
```

Per-runtime llms.txt sets available at:
- Node: `https://tigorlazuardi.github.io/telemetry-js/_llms-txt/node-usage.txt`
- Bun: `https://tigorlazuardi.github.io/telemetry-js/_llms-txt/bun-usage.txt`
- Cloudflare: `https://tigorlazuardi.github.io/telemetry-js/_llms-txt/cloudflare-usage.txt`
- Browser: `https://tigorlazuardi.github.io/telemetry-js/_llms-txt/browser-usage.txt`

## License

Apache-2.0
