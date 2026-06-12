# Ralph Contract: Cloudflare Tail Sampling

**Slice:** plans/cloudflare-otel-parity/002-tail-sampling/
**Executor:** Sonnet orchestrator, autonomous ralph-loop (fresh session)
**Planner:** Opus — contract authored 2026-06-12
**Base branch:** main
**Design spec:** docs/superpowers/specs/2026-06-12-cloudflare-otel-parity-design.md (Feature C)
**Depends on:** slice 001 (independent code, but land 001 first to avoid merge churn)

## 0. Sanity check (preflight — run FIRST, every iteration, before any task work)

```bash
git branch --show-current | grep -qE "^ralph/" \
  || { echo "ERROR: not on ralph/ branch — abort"; exit 1; }
test -f plans/cloudflare-otel-parity/002-tail-sampling/CONTRACT.md \
  || { echo "ERROR: CONTRACT.md missing"; exit 1; }
test -f plans/cloudflare-otel-parity/002-tail-sampling/RESUME.md \
  || { echo "ERROR: RESUME.md missing"; exit 1; }
test ! -f plans/cloudflare-otel-parity/002-tail-sampling/BLOCKED.md \
  || { echo "Loop BLOCKED — read BLOCKED.md:"; cat plans/cloudflare-otel-parity/002-tail-sampling/BLOCKED.md; exit 0; }
command -v pnpm >/dev/null || { echo "ERROR: pnpm missing"; exit 1; }
test -d node_modules || { echo "ERROR: deps not installed — run pnpm install"; exit 1; }
```

If ANY check fails: stop, print the error, do NOT proceed to §4 tasks.

## 1. Mission

Add tail-based sampling to the Cloudflare runtime: decide trace export at trace END (keep-on-error by default), reusing the local-isolate-is-one-trace property. Additive only — with no `sampling` config the adapter keeps today's `SimpleSpanProcessor` behaviour exactly.

## 2. Success criteria (definition of done)

Loop is DONE only when ALL hold, each proven by a command that exits 0:

- New public exports + types: `TailSampleFn`, `LocalTrace`, `keepOnError`, `keepOnHeadSampled`, `keepAll`, `keepOnSlow`, `multiTailSampler`; `SDKConfig.sampling` block honored — verify: `pnpm test`
- **Keep-on-error**: a trace whose root span status is ERROR is exported even when head decision would drop it; a non-error trace is dropped per tail policy — verify: `pnpm test`
- **Record-all nuance**: default head sampler never returns `NOT_RECORD` (tail always sees spans) — verify: `pnpm test`
- **Non-breaking**: with NO `sampling` config, adapter uses `SimpleSpanProcessor` and export timing/behaviour is unchanged — verify: `pnpm test`
- **Buffering correctness**: spans buffered by traceId, exported once root + all children end; `maxBufferedSpans` cap respected — verify: `pnpm test`
- Types compile — verify: `pnpm typecheck`
- Lint clean — verify: `pnpm lint`
- Build emits — verify: `pnpm build`
- Bundle budget — verify: `pnpm size`
- Docs build — verify: `pnpm docs:generate`

