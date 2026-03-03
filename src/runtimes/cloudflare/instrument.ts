import {
	context,
	propagation,
	type Span,
	SpanKind,
	SpanStatusCode,
	type TextMapGetter,
	type TextMapSetter,
	trace,
} from "@opentelemetry/api";
import { getLogger } from "../../logger.js";
import { initSDK } from "../../sdk.js";
import type { LogAttributes, Logger, SDKConfig, SDKResult } from "../../types.js";

// Minimal CF types to avoid @cloudflare/workers-types dependency
interface ExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException(): void;
	/** For compatibility with Wrangler 4.x. */
	props: unknown;
}

/** Minimal context for {@link traceHandler} — only `waitUntil` is required. */
export interface MinimalExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
}

interface ScheduledController {
	scheduledTime: number;
	cron: string;
	noRetry(): void;
}

interface MessageBatch<T = unknown> {
	readonly queue: string;
	readonly messages: readonly Message<T>[];
	ackAll(): void;
	retryAll(options?: MessageRetryOptions): void;
}

interface Message<T = unknown> {
	readonly id: string;
	readonly timestamp: Date;
	readonly body: T;
	readonly attempts: number;
	ack(): void;
	retry(options?: MessageRetryOptions): void;
}

interface MessageRetryOptions {
	delaySeconds?: number;
}

type FetchHandler<Env = unknown> = (
	request: Request,
	env: Env,
	ctx: ExecutionContext,
) => Response | Promise<Response>;

type ScheduledHandler<Env = unknown> = (
	controller: ScheduledController,
	env: Env,
	ctx: ExecutionContext,
) => void | Promise<void>;

type QueueHandler<Env = unknown, T = unknown> = (
	batch: MessageBatch<T>,
	env: Env,
	ctx: ExecutionContext,
) => void | Promise<void>;

interface ExportedHandler<Env = unknown> {
	fetch?: FetchHandler<Env>;
	scheduled?: ScheduledHandler<Env>;
	queue?: QueueHandler<Env>;
}

/**
 * Options for {@link instrument}. Extends {@link SDKConfig} (minus `runtime`).
 */
export interface InstrumentOptions extends Omit<SDKConfig, "runtime"> {}

let sdkResult: SDKResult | null = null;

export function ensureSDK(config: Omit<SDKConfig, "runtime">): SDKResult {
	if (!sdkResult) {
		sdkResult = initSDK({ ...config, runtime: "cloudflare-worker" });
	}
	return sdkResult;
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
	/** Execution context — only `waitUntil` is required. Pass `undefined` during SSG/prerender. */
	context: MinimalExecutionContext | undefined;
	/**
	 * Environment variable map forwarded to the SDK.
	 *
	 * When used via {@link instrument}, this is merged with the fetch `env`
	 * bindings, but fetch env takes precedence on key conflicts.
	 */
	env?: Record<string, string | undefined>;
	/** The incoming `Request` to trace. */
	request: Request;
	/** The handler to call inside the traced span. */
	handler: () => T | Promise<T>;
	/** Optional callback invoked via `ctx.waitUntil` after the span ends. */
	onFlush?: () => void | Promise<void>;
	/**
	 * Logger for automatic request/response logging.
	 * When `true`, uses `getLogger()`. When a `Logger` instance, uses that.
	 * When `false` or omitted, no automatic logging is performed.
	 * @default false
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
		return [...carrier.keys()];
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
 * import { traceHandler } from "@tigorhutasuhut/telemetry-js";
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
		...sdkOpts
	} = opts;
	ensureSDK({ ...sdkOpts, env });
	const tracer = trace.getTracer(opts.serviceName ?? "unknown");
	const url = new URL(request.url);
	const extractedCtx = propagation.extract(context.active(), request.headers, headerGetter);
	let span: Span | undefined;

	// Resolve logger
	const logger: Logger | undefined =
		loggerOpt === true ? getLogger() : loggerOpt === false ? undefined : loggerOpt || undefined;
	const sensitiveSet = sensitiveHeaders
		? new Set(sensitiveHeaders.map((h) => h.toLowerCase()))
		: DEFAULT_SENSITIVE_HEADERS;

	// Pre-read request body for logging (before it may be consumed)
	let requestBodyPromise: Promise<string | undefined> | undefined;
	if (logger && request.body && isLoggableContentType(request.headers)) {
		requestBodyPromise = readLimitedBody(request.clone(), maxBodyLogSize);
	}
	const startTime = Date.now();

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
				const res = await handler();
				if (res instanceof Response) {
					span.setAttribute("http.status_code", res.status);
					if (res.status >= 500) {
						span.setStatus({ code: SpanStatusCode.ERROR });
					}
				}
				return res;
			},
		);

		// Inject trace context into response headers when the result is a Response
		if (result instanceof Response) {
			const newResponse = new Response(result.body, result);
			propagation.inject(context.active(), newResponse.headers, headerSetter);

			// Auto-log the request/response
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

		return result;
	} catch (error) {
		span?.setStatus({
			code: SpanStatusCode.ERROR,
			message: error instanceof Error ? error.message : String(error),
		});
		span?.recordException(error as Error);

		// Log the error
		if (logger) {
			const duration = Date.now() - startTime;
			const message = `${request.method} ${url.pathname} -- FAILED ${humanDuration(duration)}`;
			const attrs: LogAttributes = {
				"http.request.method": request.method,
				"http.request.path": url.pathname,
				"http.duration_ms": duration,
				"http.error": error instanceof Error ? error.message : String(error),
			};
			if (url.search) attrs["http.request.query"] = url.search;
			logger.error(message, attrs);
		}

		throw error;
	} finally {
		span?.end();
		ctx?.waitUntil(
			(async () => {
				await sdkResult?.forceFlush();
				const result = opts.onFlush?.();
				if (result instanceof Promise) await result;
			})(),
		);
	}
}

/**
 * Wrap a Cloudflare Worker handler with OpenTelemetry instrumentation.
 *
 * Each incoming `fetch`, `scheduled`, or `queue` event is traced as a span.
 * Spans are flushed via `ctx.waitUntil` so they don't block the response.
 *
 * @param handler - The original Cloudflare Worker `ExportedHandler` to instrument.
 * @param opts - SDK configuration options.
 * @returns A new `ExportedHandler` that traces every event.
 *
 * @example
 * ```ts
 * import { instrument } from "@tigorhutasuhut/telemetry-js";
 *
 * export default instrument({
 *   async fetch(request, env, ctx) {
 *     return new Response("Hello");
 *   },
 * });
 * ```
 */
export function instrument<Env = unknown>(
	handler: ExportedHandler<Env>,
	opts?: InstrumentOptions,
): ExportedHandler<Env> {
	const sdkConfig = opts ?? {};
	const result: ExportedHandler<Env> = {};

	if (handler.fetch) {
		const originalFetch = handler.fetch;
		result.fetch = async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
			const ee = { ...sdkConfig.env, ...(env as Record<string, string | undefined>) };
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
			ensureSDK(sdkConfig);
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
			ensureSDK(sdkConfig);
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
}
