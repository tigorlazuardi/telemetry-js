---
paths:
  - docs/astro.config.mjs
  - docs/typedoc*.json
  - docs/scripts/**
  - docs/package.json
---

# Starlight docs site conventions

- **`starlight-llms-txt` `minify.whitespace` MUST stay `false`.** Default `true`
  collapses whitespace outside code fences and mangles the llms.txt output.
  Never enable it. `collapseCodeBlocks` stays default `false`.

- **API reference is generated via an explicit TypeDoc prebuild**, NOT the
  `starlight-typedoc` build plugin. Pipeline: `typedoc` CLI +
  `typedoc-plugin-markdown` + `typedoc-plugin-frontmatter`, output into
  `docs/src/content/docs/api/<runtime>/`, wired as the docs package `prebuild`
  script. Reason: decoupled from Astro plugin order so generated pages exist on
  disk before `astro build`, guaranteeing `starlight-llms-txt` sees them.

- **API ref is broken down per runtime bucket:** `node`, `bun`, `cloudflare`,
  `browser`, `shared`. One TypeDoc invocation per bucket. Folder structure drives
  the nested sidebar + per-runtime llms document sets.

- **Docs-only heavy deps** (astro, @astrojs/starlight, starlight-llms-txt,
  typedoc + plugins) live in the `docs/` workspace package ONLY. Never add them
  to the root published `package.json`.
