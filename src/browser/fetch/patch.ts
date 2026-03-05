/**
 * Browser-specific fetch instrumentation — **zero-dependency at import time**.
 *
 * This module is designed to be imported **eagerly** at the very top of a
 * browser entry point, before any library (Hono `hc`, better-auth,
 * TanStack Query, etc.) captures a reference to `globalThis.fetch`.
 *
 * ```ts
 * // main.tsx — FIRST import, synchronous, pulls NO heavy dependencies
 * import { instrumentFetch } from "@tigorhutasuhut/telemetry-js/browser/fetch";
 * instrumentFetch();               // patches globalThis.fetch immediately
 *
 * // Later, async — fire-and-forget
 * import("./lib/telemetry").then(({ initTelemetry }) => initTelemetry({ … }));
 * ```
 *
 * The patched `globalThis.fetch` is a thin wrapper that:
 * 1. Calls the **real** (original) `fetch` to perform the actual request.
 * 2. **Lazily** dynamic-imports the OTel tracing/propagation modules the
 *    first time a fetch is made, then caches them for subsequent calls.
 * 3. Creates a CLIENT span and injects `traceparent`/`tracestate` headers
 *    only once the OTel modules are available.
 *
 * Before `initSDK()` registers a real `TracerProvider`, the OTel API
 * returns a noop tracer — spans are silently discarded and fetch works
 * exactly as if it were not instrumented.
 *
 * Exporters must call {@link getOriginalFetch} to bypass the patch and
 * avoid the infinite loop: export → instrumented fetch → new span → export …
 */

/* ------------------------------------------------------------------ */
/*  NO top-level @opentelemetry imports — keep this module lightweight */
/* ------------------------------------------------------------------ */

// Lazily loaded OTel modules (populated on first fetch call)
let _otel: typeof import("./otel.js") | null = null;

/* ------------------------------------------------------------------ */
/*  Original fetch capture                                            */
/* ------------------------------------------------------------------ */

/** Snapshot of the **real** browser `fetch` captured before patching. */
let _originalFetch: typeof fetch | null = null;

/** Whether `instrumentFetch()` has already been called. */
let _patched = false;

/**
 * Return the **un-instrumented** browser `fetch`.
 *
 * Used by {@link FetchTraceExporter} / {@link FetchLogExporter} /
 * {@link FetchMetricExporter} so export calls bypass the patch.
 */
export function getOriginalFetch(): typeof fetch {
	return _originalFetch ?? globalThis.fetch;
}

/**
 * Returns `true` if {@link instrumentFetch} has already been called.
 * Used by `browserAdapter.setup()` to skip a redundant patch.
 */
export function isFetchPatched(): boolean {
	return _patched;
}

/**
 * Reset internal state (for testing).
 * @internal
 */
export function _resetBrowserFetch(): void {
	_originalFetch = null;
	_patched = false;
	_otel = null;
}

/* ------------------------------------------------------------------ */
/*  instrumentFetch                                                   */
/* ------------------------------------------------------------------ */

/**
 * Monkey-patch `globalThis.fetch` with OpenTelemetry tracing.
 *
 * **Call this as early as possible** — ideally as a synchronous top-level
 * side-effect — so that every library that later captures `fetch` gets
 * the instrumented version.
 *
 * This function itself does **not** import any `@opentelemetry/*` modules.
 * The OTel tracing code is loaded lazily on the first actual `fetch()`
 * call via a dynamic `import()`.
 *
 * Safe to call before `initSDK()` — spans only become real once a
 * `TracerProvider` is registered.
 *
 * Calling multiple times is a no-op after the first call.
 *
 * @example
 * ```ts
 * // main.tsx — synchronous, before anything else
 * import { instrumentFetch } from "@tigorhutasuhut/telemetry-js/browser/fetch";
 * instrumentFetch();
 * ```
 */
export function instrumentFetch(): void {
	if (_patched) return;

	// Capture the real fetch before we overwrite it
	_originalFetch = globalThis.fetch;
	_patched = true;

	const realFetch = _originalFetch;

	globalThis.fetch = async function instrumentedFetch(
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> {
		if (!_otel) {
			_otel = await import("./otel.js");
		}
		return _otel.tracedFetch(realFetch, input, init);
	};
}
