# SCOPE — browser lazy facade + SDK swap

Design: `DESIGN.md` (this slice).

## In scope
- Rewrite `src/browser/index.ts` as a pure-JS, zero-OTel **facade** with mutable
  passthrough impl refs swapped on `initSDK`.
- New `src/browser/passthrough.ts` (default impls).
- New `src/browser/internal/real.ts` (lazy chunk root; pulls adapter + all OTel).
- New `src/browser/sdk.ts` + `./browser/sdk` export (exporters, metrics,
  low-level providers, `StackContextManager`).
- `initSDK` → `Promise<SDKResult>` (async, idempotent, internal dynamic import).
- `SDKConfig.dev?: boolean` (shared type) + console-sink gating in
  `shared/logger.ts` + wiring in `src/browser/adapter.ts`.
- Bundle-size benchmark: `size-limit` dev-dep, `.size-limit.json`, `pnpm size`,
  CI gate.
- Tests + docs/README + entrypoint docstrings updated for the new contract.

## Out of scope (do NOT touch)
- `src/browser/fetch/*` — already optimal; leave behaviour unchanged.
- `src/browser/react/*` — keep working; only adjust if a shared-module move
  forces an import-path fix (no behaviour change).
- Node / Cloudflare / Bun adapters and their entrypoints (`src/node`,
  `src/cloudflare`, `src/bun`). The shared `SDKConfig.dev?` field is added but
  only the browser adapter honours it.
- OTLP exporter internals (`shared/exporters.ts`) — moved/re-exported, not
  rewritten.
- Public API of `withAction`/`scopeAction`/`traced`/`withTrace` signatures (stay
  synchronous `T`).

## Non-goals
- Buffer/replay of pre-init spans or logs (explicitly rejected — passthrough
  loses early signal, by design).
- Making Node/CF/Bun loggers honour `dev`.
- Auto-triggering the heavy SDK load from runtime API calls (only `initSDK`
  triggers it).

## Constraints
- Eager `/browser` facade: **no `@opentelemetry/*` static import** (assert in CI).
- No new runtime dependencies (size-limit is dev-only).
- Keep `tsc`-only build (no bundler in package build; size-limit runs its own
  esbuild for measurement).
- All breaking changes documented in README + changelog notes.

## Base branch
`main`
