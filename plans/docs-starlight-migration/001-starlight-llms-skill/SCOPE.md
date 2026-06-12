# SCOPE — docs-starlight-migration / 001-starlight-llms-skill

## In scope
- New Astro + Starlight docs site at `docs/` (workspace member, deployed to GitHub Pages).
- Embedded API reference via explicit TypeDoc prebuild (`typedoc` + `typedoc-plugin-markdown` + `typedoc-plugin-frontmatter`), broken down **per runtime** (node / bun / cloudflare / browser / shared).
- Hand-authored per-runtime usage guides (setup + recommended API + complete example) + concept/guide pages migrated from README.
- `starlight-llms-txt` integration: `llms.txt`, `llms-full.txt`, and 5 per-runtime document sets; `minify.whitespace: false` set explicitly.
- Landing page whose hero exposes the `llms.txt` URL + a copy-to-clipboard button as the first element.
- README trimmed to a short npm landing pointing at the site + llms.txt.
- Generator/installer Claude skill shipped in the npm package (`skills/telemetry-js/`), added to `package.json` `files`.
- CI: docs build job + GitHub Pages deploy workflow.

## Out of scope (non-goals)
- Versioned docs (single "latest" only).
- i18n / translations.
- Interactive playground or live code runner.
- Blog / changelog site section.
- Migrating `plans/**` into the site.
- Any change to library runtime source under `src/**` (only `package.json` + docs/skill/CI artifacts change). Generated `api/**` excepted.

## Constraints
- No change to published `exports` map or public API surface of the library (package.json `exports` stays identical).
- Docs-only heavy deps (astro, starlight, typedoc plugins) live in the `docs/` workspace package — never added to the published library's deps.
- GitHub Pages: site `https://tigorlazuardi.github.io`, base `/telemetry-js`.
- Library build (`pnpm run build`) + tests (`pnpm test`) must stay green throughout.
- Generator skill only ever writes under a consumer's `.claude/`; never touches consumer source.

## Success (high level)
See CONTRACT.md §2. Done = docs site builds under the Pages subpath, per-runtime API + guides render, llms.txt + 5 sets emit with whitespace preserved, landing hero shows llms.txt URL + copy button, README trimmed, generator skill shipped, CI builds + deploys.

## Decisions reference
Locked decisions D1–D9 live in `DESIGN.md`.
