# Ralph Contract: browser lazy facade + SDK swap

**Slice:** plans/browser-lazy-facade/001-facade-lazy-swap/
**Executor:** Sonnet orchestrator, autonomous ralph-loop (fresh session)
**Planner:** Opus — contract authored 2026-06-12
**Base branch:** main

## 0. Sanity check (preflight — run FIRST, every iteration, before any task work)

```bash
# 1. Must be on a ralph/ branch, never main/master
git branch --show-current | grep -qE "^ralph/" \
  || { echo "ERROR: not on ralph/ branch — abort"; exit 1; }
# 2. Contract + progress files must exist
test -f plans/browser-lazy-facade/001-facade-lazy-swap/CONTRACT.md \
  || { echo "ERROR: CONTRACT.md missing"; exit 1; }
test -f plans/browser-lazy-facade/001-facade-lazy-swap/RESUME.md \
  || { echo "ERROR: RESUME.md missing"; exit 1; }
# 3. If blocked, surface it and stop
test ! -f plans/browser-lazy-facade/001-facade-lazy-swap/BLOCKED.md \
  || { echo "Loop BLOCKED — read BLOCKED.md:"; cat plans/browser-lazy-facade/001-facade-lazy-swap/BLOCKED.md; exit 0; }
# 4. Toolchain present
command -v pnpm >/dev/null || { echo "ERROR: pnpm missing"; exit 1; }
test -f package.json || { echo "ERROR: not at repo root"; exit 1; }
```

If ANY check fails: stop, print the error, do NOT proceed to §4 tasks.

## 1. Mission
Make the browser entrypoint maximize code-splitting + lazy loading: `/browser`
becomes a pure-JS, zero-`@opentelemetry` facade whose API passes through
synchronously until `initSDK` lazily loads the heavy SDK and swaps in the real
impl. Add a `dev` console-gating option and a bundle-size benchmark with a CI
budget gate.

## 2. Success criteria (definition of done)
Loop is DONE only when ALL hold, each proven by a command that exits 0:
- Build, types, lint, tests pass — verify: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
- Compiled facade pulls NO OpenTelemetry at runtime — verify (after build):
  `! grep -n "@opentelemetry" dist/browser/index.js`
  (grep the COMPILED output: type-only re-exports are erased; the `import("./internal/real.js")`
  dynamic boundary lives in a separate chunk, so it must not appear as otel here)
- Facade source has NO static value import of the heavy modules —
  verify: `! grep -nE "from ['\"][^'\"]*(adapter|internal/real|shared/exporters|shared/noop)" src/browser/index.ts`
- `initSDK` returns a Promise — verify:
  `grep -nE "initSDK\\([^)]*\\)\\s*:\\s*Promise<SDKResult>" src/browser/index.ts`
- `dev` option exists — verify: `grep -nE "dev\\??:\\s*boolean" src/shared/types.ts`
- `/browser/sdk` subpath builds — verify:
  `pnpm build && test -f dist/browser/sdk/index.js && test -f dist/browser/sdk/index.d.ts`
- Bundle-size benchmark runs within budget — verify: `pnpm size`
- All §4 tasks checked done in RESUME.md.

Full gate (run ALL, in order, before any promise):
```
pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm size
```

## 3. Completion promise
Phrase: `ALL ACCEPTANCE MET`   (must match `--completion-promise` exactly)

Gate — MANDATORY before emitting, no exceptions:
1. Every task in §4 is checked done in RESUME.md.
2. Run every verify command in §2. ALL exit 0.
3. Paste the verify output into your response.
4. ONLY THEN output: `<promise>ALL ACCEPTANCE MET</promise>`

NEVER emit the promise on self-assessment alone. NEVER to escape a stuck loop.
If the gate cannot go green: iterate, escalate (§6), or abort (§7).

## 4. Tasks
Ordered. Each iteration: execute the next unchecked task. Track state in RESUME.md.
Full per-task detail in `TASKS.md` (same folder).

