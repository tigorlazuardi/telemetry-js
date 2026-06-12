# TASKS — browser lazy facade + SDK swap

Ordered. Each iteration: do the next unchecked task, run its verify, update
RESUME.md. Full gate before promise:
`pnpm install && pnpm build && pnpm test && pnpm typecheck && pnpm lint && pnpm size`.

| # | Action | Files in-scope | Done when (exit 0) | Review |
|---|---|---|---|---|
| 001 | Add `size-limit` (esbuild engine) dev-dep, `.size-limit.json` (entries: `/browser`, `/browser/fetch`, `/browser/react`, `/browser/sdk`), `pnpm size` script. Build first, then capture **baseline** numbers of current `/browser` into RESUME.md before any refactor. | `package.json`, `.size-limit.json` | `pnpm build && pnpm size` runs and prints sizes | self |
| 002 | Add `dev?: boolean` to `SDKConfig`. Add console-enable toggle to `createLogger` (default = current behaviour, i.e. console ON, so Node/CF/Bun unchanged). | `src/shared/types.ts`, `src/shared/logger.ts` | `pnpm typecheck && pnpm test` | sonnet |
| 003 | Wire `dev` in browser adapter: `adapter.ts` passes `config.dev` → `createLogger` console toggle (`console: !!config.dev`). Resource warnings still route through logger. | `src/browser/adapter.ts` | `pnpm typecheck && pnpm test` | self |
| 004 | Create `src/browser/passthrough.ts`: pure-JS default impls — `withTrace`/`traced`/`withAction`/`scopeAction` run `fn` return `T` sync; silent-noop logger; `injectContext` returns carrier unchanged; `getResource` null; plus a pure-JS passthrough `SDKResult` for the `initSDK` failure fallback (silent logger, `resource: null`, noop shutdown/forceFlush). NO `@opentelemetry/*` import. | `src/browser/passthrough.ts` | `pnpm typecheck` + grep finds no `@opentelemetry` in file | self |
| 005 | Create `src/browser/internal/real.ts`: lazy chunk root re-exporting `browserAdapter.setup` + real wrapper impls (`shared/action`, `shared/with-trace`, `shared/traced`, real logger) as one `impl` object. | `src/browser/internal/real.ts` | `pnpm typecheck` | sonnet |
| 006 | Rewrite `src/browser/index.ts` as facade: mutable `impl` ref (default passthrough), thin forwarders, async idempotent `initSDK(config): Promise<SDKResult>` that `await import("./internal/real.js")`, swaps `impl`+logger+resource, `try/catch`→**pure-JS passthrough result** (NOT `shared/noop`). Remove heavy/OTel re-exports + `instrumentFetch`. Keep type-only re-exports. | `src/browser/index.ts` | `pnpm typecheck && pnpm build && ! grep -n "@opentelemetry" dist/browser/index.js` | **opus** |
| 007 | Create `src/browser/sdk.ts` (subpath `/browser/sdk`): re-export `FetchTraceExporter`/`FetchMetricExporter`/`FetchLogExporter`, `metrics`, `StackContextManager`, low-level provider config. Add `./browser/sdk` to `package.json` `exports`. | `src/browser/sdk.ts`, `package.json` | `pnpm build` emits `dist/browser/sdk/index.d.ts`+`.js`; `pnpm typecheck` | **opus** |
| 008 | Update/extend tests: facade passthrough returns `fn` sync + no-throw; pre-init logger silent; post-init swap → real spans (mock provider); `initSDK` idempotent/concurrent + failure→passthrough; `dev` matrix (console on/off × endpoint); facade pulls no OTel. | `test/**` | `pnpm test` | sonnet |
| 009 | `.size-limit.json`: set hard budget on `/browser` facade + assert zero `@opentelemetry` in its sync chunk; small budgets for fetch/react; informational for sdk/lazy. Record **after** numbers + delta vs baseline in RESUME.md. | `.size-limit.json`, RESUME.md | `pnpm size` exits 0 within budget | self |
| 010 | Update docs: README browser section, `src/browser/index.ts` docstring, fetch/react docstrings — new async `initSDK`, `dev` option + recommended `import.meta.env` pattern, `/browser/sdk` migration, `instrumentFetch` from `/browser/fetch`. Add CI `pnpm size` job. | `README.md`, `src/browser/*.ts` docstrings, `.github/workflows/*` | `pnpm build && pnpm lint` | sonnet |

## Notes
- Tasks 006 + 007 change public API / entrypoint contract → `review: opus`.
- Task 002 default toggle MUST preserve Node/CF/Bun console behaviour (regression
  risk — covered by existing tests).
- Keep `withAction`/`scopeAction`/`traced`/`withTrace` signatures synchronous.
