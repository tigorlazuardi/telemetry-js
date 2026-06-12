---
name: telemetry-js-setup
description: Set up telemetry-js in a consumer project — detects runtime, generates .claude/rules and usage skill pointing at the matching llms.txt set.
---

# Skill: telemetry-js setup

When invoked, do the following steps in order.

## Step 1: Detect runtime

Read `package.json` from the project root. Inspect `dependencies`, `devDependencies`, and `peerDependencies` combined. Apply these rules in priority order (first match wins):

1. Has `@cloudflare/workers-types` or `wrangler` → **cloudflare**
2. Has `bun-types` or `@types/bun` → **bun**
3. Has `react` or `react-dom` → **browser**
4. Has `vite` but not `react` → **browser**
5. Default → **node**

Store the detected runtime for use in the next steps.

## Step 2: Generate `.claude/rules/telemetry-js-<runtime>.md`

Create `.claude/rules/telemetry-js-<runtime>.md` (replace `<runtime>` with the detected value). Use `paths: ["**/*.ts", "**/*.tsx"]` frontmatter. If the file already exists, overwrite it (idempotent).

### node rules

```markdown
---
paths: ["**/*.ts", "**/*.tsx"]
---

# telemetry-js — Node.js rules

- Import SDK from `@tigorhutasuhut/telemetry-js/node`
- Initialize with `initSDK(config)` at process startup, before any instrumented code runs
- Graceful shutdown: call `await sdk.shutdown()` on SIGTERM/SIGINT
- `initSDK(config)` returns `SDKResult` directly — it never throws (returns a noop result on failure). Use it directly: `const sdk = initSDK({ ... })`
- `withTrace(fn, opts?)` is available from `@tigorhutasuhut/telemetry-js/node` — first arg is the callback, span name auto-detected from function name
- Use `@tigorhutasuhut/telemetry-js/context` for context propagation helpers
- Use `@tigorhutasuhut/telemetry-js/error` for error recording helpers
- Use `@tigorhutasuhut/telemetry-js/db` for database span helpers
```

### bun rules

```markdown
---
paths: ["**/*.ts", "**/*.tsx"]
---

# telemetry-js — Bun rules

- Import SDK from `@tigorhutasuhut/telemetry-js/node` (same subpath as Node.js)
- Initialize with `initSDK(config)` at server startup
- For `Bun.serve` patterns, call `initSDK` before creating the server
- Graceful shutdown: call `await sdk.shutdown()` in the server's `stop` lifecycle or signal handler
- `initSDK(config)` returns `SDKResult` directly — it never throws (returns a noop result on failure). Use it directly: `const sdk = initSDK({ ... })`
- `withTrace(fn, opts?)` is available from `@tigorhutasuhut/telemetry-js/node` — first arg is the callback, span name auto-detected from function name
- Use `@tigorhutasuhut/telemetry-js/context` for context propagation helpers
- Use `@tigorhutasuhut/telemetry-js/error` for error recording helpers
- Use `@tigorhutasuhut/telemetry-js/db` for database span helpers
```

### cloudflare rules

```markdown
---
paths: ["**/*.ts", "**/*.tsx"]
---

# telemetry-js — Cloudflare Workers rules

- Import SDK from `@tigorhutasuhut/telemetry-js/cloudflare`
- Use `instrument()` to wrap the Worker export and `traceHandler({ serviceName, request, context, env, handler })` for individual handlers
- Never use Node.js `http`/`https` modules — Cloudflare Workers do not support them
- `instrument` and `traceHandler` handle lifecycle automatically; no manual shutdown needed
- `initSDK(config)` returns `SDKResult` directly — it never throws (returns a noop result on failure). Use it directly: `const sdk = initSDK({ ... })`
- `withTrace(fn, opts?)` is available from `@tigorhutasuhut/telemetry-js/cloudflare` — first arg is the callback, span name auto-detected from function name
- Use `@tigorhutasuhut/telemetry-js/context` for context propagation helpers
- Use `@tigorhutasuhut/telemetry-js/error` for error recording helpers
- Use `@tigorhutasuhut/telemetry-js/db` for database span helpers
```

### browser rules

```markdown
---
paths: ["**/*.ts", "**/*.tsx"]
---

# telemetry-js — Browser rules

- Import `instrumentFetch` from `@tigorhutasuhut/telemetry-js/browser/fetch` FIRST — before any other imports in your entry file (side-effect: patches globalThis.fetch)
- Import `initSDK` lazily from `@tigorhutasuhut/telemetry-js/browser` after fetch is instrumented
- `initSDK(config)` returns `Promise<SDKResult>` — must `await`. It never throws (returns a noop result on failure). Use: `const sdk = await initSDK({ ... })`
- `withTrace(fn, opts?)` is available from `@tigorhutasuhut/telemetry-js/browser` — first arg is the callback, span name auto-detected from function name
- For React component tracing, use helpers from `@tigorhutasuhut/telemetry-js/browser/react`
- Use `@tigorhutasuhut/telemetry-js/context` for context propagation helpers
- Use `@tigorhutasuhut/telemetry-js/error` for error recording helpers
- Do not call `sdk.shutdown()` in browser — page unload handles cleanup automatically
```

