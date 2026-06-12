# RESUME — Cloudflare OTel Parity (Config Factory + Binding Wrappers)

**Slice:** plans/cloudflare-otel-parity/001-config-factory-and-bindings/
**Status:** not started
**Base branch:** main
**Branch (when running):** ralph/cloudflare-otel-parity-001
**Design spec:** docs/superpowers/specs/2026-06-12-cloudflare-otel-parity-design.md

## Ralph state
- Contract: CONTRACT.md (this slice)
- Loop status: active | blocked | done  → **not started**

## Task progress (with attempt counters)
- [ ] 001 Config factory overload (ResolveConfigFn + Trigger) — attempts: 0 — review: opus
- [ ] 002 Binding core + KV (traceBinding, instrumentKV, bindingCaptureKeys) — attempts: 0 — review: opus
- [ ] 003 D1 (+ prepared-statement wrapping) — attempts: 0 — review: opus
- [ ] 004 R2 (method-latency span, no body drain) — attempts: 0 — review: sonnet
- [ ] 005 Queue producer — attempts: 0 — review: sonnet
- [ ] 006 DO storage — attempts: 0 — review: sonnet
- [ ] 007 Docs: Starlight guides + TypeDoc — attempts: 0 — review: self
- [ ] 008 Final full gate — attempts: 0 — review: sonnet

## Files touched
(none yet)

## Key decisions
- Do NOT depend on otel-cf-workers (traces-only, 13mo-stale RC). Replicate on existing engine.
- Explicit wrappers, NO env auto-detection/Proxy.
- CF binding types: hand-defined local interfaces OR `@cloudflare/workers-types` type-only devDep (no runtime dep).
- Per-op **metrics**: one histogram `cloudflare.binding.operation.duration`, bounded attrs only (type/name/operation/status), keys/sql span-only.
- Histogram uses **explicit buckets** via `advice.explicitBucketBoundaries` (default `[1,2,5,10,20,50,100,200,500,1000,2000,5000]`, configurable `bindingHistogramBoundaries`).
- **Trace continuity**: engine already ALS-backed + handler-wrapped (same as otel-cf-workers). Binding wrappers attach to `context.active()`; orphan guard `orphanBindingSpans` default `"skip"` to avoid splintering trace IDs.

## Open questions
(none)
