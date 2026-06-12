# Browser lazy facade + SDK swap — design

**Date:** 2026-06-12
**Status:** approved (brainstorming) → ralph contract authored
**Scope:** browser-side entrypoints only. Node/Cloudflare/Bun untouched except shared `SDKConfig.dev?`.

## Problem

`@tigorhutasuhut/telemetry-js/browser` (`src/browser/index.ts`) statically imports
`browserAdapter`, which statically imports the entire `@opentelemetry/*` SDK
(`sdk-trace-base`, `sdk-metrics`, `sdk-logs`, `core`, exporters via
`shared/exporters.ts` → `@opentelemetry/otlp-transformer`, `resources`,
`semantic-conventions`). The same entry re-exports the runtime API users call
directly (`logger`, `scopeAction`/`withAction`, `traced`, `withTrace`,
`injectContext`, `metrics`, exporter classes).

Result: importing *anything* from `/browser` risks dragging the whole SDK into
the initial chunk → initial-render / first-load cost. Code-splitting defeated at
the entrypoint.

Two good lazy patterns already exist and stay: `/browser/fetch` (eager light
patch, lazy `import("./otel.js")` on first fetch) and `/browser/react` (lazy
`import("../../shared/action.js")` on first action).

## Goals

1. Maximize code-splitting + lazy loading of browser code.
2. Heavy `@opentelemetry/*` never in the initial/eager chunk — only behind
   dynamic `import()`.
3. Before the heavy SDK loads, the public API **passes through** (synchronous,
   no-throw) so callers need no init-order ceremony.
4. No initial-rendering performance hit.
5. Bundle-size **benchmark** with CI budget gate.

Breaking API / entrypoint contract is allowed but minimized.

## Design

### Architecture — facade + lazy real-impl swap

Always-loaded `/browser` becomes a **pure-JS facade** with **zero
`@opentelemetry/*` static import**. It holds mutable `impl` refs defaulting to
**passthrough**. `initSDK(config)` dynamic-imports the heavy chunk, awaits
setup, **swaps** every ref to the real impl, returns the `SDKResult`. Calls
before the swap pass through; calls after are real. One dynamic-import boundary
= one lazy chunk = clean split.

```
caller                facade (eager, pure JS)          lazy chunk (on initSDK)
withTrace(fn) ───────► impl.withTrace(fn)
   pre-init:           run fn, return T  (no span)
initSDK(cfg) ────────► import("./internal/real.js") ──► adapter + shared/action
                       await real.setup(cfg)            + with-trace + traced
                       impl = real.*  (swap)            + real logger + exporters
                       return SDKResult                 + ALL @opentelemetry
post-init:
withTrace(fn) ───────► impl.withTrace(fn) = real span
```

### Module layout

```
src/browser/
  index.ts          FACADE. pure JS. mutable impl refs. always loaded. zero OTel.
  passthrough.ts    default impls: wrappers run fn directly; console logger; noop inject.
  internal/real.ts  LAZY ROOT. pulls adapter + instrumentation + all OTel.
  adapter.ts        heavy (mostly unchanged). imported only by internal/real.ts.
  sdk.ts            NEW subpath /browser/sdk: exporters, StackContextManager,
                    metrics, raw provider config. heavy, opt-in.
  fetch/*           unchanged (already optimal eager-light / lazy-otel).
  react/*           unchanged; bundler dedupes shared/action chunk.
```

The facade MUST NOT statically import `internal/real.ts`, `adapter.ts`,
`shared/exporters.ts`, `shared/logger.ts` (real), or any `@opentelemetry/*`
package. It reaches them only via `await import()`.

`instrumentFetch` is **dropped** from the `/browser` re-export (it pulls
`@opentelemetry/api`). It stays available from `/browser/fetch`, which the docs
already recommend as the eager-patch location.

### Passthrough semantics (pre-init)

| API | Passthrough (pre-init) | Post-swap |
|---|---|---|
| `withTrace` / `traced` / `withAction` / `scopeAction` | run `fn`, return `T` synchronously, no span/metric | real spans + metrics |
| `logger.{debug,info,warn,error}` | **silent noop** | console (gated by `dev`) + OTLP (gated by endpoint) |
| `injectContext` | no-op (returns carrier unchanged) | real W3C inject |
| `getResource()` | `null` | real resource |

