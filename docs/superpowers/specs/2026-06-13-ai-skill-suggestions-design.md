# Design: telemetry-js best-practice skill suggestions across docs/llms.txt + dedicated Cloudflare skill

Date: 2026-06-13
Status: Approved
Branch: `docs/ai-skill-suggestions`

## Goal

Make any AI coding agent that consumes telemetry-js docs aware that it should
materialize a project-local **best-practice skill** for the library, and — when
the consuming project targets Cloudflare Workers — also install a **dedicated
Cloudflare instrumentation skill**. The suggestion must surface in the main
`llms.txt` section, a docs guide page, the landing splash, and as an interactive
offer in the existing setup skill.

## Decisions (from brainstorming)

- **Form:** Ship ready-made skill content + reference it (not call-to-action only).
- **Structure:** Upgrade the existing `telemetry-js-setup` skill to emit fuller
  best-practice content, PLUS add one separate Cloudflare instrumentation skill.
- **Surfaces (all four):** main `llms.txt` `details`, dedicated docs page, landing
  splash, setup-skill interactive offer.
- **CF skill delivery:** Approach A — Embed. A standalone canonical CF skill file
  lives in the repo; the setup skill carries the same content as an embedded block
  and writes it into the consumer's `.claude/skills/` on Cloudflare detection.
  Robust offline (library ships from npm). Duplication is accepted and synced
  manually per release.

## Components

### 1. Canonical Cloudflare skill — `skills/telemetry-js-cloudflare/SKILL.md` (new)

Full Cloudflare instrumentation best practices, sourced from `guides/cloudflare.md`
and the `api/cloudflare` reference. Frontmatter `name: telemetry-js-cloudflare`,
description focused on CF instrumentation.

Must cover:
- `instrument()` (wraps `ExportedHandler`: `fetch`/`scheduled`/`queue`) vs
  `traceHandler()` (SvelteKit / Remix / Cloudflare Pages).
- Correct import path — **reconcile the discrepancy**: `guides/cloudflare.md`
  imports `instrument`/`traceHandler` from the bare package
  `@tigorhutasuhut/telemetry-js`, while the current setup skill says
  `@tigorhutasuhut/telemetry-js/cloudflare`. At implementation time, verify
  against `docs/src/content/docs/api/cloudflare/**` and the package `exports`
  map in `package.json`; use the path the published package actually exposes.
- Never use Node.js `http`/`https` modules in Workers.
- Spans flush via `ctx.waitUntil` automatically — never block the response.
- **Initialize the SDK once per isolate**, not per request (the SvelteKit
  `ensureTelemetry()` singleton pattern).
- W3C Trace Context (`traceparent`/`tracestate`) extracted in / injected out
  automatically.
- 5xx responses and thrown exceptions set `ERROR` span status automatically.
- SvelteKit-on-Pages setup (typing `App.Platform`, one-time init helper).

Header note: "Canonical source — keep in sync with the embedded block in
`skills/telemetry-js/SKILL.md`."

### 2. Upgrade setup skill — `skills/telemetry-js/SKILL.md`

- Enrich the generated `.claude/skills/telemetry-js-usage/SKILL.md` per-runtime
  blocks: expand from thin llms.txt pointers into fuller best-practice bullets
  (keep the existing llms.txt URLs).
- Add a conditional step: when detected runtime == `cloudflare`, **interactively
  offer** to also install the dedicated Cloudflare instrumentation skill
  ("Install dedicated Cloudflare instrumentation skill? (y/n)"). On yes, write
  `.claude/skills/telemetry-js-cloudflare/SKILL.md` with the embedded CF skill
  content (identical to component 1). Idempotent — overwrite if present.
- Header note: "Embedded CF block — keep in sync with
  `skills/telemetry-js-cloudflare/SKILL.md`."
- Update the Step 4 confirmation report to mention the CF skill when installed.

### 3. Main `llms.txt` `details` — `docs/astro.config.mjs`

Add a `details:` string to the `starlightLlmsTxt({...})` options. Markdown,
**no headings** (llmstxt spec: paragraphs/lists only). Content: a call-to-action
telling AI agents to create a project-local telemetry-js best-practice skill (run
the `telemetry-js-setup` skill or copy from the repo skills URL), and a
conditional line: if the project targets Cloudflare Workers, also install the
dedicated Cloudflare instrumentation skill (URL). Optionally add `optionalLinks`
pointing to the GitHub skill sources:
- `https://github.com/tigorlazuardi/telemetry-js/tree/main/skills`
- `https://github.com/tigorlazuardi/telemetry-js/tree/main/skills/telemetry-js-cloudflare`

This lands immediately after the description in generated `/llms.txt` — the
"main section".

### 4. Docs guide page — `docs/src/content/docs/guides/ai-skills.mdx` (new)

Auto-added to the Guides sidebar (`autogenerate: { directory: "guides" }`).
Requires `title` + `description` frontmatter (Starlight). Explains the
best-practice skill concept, how to install via the setup skill, the conditional
Cloudflare skill offer, and links to the per-runtime llms.txt sets + GitHub skill
source.

### 5. Landing splash — `docs/src/content/docs/index.mdx`

Add a section beneath the existing `CopyLlmsUrl` widget promoting the
best-practice skills, linking to the new `guides/ai-skills` page.

## Sync invariant (Approach A)

The canonical `skills/telemetry-js-cloudflare/SKILL.md` and the CF block embedded
in `skills/telemetry-js/SKILL.md` must stay identical. Author the canonical file
first, then copy into the setup skill. Both files carry a sync note.

## Verification

- `pnpm build` in `docs/` succeeds.
- Generated `docs/dist/llms.txt` contains the details call-to-action text and the
  Cloudflare conditional note.
- New `ai-skills.mdx` has valid frontmatter (build would fail otherwise).
- `biome` format/lint clean (root + docs as configured).
- Skill files are markdown — no build step; verify frontmatter `name:` present.

## Out of scope

- No changes to the runtime SDK source (`src/`).
- No new llms.txt custom set (the existing Cloudflare set already exists).
- No automated sync tooling for the duplicated CF content — manual per release.
