# RESUME — Cloudflare OTel Parity (Config Factory + Binding Wrappers)

**Slice:** plans/cloudflare-otel-parity/001-config-factory-and-bindings/
**Status:** in progress (tasks 001–006 done; code complete, docs + gate left)
**Base branch:** main
**Branch (when running):** ralph/cloudflare-otel-parity-001
**Design spec:** docs/superpowers/specs/2026-06-12-cloudflare-otel-parity-design.md

## Ralph state
- Contract: CONTRACT.md (this slice)
- Loop status: active | blocked | done  → **not started**

## Task progress (with attempt counters)
- [x] 001 Config factory overload (ResolveConfigFn + Trigger) — done, instrument.ts overload + traceHandler config field; 12 new tests, 35 regression pass; opus-reviewed — attempts: 0 — review: opus
- [x] 002 Binding core + KV — done; trace-binding.ts (span+histogram, orphan guard, explicit buckets), config.ts (ensureSDK hook), kv.ts proxy; 18 tests incl continuity/orphan/redaction/buckets; opus-reviewed — attempts: 0 — review: opus
- [x] 003 D1 — done; d1.ts (prepare→wrapped stmt, bind chains, terminal ops span once w/ db.statement, batch unwraps via RAW_STMT symbol, sqlVerb bounded metric); 15 tests; opus-reviewed — attempts: 0 — review: opus
- [x] 004 R2 — done; r2.ts proxy (get/put/head/delete/list/createMultipartUpload), body stream untouched (bodyUsed=false verified), key rules incl delete-array skip; 23 tests; reviewed — attempts: 0 — review: sonnet
- [x] 005 Queue producer — done; queue.ts proxy (send/sendBatch, PRODUCER kind, messaging.* semconv, sendBatch materializes iterable for count + no-drain); 14 tests; reviewed — attempts: 0 — review: sonnet
- [x] 006 DO storage — done; do-storage.ts proxy (get/put/delete/list/deleteAll, single-string key rules, state.storage example); 24 tests; reviewed — attempts: 0 — review: sonnet
- [x] 007 Docs — done; 2 Starlight guides (per-request-config, binding-tracing), auto-sidebar + auto-llms-txt; TypeDoc API bucket regenerates new exports (verified instrumentKV/D1/ResolveConfigFn md generated); docs:generate exit 0 (280 pages) — attempts: 0 — review: self
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