## Step 3: Generate `.claude/skills/telemetry-js-usage/SKILL.md`

Ensure `.claude/skills/telemetry-js-usage/` directory exists. If the skill file already exists, update it in place (idempotent — do not append, do not duplicate). Use the runtime detected in Step 1.

### node skill content

```markdown
---
name: telemetry-js-usage
description: telemetry-js usage guidance for Node.js — SDK init, tracing, error helpers, context propagation.
---

# telemetry-js usage — Node.js

Primary import path: `@tigorhutasuhut/telemetry-js/node`

Key APIs:
- `initSDK(config)` — initialize at process startup, before any instrumented code; returns `SDKResult` directly (never throws). Use: `const sdk = initSDK({ ... })`
- `sdk.shutdown()` — graceful shutdown; call on `SIGTERM`/`SIGINT`
- `withTrace(fn, opts?)` — wrap a function in a span; span name auto-detected from function name; first arg is the callback
- Use `@tigorhutasuhut/telemetry-js/context` for context propagation helpers
- Use `@tigorhutasuhut/telemetry-js/error` for error recording helpers
- Use `@tigorhutasuhut/telemetry-js/db` for database span helpers

Full API reference and usage examples:
https://tigorlazuardi.github.io/telemetry-js/_llms-txt/node-usage.txt

Full SDK reference (all runtimes):
https://tigorlazuardi.github.io/telemetry-js/llms.txt
```

### bun skill content

```markdown
---
name: telemetry-js-usage
description: telemetry-js usage guidance for Bun — SDK init, Bun.serve patterns, tracing, error helpers.
---

# telemetry-js usage — Bun

Primary import path: `@tigorhutasuhut/telemetry-js/node` (shared with Node.js)

Key APIs:
- `initSDK(config)` — initialize before `Bun.serve`; returns `SDKResult` directly (never throws). Use: `const sdk = initSDK({ ... })`
- `sdk.shutdown()` — graceful shutdown in the server `stop` lifecycle or signal handler
- `withTrace(fn, opts?)` — wrap a function in a span; span name auto-detected from function name; first arg is the callback
- Use `@tigorhutasuhut/telemetry-js/context` for context propagation helpers
- Use `@tigorhutasuhut/telemetry-js/error` for error recording helpers
- Use `@tigorhutasuhut/telemetry-js/db` for database span helpers

Full API reference and usage examples:
https://tigorlazuardi.github.io/telemetry-js/_llms-txt/bun-usage.txt

Full SDK reference (all runtimes):
https://tigorlazuardi.github.io/telemetry-js/llms.txt
```

### cloudflare skill content

```markdown
---
name: telemetry-js-usage
description: telemetry-js usage guidance for Cloudflare Workers — instrument(), traceHandler(), no Node.js http.
---

# telemetry-js usage — Cloudflare Workers

Primary import path: `@tigorhutasuhut/telemetry-js/cloudflare` (not the bare package name — no bare entry point exists)

Key APIs:
- `instrument(handler, opts?)` — wrap the full `ExportedHandler`; supports `fetch`, `scheduled`, `queue`; accepts static config or per-request factory function
- `traceHandler({ serviceName, request, context, env, handler, onFlush? })` — trace individual fetch handlers; use in SvelteKit/Remix/Pages where you have `Request` + `ExecutionContext` but not the full `ExportedHandler` pattern
- `withTrace(fn, opts?)` — wrap a function in a child span; span name auto-detected from function name; note: reports 0 ms for pure CPU work (no I/O) due to Spectre mitigation
- `initSDK(config)` — initialize once per isolate, not per request; returns `SDKResult` (never throws); use a module-level singleton (`ensureTelemetry()` pattern)
- Never use Node.js `http`/`https` in Workers
- Spans flush via `ctx.waitUntil` — never block the response
- W3C Trace Context (`traceparent`/`tracestate`) extracted from incoming headers and injected into response headers automatically
- 5xx responses and thrown exceptions automatically set `ERROR` span status
- Use `@tigorhutasuhut/telemetry-js/context` for context propagation helpers
- Use `@tigorhutasuhut/telemetry-js/error` for error recording helpers
- Use `@tigorhutasuhut/telemetry-js/db` for database span helpers

Full API reference and usage examples:
https://tigorlazuardi.github.io/telemetry-js/_llms-txt/cloudflare-usage.txt

Full SDK reference (all runtimes):
https://tigorlazuardi.github.io/telemetry-js/llms.txt
```

