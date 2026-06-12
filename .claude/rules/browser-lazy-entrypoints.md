---
paths:
  - src/browser/**/*.ts
---

# Browser entrypoints: maximize code-splitting + lazy loading

Browser code MUST keep heavy dependencies out of the eager/initial chunk. No
import from a browser entrypoint may cause `@opentelemetry/*` SDK code to load
before it is actually needed.

## Non-negotiables

- **Eager facade is dependency-free.** The always-loaded entry (`src/browser/index.ts`)
  MUST have **zero `@opentelemetry/*` static import**. Verify the *compiled*
  output: `! grep -n "@opentelemetry" dist/browser/index.js`. Type-only
  re-exports (`export type { … } from "@opentelemetry/api"`) are fine — they
  erase at build.
- **Heavy code only behind `await import()`.** The SDK adapter, exporters
  (`shared/exporters.ts` → `otlp-transformer`), real logger (`shared/logger.ts`),
  and instrumentation (`shared/action`/`with-trace`/`traced`/`context`) load
  lazily through a single dynamic-import boundary (`internal/real.ts`), never via
  a top-level `import … from`.
- **Do NOT statically import `shared/noop.ts` from the facade** — it pulls
  `@opentelemetry/api` + `resources`. Failure/fallback paths use a pure-JS
  passthrough result instead.
- **Passthrough before init.** Public API (`withTrace`/`traced`/`withAction`/
  `scopeAction`/`injectContext`/`logger`) MUST work synchronously before the SDK
  is loaded: run the user fn and return its value (no span), logger is silent.
  Wrapper signatures stay synchronous (`T`, not `Promise<T>`). `initSDK` triggers
  the lazy load and swaps the passthrough impl for the real one.
- **New runtime deps in a browser entry are guilty until proven split.** Anything
  added must sit behind a dynamic import or have a size-limit budget proving it
  does not bloat the eager chunk.

## Guarding it

A `size-limit` budget gates `/browser` (hard cap + zero-OTel assertion) and the
other browser subpaths. Adding weight to the eager chunk fails CI — fix by moving
the dependency behind `await import()`, not by raising the budget.
