# RESUME — Cloudflare Tail Sampling

**Slice:** plans/cloudflare-otel-parity/002-tail-sampling/
**Status:** done
**Base branch:** main
**Branch (when running):** ralph/cloudflare-otel-parity-002
**Design spec:** docs/superpowers/specs/2026-06-12-cloudflare-otel-parity-design.md (Feature C)
**Depends on:** slice 001 (land first to avoid merge churn; code is independent)

## Ralph state
- Contract: CONTRACT.md (this slice)
- Loop status: active | blocked | done  → **done**

## Task progress (with attempt counters)
- [x] 001 Sampling types + built-in tail samplers + SDKConfig.sampling — attempts: 0 — review: opus — commit: 05df487
- [x] 002 TailSampleSpanProcessor (buffer/decide/flush, memory cap) — attempts: 0 — review: opus — commit: 569df6e
- [x] 003 Record-all + ratio-propagate head sampler (ParentBased) — attempts: 0 — review: opus — commit: fe7c1db
- [x] 004 Adapter wiring (tail processor only when sampling set; waitUntil flush) — attempts: 0 — review: opus — commit: 66667a8
- [x] 005 Docs: tail-sampling guide + TSDoc — attempts: 0 — review: self — commit: 56bc007
- [x] 006 Final full gate — attempts: 0 — review: sonnet — all §2 commands exit 0

## Files touched
- `src/cloudflare/sampling.ts` (new — built-in samplers)
- `src/cloudflare/index.ts` (added tail-sampling re-exports)
- `src/shared/types.ts` (added LocalTrace, TailSampleFn, SDKConfig.sampling)
- `test/cloudflare-sampling.test.ts` (new — 14 tests)
- `src/cloudflare/tail-processor.ts` (new — TailSampleSpanProcessor)
- `test/cloudflare-tail-processor.test.ts` (new — 10 tests)
- `src/cloudflare/sampling.ts` (added RecordAllRatioSampler, RecordOnlySampler, createRecordAllHeadSampler)
- `src/cloudflare/index.ts` (added createRecordAllHeadSampler export)
- `test/cloudflare-sampling.test.ts` (added 7 head-sampler tests, regression for 0xffffffff off-by-one)

## Key decisions
- Tail sampling fits CF: one isolate = one request = one whole trace in memory → cheap, complete, flush in ctx.waitUntil (no added latency).
- Default tail policy: `multiTailSampler([keepOnHeadSampled, keepOnError])` = keep on error, else head decision.
- **Record-all invariant**: default head sampler NEVER returns NOT_RECORD, else tail can't keep errored traces head dropped. Volume reduction is at the TAIL.
- Propagation tension: SAMPLED bit is a head decision injected at outbound fetch; tail "force on error" is a LOCAL guarantee. Default `propagationRatio: 1.0`.
- Non-breaking: tail processor used ONLY when `sampling` configured; else `SimpleSpanProcessor` unchanged.
- `maxBufferedSpans` default 2048 (isolate memory cap).

## Open questions
- Default `propagationRatio` 1.0 (propagate all) vs a ratio — confirm in review.
