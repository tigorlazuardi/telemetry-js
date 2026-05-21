import {
	type Counter,
	context,
	type Histogram,
	metrics,
	propagation,
	type Span,
	SpanKind,
	SpanStatusCode,
	type TextMapGetter,
	type TextMapSetter,
	trace,
	type UpDownCounter,
} from "@opentelemetry/api";
import { nodeAdapter } from "../node/adapter.js";
import { getLogger } from "../shared/logger.js";
import { noopSDKResult } from "../shared/noop.js";
import type { LogAttributes, Logger, SDKConfig, SDKResult } from "../shared/types.js";

/**
 * Options for {@link traceHandler}. Extends {@link SDKConfig} (minus `runtime`).
 */
export interface TraceHandlerOptions<T = Response> extends Omit<SDKConfig, "runtime"> {
	/** The incoming `Request` to trace. */
	request: Request;
	/** The handler to call inside the traced span. */
	handler: () => T | Promise<T>;
	/**
	 * Logger for automatic request/response logging.
	 * When `true` or omitted, uses `getLogger()`. When a `Logger` instance, uses that.
	 * When `false`, no automatic logging is performed.
	 * @default true
	 */
	logger?: Logger | boolean;
	/**
	 * Header names whose values are replaced with `"[REDACTED]"` in logs.
	 * Overrides the default set (`authorization`, `cookie`, `set-cookie`, `x-api-key`, `proxy-authorization`).
	 */
	sensitiveHeaders?: string[];
	/**
	 * Maximum bytes to read from request/response bodies for logging.
	 * @default 65536 (64 KB)
	 */
	maxBodyLogSize?: number;
}

let sdkResult: SDKResult | null = null;

/* ------------------------------------------------------------------ */
/*  HTTP server metrics (lazy-initialised on first use)               */
/* ------------------------------------------------------------------ */

let _httpRequestDuration: Histogram | null = null;
let _httpRequestTotal: Counter | null = null;
let _httpActiveRequests: UpDownCounter | null = null;

function getHttpMetrics() {
	if (!_httpRequestDuration) {
		const meter = metrics.getMeter("http.server");
		_httpRequestDuration = meter.createHistogram("http.server.request.duration", {
			description: "Duration of HTTP server requests in milliseconds",
			unit: "ms",
		});
		_httpRequestTotal = meter.createCounter("http.server.request.total", {
			description: "Total number of HTTP server requests",
		});
		_httpActiveRequests = meter.createUpDownCounter("http.server.active_requests", {
			description: "Number of in-flight HTTP server requests",
		});
	}
	return {
		duration: _httpRequestDuration,
		total: _httpRequestTotal!,
		active: _httpActiveRequests!,
	};
}

function ensureSDK(config: Omit<SDKConfig, "runtime">): SDKResult {
	if (!sdkResult) {
		try {
			sdkResult = nodeAdapter.setup(config);
		} catch {
			sdkResult = noopSDKResult();
		}
	}
	return sdkResult;
}

/* ------------------------------------------------------------------ */
/*  Auto-logging helpers                                              */
/* ------------------------------------------------------------------ */

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

const DEFAULT_MAX_BODY_LOG_SIZE = 65_536; // 64 KB

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

