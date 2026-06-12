# RESUME — browser lazy facade + SDK swap

**Slice:** plans/browser-lazy-facade/001-facade-lazy-swap/
**Status:** active
**Base branch:** main

## Initial state
Fresh slice. No code changed yet. `src/browser/index.ts` still statically
imports `browserAdapter` (full OTel SDK in eager chunk). Design approved: `DESIGN.md` (this slice).

## Ralph state
- Contract: CONTRACT.md (this slice)
- Loop status: active

## Bundle-size benchmark
- Baseline `/browser` (full SDK, brotli): 30.17 kB
- Baseline `/browser/fetch` (brotli): 4.31 kB
- Baseline `/browser/react` (brotli): 5.73 kB
- After `/browser` facade (brotli, esbuild total incl. lazy chunk): 31.89 kB
- After `/browser/fetch` (brotli): 4.31 kB (unchanged)
- After `/browser/react` (brotli): 5.73 kB (unchanged)
- After `/browser/sdk` (brotli, new heavy subpath): 25.36 kB
- Delta /browser: +1.72 kB vs baseline (size-limit includes lazy chunk — esbuild bundles dynamic imports; eager-only chunk is much smaller, ~2 kB)
- Note: size-limit measures total bundle (eager + lazy). Zero-OTel in eager chunk verified by `! grep "@opentelemetry" dist/browser/index.js` (§2 check, not size-limit).

## Task progress (with attempt counters)
- [x] 001 size-limit tooling + baseline — attempts: 0
- [x] 002 SDKConfig.dev + createLogger console toggle — attempts: 0
- [x] 003 adapter wires config.dev → logger — attempts: 0
- [x] 004 passthrough.ts — attempts: 0
- [x] 005 internal/real.ts lazy chunk root — attempts: 0
- [x] 006 rewrite index.ts as facade (async initSDK) — attempts: 0
- [x] 007 sdk.ts subpath + package exports — attempts: 0
- [x] 008 tests — attempts: 0
- [x] 009 size budgets + after numbers — attempts: 0
- [ ] 010 docs + CI size job — attempts: 0

## Open questions
(none — design fully specified)

## Decisions / notes log
- 001: Added @size-limit/file@12 (alongside @size-limit/esbuild@11) — `path` field requires file plugin. Baseline: /browser=30.17kB, /browser/fetch=4.31kB, /browser/react=5.73kB (brotli, esbuild bundled).
- 002: Added `dev?: boolean` to SDKConfig. Added `options?: { console?: boolean }` to createLogger — default true (console ON), flag false suppresses stderrWriter only (OTLP still emits). Pre-existing flaky test "colors later TTY logs" unrelated to this change.
- 003: Wired `config.dev` → `createLogger(resolvedServiceName, { console: !!config.dev })` in browser adapter. One-line change, all other adapters unchanged.
- 004: Created src/browser/passthrough.ts — pure-JS, zero @opentelemetry imports. Exports: passthroughLogger (silent noop), passthroughWithTrace/WithAction/ScopeAction (run fn(NOOP_SPAN)), passthroughTraced (returns original method), passthroughInjectContext (returns carrier unchanged), makePassthroughSDKResult (null resource, as-any provider).
- 005: Created src/browser/internal/real.ts — lazy chunk root. Bundles all heavy OTel via impl object: withTrace, withAction, scopeAction, traced, injectContext, createLogger, setDefaultLogger, setup (delegates to browserAdapter).
- 006: Rewrote src/browser/index.ts as pure-JS lazy facade. initSDK async + idempotent (_initPromise guard), failure→makePassthroughSDKResult. Thin forwarders for all 5 API fns. Dropped: metrics, FetchExporters, logger fns, noopSDKResult, instrumentFetch. Opus review: LGTM, all 10 criteria pass. Comment-only issue fixed (endpoint→exporterEndpoint in docstring).
- 007: Created src/browser/sdk/index.ts — heavy opt-in subpath. Exports: FetchTraceExporters, metrics, StackContextManager, BasicTracerProvider, MeterProvider, LoggerProvider + logger fns + noopSDKResult. Added ./browser/sdk to package.json exports. Added /browser/sdk size-limit entry (no limit yet — task 009 sets budgets). Removed @internal from StackContextManager (it's now public API in /browser/sdk). Opus review: LGTM, all 6 criteria pass.
