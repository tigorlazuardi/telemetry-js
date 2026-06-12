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
- [ ] 002 TypeDoc prebuild pipeline (per-runtime buckets) — attempts: 0
- [ ] 003 astro.config.mjs (starlight + llms-txt, whitespace:false, 5 sets) — attempts: 0
- [ ] 004 getting-started/ pages — attempts: 0
- [ ] 005 runtimes/node.md — attempts: 0
- [ ] 006 runtimes/bun.md — attempts: 0
- [ ] 007 runtimes/cloudflare.md — attempts: 0
- [ ] 008 runtimes/browser.md — attempts: 0
- [ ] 009 guides/*.md (11) — attempts: 0
- [ ] 010 landing index.mdx + CopyLlmsUrl.astro — attempts: 0
- [ ] 011 verify llms output (emit + whitespace) — attempts: 0
- [ ] 012 trim README — attempts: 0
- [ ] 013 generator skill + package.json files — attempts: 0  (review: opus)
- [ ] 014 reconcile root package.json + drop HTML typedoc — attempts: 0  (review: opus)
- [ ] 015 CI docs build + Pages deploy — attempts: 0

## Files touched (append as tasks complete)
- 001: docs/package.json, docs/tsconfig.json, docs/src/content.config.ts, docs/src/content/docs/index.mdx, pnpm-workspace.yaml, .gitignore

## Key decisions made during execution
- (none yet)

## Open questions / discovered-but-out-of-scope
- (none yet)

## Notes
- If `starlight-llms-txt` installed version emits set/llms files under different names than CONTRACT.md §2 assumes, fix the affected path check + record here. Never remove the whitespace or emit checks.
- Resolve exact plugin versions/flags per DESIGN.md "Open items" on first run.