### browser skill content

```markdown
---
name: telemetry-js-usage
description: telemetry-js usage guidance for browser — instrumentFetch import order, lazy initSDK, React helpers.
---

# telemetry-js usage — Browser

Entry file import order (critical — side-effect patches globalThis.fetch):
1. `import { instrumentFetch } from '@tigorhutasuhut/telemetry-js/browser/fetch'` — MUST be first, before any other imports
2. All other imports follow

Key APIs:
- `initSDK(config)` from `@tigorhutasuhut/telemetry-js/browser` — lazy init after fetch is instrumented; returns `Promise<SDKResult>` (never throws). Use: `const sdk = await initSDK({ ... })`
- `withTrace(fn, opts?)` — wrap a function in a span; span name auto-detected from function name; first arg is the callback
- React helpers: `@tigorhutasuhut/telemetry-js/browser/react` for component tracing
- Do NOT call `sdk.shutdown()` in browser — page unload handles cleanup automatically
- Use `@tigorhutasuhut/telemetry-js/context` for context propagation helpers
- Use `@tigorhutasuhut/telemetry-js/error` for error recording helpers

Full API reference and usage examples:
https://tigorlazuardi.github.io/telemetry-js/_llms-txt/browser-usage.txt

Full SDK reference (all runtimes):
https://tigorlazuardi.github.io/telemetry-js/llms.txt
```

## Step 3b: Cloudflare instrumentation skill (cloudflare runtime only)

**Only run this step when the runtime detected in Step 1 is `cloudflare`.**

Ask the user interactively: **"Install dedicated Cloudflare instrumentation skill? (y/n)"**

- **On yes:** Ensure `.claude/skills/telemetry-js-cloudflare/` directory exists. Write `.claude/skills/telemetry-js-cloudflare/SKILL.md` with the content below. Overwrite if the file already exists (idempotent).
- **On no:** Skip — do not write anything.

<!-- keep in sync with skills/telemetry-js-cloudflare/SKILL.md -->

````markdown
---
name: telemetry-js-cloudflare
description: Cloudflare Workers instrumentation best practices for telemetry-js — instrument(), traceHandler(), per-isolate init, no Node http
---

<!-- Canonical source — keep in sync with the embedded CF block in skills/telemetry-js/SKILL.md -->

# telemetry-js — Cloudflare Workers instrumentation

## Import path

**Always import from `@tigorhutasuhut/telemetry-js/cloudflare`** — not the bare package name.

```ts
import { instrument, traceHandler, withTrace, initSDK } from "@tigorhutasuhut/telemetry-js/cloudflare";
```

The bare package `@tigorhutasuhut/telemetry-js` has no default export; there is no bare entry point. The `package.json` exports map exposes `./cloudflare` as the subpath for all Cloudflare APIs.

## Two entry points

| API | Use case |
|-----|----------|
| `instrument()` | Cloudflare Workers — wraps a full `ExportedHandler` (`fetch`, `scheduled`, `queue`) |
| `traceHandler()` | SvelteKit / Remix / Cloudflare Pages — per-request tracing when you have `Request` + `ExecutionContext` but not `ExportedHandler` |

Both automatically:
- Create a `SERVER` span with HTTP attributes for every request
- Extract incoming W3C Trace Context (`traceparent` / `tracestate`) from request headers
- Inject `traceparent` / `tracestate` into response headers
- Flush spans via `ctx.waitUntil` — never blocks the response
- Set `ERROR` span status on 5xx responses or thrown exceptions

## `instrument()` — Cloudflare Worker

Wraps the full `ExportedHandler`. Static config object or per-request factory function.

**Static config (simple):**

```ts
// src/index.ts
import { instrument } from "@tigorhutasuhut/telemetry-js/cloudflare";

export default instrument(
  {
    async fetch(request, env, ctx) {
      return new Response("Hello from Worker");
    },
    async scheduled(controller, env, ctx) {
      // cron job logic
    },
  },
  { serviceName: "my-worker", exporterEndpoint: "https://otel.example.com" },
);
```

**Factory form — secrets from `env` (preferred for tokens):**

```ts
import { instrument } from "@tigorhutasuhut/telemetry-js/cloudflare";

export default instrument(
  { async fetch(request, env, ctx) { return new Response("Hello"); } },
  (env, trigger) => ({
    serviceName: "my-worker",
    exporterEndpoint: env.OTEL_ENDPOINT,
    exporterHeaders: { Authorization: `Bearer ${env.OTEL_TOKEN}` },
  }),
);
```

## `traceHandler()` — SvelteKit / Pages

