# RESUME — docs-starlight-migration / 001-starlight-llms-skill

## Status
- Slice status: `active`
- Loop status: `active`
- Contract: CONTRACT.md (this slice)
- Base branch: main
- Branch (loop): ralph/docs-starlight-migration-001

## Ralph state
- max-iterations: 40
- Completion promise: `ALL ACCEPTANCE MET`

## Task progress (with attempt counters)
- [x] 001 Scaffold docs/ workspace — attempts: 0
- [x] 002 TypeDoc prebuild pipeline (per-runtime buckets) — attempts: 0
- [x] 003 astro.config.mjs (starlight + llms-txt, whitespace:false, 5 sets) — attempts: 1
- [x] 004 getting-started/ pages — attempts: 1
- [x] 005 runtimes/node.md — attempts: 0
- [x] 006 runtimes/bun.md — attempts: 0
- [x] 007 runtimes/cloudflare.md — attempts: 0
- [x] 008 runtimes/browser.md — attempts: 0
- [x] 009 guides/*.md (12 created) — attempts: 0
- [x] 010 landing index.mdx + CopyLlmsUrl.astro — attempts: 0
- [x] 011 verify llms output (emit + whitespace) — attempts: 0
- [x] 012 trim README — attempts: 0
- [x] 013 generator skill + package.json files — attempts: 1  (review: opus — ISSUES FOUND + fixed: SDKResult.ok/.value hallucination, withTrace(name,fn) wrong sig, traceHandler positional arg)
- [x] 014 reconcile root package.json + drop HTML typedoc — attempts: 0  (review: opus — APPROVED)
- [ ] 015 CI docs build + Pages deploy — attempts: 0

## Files touched (append as tasks complete)
- 001: docs/package.json, docs/tsconfig.json, docs/src/content.config.ts, docs/src/content/docs/index.mdx, pnpm-workspace.yaml, .gitignore
- 002: docs/typedoc.base.json, docs/scripts/gen-api.mjs
- 003: docs/astro.config.mjs
- 004: docs/src/content/docs/getting-started/{installation,subpath-exports,concepts}.md; docs/src/content.config.ts (docsLoader fix); docs/scripts/gen-api.mjs (title frontmatter injection)
- 005-008: docs/src/content/docs/runtimes/{node,bun,cloudflare,browser}.md
- 009: docs/src/content/docs/guides/{with-trace,trace-handler,context,database-naming,endpoint-resolution,logger,metrics,ui-action-metrics,exporters,configuration,resource-validation,instrument-fetch}.md
- 010: docs/src/content/docs/index.mdx (splash + CopyLlmsUrl), docs/src/components/CopyLlmsUrl.astro
- 011: verified llms.txt + llms-full.txt emitted (18 + 19751 lines), 5 custom sets in _llms-txt/, whitespace:false confirmed
- 012: README.md trimmed to 65 lines (was 734); docs site + llms.txt links present
- 013: skills/telemetry-js/SKILL.md (generator skill, Opus-reviewed + fixed); package.json files += "skills"
- 014: package.json docs:generate → pnpm --filter docs build; typedoc.json out → docs-html-legacy; .gitignore += docs-html-legacy/. Opus APPROVED.

## Key decisions made during execution
- 003: Starlight v0.39.0 breaking change — `{ label, autogenerate }` sidebar groups removed. New syntax: `{ label, items: [{ autogenerate: { directory } }] }`. Collapsed: true moves to group level.
- 001/004: Starlight 0.40.0 Content Layer API — `content.config.ts` must use `docsLoader()` from `@astrojs/starlight/loaders`. Old `defineCollection({ schema })` without loader = no pages built.
- 002/004: TypeDoc-generated files have no frontmatter by default. `typedoc-plugin-frontmatter` only emits static globals. Solution: post-process in `gen-api.mjs` — extract H1 heading, unescape MD backslash sequences (e.g. `\<`), emit YAML single-quoted `title` frontmatter.

## Open questions / discovered-but-out-of-scope
- (none yet)

## Notes
- If `starlight-llms-txt` installed version emits set/llms files under different names than CONTRACT.md §2 assumes, fix the affected path check + record here. Never remove the whitespace or emit checks.
- Resolve exact plugin versions/flags per DESIGN.md "Open items" on first run.
