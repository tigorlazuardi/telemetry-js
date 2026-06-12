# Ralph Contract: Cloudflare OTel Parity — Config Factory + Binding Wrappers

**Slice:** plans/cloudflare-otel-parity/001-config-factory-and-bindings/
**Executor:** Sonnet orchestrator, autonomous ralph-loop (fresh session)
**Planner:** Opus — contract authored 2026-06-12
**Base branch:** main
**Design spec:** docs/superpowers/specs/2026-06-12-cloudflare-otel-parity-design.md

## 0. Sanity check (preflight — run FIRST, every iteration, before any task work)

```bash
# 1. Must be on a ralph/ branch, never main/master
git branch --show-current | grep -qE "^ralph/" \
  || { echo "ERROR: not on ralph/ branch — abort"; exit 1; }
# 2. Contract + progress files must exist
test -f plans/cloudflare-otel-parity/001-config-factory-and-bindings/CONTRACT.md \
  || { echo "ERROR: CONTRACT.md missing"; exit 1; }
test -f plans/cloudflare-otel-parity/001-config-factory-and-bindings/RESUME.md \
  || { echo "ERROR: RESUME.md missing"; exit 1; }
# 3. If blocked, surface it and stop
test ! -f plans/cloudflare-otel-parity/001-config-factory-and-bindings/BLOCKED.md \
  || { echo "Loop BLOCKED — read BLOCKED.md:"; cat plans/cloudflare-otel-parity/001-config-factory-and-bindings/BLOCKED.md; exit 0; }
# 4. Toolchain present
command -v pnpm >/dev/null || { echo "ERROR: pnpm missing"; exit 1; }
test -d node_modules || { echo "ERROR: deps not installed — run pnpm install"; exit 1; }
```

If ANY check fails: stop, print the error, do NOT proceed to §4 tasks.

## 1. Mission

Reach feature parity with `otel-cf-workers` on the existing telemetry-js engine — WITHOUT depending on it — by adding (A) a per-request `ResolveConfigFn` config-factory overload and (B) explicit binding wrappers (KV/D1/R2/Queue/DO storage). Additive only; no breaking change to v2.0.0 public API; traces + metrics + logs all preserved.

## 2. Success criteria (definition of done)

Loop is DONE only when ALL hold, each proven by a command that exits 0:

- All tasks 001–008 checked done in RESUME.md.
- New public exports present + typed: `ResolveConfigFn`, `Trigger`, `instrumentKV`, `instrumentD1`, `instrumentR2`, `instrumentQueue`, `instrumentDOStorage`; config `bindingCaptureKeys`/`bindingHistogramBoundaries`/`orphanBindingSpans` honored — verify: `pnpm test`
- **Trace continuity**: a wrapped binding op inside `traceHandler` emits a span whose `traceId` equals the root span's `traceId` — verify: `pnpm test`
- **Metrics**: `cloudflare.binding.operation.duration` histogram recorded per op with explicit bucket boundaries (default or configured); metric attrs bounded (no keys/sql) — verify: `pnpm test`
- Existing CF behavior unchanged (object-form `instrument()`, `traceHandler`, `instrumentWorkflow`) — verify: `pnpm test`
- Types compile — verify: `pnpm typecheck`
- Lint clean — verify: `pnpm lint`
- Build emits — verify: `pnpm build`
- Cloudflare entry pulls NO new runtime dep (bundle budget) — verify: `pnpm size`
- Docs build (guide pages + TypeDoc) — verify: `pnpm docs:generate`

