# Ralph Contract: Docs migration — Starlight + llms.txt + consumer skill

**Slice:** plans/docs-starlight-migration/001-starlight-llms-skill/
**Executor:** Sonnet orchestrator, autonomous ralph-loop (fresh session)
**Planner:** Opus — contract authored 2026-06-12
**Base branch:** main

## 0. Sanity check (preflight — run FIRST, every iteration, before any task work)

```bash
SLICE=plans/docs-starlight-migration/001-starlight-llms-skill
# 1. Must be on a ralph/ branch, never main/master
git branch --show-current | grep -qE "^ralph/" \
  || { echo "ERROR: not on ralph/ branch — abort"; exit 1; }
# 2. Contract + progress files must exist
test -f "$SLICE/CONTRACT.md" || { echo "ERROR: CONTRACT.md missing"; exit 1; }
test -f "$SLICE/RESUME.md"   || { echo "ERROR: RESUME.md missing"; exit 1; }
# 3. If blocked, surface and stop
test ! -f "$SLICE/BLOCKED.md" \
  || { echo "Loop BLOCKED — read BLOCKED.md:"; cat "$SLICE/BLOCKED.md"; exit 0; }
# 4. Toolchain present
command -v node >/dev/null || { echo "ERROR: node missing"; exit 1; }
command -v pnpm >/dev/null || { echo "ERROR: pnpm missing"; exit 1; }
```

If ANY check fails: stop, print the error, do NOT proceed to §4 tasks.

## 1. Mission
Replace pure-TypeDoc HTML docs with an Astro + Starlight site (GitHub Pages) that embeds a per-runtime TypeDoc API reference, ships per-runtime usage guides, emits `llms.txt` + 5 document sets (whitespace preserved), leads with an llms.txt URL + copy button on the landing page, trims the README to a pointer, and ships a generator Claude skill in the npm package.

## 2. Success criteria (definition of done)
Loop is DONE only when ALL hold, each proven by a command that exits 0:

- Library still builds — verify: `pnpm run build`
- Library tests pass — verify: `pnpm test`
- API markdown generated per runtime — verify: `pnpm --filter docs run docs:api && test -d docs/src/content/docs/api/node && test -d docs/src/content/docs/api/bun && test -d docs/src/content/docs/api/cloudflare && test -d docs/src/content/docs/api/browser && test -d docs/src/content/docs/api/shared`
- Docs site builds under Pages base — verify: `pnpm --filter docs build`
- llms.txt + full variant emitted — verify: `test -f docs/dist/llms.txt && test -f docs/dist/llms-full.txt`
- Whitespace preserved (not collapsed to single spaces): `minify: { whitespace: false }` present in config — verify: `grep -Eq "whitespace:\s*false" docs/astro.config.mjs`
- 5 custom sets configured — verify: `grep -c "label:" docs/astro.config.mjs | awk '$1>=5{exit 0} {exit 1}'`
- Each runtime page has setup + recommended API + example headings — verify: `for r in node bun cloudflare browser; do f=docs/src/content/docs/runtimes/$r.md; grep -qi "## setup" "$f" && grep -qi "recommended" "$f" && grep -qi "## example" "$f" || { echo "missing section in $f"; exit 1; }; done`
- Landing hero shows llms.txt URL + copy button — verify: `grep -q "llms.txt" docs/src/content/docs/index.mdx && grep -q "CopyLlmsUrl" docs/src/content/docs/index.mdx && test -f docs/src/components/CopyLlmsUrl.astro`
- README trimmed + links to site & llms.txt — verify: `grep -q "tigorlazuardi.github.io/telemetry-js" README.md && grep -q "llms.txt" README.md && test "$(wc -l < README.md)" -lt 140`
- Generator skill shipped — verify: `test -f skills/telemetry-js/SKILL.md && node -e "const f=require('./package.json').files||[]; process.exit(f.includes('skills')?0:1)"`
- CI has docs build + Pages deploy — verify: `grep -rqi "filter docs" .github/workflows/ && grep -rqi "deploy-pages\|actions/deploy-pages\|Pages" .github/workflows/`

