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
- After `/browser` facade (brotli): _TBD — task 009_
- Delta: _TBD_

## Task progress (with attempt counters)
- [x] 001 size-limit tooling + baseline — attempts: 0
- [ ] 002 SDKConfig.dev + createLogger console toggle — attempts: 0
- [ ] 003 adapter wires config.dev → logger — attempts: 0
- [ ] 004 passthrough.ts — attempts: 0
- [ ] 005 internal/real.ts lazy chunk root — attempts: 0
- [ ] 006 rewrite index.ts as facade (async initSDK) — attempts: 0
- [ ] 007 sdk.ts subpath + package exports — attempts: 0
- [ ] 008 tests — attempts: 0
- [ ] 009 size budgets + after numbers — attempts: 0
- [ ] 010 docs + CI size job — attempts: 0

## Open questions
(none — design fully specified)

## Decisions / notes log
- 001: Added @size-limit/file@12 (alongside @size-limit/esbuild@11) — `path` field requires file plugin. Baseline: /browser=30.17kB, /browser/fetch=4.31kB, /browser/react=5.73kB (brotli, esbuild bundled).
