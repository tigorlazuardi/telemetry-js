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
- `initSDK(config)` — initialize the SDK; returns `SDKResult` directly (never throws). Use: `const sdk = initSDK({ ... })`
- `sdk.shutdown()` — graceful shutdown on process exit
- `withTrace(fn, opts?)` — wrap a function in a span; span name auto-detected from function name

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
- `sdk.shutdown()` — graceful shutdown in server stop/signal handler
- `withTrace(fn, opts?)` — wrap a function in a span; span name auto-detected from function name

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

Primary import path: `@tigorhutasuhut/telemetry-js/cloudflare`

Key APIs:
- `instrument(worker)` — wrap the Worker default export
- `traceHandler({ serviceName, request, context, env, handler })` — trace individual fetch/scheduled handlers; takes an options object
- `withTrace(fn, opts?)` — wrap a function in a span; span name auto-detected from function name
- Never use Node.js `http`/`https` in Workers

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

Entry file import order (critical):
1. `import { instrumentFetch } from '@tigorhutasuhut/telemetry-js/browser/fetch'` — MUST be first
2. All other imports follow

Key APIs:
- `initSDK(config)` from `@tigorhutasuhut/telemetry-js/browser` — lazy init; returns `Promise<SDKResult>` (never throws). Use: `const sdk = await initSDK({ ... })`
- `withTrace(fn, opts?)` — wrap a function in a span; span name auto-detected from function name
- React helpers: `@tigorhutasuhut/telemetry-js/browser/react`

Full API reference and usage examples:
https://tigorlazuardi.github.io/telemetry-js/_llms-txt/browser-usage.txt

Full SDK reference (all runtimes):
https://tigorlazuardi.github.io/telemetry-js/llms.txt
```

## Step 4: Confirm

Report back:
- Detected runtime
- Files written (full relative paths)
- The llms.txt URL for the detected runtime (load it with WebFetch or share it for the user to reference)
