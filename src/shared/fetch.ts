import {
	context,
	propagation,
	SpanKind,
	SpanStatusCode,
	type TextMapSetter,
	trace,
} from "@opentelemetry/api";
import type { LogAttributes, Logger } from "./types.js";

/**
 * Snapshot of `globalThis.fetch` captured before any instrumentation.
 *
 * Used by internal exporters ({@link getOriginalFetch}) to avoid the
 * infinite loop: export → instrumented fetch → new span → export …
 */
let _originalFetch: typeof fetch | null = null;

/**
 * Return the **un-instrumented** `fetch` function.
 *
 * If {@link instrumentFetch} (or the Cloudflare `instrument()` helper that
 * calls it internally) has been used, this returns the original reference
 * captured *before* the monkey-patch was applied.
 *
 * Falls back to `globalThis.fetch` when no instrumentation has occurred.
 *
 * @example
 * ```ts
 * import { getOriginalFetch } from "@tigorhutasuhut/telemetry-js/cloudflare";
 *
 * // Always hits the network without creating a span:
 * const res = await getOriginalFetch()("https://collector.example.com/v1/traces", { method: "POST", body });
 * ```
 */
export function getOriginalFetch(): typeof fetch {
	return _originalFetch ?? globalThis.fetch;
}

/**
 * Store the original fetch reference. Called once before the first patch.
 * @internal
 */
function captureOriginalFetch(): void {
	if (!_originalFetch) {
		_originalFetch = globalThis.fetch;
	}
}

/**
 * Reset stored original fetch (for testing).
 * @internal
 */
export function _resetOriginalFetch(): void {
	_originalFetch = null;
}

const DEFAULT_SENSITIVE_HEADERS = new Set([
	"authorization",
	"cookie",
	"set-cookie",
	"x-api-key",
	"proxy-authorization",
]);

const LOGGABLE_CONTENT_TYPES = [
	"application/json",
	"application/x-www-form-urlencoded",
	"text/plain",
];

const DEFAULT_MAX_BODY_LOG_SIZE = 1_048_576; // 1 MB

const headerSetter: TextMapSetter<Headers> = {
	set(carrier, key, value) {
		carrier.set(key, value);
	},
};

/**
 * Configuration for {@link instrumentFetch}.
 */
export interface InstrumentFetchConfig {
	/** Tracer name. Defaults to `"fetch"`. */
	serviceName?: string;
	/** When provided, emits one structured log entry per fetch call. */
	logger?: Logger;
	/** Header names whose values are replaced with `"[REDACTED]"`. Overrides defaults. */
	sensitiveHeaders?: string[];
	/** Max bytes to read from request/response bodies for logging. Default 1 MB. */
	maxBodyLogSize?: number;
}

function redactHeaders(headers: Headers, sensitiveSet: Set<string>): Record<string, string> {
	const result: Record<string, string> = {};
	headers.forEach((value, key) => {
		result[key] = sensitiveSet.has(key.toLowerCase()) ? "[REDACTED]" : value;
	});
	return result;
}

function isLoggableContentType(headers: Headers): boolean {
	const ct = headers.get("content-type") ?? "";
	return LOGGABLE_CONTENT_TYPES.some((t) => ct.includes(t));
}

async function readLimitedBody(
	readable: { text(): Promise<string> },
	maxBytes: number,
): Promise<string | undefined> {
	try {
		const text = await readable.text();
		if (text.length > maxBytes) {
			return `${text.slice(0, maxBytes)}[truncated]`;
		}
		return text;
	} catch {
		return undefined;
	}
}

