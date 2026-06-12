# IMPLEMENTATION — docs-starlight-migration / 001-starlight-llms-skill

## Why
Current docs = pure TypeDoc HTML (`out: docs/`, gitignored) + one big README (~730 lines) + one guide. Hard for humans to navigate, and not LLM-friendly. Goal: a real docs site (Starlight) with per-runtime guides, embedded per-runtime API ref, and first-class `llms.txt` so LLM consumers load only the tokens they need — plus a shipped Claude skill that bootstraps telemetry-js usage rules in consumer projects.

## Approach (see DESIGN.md for full detail + config snippets)
1. **`docs/` workspace package** — Astro + Starlight. `site`/`base` set for GitHub Pages subpath.
2. **API generation = explicit TypeDoc prebuild (D8).** `docs/scripts/gen-api.mjs` runs `typedoc` once per runtime bucket (D9) into `docs/src/content/docs/api/<bucket>/`. Decoupled from Astro plugin order, so generated pages always exist before `astro build` and `starlight-llms-txt` sees them. `starlight-typedoc` plugin NOT used.
3. **Content migration** — README sections → `getting-started/`, `runtimes/`, `guides/` Markdown pages. Each runtime page: setup + recommended API + complete example.
4. **llms.txt** — `starlight-llms-txt` with `minify.whitespace: false` (explicit, known mangling bug) and 5 `customSets` (one per runtime carrying its own API bucket + shared + guides + getting-started; one full API set).
5. **Landing page** — splash `index.mdx`; hero = llms.txt URL + `CopyLlmsUrl.astro` copy button, first element.
6. **README trim** — short npm landing → links to site + llms.txt.
7. **Generator skill** — `skills/telemetry-js/SKILL.md` detects consumer runtime, generates `.claude/rules` + a usage skill pointing at the matching published llms.txt set. Shipped via `package.json` `files`.
8. **CI** — docs build job + GitHub Pages deploy workflow.

## Key decisions
- **D8 TypeDoc prebuild, not the build plugin** — deterministic, removes plugin-ordering risk.
- **D9 per-runtime API buckets** — node/bun/cloudflare/browser/shared; folder structure drives nested sidebar + per-runtime llms sets.
- **Shared modules** (error/db/context/vite) live once under `api/shared` (own sidebar group); each runtime llms set includes `api/shared/**`.
- **One big slice** (user choice) executed by an autonomous ralph-loop on Sonnet, Opus-gated on the two risky tasks (root `package.json`, generator skill).

## Risks (full table in DESIGN.md)
- Plugin order → RESOLVED by D8 prebuild.
- `typedoc-plugin-markdown` frontmatter vs Starlight content schema → add `typedoc-plugin-frontmatter` (`title`).
- `base: '/telemetry-js'` subpath link/asset breakage → verify built site with `astro build` (Pages base applied) + relative links.
- llms.txt set output naming / whitespace → verify emitted files post-build; `minify.whitespace: false`.
- Generator skill writing into consumer repos → idempotent, `.claude/`-only, never touches source.

## Notes for the executor
- Delegate all code/file writes to `sonnet-implementer` per the CLAUDE.md orchestrator/worker split; the loop session orchestrates + verifies.
- Resolve exact installed plugin versions + flags at impl time (DESIGN "Open items"). If `starlight-llms-txt` set output paths differ from assumptions, adjust the verify greps in CONTRACT.md §2 accordingly and note it in RESUME.md — do NOT loosen the whitespace/emit checks.
