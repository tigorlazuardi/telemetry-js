# TASKS — docs-starlight-migration / 001-starlight-llms-skill

Authoritative task table (with verify commands, difficulty, review, escalate_after) lives in **CONTRACT.md §4**. This file is the human-readable ordered checklist; keep in sync with CONTRACT.md.

1. **001** Scaffold `docs/` Astro+Starlight workspace; pnpm-workspace + .gitignore. *(self)*
2. **002** TypeDoc prebuild pipeline — per-runtime buckets (`gen-api.mjs`, `typedoc.base.json`, scripts). *(self)*
3. **003** `docs/astro.config.mjs` — starlight + sidebar + `starlight-llms-txt` (whitespace:false, 5 sets). *(self)*
4. **004** `getting-started/` pages (installation, subpath-exports, concepts). *(self)*
5. **005** `runtimes/node.md` (setup + recommended API + example). *(self)*
6. **006** `runtimes/bun.md`. *(self)*
7. **007** `runtimes/cloudflare.md` (fold in guides/cloudflare.md). *(self)*
8. **008** `runtimes/browser.md` (fetch + react hooks + sdk). *(self)*
9. **009** `guides/*.md` (11 guides migrated from README). *(self)*
10. **010** Landing `index.mdx` hero = llms.txt URL + `CopyLlmsUrl.astro` copy button (first element). *(self)*
11. **011** Verify llms output (llms.txt + llms-full.txt emit, whitespace preserved); reconcile §2 paths if needed. *(self)*
12. **012** Trim README → npm landing + links to site & llms.txt. *(self)*
13. **013** Generator/installer Claude skill `skills/telemetry-js/` + add `"skills"` to package.json `files`. *(**opus** review)*
14. **014** Reconcile root `package.json` + remove old TypeDoc HTML pipeline; `exports`/deps unchanged. *(**opus** review)*
15. **015** CI: docs build job + GitHub Pages deploy workflow. *(self)*

Promise gate (CONTRACT.md §3) after all 15: run §2 full gate → all green → `<promise>ALL ACCEPTANCE MET</promise>` → §11 PR offer.
