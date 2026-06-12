# IMPLEMENTATION — browser lazy facade + SDK swap

Design: `DESIGN.md` (this slice).

## Why
`src/browser/index.ts` statically imports `browserAdapter` → entire
`@opentelemetry/*` SDK in the initial chunk. Importing any runtime API from
`/browser` drags the SDK into first load. Goal: heavy OTel only behind dynamic
`import()`; eager facade is dependency-free; API passes through until the SDK
swaps in.

## Approach
1. **Facade holds mutable impl refs.** `src/browser/index.ts` declares
   module-level `let impl = passthrough` and thin exported wrappers that forward
   to `impl.*`. Pure JS, zero OTel static import.
2. **Passthrough impls** (`passthrough.ts`): `withTrace`/`traced`/`withAction`/
   `scopeAction` run `fn` and return `T` synchronously (no span). `logger` is a
   silent noop. `injectContext` returns the carrier unchanged. `getResource` →
   `null`.
3. **Lazy real chunk** (`internal/real.ts`): re-exports `browserAdapter.setup`
   and the real wrapper impls (`shared/action`, `shared/with-trace`,
   `shared/traced`, real `shared/logger`). This is the ONLY module that pulls
   `@opentelemetry/*` + the adapter. Imported via `await import()` only.
4. **`initSDK` async + swap.** `initSDK(config)` lazily imports `internal/real`,
   `await`s `setup(config)`, assigns `impl = real.impl`, swaps the default
   logger to the real (dev-gated) logger, stores the resource, returns the
   `SDKResult`. Idempotent via a cached module promise. `try/catch` → on failure
   stays passthrough, resolves `noopSDKResult()`.
5. **`/browser/sdk` subpath** (`sdk.ts`): re-exports exporter classes,
   `metrics`, `StackContextManager`, low-level provider config. Heavy, opt-in.
   Add `./browser/sdk` to `package.json` `exports`.
6. **`dev` gating.** `SDKConfig.dev?: boolean` in `shared/types.ts`.
   `createLogger` in `shared/logger.ts` gains a console-enable toggle (default
   off). `adapter.ts` passes `config.dev` into `createLogger`. Console output ⇔
   `dev:true`; OTLP ⇔ endpoint resolves; axes independent.
7. **Size benchmark.** `size-limit` + esbuild engine. `.size-limit.json`
   entries per entrypoint. `pnpm size` script. CI job. Facade budget +
   zero-`@opentelemetry` assertion. Baseline captured before refactor.

## Key decisions
- Passthrough is **synchronous** — wrapper signatures stay `T`, not `Promise<T>`
  (minimal breakage). Early spans lost by design.
- `instrumentFetch` removed from `/browser` (it imports `@opentelemetry/api`);
  remains at `/browser/fetch`.
- Pre-init logger is **silent** (not console) so prod never leaks during the
  load window; console starts only post-init under `dev:true`.
- Only `initSDK` triggers the heavy load. Runtime API calls never auto-load it.
- React entry keeps its own lazy `import("../../shared/action.js")`; the bundler
  dedupes `shared/action` across the React chunk and `internal/real`.

## Risks
- **Tree-shake assumption.** size-limit must confirm the facade chunk truly has
  no OTel. If a stray re-export leaks otel, the zero-otel assertion fails CI —
  that is the safety net.
- **`shared/noop` trap.** `shared/noop.ts` imports `@opentelemetry/api` +
  `resources`. The facade's `initSDK` catch path must NOT use `noopSDKResult()`
  from it — that would drag otel into the eager chunk. Use a pure-JS passthrough
  `SDKResult` from `passthrough.ts`. Verified by grepping compiled
  `dist/browser/index.js` for `@opentelemetry`.
- **`metrics` removal** from `/browser` may break consumers; documented as a
  breaking change with the `/browser/sdk` migration path.
- **Async `initSDK`.** Consumers that read `result.provider` synchronously must
  now `await`. Documented.
- **Logger console toggle** must not change Node/CF/Bun behaviour — toggle
  defaults to current behaviour for non-browser callers (those adapters don't
  pass the new flag, so keep their existing console path intact).

## Verify gate
`pnpm install && pnpm build && pnpm test && pnpm typecheck && pnpm lint && pnpm size`