| #   | Action | Files in-scope | Out-of-scope | Done when (exit 0) | Difficulty | Review | escalate_after |
| :-- | :----- | :------------- | :----------- | :----------------- | :--------- | :----- | :------------- |
| 001 | size-limit dev-dep + `.size-limit.json` + `pnpm size`; capture `/browser` baseline into RESUME.md | `package.json`, `.size-limit.json`, RESUME.md | `src/**` | `pnpm build && pnpm size` | easy | self | 2 |
| 002 | `SDKConfig.dev?: boolean` + `createLogger` console toggle (default = console ON, preserve Node/CF/Bun) | `src/shared/types.ts`, `src/shared/logger.ts` | other adapters' behaviour | `pnpm typecheck && pnpm test` | medium | sonnet | 2 |
| 003 | adapter passes `config.dev` → `createLogger` (`console: !!config.dev`) | `src/browser/adapter.ts` | `src/node`,`src/cloudflare`,`src/bun` | `pnpm typecheck && pnpm test` | easy | self | 2 |
| 004 | `src/browser/passthrough.ts` pure-JS default impls (sync wrappers, silent logger, noop inject), zero OTel | `src/browser/passthrough.ts` | any OTel import | `pnpm typecheck && ! grep -n "@opentelemetry" src/browser/passthrough.ts` | medium | self | 2 |
| 005 | `src/browser/internal/real.ts` lazy chunk root: real setup + real wrapper impls as one `impl` | `src/browser/internal/real.ts` | facade index.ts | `pnpm typecheck` | medium | sonnet | 2 |
| 006 | Rewrite `src/browser/index.ts` as facade: mutable impl, async idempotent `initSDK: Promise<SDKResult>`, dynamic import + swap, drop heavy/OTel re-exports + `instrumentFetch`, keep type-only exports. Failure fallback MUST be pure-JS (do NOT static-import `shared/noop` — it pulls otel) | `src/browser/index.ts` | `src/browser/fetch/*`, `src/browser/react/*` | `pnpm typecheck && pnpm build && ! grep -n "@opentelemetry" dist/browser/index.js` | hard | opus | 2 |
| 007 | `src/browser/sdk.ts` (`/browser/sdk`): exporters, `metrics`, `StackContextManager`, low-level providers + `package.json` exports entry | `src/browser/sdk.ts`, `package.json` | facade index.ts | `pnpm build && test -f dist/browser/sdk/index.js && test -f dist/browser/sdk/index.d.ts` | medium | opus | 2 |
| 008 | Tests: passthrough sync + no-throw; pre-init logger silent; post-init swap real spans; initSDK idempotent/concurrent + failure→passthrough; `dev` matrix; facade pulls no OTel | `test/**` | `src/**` behaviour | `pnpm test` | hard | sonnet | 2 |
| 009 | `.size-limit.json` hard budgets + zero-OTel assertion on facade; record after-numbers + delta in RESUME.md | `.size-limit.json`, RESUME.md | `src/**` | `pnpm size` | medium | self | 2 |
| 010 | Docs: README browser section, entrypoint docstrings, CI `pnpm size` job | `README.md`, `src/browser/*.ts` docstrings, `.github/workflows/*` | code behaviour | `pnpm build && pnpm lint` | medium | sonnet | 2 |

**Review levels:** `self` = run verify + self-check diff. `sonnet` = re-read full
diff with fresh eyes vs acceptance before done. `opus` = spawn Opus subagent to
deep-review the diff BEFORE marking done (mandatory for `opus` rows 006, 007 —
public-API / entrypoint-contract change).

## 5. Guardrails (do NOT violate)
- Do NOT touch `src/browser/fetch/*` or `src/browser/react/*` behaviour (import-
  path fixes only if a shared-module move forces one — no logic change).
- Do NOT touch `src/node`, `src/cloudflare`, `src/bun` adapters/entrypoints.
- Do NOT change Node/CF/Bun logger console behaviour — the `createLogger` toggle
  MUST default to current behaviour (console ON); only the browser adapter opts
  into `dev`-gating.
- Keep `withAction`/`scopeAction`/`traced`/`withTrace` signatures **synchronous**
  (`T`, not `Promise<T>`).
- Eager `/browser` facade: **zero `@opentelemetry/*` static import** (the §2
  grep is the gate). The facade must NOT statically import any of: `shared/noop`
  (pulls `@opentelemetry/api` + `resources`), `shared/exporters`, real
  `shared/logger`, `shared/action`, `shared/with-trace`, `shared/traced`,
  `shared/context`, `./adapter`, `./internal/real`. All of these are reachable
  only via the lazy `await import("./internal/real.js")` boundary. The `initSDK`
  catch/failure path returns a **pure-JS passthrough** SDKResult (silent logger,
  `resource: null`, noop `shutdown`/`forceFlush`), NOT `noopSDKResult()` from
  `shared/noop`.
- No new RUNTIME dependencies (size-limit is dev-only).
- Do NOT expand scope beyond §4. New need → record in RESUME.md "Open
  questions"; do NOT silently implement.
