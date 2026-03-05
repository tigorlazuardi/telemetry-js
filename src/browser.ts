/**
 * Browser entry point.
 *
 * ```ts
 * import { initSDK } from "@tigorhutasuhut/telemetry-js/browser";
 * ```
 *
 * Only browser runtime code is included — Cloudflare Workers and Node.js
 * adapter code is never pulled in, ensuring a clean tree-shake.
 *
 * Uses fetch-based OTLP exporters which are browser-native and lightweight.
 *
 * ## Recommended setup — eager fetch patch, lazy SDK init
 *
 * Libraries like Hono `hc`, better-auth, and TanStack Query may capture a
 * reference to `globalThis.fetch` at **module load time**.  If the SDK
 * monkey-patches `fetch` after those modules have loaded, outgoing
 * requests will bypass instrumentation.
 *
 * To guarantee every `fetch` call is traced, split initialisation into two
 * phases:
 *
 * ### 1. Eager — patch `globalThis.fetch` synchronously (first import)
 *
 * ```ts
 * // main.tsx — very first lines, before ANY other import
 * import { instrumentFetch } from "@tigorhutasuhut/telemetry-js/browser/fetch";
 * instrumentFetch();
 * ```
 *
 * Use the `/browser/fetch` subpath — it exports **only** `instrumentFetch`
 * and does NOT pull in `@opentelemetry/*`, exporters, providers, or any
 * other SDK code.  The OTel tracing code is loaded lazily (via dynamic
 * `import()`) only when the first `fetch()` is actually made.  By that
 * point the browser has already parallel-loaded and cached all chunks,
 * so tracing kicks in instantly.
 *
 * ### 2. Lazy — full SDK setup via dynamic import (fire-and-forget)
 *
 * ```ts
 * // Still in main.tsx, after the eager patch
 * import("./lib/telemetry").then(({ initTelemetry }) =>
 *   initTelemetry({
 *     endpoint: import.meta.env.VITE_OTLP_ENDPOINT,
 *     enabled: true,
 *   }),
 * );
 * ```
 *
 * `initTelemetry` (your app wrapper around `initSDK`) registers the
 * `TracerProvider`, propagators, and exporters.  `initSDK` automatically
 * detects that `instrumentFetch()` was already called and skips a
 * redundant patch.
 *
 * Before the `TracerProvider` is registered, the OTel API returns a noop
 * tracer — `fetch` still works normally, just without tracing.  Once the
 * provider is up, every subsequent `fetch` call produces real spans.
 */

import type { Resource } from "@opentelemetry/resources";
import { noopSDKResult } from "./noop.js";
import { browserAdapter } from "./runtimes/browser.js";
import type { SDKConfig, SDKResult } from "./types.js";

/** Module-level reference to the last initialised resource. */
let _globalResource: Resource | null = null;

/**
 * Initialise the OpenTelemetry SDK for browser environments.
 *
 * @param config - SDK configuration options.
 * @returns An {@link SDKResult} with the active providers and lifecycle helpers.
 */
export function initSDK(config: SDKConfig): SDKResult {
	try {
		const result = browserAdapter.setup(config);
		_globalResource = result.resource;
		return result;
	} catch {
		return noopSDKResult();
	}
}

/**
 * Return the {@link Resource} created by the most recent {@link initSDK} call,
 * or `null` if the SDK has not been initialised yet.
 */
export function getResource(): Resource | null {
	return _globalResource;
}

// ── Re-export shared utilities ──────────────────────────────────────────

export type {
	Counter,
	Histogram,
	Meter,
	MeterProvider,
	UpDownCounter,
} from "@opentelemetry/api";
export { metrics } from "@opentelemetry/api";
export type { Resource } from "@opentelemetry/resources";
export { normalizeEndpoint, resolveSignalEndpoint } from "./endpoints.js";
export type { FetchExporterConfig } from "./exporters.js";
export { FetchLogExporter, FetchMetricExporter, FetchTraceExporter } from "./exporters.js";
export { instrumentFetch } from "./instrument-fetch-browser.js";
export { createLogger, getLogger, runWithLogger, setDefaultLogger } from "./logger.js";
export { noopLogger, noopSDKResult } from "./noop.js";
export type { TracedCallContext, TracedInput } from "./traced.js";
export { traced } from "./traced.js";
export type {
	Carrier,
	LogAttributes,
	Logger,
	LogLevel,
	LogOptions,
	OtlpSignal,
	RuntimeAdapter,
	RuntimeName,
	SDKConfig,
	SDKResult,
} from "./types.js";
export type { WithTraceOptions } from "./with-trace.js";
export { withTrace } from "./with-trace.js";
