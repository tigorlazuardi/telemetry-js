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
import { instrumentFetch } from "../shared/fetch.js";
import { getLogger } from "../shared/logger.js";
import { noopSDKResult } from "../shared/noop.js";
import type { LogAttributes, Logger, SDKConfig, SDKResult } from "../shared/types.js";
import { cloudflareWorkerAdapter } from "./adapter.js";
import { setBindingConfig } from "./bindings/config.js";

// Minimal CF types to avoid @cloudflare/workers-types dependency
export interface ExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException(): void;
	/** For compatibility with Wrangler 4.x. */
	props: unknown;
}

/** Minimal context for {@link traceHandler} — only `waitUntil` is required. */
export interface MinimalExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
}

export interface ScheduledController {
	scheduledTime: number;
	cron: string;
	noRetry(): void;
}

export interface MessageBatch<T = unknown> {
	readonly queue: string;
	readonly messages: readonly Message<T>[];
	ackAll(): void;
	retryAll(options?: MessageRetryOptions): void;
}

export interface Message<T = unknown> {
	readonly id: string;
	readonly timestamp: Date;
	readonly body: T;
	readonly attempts: number;
	ack(): void;
	retry(options?: MessageRetryOptions): void;
}

export interface MessageRetryOptions {
	delaySeconds?: number;
}

export type FetchHandler<Env = unknown> = (
	request: Request,
	env: Env,
	ctx: ExecutionContext,
) => Response | Promise<Response>;

export type ScheduledHandler<Env = unknown> = (
	controller: ScheduledController,
	env: Env,
	ctx: ExecutionContext,
) => void | Promise<void>;

export type QueueHandler<Env = unknown, T = unknown> = (
	batch: MessageBatch<T>,
	env: Env,
	ctx: ExecutionContext,
) => void | Promise<void>;

export interface ExportedHandler<Env = unknown> {
	fetch?: FetchHandler<Env>;
	scheduled?: ScheduledHandler<Env>;
	queue?: QueueHandler<Env>;
}

/**
 * Options for {@link instrument}. Extends {@link SDKConfig} (minus `runtime`).
 */
export interface InstrumentOptions extends Omit<SDKConfig, "runtime"> {}

/**
 * The event that triggered the current invocation.
 * Passed as the second argument to a {@link ResolveConfigFn}.
 *
 * - `Request` — a `fetch` event.
 * - `ScheduledController` — a `scheduled` event.
 * - `MessageBatch` — a `queue` event.
 * - `"do"` — a Durable Object or non-event entry point.
 */
export type Trigger = Request | ScheduledController | MessageBatch | "do";

/**
 * Per-invocation config resolver for {@link instrument}.
 *
 * Receives the request-time `env` and the triggering event, returns
 * {@link InstrumentOptions} used only for that invocation.  Secrets and
 * binding values (e.g. `env.OTEL_TOKEN`) are accessible here because the
 * factory is called *inside* the handler, not at module load time.
 *
 * @example
 * ```ts
 * export default instrument(
 *   { async fetch(req, env, ctx) { return new Response("ok"); } },
 *   (env, trigger) => ({
 *     serviceName: "my-worker",
 *     exporterEndpoint: env.OTEL_ENDPOINT,
 *     exporterHeaders: { Authorization: `Bearer ${env.OTEL_TOKEN}` },
 *   }),
 * );
 * ```
 */
export type ResolveConfigFn<Env = unknown> = (env: Env, trigger: Trigger) => InstrumentOptions;

let sdkResult: SDKResult | null = null;
let fetchPatched = false;

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

export function ensureSDK(config: Omit<SDKConfig, "runtime">): SDKResult {
	if (!sdkResult) {
		try {
			sdkResult = cloudflareWorkerAdapter.setup(config);
		} catch {
			sdkResult = noopSDKResult();
		}
		setBindingConfig(config);
	}
	return sdkResult;
}

/**
 * Monkey-patch `globalThis.fetch` with {@link instrumentFetch} exactly once.
 *
 * Called from both {@link instrument} and {@link traceHandler} so that
 * outgoing `fetch` calls are automatically traced regardless of which
 * entry-point the consumer uses.  The guard ensures the patch is never
 * applied twice.
 */