Full gate (run ALL, in order, before any promise):

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build && pnpm size && pnpm docs:generate
```

## 3. Completion promise

Phrase: `ALL ACCEPTANCE MET`   (must match `--completion-promise` exactly)

Gate — MANDATORY before emitting, no exceptions:
1. Every task in §4 is checked done in RESUME.md.
2. Run every verify command in §2 full gate. ALL exit 0.
3. Paste the verify output into your response.
4. ONLY THEN output: `<promise>ALL ACCEPTANCE MET</promise>`

NEVER emit the promise on self-assessment alone. NEVER to escape a stuck loop. If the gate is not green, you are NOT done — iterate, escalate (§6), or abort (§7).

## 4. Tasks

Ordered. Each iteration: execute the next unchecked task. Track state in RESUME.md. Each impl task's in-scope INCLUDES its TSDoc (`@param`/`@returns`/`@example`) and its own `test/*.test.ts`.

| #   | Action | Files in-scope | Out-of-scope | Done when (exit 0) | Difficulty | Review | escalate_after |
| :-- | :----- | :------------- | :----------- | :----------------- | :--------- | :----- | :------------- |
| 001 | Config factory: add `ResolveConfigFn<Env>` + `Trigger` types; overload `instrument()` (discriminate `typeof === "function"`, invoke factory per handler with live `env`+event); accept factory in `traceHandler` via `TraceHandlerOptions.config`. Factory throw → existing noop fallback. | `src/cloudflare/instrument.ts`, `src/cloudflare/index.ts`, `test/cloudflare-config-factory.test.ts` | binding wrappers; shared SDKConfig shape; any non-CF runtime | `pnpm test cloudflare-config-factory && pnpm typecheck` | medium | opus | 2 |
| 002 | Binding core + KV: `src/cloudflare/bindings/trace-binding.ts` (shared helper = span **+** duration histogram; CLIENT/PRODUCER kind; **attach to `context.active()` via `startActiveSpan`**; **orphan guard**: no recording active span → honor `orphanBindingSpans` (default `"skip"` = metric-only, no disconnected root span); error records + rethrow; span always ends); histogram `cloudflare.binding.operation.duration` created with **explicit buckets via `advice.explicitBucketBoundaries`** (configurable, default `[1,2,5,10,20,50,100,200,500,1000,2000,5000]`); metric attrs bounded only (type/name/operation/status — NO keys/sql); `instrumentKV<T extends KVNamespace>`; add `bindingCaptureKeys?: boolean` (default false), `bindingHistogramBoundaries?: number[]`, `orphanBindingSpans?: "skip"\|"root"` (default `"skip"`) to `SDKConfig`; wire bindings index; re-export from cloudflare entry. **Continuity test**: a KV op inside `traceHandler` yields a span whose `traceId` == root span `traceId`. | `src/cloudflare/bindings/{trace-binding,kv,index}.ts`, `src/cloudflare/index.ts`, `src/shared/types.ts`, `test/cloudflare-kv.test.ts` | D1/R2/Queue/DO; env auto-detection (forbidden); MeterProvider View edits to adapter.ts | `pnpm test cloudflare-kv && pnpm typecheck` | hard | opus | 2 |
| 003 | D1: `instrumentD1<T extends D1Database>`; wrap `prepare()` → wrapped `D1PreparedStatement` so span opens at `.first/.all/.run/.raw` carrying `db.statement` from prepare; `.bind()` returns wrapped stmt (chainable); span `batch()`/`exec()` directly. `db.system=cloudflare-d1`. | `src/cloudflare/bindings/d1.ts`, `src/cloudflare/bindings/index.ts`, `src/cloudflare/index.ts`, `test/cloudflare-d1.test.ts` | other bindings | `pnpm test cloudflare-d1 && pnpm typecheck` | hard | opus | 2 |
| 004 | R2: `instrumentR2<T extends R2Bucket>`; span `get/put/head/delete/list/createMultipartUpload`; span = method-promise latency ONLY, do NOT consume/trace the returned `R2ObjectBody` stream (body must remain readable). `cloudflare.r2.*` attrs. | `src/cloudflare/bindings/r2.ts`, `.../index.ts`, `src/cloudflare/index.ts`, `test/cloudflare-r2.test.ts` | other bindings | `pnpm test cloudflare-r2 && pnpm typecheck` | medium | sonnet | 2 |
| 005 | Queue producer: `instrumentQueue<T extends Queue>`; span `send`/`sendBatch` with PRODUCER kind; `messaging.system=cloudflare-queues`, `messaging.destination.name`, `messaging.batch.message_count`. | `src/cloudflare/bindings/queue.ts`, `.../index.ts`, `src/cloudflare/index.ts`, `test/cloudflare-queue.test.ts` | consumer-side (already in `instrument().queue`) | `pnpm test cloudflare-queue && pnpm typecheck` | easy | sonnet | 2 |
| 006 | DO storage: `instrumentDOStorage<T extends DurableObjectStorage>`; span `get/put/delete/list` (+ transaction if trivial); `cloudflare.do.storage.*` attrs; document the `state.storage` wrapping access path in TSDoc `@example`. | `src/cloudflare/bindings/do-storage.ts`, `.../index.ts`, `src/cloudflare/index.ts`, `test/cloudflare-do-storage.test.ts` | DO RPC/alarm tracing | `pnpm test cloudflare-do-storage && pnpm typecheck` | medium | sonnet | 2 |
| 007 | Docs (STRENGTHEN): Starlight guide page *"Per-request config (ResolveConfigFn)"* (object vs factory, secrets/headers, fallback) + page *"Tracing Cloudflare bindings"* (one section per binding: one-line wrap example, resulting span name/attrs table, key-redaction note, R2 streaming caveat, D1 statement-capture note); ensure TypeDoc picks up new exports; add a non-breaking migration note. | `docs/**` (Starlight content + sidebar), guide markdown | TypeDoc-generated API markdown (auto); source code | `pnpm docs:generate` | medium | self | 2 |
| 008 | Final gate: run full §2 gate; fix any lint/size/build fallout (e.g. `import type` only for CF types, no runtime dep leak). | any file flagged by the gate | new features | `pnpm test && pnpm typecheck && pnpm lint && pnpm build && pnpm size && pnpm docs:generate` | medium | sonnet | 2 |

**Review levels:** `self` — run verify, self-check diff. `sonnet` — re-read full diff fresh vs acceptance before done. `opus` — spawn Opus subagent deep-review of the diff BEFORE marking done (mandatory for opus rows: 001, 002, 003 — public API surface).

## 5. Guardrails (do NOT violate)

- Do NOT touch: `src/node/**`, `src/browser/**`, `src/bun/**`, `src/shared/exporters.ts`, `src/cloudflare/adapter.ts` (except unavoidable type re-export), `src/cloudflare/workflow.ts`.
- **Additive only.** Object-form `instrument(handler, config)` + existing `traceHandler`/`instrumentWorkflow` signatures and behavior MUST stay byte-compatible. Overload, never replace.
- **No new RUNTIME dependency.** CF binding TYPES: prefer hand-defined minimal local interfaces OR `@cloudflare/workers-types` as a **type-only devDependency** consumed via `import type` (zero runtime, zero bundle). Confirm via `pnpm size`.
- **No env auto-detection / env Proxy.** Explicit wrappers only (rejected approach in spec). Do NOT proxy the `env` object.
- Spans **+ one duration histogram** per op — no per-binding logs this slice.
- **Trace continuity**: child spans MUST attach to `context.active()`. NEVER mint a disconnected root for a binding op — honor `orphanBindingSpans` (default `"skip"`). This is the guard against "different trace ID for the same operation".
- **Histogram**: explicit bucket boundaries via `advice.explicitBucketBoundaries` (default `[1,2,5,10,20,50,100,200,500,1000,2000,5000]`, override via `bindingHistogramBoundaries`). Do NOT ship default-SDK buckets.
- **Metric cardinality**: metric attrs = type/name/operation/status ONLY. NEVER put `kv.key`/`db.statement`/`r2.key` in a metric label (keep them span-only).
- Keys (`*.key` attrs) omitted unless `bindingCaptureKeys === true`. SQL `db.statement` captured, bound params NEVER.
- Reuse existing tracer + meter + `FetchTraceExporter`/`FetchMetricExporter`; do NOT add a new exporter/provider, do NOT edit the adapter's MeterProvider/View (use instrument `advice`).
- Do NOT expand scope beyond this table. New need → record under RESUME.md "Open questions", do NOT silently implement.
- Do NOT delete/rewrite a file you did not create without surfacing it in RESUME.md first.
- Follow CLAUDE.md orchestrator/worker split: delegate code writes to `sonnet-implementer`; loop session orchestrates + reviews.

## 6. Escalation rules

Spawn an Opus subagent (`Agent({ model: "opus", ... })`, cold-context briefing) when ANY:
- Task tagged `review: opus` (001/002/003) → Opus reviews its diff before the task is marked done.
- Diff touches public API surface (new exports in `src/cloudflare/index.ts`) → inherits CLAUDE.md public-API auto-trigger → Opus review.
- The SAME task fails its verify `escalate_after` (2) times → Opus DIAGNOSE → returns `SOLVABLE`+hint (reset attempts, apply, continue) or `IMPOSSIBLE`+rationale (→ §7).
Briefing = task row + failing verify output + file paths. Batch multiple Opus questions into ONE call.

## 7. Abort protocol (only authorized exit besides success)

Trigger: Opus DIAGNOSE returned `IMPOSSIBLE`. (Sonnet judgment alone is NOT valid.)
1. Write `BLOCKED.md` in the slice folder.
2. Set RESUME.md status: `blocked`.
3. Run: `rm .claude/.ralph-loop.local.md`
4. Exit with a short summary pointing at BLOCKED.md.

Overrides ralph's "never circumvent" default — gated by Opus, not self-escape. Do NOT emit the promise to abort. Do NOT delete the state file for any other reason.

## 8. Iteration discipline (every iteration, in order)

1. Read CONTRACT.md and RESUME.md first.
2. Idempotency: never redo a task checked done.
3. Pick next unchecked §4 task.
4. Implement it (delegate code writes per CLAUDE.md split).
5. Run the task's verify:
   - Pass → check done in RESUME.md; record files touched + decisions; reset its `attempts` to 0.
   - Fail → increment `attempts:` in RESUME.md. `attempts >= escalate_after` → §6.
6. Checkpoint commit (user authorized commits): one commit per completed task — keeps each iteration revertable.
7. All tasks done → run §3 promise gate.

## 9. Backstop

max-iterations: 24. Hard ceiling. If hit, loop stops; user reviews RESUME.md + any BLOCKED.md.

## 10. Start command (fresh Sonnet session, dedicated branch)

```
git checkout -b ralph/cloudflare-otel-parity-001
/ralph-loop:ralph-loop "$(cat plans/cloudflare-otel-parity/001-config-factory-and-bindings/PROMPT.md)" --max-iterations 24 --completion-promise 'ALL ACCEPTANCE MET'
```

Invoke form is `/ralph-loop:ralph-loop` (`plugin:command`, repeated) — NOT `/ralph-loop`. Prompt read from PROMPT.md via `"$(cat …)"`.

## 11. Post-completion — open PR to base branch

Runs in the SAME response that emits the §3 promise. Target: PR from head `ralph/cloudflare-otel-parity-001` → base `main`.

1. Push: `git push -u origin "$(git branch --show-current)"`
2. Detect remote + provider:
```bash
url=$(git remote get-url origin 2>/dev/null) || { echo "no origin remote — skip PR, report loop done + branch"; }
host=$(printf '%s' "$url" | sed -E 's#^(git@|ssh://git@|https?://)([^/:]+)[/:].*#\2#')
path=$(printf '%s' "$url" | sed -E 's#^(git@|ssh://git@|https?://)[^/:]+[/:]##; s#\.git$##')
base="main"; head=$(git branch --show-current)
```
   Host not github*/gitlab* → skip PR; report loop done + pushed branch.
3. Pick CLI: `github.com`/GHE → `gh`; `gitlab.*` → `glab`.
4. CLI authed AND host matches AND access (`gh auth status`/`glab auth status` exit 0) → **OFFER, do NOT auto-create**:
   - GitHub: `gh pr create --base "$base" --head "$head" --fill`
5. Else → compare URL: `https://$host/$path/compare/$base...$head?expand=1` — print it.

End the promise turn with: `base ← head`, plus the offered command (authed) or compare URL (unauthed).