Calls fired before `initSDK` resolves lose their spans/metrics — accepted,
consistent with OTel's existing "noop tracer before provider" behavior.

### `initSDK` async contract (breaking)

```ts
function initSDK(config: SDKConfig): Promise<SDKResult>;
```

Was synchronous `SDKResult`. Caller awaits or fire-and-forgets — caller's
choice. Idempotent: concurrent calls share one `import()`. Internally
`try/catch`; on failure the facade stays passthrough and resolves to
`noopSDKResult()`.

### `dev` option — console gating

New `SDKConfig.dev?: boolean`, **default `false`**. Console output is gated
**solely** by `dev`. OTLP shipping is gated **solely** by endpoint resolution.
Independent axes:

| `dev` | logs endpoint | console | OTLP |
|---|---|---|---|
| `false` (default) | resolved | ✗ | ✓ |
| `false` | unresolved | ✗ | ✗ |
| `true` | resolved | ✓ pretty | ✓ |
| `true` | unresolved | ✓ pretty | ✗ |

- Pre-init (lazy-load window, `dev` not yet known): logger is **silent noop**.
  Console begins only post-init when `dev:true`. Guarantees prod (`dev:false`)
  never leaks to console even during the load window.
- The SDK's own diagnostics (e.g. resource `warnings`) route through
  `logger.warn` → visible only when `dev:true`. No console spam on bad config.
- Recommended docs pattern:
  ```ts
  initSDK({ endpoint, dev: import.meta.env.NODE_ENV !== "production" });
  // or pass the Vite dev flag: dev: import.meta.env.DEV
  ```

Wiring: `shared/types.ts` gains `dev?`; `shared/logger.ts` `createLogger` gains
a console-enable toggle; `adapter.ts` passes `config.dev` → `createLogger`.
Other runtimes ignore `dev` for now (out of scope).

### Moved to `/browser/sdk` (breaking)

No longer importable from bare `/browser`:
- Exporter classes: `FetchTraceExporter`, `FetchMetricExporter`, `FetchLogExporter`.
- `metrics` namespace (from `@opentelemetry/api`).
- Low-level providers / `StackContextManager` / `contextManager` config knob.

`package.json` `exports` gains `./browser/sdk`.

### Bundle-size benchmark

Add `size-limit` (esbuild engine) dev-dep + `pnpm size` script + CI gate
(`.github/workflows`):

- `/browser` facade — **hard budget** (target ≤ 2 KB gz) AND assert **zero
  `@opentelemetry` in the resolved sync chunk** (size-limit `import` of the
  entry must not pull otel; verified by inspecting the built bundle / a
  `why`-style check or a grep over the size-limit output).
- `/browser/fetch`, `/browser/react` — small budgets (`@opentelemetry/api`-only).
- lazy chunk + `/browser/sdk` — informational (heavy, expected).
- Baseline (current `/browser` with full SDK) captured **before** the refactor;
  after-numbers prove the reduction. Regression fails CI.

## Breaking changes (summary, minimized)

1. `initSDK` → `Promise<SDKResult>` (was sync).
2. `instrumentFetch` dropped from `/browser` → use `/browser/fetch`.
3. Exporters / `metrics` / low-level providers / `contextManager` config →
   moved to `/browser/sdk`.
4. Logger pre-init = silent; post-init console gated by new `dev` flag (was:
   real logger always console'd).

## Testing

- Passthrough wrappers return `fn` value synchronously, no throw, and the
  facade module pulls no `@opentelemetry/*` (static-import assertion / grep).
- Console logger: `dev:true` writes to console; `dev:false` silent; endpoint
  axis independent.
- Pre-init logger silent.
- Post-init: `impl` swapped → real spans against a mock provider.
- `initSDK` idempotent / concurrent calls share one `import()`; failure →
  passthrough + `noopSDKResult`.
- `size-limit` assertions (facade budget + zero-otel).
- Existing fetch/react tests stay green.

Full gate: `pnpm install && pnpm build && pnpm test && pnpm typecheck && pnpm lint && pnpm size`.

## Follow-up

After landing: `/promote-rules` for the durable convention "browser entrypoints
= max code-split + lazy-load; heavy deps behind dynamic `import()`; eager facade
stays dependency-free; passthrough before init."