- Do NOT delete/rewrite a file you did not create without surfacing it in
  RESUME.md first.
- Follow CLAUDE.md orchestrator/worker split: delegate code writes to
  `sonnet-implementer`; the loop session orchestrates + reviews.

## 6. Escalation rules
Spawn an Opus subagent (`Agent({ model: "opus", ... })`, cold-context briefing) when ANY:
- Task tagged `review: opus` (006, 007) → Opus reviews its diff before done.
- Diff touches public API / entrypoint contract / `package.json` exports → Opus
  review (CLAUDE.md auto-trigger: public-API surface).
- SAME task fails its verify `escalate_after` (2) times → Opus DIAGNOSE. Opus returns:
  - `SOLVABLE` + concrete hint → reset that task's `attempts` to 0, apply, continue.
  - `IMPOSSIBLE` + rationale → §7 Abort.
Briefing = task row + failing verify output + relevant file paths. Batch
multiple Opus questions into ONE call.

## 7. Abort protocol (only authorized exit besides success)
Trigger: Opus DIAGNOSE returned `IMPOSSIBLE`. (Sonnet judgment alone is NOT valid.)
1. Write `BLOCKED.md` in the slice folder (template in ralph-contract-template).
2. Set RESUME.md status: `blocked`.
3. Run: `rm .claude/.ralph-loop.local.md`
4. Exit with a short summary pointing at BLOCKED.md.

Do NOT emit the completion promise to abort (that lies). Do NOT delete the state
file for any other reason.

## 8. Iteration discipline (every iteration, in order)
1. Read this CONTRACT.md and RESUME.md first.
2. Idempotency: never redo a task already checked done in RESUME.md.
3. Pick the next unchecked task in §4.
4. Implement it (delegate code writes per CLAUDE.md split).
5. Run the task's verify command:
   - Pass → check it done in RESUME.md; record files touched + key decisions; reset `attempts` to 0.
   - Fail → increment that task's `attempts:`. If `attempts >= escalate_after` → §6.
6. Checkpoint commit per completed task (keeps each iteration revertable).
7. When every task is done → run the §3 promise gate.

## 9. Backstop
max-iterations: 30. Hard ceiling. If hit, loop stops; user reviews RESUME.md +
any BLOCKED.md.

## 10. Start command (fresh Sonnet session, dedicated branch)
```
git checkout -b ralph/browser-lazy-facade-001
/ralph-loop:ralph-loop "$(cat plans/browser-lazy-facade/001-facade-lazy-swap/PROMPT.md)" --max-iterations 30 --completion-promise 'ALL ACCEPTANCE MET'
```
Invoke form is `/ralph-loop:ralph-loop` (`plugin:command`, repeated) — NOT
`/ralph-loop`. The prompt is read from `PROMPT.md` via `"$(cat …/PROMPT.md)"`.

## 11. Post-completion — open PR/MR to base branch
Runs in the SAME response that emits the §3 promise. Target: head
`ralph/browser-lazy-facade-001` → base `main`.

Steps:
1. Push: `git push -u origin "$(git branch --show-current)"`
2. Detect remote + provider:
```bash
url=$(git remote get-url origin 2>/dev/null) || { echo "no origin remote — skip PR/MR, report loop done + branch"; }
host=$(printf '%s' "$url" | sed -E 's#^(git@|ssh://git@|https?://)([^/:]+)[/:].*#\2#')
path=$(printf '%s' "$url" | sed -E 's#^(git@|ssh://git@|https?://)[^/:]+[/:]##; s#\.git$##')
base="main"; head=$(git branch --show-current)
```
   Host not github*/gitlab* → skip PR/MR; report loop done + pushed branch.
3. Pick CLI by host: `github.com` → `gh`; `gitlab.*` → `glab`.
4. CLI authed + host matches + access (`gh auth status`/`glab auth status` exit 0) →
   **OFFER, do NOT auto-create**:
   - GitHub: `gh pr create --base "$base" --head "$head" --fill`
   - GitLab: `glab mr create --source-branch "$head" --target-branch "$base" --fill`
5. CLI absent/not authed/wrong host → print compare URL:
   - GitHub: `https://$host/$path/compare/$base...$head?expand=1`
   - GitLab: `https://$host/$path/-/merge_requests/new?merge_request[source_branch]=$head&merge_request[target_branch]=$base`

End the promise turn with: base ← head, plus the offered command (authed) or
compare URL (unauthed).