function contentTypeSummary(headers: Headers): string {
	return headers.get("content-type") ?? "unknown";
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

function humanBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function humanDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

const headerGetter: TextMapGetter<Headers> = {
	keys(carrier) {
		return [...(carrier as any).keys()];
	},
	get(carrier, key) {
		return carrier.get(key) ?? undefined;
	},
};

const headerSetter: TextMapSetter<Headers> = {
	set(carrier, key, value) {
		carrier.set(key, value);
	},
};

/**
 * Trace a single fetch-style request in a Bun runtime.
 *
 * Creates a `SERVER` span, propagates incoming W3C trace context
 * (`traceparent`/`tracestate`) from `request` headers, and injects
 * trace context into the response headers.
 *
 * Mirrors the Cloudflare `traceHandler` API but is adapted for Bun:
 * there is no `ExecutionContext.waitUntil`. The SDK's batch processors
 * flush on process `beforeExit`/`SIGTERM` (handled by `@opentelemetry/sdk-node`),
 * so per-request flushing is unnecessary.
 *
 * @example
 * ```ts
 * import { traceHandler } from "@tigorhutasuhut/telemetry-js/bun";
 *
 * Bun.serve({
 *   async fetch(request) {
 *     return traceHandler({
 *       serviceName: "my-bun-app",
 *       request,
 *       handler: () => new Response("Hello"),
 *     });
 *   },
 * });
 * ```
 */
export async function traceHandler<T = Response>(opts: TraceHandlerOptions<T>): Promise<T> {
	const {
		request,
		handler,
		logger: loggerOpt,
		sensitiveHeaders,
		maxBodyLogSize = DEFAULT_MAX_BODY_LOG_SIZE,
		...sdkOpts
	} = opts;
	ensureSDK(sdkOpts);
	const tracer = trace.getTracer(opts.serviceName ?? "unknown");
	const url = new URL(request.url);
	const extractedCtx = propagation.extract(context.active(), request.headers, headerGetter);
	let span: Span | undefined;

	const logger: Logger | undefined =
		loggerOpt === false
			? undefined
			: loggerOpt === true || loggerOpt == null
				? getLogger()
				: loggerOpt;
	const sensitiveSet = sensitiveHeaders
		? new Set(sensitiveHeaders.map((h) => h.toLowerCase()))
		: DEFAULT_SENSITIVE_HEADERS;

	let requestBodyPromise: Promise<string | undefined> | undefined;
	if (logger && request.body && isLoggableContentType(request.headers)) {
		requestBodyPromise = readLimitedBody(request.clone(), maxBodyLogSize);
	}
	const startTime = Date.now();
	const httpMetrics = getHttpMetrics();
	const metricAttrs = { "http.method": request.method, "http.route": url.pathname };
	httpMetrics.active.add(1, metricAttrs);
	let statusCode = 0;

	try {
		const result = await tracer.startActiveSpan(
			`${request.method} ${url.pathname}`,
			{
				kind: SpanKind.SERVER,
				attributes: {
					"http.method": request.method,
					"http.url": request.url,
					"http.target": `${url.pathname}${url.search}`,
					"http.host": url.host,
				},
			},
			extractedCtx,
			async (s) => {
				span = s;
				try {
					const res = await handler();
					if (res instanceof Response) {
						statusCode = res.status;
						span.setAttribute("http.status_code", res.status);
						if (res.status >= 500) {
							span.setStatus({ code: SpanStatusCode.ERROR });
						}
					}

					if (res instanceof Response) {
						const newResponse = new Response(res.body, res);
						const activeCtx = context.active();
						propagation.inject(activeCtx, newResponse.headers, headerSetter);

						const currentSpan = trace.getSpan(activeCtx);
						if (currentSpan) {
							const sc = currentSpan.spanContext();
							if (sc.traceId) {
								const traceFlagsHex = sc.traceFlags.toString(16).padStart(2, "0");
								newResponse.headers.set(
									"traceparent",
									`00-${sc.traceId}-${sc.spanId}-${traceFlagsHex}`,
								);
								newResponse.headers.set("x-trace-id", sc.traceId);
							}
						}

						const baggage = propagation.getBaggage(activeCtx);
						if (baggage) {
							for (const [key, entry] of baggage.getAllEntries()) {
								span.setAttribute(`baggage.${key}`, entry.value);
							}
						}

						if (logger) {
							const duration = Date.now() - startTime;
							const responseSize = Number(newResponse.headers.get("content-length") ?? 0);

							const message = `${request.method} ${url.pathname} -- ${newResponse.status} ${humanDuration(duration)} ${humanBytes(responseSize)}`;

							const attrs: LogAttributes = {};

							attrs["http.request.method"] = request.method;
							attrs["http.request.path"] = url.pathname;
							if (url.search) attrs["http.request.query"] = url.search;
							const ua = request.headers.get("user-agent");
							if (ua) attrs["http.request.user_agent"] = ua;
							attrs["http.request.headers"] = JSON.stringify(
								redactHeaders(request.headers, sensitiveSet),
							);
							const requestBody = await requestBodyPromise;
							if (requestBody !== undefined) {
								attrs["http.request.body"] = requestBody;
							} else if (request.body) {
								attrs["http.request.body"] = `[${contentTypeSummary(request.headers)}]`;
							}

							attrs["http.response.status"] = newResponse.status;
							attrs["http.response.headers"] = JSON.stringify(
								redactHeaders(newResponse.headers, sensitiveSet),
							);
							if (newResponse.body && isLoggableContentType(newResponse.headers)) {
								const responseBody = await readLimitedBody(newResponse.clone(), maxBodyLogSize);
								if (responseBody !== undefined) {
									attrs["http.response.body"] = responseBody;
								}
							} else if (newResponse.body) {
								attrs["http.response.body"] = `[${contentTypeSummary(newResponse.headers)}]`;
							}
							attrs["http.response.size"] = humanBytes(responseSize);
							attrs["http.duration_ms"] = duration;

							if (newResponse.status >= 500) {
								logger.error(message, attrs);
							} else if (newResponse.status >= 400) {
								logger.warn(message, attrs);
							} else {
								logger.info(message, attrs);
							}
						}

						return newResponse as T;
					}

					return res;
				} catch (error) {
					span.setStatus({
						code: SpanStatusCode.ERROR,
						message: error instanceof Error ? error.message : String(error),
					});
					span.recordException(error as Error);

					if (logger) {
						const duration = Date.now() - startTime;
						const message = `${request.method} ${url.pathname} -- FAILED ${humanDuration(duration)}`;
						const attrs: LogAttributes = {
							"http.request.method": request.method,
							"http.request.path": url.pathname,
							"http.duration_ms": duration,
							"http.error": error instanceof Error ? error.message : error,
						};
						if (url.search) attrs["http.request.query"] = url.search;
						logger.error(message, attrs);
					}

					throw error;
				} finally {
					span.end();
				}
			},
		);

		return result;
	} finally {
		const duration = Date.now() - startTime;
		const finalAttrs = { ...metricAttrs, "http.status_code": String(statusCode) };
		httpMetrics.active.add(-1, metricAttrs);
		httpMetrics.duration.record(duration, finalAttrs);
		httpMetrics.total.add(1, finalAttrs);
	}
}

/**
 * Reset internal SDK state (for testing).
 * @internal
 */
export function _resetInstrumentState(): void {
	sdkResult = null;
	_httpRequestDuration = null;
	_httpRequestTotal = null;
	_httpActiveRequests = null;
}