For frameworks that provide `Request` + `ExecutionContext` but not the full `ExportedHandler` pattern.

```ts
import { traceHandler } from "@tigorhutasuhut/telemetry-js/cloudflare";

// Inside SvelteKit hooks.server.ts
export const handle: Handle = async ({ event, resolve }) => {
  return traceHandler({
    serviceName: "my-sveltekit-app",
    context: event.platform?.ctx,
    env: event.platform?.env ?? {},
    request: event.request,
    handler: () => resolve(event),
  });
};
```

## Initialize once per isolate — NOT per request

Cloudflare Workers run in isolates that are reused across many requests. Initialize the SDK once at module scope or via a singleton, not inside the request handler.

```ts
// src/lib/server/telemetry.ts
import { initSDK, type SDKResult } from "@tigorhutasuhut/telemetry-js/cloudflare";

let sdk: SDKResult | null = null;

export function ensureTelemetry(): SDKResult {
  if (!sdk) {
    sdk = initSDK({
      serviceName: "my-sveltekit-app",
      runtime: "cloudflare-worker",
      exporterEndpoint: "https://otel.example.com",
    });
  }
  return sdk;
}
```

Then in `hooks.server.ts`:

```ts
import { traceHandler } from "@tigorhutasuhut/telemetry-js/cloudflare";
import { ensureTelemetry } from "$lib/server/telemetry";

export const handle: Handle = async ({ event, resolve }) => {
  const sdk = ensureTelemetry();

  return traceHandler({
    serviceName: "my-sveltekit-app",
    context: event.platform?.ctx,
    env: event.platform?.env ?? {},
    request: event.request,
    handler: () => resolve(event),
    onFlush: () => sdk.forceFlush(),
  });
};
```

## `withTrace()` — inner spans

Wrap any async/sync function in a child span. Span name is auto-detected from the function name.

```ts
import { withTrace } from "@tigorhutasuhut/telemetry-js/cloudflare";

const result = await withTrace(async function fetchUser(span) {
  span.setAttribute("user.id", userId);
  return db.query(userId);
});

// Explicit name + attributes
const data = withTrace(
  (span) => compute(span),
  { name: "heavy-computation", attributes: { "input.size": "42" } },
);
```

**Workers caveat:** `performance.now()` only advances after I/O (Spectre mitigation). `withTrace` on pure CPU work will report 0 ms duration. Use it for operations that involve at least one I/O call.

## SvelteKit on Cloudflare Pages — full setup

### 1. Type `App.Platform` in `src/app.d.ts`

```ts
declare global {
  namespace App {
    interface Platform {
      env: {
        // your KV / D1 / Durable Object bindings
      };
      ctx: ExecutionContext;
    }
  }
}

export {};
```

### 2. Singleton init helper

See "Initialize once per isolate" above — create `src/lib/server/telemetry.ts` with `ensureTelemetry()`.

### 3. Server hook

Use `traceHandler` inside `handle`. Place telemetry first in `sequence()` so every downstream hook is inside the span:

```ts
import { sequence } from "@sveltejs/kit/hooks";
import { traceHandler } from "@tigorhutasuhut/telemetry-js/cloudflare";
import { ensureTelemetry } from "$lib/server/telemetry";

const telemetry: Handle = async ({ event, resolve }) => {
  const sdk = ensureTelemetry();
  return traceHandler({
    serviceName: "my-sveltekit-app",
    context: event.platform?.ctx,
    env: event.platform?.env ?? {},
    request: event.request,
    handler: () => resolve(event),
    onFlush: () => sdk.forceFlush(),
  });
};

const auth: Handle = async ({ event, resolve }) => {
  // auth logic
  return resolve(event);
};

export const handle = sequence(telemetry, auth);
```

## Rules

- Never import `http` or `https` from Node.js — Cloudflare Workers do not support them
- Never block the response waiting for span export — `ctx.waitUntil` handles flushing
- Initialize SDK once per isolate, not per request
- `initSDK` / `instrument` / `traceHandler` never throw — they return noop results on failure
- Use `@tigorhutasuhut/telemetry-js/context` for context propagation helpers
- Use `@tigorhutasuhut/telemetry-js/error` for error recording helpers
- Use `@tigorhutasuhut/telemetry-js/db` for database span helpers

## References

- Full Cloudflare usage reference: https://tigorlazuardi.github.io/telemetry-js/_llms-txt/cloudflare-usage.txt
- Full SDK reference (all runtimes): https://tigorlazuardi.github.io/telemetry-js/llms.txt
````

## Step 4: Confirm

Report back:
- Detected runtime
- Files written (full relative paths)
- The llms.txt URL for the detected runtime (load it with WebFetch or share it for the user to reference)
- Whether the Cloudflare instrumentation skill was installed (cloudflare runtime only)