Full gate (run ALL, in order, before any promise):
```bash
set -e
SLICE=plans/docs-starlight-migration/001-starlight-llms-skill
pnpm install
pnpm run build
pnpm test
pnpm --filter docs run docs:api
test -d docs/src/content/docs/api/node && test -d docs/src/content/docs/api/bun \
  && test -d docs/src/content/docs/api/cloudflare && test -d docs/src/content/docs/api/browser \
  && test -d docs/src/content/docs/api/shared
pnpm --filter docs build
test -f docs/dist/llms.txt && test -f docs/dist/llms-full.txt
grep -Eq "whitespace:\s*false" docs/astro.config.mjs
for r in node bun cloudflare browser; do f=docs/src/content/docs/runtimes/$r.md; \
  grep -qi "## setup" "$f" && grep -qi "recommended" "$f" && grep -qi "## example" "$f"; done
grep -q "llms.txt" docs/src/content/docs/index.mdx && grep -q "CopyLlmsUrl" docs/src/content/docs/index.mdx
test -f docs/src/components/CopyLlmsUrl.astro
grep -q "tigorlazuardi.github.io/telemetry-js" README.md && grep -q "llms.txt" README.md
test "$(wc -l < README.md)" -lt 140
test -f skills/telemetry-js/SKILL.md
node -e "const f=require('./package.json').files||[]; process.exit(f.includes('skills')?0:1)"
grep -rqi "filter docs" .github/workflows/
grep -rqi "deploy-pages\|actions/deploy-pages\|github-pages" .github/workflows/
echo "FULL GATE GREEN"
```

> If `starlight-llms-txt` (installed version) emits the custom-set or llms files under different names/paths than assumed, adjust ONLY the file-path in the affected check to the real emitted path — record the change in RESUME.md. Do NOT delete the whitespace check or the llms emit check.

## 3. Completion promise
Phrase: `ALL ACCEPTANCE MET`   (must match `--completion-promise` exactly)

Gate — MANDATORY before emitting, no exceptions:
1. Every task in §4 checked done in RESUME.md.
2. Run the §2 full gate. It prints `FULL GATE GREEN` (all exit 0).
3. Paste the gate output into your response.
4. ONLY THEN output: `<promise>ALL ACCEPTANCE MET</promise>`

NEVER emit on self-assessment. NEVER emit to escape a stuck loop. Cannot make the gate green → iterate, escalate (§6), or abort (§7).

## 4. Tasks
Ordered. Each iteration: execute the next unchecked task. Track state in RESUME.md. All file writes delegated to `sonnet-implementer`.