function ensureFetchPatched(): void {
	if (fetchPatched) return;
	fetchPatched = true;
	globalThis.fetch = instrumentFetch(globalThis.fetch);
}

function flush(): Promise<void> {
	if (!sdkResult) return Promise.resolve();
	return sdkResult.forceFlush();
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

/** Format byte count into human-readable string. */
function humanBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Format milliseconds into human-readable duration. */
function humanDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Options for {@link traceHandler}.
 */
export interface TraceHandlerOptions<T = Response> extends InstrumentOptions {
	/**
	 * Optional per-request config factory.  When provided, it is resolved with
	 * `(env, request)` and its result is merged into the options for this
	 * invocation.  Useful when the static `InstrumentOptions` fields in this
	 * object cannot carry secrets that only exist at request time.
	 *
	 * Throws → silently ignored (existing fail-silent contract).
	 */
	config?: InstrumentOptions | ResolveConfigFn;
	/** Execution context — only `waitUntil` is required. Pass `undefined` during SSG/prerender. */
	context: MinimalExecutionContext | undefined;
	/**
	 * Environment variable map forwarded to the SDK.
	 *
	 * Accepts `Record<string, unknown>` for compatibility with Cloudflare's
	 * `Env` bindings — only string values are read.
	 *
	 * When used via {@link instrument}, this is merged with the fetch `env`
	 * bindings, but fetch env takes precedence on key conflicts.
	 */
	env?: Record<string, unknown>;
	/** The incoming `Request` to trace. */
	request: Request;
	/** The handler to call inside the traced span. */
	handler: () => T | Promise<T>;
	/** Optional callback invoked via `ctx.waitUntil` after the span ends. */
	onFlush?: () => void | Promise<void>;
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
 * Trace a single fetch-style request.
 *
 * Creates a `SERVER` span, propagates incoming W3C trace context
 * (`traceparent`/`tracestate`) from `request` headers, and injects
 * trace context into the response headers.
 *
 * Use this directly in frameworks (e.g. SvelteKit hooks) that provide
 * `Request` + `ExecutionContext` but not the full `ExportedHandler` pattern.
 *
 * @example
 * ```ts
 * import { traceHandler } from "@tigorhutasuhut/telemetry-js/cloudflare";
 *
 * export async function handle({ event, resolve }) {
 *   return traceHandler({
 *     serviceName: "my-sveltekit-app",
 *     context: event.platform?.ctx,
 *     env: event.platform?.env ?? {},
 *     request: event.request,
 *     handler: () => resolve(event),
 *   });
 * }
 * ```
 */
export async function traceHandler<T = Response>(opts: TraceHandlerOptions<T>): Promise<T> {
	const {
		context: ctx,
		env,
		request,
		handler,
		onFlush,
		logger: loggerOpt,
		sensitiveHeaders,
		maxBodyLogSize = DEFAULT_MAX_BODY_LOG_SIZE,
		config: configOpt,
		...sdkOpts
	} = opts;

	// Resolve per-request config factory if provided
	let resolvedConfig: InstrumentOptions = {};
	if (configOpt !== undefined) {
		if (typeof configOpt === "function") {
			try {
				resolvedConfig = configOpt(env as unknown, request);
			} catch {
				// Fail-silent: factory threw, ignore and use base sdkOpts
				resolvedConfig = {};
			}
		} else {
			resolvedConfig = configOpt;
		}
	}
	const mergedOpts = { ...sdkOpts, ...resolvedConfig };

	ensureSDK({ ...mergedOpts, env });
	ensureFetchPatched();
	const tracer = trace.getTracer(mergedOpts.serviceName ?? opts.serviceName ?? "unknown");
	const url = new URL(request.url);
	const extractedCtx = propagation.extract(context.active(), request.headers, headerGetter);
	let span: Span | undefined;

	// Resolve logger (default: true → getLogger())
	const logger: Logger | undefined =
		loggerOpt === false
			? undefined
			: loggerOpt === true || loggerOpt == null
				? getLogger()
				: loggerOpt;
	const sensitiveSet = sensitiveHeaders
		? new Set(sensitiveHeaders.map((h) => h.toLowerCase()))
		: DEFAULT_SENSITIVE_HEADERS;

	// Pre-read request body for logging (before it may be consumed)
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

					// Inject trace context into response headers when the result is a Response
					if (res instanceof Response) {
						const newResponse = new Response(res.body, res);
						const activeCtx = context.active();
						propagation.inject(activeCtx, newResponse.headers, headerSetter);

						// Explicit traceparent + x-trace-id for easy client extraction
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

						// Propagate baggage as span attributes
						const baggage = propagation.getBaggage(activeCtx);
						if (baggage) {
							for (const [key, entry] of baggage.getAllEntries()) {
								span.setAttribute(`baggage.${key}`, entry.value);
							}
						}

						// Auto-log the request/response (inside span context so logs get span_id/trace_id)
						if (logger) {
							const duration = Date.now() - startTime;
							const responseSize = Number(newResponse.headers.get("content-length") ?? 0);

							// Build log message: [Method] [Path] -- [status] [duration] [size]
							const message = `${request.method} ${url.pathname} -- ${newResponse.status} ${humanDuration(duration)} ${humanBytes(responseSize)}`;

							// Build attributes
							const attrs: LogAttributes = {};

							// Request attributes
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

							// Response attributes
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

					// Log the error (inside span context so logs get span_id/trace_id)
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

		ctx?.waitUntil(
			(async () => {
				const traceId = span?.spanContext().traceId;
				if (traceId && sdkResult?.flushTrace) {
					await sdkResult.flushTrace(traceId);
				} else {
					await sdkResult?.forceFlush();
				}
				const result = opts.onFlush?.();
				if (
					result != null &&
					typeof (result as unknown as PromiseLike<unknown>).then === "function"
				)
					await result;
			})(),
		);
	}
}

/**
 * Resolve a static or factory config for use inside a handler branch.
 * Factory throws are swallowed (fail-silent); the base `fallback` is returned instead.
 * @internal
 */
function resolveInstrumentConfig<Env>(
	optsOrFactory: InstrumentOptions | ResolveConfigFn<Env> | undefined,
	env: Env,
	trigger: Trigger,
): InstrumentOptions {
	if (optsOrFactory === undefined) return {};
	if (typeof optsOrFactory === "function") {
		try {
			return optsOrFactory(env, trigger);
		} catch {
			// Fail-silent: factory threw → noop config, worker still runs
			console.error("[telemetry-js] ResolveConfigFn threw — falling back to noop config");
			return {};
		}
	}
	return optsOrFactory;
}

/**
 * Wrap a Cloudflare Worker handler with OpenTelemetry instrumentation.
 *
 * Accepts either a static config object or a per-request factory function as
 * the second argument.  The factory form is useful when secrets (e.g.
 * `env.OTEL_TOKEN`) only exist inside a request and cannot be captured at
 * module load time.
 *
 * Each incoming `fetch`, `scheduled`, or `queue` event is traced as a span.
 * Spans are flushed via `ctx.waitUntil` so they don't block the response.
 *
 * @param handler - The original Cloudflare Worker `ExportedHandler` to instrument.
 * @param opts - Static SDK configuration options (object form).
 * @returns A new `ExportedHandler` that traces every event.
 *
 * @example Object form (unchanged)
 * ```ts
 * import { instrument } from "@tigorhutasuhut/telemetry-js/cloudflare";
 *
 * export default instrument(
 *   { async fetch(request, env, ctx) { return new Response("Hello"); } },
 *   { serviceName: "my-worker" },
 * );
 * ```
 *
 * @example Factory form — secrets from `env`
 * ```ts
 * import { instrument } from "@tigorhutasuhut/telemetry-js/cloudflare";
 *
 * export default instrument(
 *   { async fetch(request, env, ctx) { return new Response("Hello"); } },
 *   (env, trigger) => ({
 *     serviceName: "my-worker",
 *     exporterEndpoint: env.OTEL_ENDPOINT,
 *     exporterHeaders: { Authorization: `Bearer ${env.OTEL_TOKEN}` },
 *   }),
 * );
 * ```
 */
export function instrument<Env = unknown>(
	handler: ExportedHandler<Env>,
	opts?: InstrumentOptions,
): ExportedHandler<Env>;
export function instrument<Env = unknown>(
	handler: ExportedHandler<Env>,
	resolveConfig: ResolveConfigFn<Env>,
): ExportedHandler<Env>;
export function instrument<Env = unknown>(
	handler: ExportedHandler<Env>,
	optsOrFactory?: InstrumentOptions | ResolveConfigFn<Env>,
): ExportedHandler<Env> {
	const isFactory = typeof optsOrFactory === "function";
	// For the static object form, extract base config once (existing behaviour)
	const staticConfig: InstrumentOptions = isFactory ? {} : (optsOrFactory ?? {});
	staticConfig.env = staticConfig.env || globalThis.process?.env || {};
	const result: ExportedHandler<Env> = {};

	if (handler.fetch) {
		const originalFetch = handler.fetch;
		result.fetch = async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
			// Resolve config inside the handler so factory gets the live env + trigger
			const resolvedConfig = resolveInstrumentConfig(optsOrFactory, env, request);
			const sdkConfig = isFactory ? resolvedConfig : staticConfig;
			const ee = { ...sdkConfig.env, ...(env as Record<string, unknown>) };
			return traceHandler({
				...sdkConfig,
				context: ctx,
				env: ee,
				request,
				serviceName: sdkConfig.serviceName ?? "unknown",
				handler: () => originalFetch(request, env, ctx),
				onFlush: () => flush(),
			});
		};
	}

	if (handler.scheduled) {
		const originalScheduled = handler.scheduled;
		result.scheduled = async (
			controller: ScheduledController,
			env: Env,
			ctx: ExecutionContext,
		): Promise<void> => {
			const resolvedConfig = resolveInstrumentConfig(optsOrFactory, env, controller);
			const sdkConfig = isFactory ? resolvedConfig : staticConfig;
			ensureSDK(sdkConfig);
			ensureFetchPatched();
			const tracer = trace.getTracer(sdkConfig.serviceName ?? "unknown");
			let span: Span | undefined;

			try {
				await tracer.startActiveSpan(
					`scheduled ${controller.cron}`,
					{
						kind: SpanKind.INTERNAL,
						attributes: {
							"faas.trigger": "timer",
							"faas.cron": controller.cron,
							"faas.time": new Date(controller.scheduledTime).toISOString(),
						},
					},
					async (s) => {
						span = s;
						await originalScheduled(controller, env, ctx);
					},
				);
			} catch (error) {
				span?.setStatus({
					code: SpanStatusCode.ERROR,
					message: error instanceof Error ? error.message : String(error),
				});
				span?.recordException(error as Error);
				throw error;
			} finally {
				span?.end();
				ctx.waitUntil(flush());
			}
		};
	}

	if (handler.queue) {
		const originalQueue = handler.queue;
		result.queue = async (batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> => {
			const resolvedConfig = resolveInstrumentConfig(optsOrFactory, env, batch);
			const sdkConfig = isFactory ? resolvedConfig : staticConfig;
			ensureSDK(sdkConfig);
			ensureFetchPatched();
			const tracer = trace.getTracer(sdkConfig.serviceName ?? "unknown");
			let span: Span | undefined;

			try {
				await tracer.startActiveSpan(
					`queue ${batch.queue}`,
					{
						kind: SpanKind.CONSUMER,
						attributes: {
							"faas.trigger": "pubsub",
							"messaging.system": "cloudflare",
							"messaging.destination": batch.queue,
							"messaging.batch.message_count": batch.messages.length,
						},
					},
					async (s) => {
						span = s;
						await originalQueue(batch, env, ctx);
					},
				);
			} catch (error) {
				span?.setStatus({
					code: SpanStatusCode.ERROR,
					message: error instanceof Error ? error.message : String(error),
				});
				span?.recordException(error as Error);
				throw error;
			} finally {
				span?.end();
				ctx.waitUntil(flush());
			}
		};
	}

	return result;
}

/**
 * Reset internal SDK state (for testing).
 * @internal
 */
export function _resetInstrumentState(): void {
	sdkResult = null;
	fetchPatched = false;
	_httpRequestDuration = null;
	_httpRequestTotal = null;
	_httpActiveRequests = null;
}
