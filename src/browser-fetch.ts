/**
 * Lightweight browser fetch instrumentation — **zero `@opentelemetry` imports**.
 *
 * ```ts
 * // main.tsx — FIRST import, before any other code
 * import { instrumentFetch } from "@tigorhutasuhut/telemetry-js/browser/fetch";
 * instrumentFetch();
 * ```
 *
 * This subpath export exists so that eagerly patching `globalThis.fetch`
 * does **not** pull in the full browser SDK (`@opentelemetry/*`, exporters,
 * providers, etc.).  The OTel tracing code is loaded lazily via dynamic
 * `import()` only when the first `fetch()` call is actually made.
 *
 * See the `./browser` entry point JSDoc for the full recommended setup
 * pattern (eager fetch patch + lazy SDK init).
 */

export { instrumentFetch } from "./instrument-fetch-browser.js";