/**
 * Wrap a `fetch` function with OpenTelemetry tracing and optional request/response logging.
 *
 * Creates a `CLIENT` span for each outgoing request, injects `traceparent`/`tracestate`
 * into outgoing headers via `propagation.inject()`, and optionally emits a single
 * structured log entry with the full request/response round-trip details.
 *
 * **Cloudflare Workers** — you do **not** need to call this manually.
 * {@link instrument} and {@link traceHandler} automatically monkey-patch
 * `globalThis.fetch` on the first request.  Use {@link getOriginalFetch} if
 * you need the un-instrumented version (e.g. for OTLP export calls).
 *
 * **Node.js** — you do **not** need to call this either.
 * `@opentelemetry/sdk-node` (used internally by `initSDK`) registers
 * auto-instrumentation for `http`/`undici` which already traces outgoing
 * requests.  Calling `instrumentFetch` on top of that would produce
 * duplicate spans.
 *
 * This function is mainly useful when you need **custom control** over which
 * `fetch` reference is wrapped, or when running in a non-standard runtime
 * where neither the Cloudflare nor Node.js adapters apply.
 *
 * @param originalFetch - The `fetch` function to wrap (typically `globalThis.fetch`).
 * @param config - Optional configuration.
 * @returns A wrapped `fetch` with the same signature.
 *
 * @example
 * ```ts
 * import { instrumentFetch } from "@tigorhutasuhut/telemetry-js/cloudflare";
 *
 * const tracedFetch = instrumentFetch(globalThis.fetch, { logger });
 * const res = await tracedFetch("https://api.example.com/data");
 * ```
 */
export function instrumentFetch(
	originalFetch: typeof fetch,
	config?: InstrumentFetchConfig,
): typeof fetch {
	captureOriginalFetch();
	const serviceName = config?.serviceName ?? "fetch";
	const logger = config?.logger;
	const sensitiveSet = config?.sensitiveHeaders
		? new Set(config.sensitiveHeaders.map((h) => h.toLowerCase()))
		: DEFAULT_SENSITIVE_HEADERS;
	const maxBodyLogSize = config?.maxBodyLogSize ?? DEFAULT_MAX_BODY_LOG_SIZE;

	return function instrumentedFetch(
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> {
		const request = new Request(input, init);
		const method = request.method;
		const url = request.url;
		const tracer = trace.getTracer(serviceName);

		return tracer.startActiveSpan(`${method} ${url}`, { kind: SpanKind.CLIENT }, async (span) => {
			const startTime = Date.now();

			try {
				// Read request body for logging (before consuming it)
				let requestBodyPromise: Promise<string | undefined> | undefined;
				if (logger && request.body && isLoggableContentType(request.headers)) {
					requestBodyPromise = readLimitedBody(request.clone(), maxBodyLogSize);
				}

				// Inject trace context into outgoing headers
				propagation.inject(context.active(), request.headers, headerSetter);

				const response = await originalFetch(request);
				const duration = Date.now() - startTime;

				span.setAttribute("http.status_code", response.status);
				if (response.status >= 500) {
					span.setStatus({ code: SpanStatusCode.ERROR });
				}

				// Record response traceparent if present
				const responseTraceparent = response.headers.get("traceparent");
				if (responseTraceparent) {
					span.setAttribute("http.response.traceparent", responseTraceparent);
				}

				if (logger) {
					let responseBody: string | undefined;
					if (response.body && isLoggableContentType(response.headers)) {
						responseBody = await readLimitedBody(response.clone(), maxBodyLogSize);
					}

					const requestBody = await requestBodyPromise;

					const attrs: LogAttributes = {
						"http.method": method,
						"http.url": url,
						"http.status_code": response.status,
						"http.duration_ms": duration,
						"http.request.headers": JSON.stringify(redactHeaders(request.headers, sensitiveSet)),
						"http.response.headers": JSON.stringify(redactHeaders(response.headers, sensitiveSet)),
					};
					if (requestBody !== undefined) {
						attrs["http.request.body"] = requestBody;
					}
					if (responseBody !== undefined) {
						attrs["http.response.body"] = responseBody;
					}

					logger.info(`${method} ${url} ${response.status} ${duration}ms`, attrs);
				}

				return response;
			} catch (error) {
				const duration = Date.now() - startTime;
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: error instanceof Error ? error.message : String(error),
				});
				span.recordException(error as Error);

				if (logger) {
					const attrs: LogAttributes = {
						"http.method": method,
						"http.url": url,
						"http.duration_ms": duration,
						"http.error": error instanceof Error ? error.message : error,
					};
					logger.error(`${method} ${url} FAILED ${duration}ms`, attrs);
				}

				throw error;
			} finally {
				span.end();
			}
		});
	};
}
