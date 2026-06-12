# RESUME — Cloudflare Tail Sampling

**Slice:** plans/cloudflare-otel-parity/002-tail-sampling/
**Status:** not started
**Base branch:** main
**Branch (when running):** ralph/cloudflare-otel-parity-002
**Design spec:** docs/superpowers/specs/2026-06-12-cloudflare-otel-parity-design.md (Feature C)
**Depends on:** slice 001 (land first to avoid merge churn; code is independent)

## Ralph state
- Contract: CONTRACT.md (this slice)
- Loop status: active | blocked | done  → **not started**

## Task progress (with attempt counters)
- [ ] 001 Sampling types + built-in tail samplers + SDKConfig.sampling — attempts: 0 — review: opus
- [ ] 002 TailSampleSpanProcessor (buffer/decide/flush, memory cap) — attempts: 0 — review: opus
- [ ] 003 Record-all + ratio-propagate head sampler (ParentBased) — attempts: 0 — review: opus
- [ ] 004 Adapter wiring (tail processor only when sampling set; waitUntil flush) — attempts: 0 — review: opus
- [ ] 005 Docs: tail-sampling guide + TSDoc — attempts: 0 — review: self
- [ ] 006 Final full gate — attempts: 0 — review: sonnet

## Files touched
(none yet)

## Key decisions
- Tail sampling fits CF: one isolate = one request = one whole trace in memory → cheap, complete, flush in ctx.waitUntil (no added latency).
- Default tail policy: `multiTailSampler([keepOnHeadSampled, keepOnError])` = keep on error, else head decision.
- **Record-all invariant**: default head sampler NEVER returns NOT_RECORD, else tail can't keep errored traces head dropped. Volume reduction is at the TAIL.
- Propagation tension: SAMPLED bit is a head decision injected at outbound fetch; tail "force on error" is a LOCAL guarantee. Default `propagationRatio: 1.0`.
- Non-breaking: tail processor used ONLY when `sampling` configured; else `SimpleSpanProcessor` unchanged.
- `maxBufferedSpans` default 2048 (isolate memory cap).

## Open questions
- Default `propagationRatio` 1.0 (propagate all) vs a ratio — confirm in review.