Full gate (run ALL, in order, before any promise):

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build && pnpm size && pnpm docs:generate
```

## 3. Completion promise

Phrase: `ALL ACCEPTANCE MET`   (must match `--completion-promise` exactly)

Gate — MANDATORY before emitting:
1. Every task in §4 checked done in RESUME.md.
2. Run every §2 full-gate command. ALL exit 0.
3. Paste the verify output into your response.
4. ONLY THEN output: `<promise>ALL ACCEPTANCE MET</promise>`

NEVER on self-assessment. NEVER to escape a stuck loop. Gate not green → iterate, escalate (§6), or abort (§7).

## 4. Tasks

Ordered. Each impl task in-scope INCLUDES its TSDoc + its own `test/*.test.ts`.

| #   | Action | Files in-scope | Out-of-scope | Done when (exit 0) | Difficulty | Review | escalate_after |
| :-- | :----- | :------------- | :----------- | :----------------- | :--------- | :----- | :------------- |
| 001 | Sampling types + built-ins: `LocalTrace`, `TailSampleFn`; `keepOnError` (root status ERROR), `keepOnHeadSampled` (SAMPLED flag), `keepAll`, `keepOnSlow(ms)`, `multiTailSampler(fns)` (OR); add `SDKConfig.sampling?: { tailSampler?; headSampler?; propagationRatio?; maxBufferedSpans? }`. | `src/cloudflare/sampling.ts`, `src/cloudflare/index.ts`, `src/shared/types.ts`, `test/cloudflare-sampling.test.ts` | the processor; adapter wiring | `pnpm test cloudflare-sampling && pnpm typecheck` | medium | opus | 2 |
| 002 | `TailSampleSpanProcessor implements SpanProcessor`: buffer spans by traceId (`onStart` add, `onEnd` remove from in-progress; when in-progress==0 → run tailSampler → export kept via the existing trace exporter, drop otherwise); `forceFlush(traceId?)`; `maxBufferedSpans` cap (default 2048) → on overflow force-decide+flush early, log drop. Default tailSampler `multiTailSampler([keepOnHeadSampled, keepOnError])`. | `src/cloudflare/tail-processor.ts`, `test/cloudflare-tail-processor.test.ts` | head sampler; adapter wiring | `pnpm test cloudflare-tail-processor && pnpm typecheck` | hard | opus | 2 |
| 003 | Head sampler that **records all** + propagates by ratio: custom `Sampler` returning `RECORD_AND_SAMPLED` w.p. `propagationRatio` (default 1.0) else `RECORD` (never `NOT_RECORD`), wrapped in `ParentBasedSampler` (respect remote parent). Default head sampler when `sampling` set. | `src/cloudflare/sampling.ts`, `test/cloudflare-sampling.test.ts` | adapter wiring | `pnpm test cloudflare-sampling && pnpm typecheck` | hard | opus | 2 |
| 004 | Adapter wiring: when `config.sampling` present → use `TailSampleSpanProcessor` + the record-all head sampler; else keep `SimpleSpanProcessor` (unchanged). Hook `forceFlush(traceId)` into the request-end `ctx.waitUntil` flush so the tail decision runs after response. | `src/cloudflare/adapter.ts`, `src/cloudflare/instrument.ts`, `test/cloudflare-tail-integration.test.ts` | unrelated adapter setup | `pnpm test cloudflare-tail-integration && pnpm typecheck` | hard | opus | 2 |
| 005 | Docs: Starlight page *"Tail sampling on Cloudflare"* — the record-all nuance (why head must not drop), the propagation tension (SAMPLED is a head decision; local-only guarantee), CF one-isolate-one-trace synergy, `keepOnError`/`multiTailSampler` examples, `propagationRatio` cost trade-off; **plus a "Cloudflare observability vs this library" subsection** (see §5 note): wrangler `[observability] head_sampling_rate` gates ONLY CF's native Workers-Logs pipeline, NOT the library's userland OTLP `fetch` export — it never blocks tail-sampled error traces to the external collector; CF head sampling has no error bias, so keep `head_sampling_rate = 1` for reliable error capture on the CF-dashboard backup. TSDoc on all new exports. | `docs/**` | source code | `pnpm docs:generate` | medium | self | 2 |
| 006 | Final gate: run full §2 gate; fix lint/size/build fallout (no new runtime dep). | any flagged file | new features | `pnpm test && pnpm typecheck && pnpm lint && pnpm build && pnpm size && pnpm docs:generate` | medium | sonnet | 2 |

**Review levels:** `self` run+self-check; `sonnet` re-read full diff fresh; `opus` spawn Opus subagent deep-review BEFORE marking done (mandatory for 001/002/003/004 — public API + core export pipeline).

## 5. Guardrails (do NOT violate)

- Do NOT touch: `src/node/**`, `src/browser/**`, `src/bun/**`, `src/shared/exporters.ts`, `src/cloudflare/workflow.ts`, the binding wrappers from slice 001.
- **Additive / non-breaking.** No `sampling` config → adapter behaviour byte-identical to today (`SimpleSpanProcessor`, export-per-span). Prove it with a test.
- **Record-all invariant:** the default head sampler MUST NEVER return `NOT_RECORD` — otherwise tail can't keep errored traces. This is the core correctness property.
- **No new RUNTIME dependency.** Reuse existing trace exporter (`FetchTraceExporter`) + `@opentelemetry/sdk-trace-base` (already a dep).
- Tail decision + export MUST run in `ctx.waitUntil` (after response) — never block the response.
- Respect `maxBufferedSpans`; never grow the buffer unbounded (isolate memory).
- Do NOT expand scope beyond this table. New need → RESUME.md "Open questions", do NOT silently implement.
- Do NOT delete/rewrite a file you did not create without surfacing it in RESUME.md first.
- Follow CLAUDE.md orchestrator/worker split: delegate code writes to `sonnet-implementer`.

**Doc-accuracy note (for task 005 — must be stated correctly, it is a common misconfiguration):**
- Cloudflare wrangler `[observability] head_sampling_rate` (0–1, default 1) gates ONLY Cloudflare's native Workers-Logs / dashboard pipeline. It does NOT gate this library's OTLP trace export — spans leave via a userland `fetch()` subrequest, unaffected by that rate. So a wrangler rate `< 1` NEVER blocks tail-sampled error traces from reaching the external collector. They are independent pipelines.
- CF head sampling has NO error bias (head-only, no tail). Therefore errored invocations can be dropped from the CF dashboard when `head_sampling_rate < 1`. For a reliable CF-dashboard backup, keep `head_sampling_rate = 1`; the library's tail `keepOnError` backstops the external collector either way.
- Sources: developers.cloudflare.com/workers/observability/logs/workers-logs/ , /workers/wrangler/configuration/ , /workers/observability/traces/

## 6. Escalation rules

Spawn an Opus subagent (cold-context briefing) when ANY:
- Task tagged `review: opus` (001/002/003/004) → Opus reviews diff before done.
- Diff touches public API (`src/cloudflare/index.ts`) or the span-processor pipeline (`adapter.ts`) → Opus review (CLAUDE.md auto-trigger).
- SAME task fails verify `escalate_after` (2) times → Opus DIAGNOSE → `SOLVABLE`+hint (reset attempts, apply) or `IMPOSSIBLE`+rationale (→ §7).
Briefing = task row + failing verify output + paths. Batch Opus questions into ONE call.

## 7. Abort protocol (only authorized exit besides success)

Trigger: Opus DIAGNOSE returned `IMPOSSIBLE`.
1. Write `BLOCKED.md` in the slice folder.
2. Set RESUME.md status: `blocked`.
3. Run: `rm .claude/.ralph-loop.local.md`
4. Exit with a short summary pointing at BLOCKED.md.

Overrides ralph's "never circumvent" default — gated by Opus, not self-escape. Do NOT emit the promise to abort. Do NOT delete the state file for any other reason.

## 8. Iteration discipline (every iteration, in order)

1. Read CONTRACT.md and RESUME.md first.
2. Idempotency: never redo a done task.
3. Pick next unchecked §4 task.
4. Implement (delegate code writes per CLAUDE.md split).
5. Run verify: pass → check done + record files/decisions + reset `attempts` to 0; fail → increment `attempts:`; `attempts >= escalate_after` → §6.
6. Checkpoint commit (one per completed task).
7. All done → run §3 promise gate.

## 9. Backstop

max-iterations: 18. Hard ceiling. If hit, loop stops; user reviews RESUME.md + any BLOCKED.md.

## 10. Start command (fresh Sonnet session, dedicated branch)

```
git checkout -b ralph/cloudflare-otel-parity-002
/ralph-loop:ralph-loop "$(cat plans/cloudflare-otel-parity/002-tail-sampling/PROMPT.md)" --max-iterations 18 --completion-promise 'ALL ACCEPTANCE MET'
```

Invoke form is `/ralph-loop:ralph-loop` (`plugin:command`, repeated) — NOT `/ralph-loop`. Prompt read from PROMPT.md via `"$(cat …)"`.

## 11. Post-completion — open PR to base branch

Runs in the SAME response that emits the §3 promise. Target: PR from head `ralph/cloudflare-otel-parity-002` → base `main`.

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
4. CLI authed AND host matches AND access (`gh auth status` exit 0) → **OFFER, do NOT auto-create**:
   - GitHub: `gh pr create --base "$base" --head "$head" --fill`
5. Else → compare URL: `https://$host/$path/compare/$base...$head?expand=1` — print it.

End the promise turn with: `base ← head`, plus the offered command (authed) or compare URL (unauthed).