| #   | Action | Files in-scope | Out-of-scope | Done when (verify cmd, exit 0) | Difficulty | Review | escalate_after |
| :-- | :----- | :------------- | :----------- | :----------------------------- | :--------- | :----- | :------------- |
| 001 | Scaffold `docs/` workspace: `docs/package.json` (deps: astro, @astrojs/starlight, starlight-llms-txt, typedoc, typedoc-plugin-markdown, typedoc-plugin-frontmatter), `docs/tsconfig.json`, `docs/src/content.config.ts`, placeholder `docs/src/content/docs/index.mdx`. Add `docs` to `pnpm-workspace.yaml`. Remove `docs/` from `.gitignore`; add `docs/dist/`, `docs/.astro/`, `docs/src/content/docs/api/`. | `docs/package.json`, `docs/tsconfig.json`, `docs/src/content.config.ts`, `docs/src/content/docs/index.mdx`, `pnpm-workspace.yaml`, `.gitignore` | `src/**`, root `package.json` | `pnpm install >/dev/null 2>&1 && pnpm --filter docs exec astro --version` | medium | self | 2 |
| 002 | TypeDoc prebuild pipeline: `docs/typedoc.base.json` (shared opts) + `docs/scripts/gen-api.mjs` (per-bucket runner, D9 table) + `docs:api`/`prebuild`/`build`/`dev`/`preview` scripts in `docs/package.json`. | `docs/typedoc.base.json`, `docs/scripts/gen-api.mjs`, `docs/package.json` | `src/**`, root `package.json` | `pnpm --filter docs run docs:api && test -d docs/src/content/docs/api/node && test -d docs/src/content/docs/api/browser && test -d docs/src/content/docs/api/shared` | hard | self | 2 |
| 003 | Astro config: `docs/astro.config.mjs` — starlight (title, social, site `https://tigorlazuardi.github.io`, base `/telemetry-js`), sidebar (getting-started, runtimes, guides auto + API Reference autogenerate `api` collapsed), `starlight-llms-txt` plugin with `minify:{whitespace:false}` + 5 customSets per DESIGN. Build must pass with generated API + placeholder index. | `docs/astro.config.mjs` | `src/**` | `pnpm --filter docs build` | hard | self | 2 |
| 004 | `getting-started/` pages: installation, subpath-exports, concepts — migrated from README. | `docs/src/content/docs/getting-started/*.md` | runtimes/, guides/ | `for f in installation subpath-exports concepts; do test -f docs/src/content/docs/getting-started/$f.md; done && pnpm --filter docs build` | easy | self | 2 |
| 005 | `runtimes/node.md` — setup + recommended API + complete example. | `docs/src/content/docs/runtimes/node.md` | other runtimes | `f=docs/src/content/docs/runtimes/node.md; grep -qi "## setup" $f && grep -qi recommended $f && grep -qi "## example" $f` | medium | self | 2 |
| 006 | `runtimes/bun.md` — setup + recommended API + example. | `docs/src/content/docs/runtimes/bun.md` | other runtimes | `f=docs/src/content/docs/runtimes/bun.md; grep -qi "## setup" $f && grep -qi recommended $f && grep -qi "## example" $f` | medium | self | 2 |
| 007 | `runtimes/cloudflare.md` — setup + recommended API + example; fold in `guides/cloudflare.md`. | `docs/src/content/docs/runtimes/cloudflare.md` | other runtimes | `f=docs/src/content/docs/runtimes/cloudflare.md; grep -qi "## setup" $f && grep -qi recommended $f && grep -qi "## example" $f` | medium | self | 2 |
| 008 | `runtimes/browser.md` — setup + recommended API + example; cover `/browser/fetch`, `/browser/react` hooks, `/browser/sdk`. | `docs/src/content/docs/runtimes/browser.md` | other runtimes | `f=docs/src/content/docs/runtimes/browser.md; grep -qi "## setup" $f && grep -qi recommended $f && grep -qi "## example" $f` | medium | self | 2 |
| 009 | `guides/` pages migrated from README: with-trace, trace-handler, context, database-naming, endpoint-resolution, logger, metrics, ui-action-metrics, exporters, configuration, resource-validation, instrument-fetch. | `docs/src/content/docs/guides/*.md` | runtimes/ | `n=$(ls docs/src/content/docs/guides/*.md | wc -l); test $n -ge 11 && pnpm --filter docs build` | medium | self | 2 |
| 010 | Landing page: splash `index.mdx` with hero = llms.txt URL + `<CopyLlmsUrl />` first element; `docs/src/components/CopyLlmsUrl.astro` (clipboard + "copied" feedback, no deps). | `docs/src/content/docs/index.mdx`, `docs/src/components/CopyLlmsUrl.astro` | — | `grep -q llms.txt docs/src/content/docs/index.mdx && grep -q CopyLlmsUrl docs/src/content/docs/index.mdx && test -f docs/src/components/CopyLlmsUrl.astro && pnpm --filter docs build` | medium | self | 2 |
| 011 | Verify llms output: after build, `docs/dist/llms.txt` + `docs/dist/llms-full.txt` exist; spot-check a runtime set preserves formatting (newlines/code fences intact, not collapsed). If emitted paths differ from assumption, fix §2 path checks + note in RESUME. | (config already in 003) | — | `pnpm --filter docs build && test -f docs/dist/llms.txt && test -f docs/dist/llms-full.txt` | medium | self | 2 |
| 012 | Trim README → npm landing: title/badges, install, ONE quick example, links to docs site + llms.txt. Remove migrated long sections. | `README.md` | docs site content | `grep -q "tigorlazuardi.github.io/telemetry-js" README.md && grep -q llms.txt README.md && test "$(wc -l < README.md)" -lt 140` | medium | self | 2 |
| 013 | Generator/installer Claude skill: `skills/telemetry-js/SKILL.md` (+ templates) — detects consumer runtime, generates `.claude/rules/telemetry-js-*.md` + a usage skill pointing at the matching published llms.txt set; idempotent; `.claude/`-only. Add `"skills"` to root `package.json` `files`. | `skills/telemetry-js/**`, root `package.json` (`files` only) | root `package.json` `exports`/`dependencies` | `test -f skills/telemetry-js/SKILL.md && node -e "process.exit((require('./package.json').files||[]).includes('skills')?0:1)"` | hard | **opus** | 2 |
| 014 | Reconcile root `package.json` + remove old standalone TypeDoc HTML pipeline: drop/repoint `docs:generate`; ensure `typedoc` no longer targets `out: docs`; reconcile root `typedoc.json` (delete or neutralize). `exports` + `dependencies` UNCHANGED. | root `package.json`, root `typedoc.json` | `exports`, runtime `dependencies`, `src/**` | `pnpm run build && pnpm test && node -e "const e=require('./package.json').exports; process.exit(e['./node']&&e['./browser']?0:1)"` | hard | **opus** | 2 |
| 015 | CI: extend `.github/workflows/ci.yml` with a docs build job (`pnpm --filter docs build`); add `.github/workflows/deploy-docs.yml` (build docs → `actions/upload-pages-artifact` → `actions/deploy-pages`, on push to main, correct permissions). | `.github/workflows/ci.yml`, `.github/workflows/deploy-docs.yml` | other workflows | `grep -rqi "filter docs" .github/workflows/ && grep -rqi "deploy-pages\|github-pages" .github/workflows/ && node -e "const y=require('fs').readFileSync('.github/workflows/deploy-docs.yml','utf8'); process.exit(y.includes('pages')?0:1)"` | medium | self | 2 |

**Review levels:** `self` = run verify + self-check diff; `opus` = spawn Opus subagent to deep-review the diff BEFORE marking done (mandatory for rows 013, 014).

## 5. Guardrails (do NOT violate)
- Do NOT touch library runtime source: `src/**` (except generated `docs/src/content/docs/api/**`).
- Do NOT change root `package.json` `exports` map or runtime `dependencies` / `peerDependencies`. Task 013 edits only `files`; task 014 edits only `scripts`/`devDependencies` + removes the HTML typedoc pipeline.
- Do NOT add astro/starlight/typedoc-plugin deps to the root (published) package — they belong in `docs/`.
- Keep `minify: { whitespace: false }` — never enable whitespace collapse (known mangling bug).
- Do NOT expand scope beyond the §4 table. New need → record in RESUME.md "Open questions", do not silently implement.
- Do NOT delete/rewrite a file you did not create without surfacing in RESUME.md first (notably `README.md` — trim per task 012, keep license/install essentials).
- Generator skill writes ONLY under a consumer's `.claude/`; never touches consumer source.
- Follow CLAUDE.md split: delegate code writes to `sonnet-implementer`; loop session orchestrates + reviews.

## 6. Escalation rules
Spawn an Opus subagent (`Agent({ model: "opus", ... })`, cold-context briefing) when ANY:
- Task tagged `review: opus` (013, 014) → Opus reviews its diff before marking done.
- Diff unexpectedly touches root `package.json` `exports`/`dependencies` or any `src/**` runtime file → Opus review (public-surface auto-trigger).
- SAME task fails its verify `escalate_after` (2) times → Opus DIAGNOSE. Returns:
  - `SOLVABLE` + hint → reset that task's `attempts` to 0, apply hint, continue.
  - `IMPOSSIBLE` + rationale → §7 Abort.
Briefing = task row + failing verify output + relevant file paths. Batch multiple questions into ONE Opus call.

## 7. Abort protocol (only authorized exit besides success)
Trigger: Opus DIAGNOSE returned `IMPOSSIBLE`. (Sonnet judgment alone is NOT valid.)
Steps:
1. Write `BLOCKED.md` in the slice folder (template in ralph-contract-template.md).
2. Set RESUME.md status: `blocked`.
3. Run: `rm .claude/.ralph-loop.local.md`
4. Exit with a short summary pointing at BLOCKED.md.

Do NOT emit the completion promise to abort. Do NOT delete the state file for any other reason.

## 8. Iteration discipline (every iteration, in order)
1. Read CONTRACT.md + RESUME.md first.
2. Idempotency: never redo a task already checked done.
3. Pick next unchecked §4 task.
4. Implement (delegate code writes to `sonnet-implementer`).
5. Run task verify:
   - Pass → check done in RESUME.md; record files touched + decisions; reset its `attempts` to 0.
   - Fail → increment task `attempts:`. If `attempts >= escalate_after` → §6.
6. Checkpoint commit (one commit per completed task) — `git commit` with a conventional message ending the Co-Authored-By trailer; keeps each iteration revertable.
7. opus-tagged task: Opus review BEFORE marking done.
8. All tasks done → run §3 promise gate.

## 9. Backstop
max-iterations: 40. Hard ceiling. If hit, loop stops; user reviews RESUME.md + any BLOCKED.md.

## 10. Start command (fresh Sonnet session, dedicated branch)
```
git checkout -b ralph/docs-starlight-migration-001
/ralph-loop:ralph-loop "$(cat plans/docs-starlight-migration/001-starlight-llms-skill/PROMPT.md)" --max-iterations 40 --completion-promise 'ALL ACCEPTANCE MET'
```
Invoke form is `/ralph-loop:ralph-loop` (`plugin:command`, repeated) — NOT `/ralph-loop`.

## 11. Post-completion — open PR to base branch
Runs in the SAME response that emits the §3 promise. Target: PR from head `ralph/docs-starlight-migration-001` → base `main`.

Steps:
1. Push the feature branch: `git push -u origin "$(git branch --show-current)"`
2. Detect remote + provider:
```bash
url=$(git remote get-url origin 2>/dev/null) || echo "no origin — skip PR, report loop done + branch"
host=$(printf '%s' "$url" | sed -E 's#^(git@|ssh://git@|https?://)([^/:]+)[/:].*#\2#')
path=$(printf '%s' "$url" | sed -E 's#^(git@|ssh://git@|https?://)[^/:]+[/:]##; s#\.git$##')
base="main"; head=$(git branch --show-current)
```
3. Host `github.com` → `gh`. (origin is github.com/tigorlazuardi/telemetry-js.)
4. `gh auth status` exits 0 + host matches → **OFFER, do NOT auto-create**: `gh pr create --base "$base" --head "$head" --fill`
5. `gh` absent / not authed → print compare URL: `https://$host/$path/compare/$base...$head?expand=1`

End the promise turn with: `base ← head`, plus the offered `gh` command or the compare URL.
