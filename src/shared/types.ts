import type {
	ContextManager,
	MeterProvider,
	SpanContext,
	TracerProvider,
} from "@opentelemetry/api";
import type { LoggerProvider } from "@opentelemetry/api-logs";
import type { Resource } from "@opentelemetry/resources";
import type { ReadableSpan, Sampler } from "@opentelemetry/sdk-trace-base";

/**
 * Supported runtime identifiers.
 *
 * Built-in values are `"node"` and `"cloudflare-worker"`.
 * Any other string is accepted for custom adapters.
 */
export type RuntimeName = "node" | "cloudflare-worker" | "browser" | (string & {});

/**
 * A complete local trace as buffered within one Cloudflare Worker isolate.
 *
 * Because a single isolate handles exactly one request, all spans for a given
 * `traceId` are available in memory simultaneously — making tail-sampling
 * both cheap and complete.
 */
export interface LocalTrace {
	/** W3C hex trace ID shared by all spans in this trace. */
	traceId: string;
	/** Every span that belongs to this trace. */
	spans: ReadableSpan[];
	/**
	 * The root span — the span with no `parentSpanContext`.
	 * Status, duration, and trace flags are read from here for built-in samplers.
	 */
	rootSpan: ReadableSpan;
}

/**
 * Decides whether a completed local trace should be exported.
 *
 * Return `true` to export all spans in the trace; `false` to drop them.
 * Called once per trace, after the root span ends and all children have ended.
 */
export type TailSampleFn = (trace: LocalTrace) => boolean;

/**
 * Configuration passed to {@link initSDK} to initialise tracing, metrics, and logging.
 */
export interface SDKConfig {
	/** The logical name of the service reported in every span. */
	serviceName?: string;

	/**
	 * Explicit runtime to use. When omitted the SDK auto-detects
	 * by calling each registered adapter's `detect()` method.
	 */
	runtime?: RuntimeName;

	/**
	 * Base OTLP HTTP endpoint (e.g. `"https://otel.example.com"`).
	 *
	 * The SDK appends per-signal paths (`/v1/traces`, `/v1/metrics`, `/v1/logs`)
	 * automatically. Use signal-specific endpoints to override individual signals.
	 */
	exporterEndpoint?: string;

	/** Additional headers sent with every OTLP export request (e.g. auth tokens). */
	exporterHeaders?: Record<string, string>;

	/** Extra key/value pairs merged into the OpenTelemetry `Resource`. */
	resourceAttributes?: Record<string, string>;

	/** OTLP HTTP endpoint for the metrics exporter. Falls back to `exporterEndpoint + /v1/metrics` when omitted. */
	metricsExporterEndpoint?: string;

	/** Metrics collection interval in milliseconds (default `60000`). */
	metricsExportIntervalMs?: number;

	/** Signal-specific OTLP endpoint for traces (full URL, no suffix appended). */
	tracesExporterEndpoint?: string;

	/** Signal-specific OTLP endpoint for logs (full URL, no suffix appended). */
	logsExporterEndpoint?: string;

	/** OpenTelemetry instrumentations to register (Node only). */
	instrumentations?: unknown[];

	/**
	 * Enable development mode. When `true`, the browser adapter gates all
	 * console output through this flag — logs are silent until `dev: true`.
	 * Has no effect on Node.js, Cloudflare Workers, or Bun adapters.
	 */
	dev?: boolean;

	/**
	 * Capture binding keys (`kv.key`, `r2.key`, `do.storage.key`) as span attributes.
	 *
	 * **PII risk** — keys may contain user-identifiable data. Defaults to `false`.
	 * Set to `true` to opt in to key capture (span-only; keys are never added to metric labels).
	 */
	bindingCaptureKeys?: boolean;

	/**
	 * Explicit histogram bucket boundaries in **milliseconds** for `cloudflare.binding.operation.duration`.
	 *
	 * Defaults to `[1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000]` — tuned for
	 * Cloudflare edge-storage latencies. Override to match your p99 targets.
	 */
	bindingHistogramBoundaries?: number[];

	/**
	 * What to do when a binding operation is called with no active recording span.
	 *
	 * - `"skip"` *(default)* — record only the duration metric; emit no span. Prevents
	 *   disconnected root spans that would carry a different `traceId` than the request.
	 * - `"root"` — emit a root span regardless (opt-in, for top-level work outside a request).
	 */
	orphanBindingSpans?: "skip" | "root";

	/**
	 * Tail-sampling configuration (Cloudflare Workers only).
	 *
	 * When present, the Cloudflare adapter switches from `SimpleSpanProcessor`
	 * to a buffering `TailSampleSpanProcessor`. With no `sampling` config the
	 * adapter behaves exactly as before — export-per-span via `SimpleSpanProcessor`.
	 */
	sampling?: {
		/**
		 * Function deciding whether to export a completed trace.
		 * Default: `multiTailSampler([keepOnHeadSampled, keepOnError])` — keep on
		 * error OR on head-sampled propagation.
		 */
		tailSampler?: TailSampleFn;
		/**
		 * Custom head sampler. **Must never return `NOT_RECORD`** — the tail
		 * sampler needs all spans in memory. Default: record-all sampler that
		 * marks spans `RECORD_AND_SAMPLED` with probability `propagationRatio`,
		 * else `RECORD` (never `NOT_RECORD`), wrapped in `ParentBasedSampler`.
		 */
		headSampler?: Sampler;
		/**
		 * Fraction (0–1) of traces to mark `SAMPLED` in the propagated W3C
		 * `traceparent`. Affects downstream `keepOnHeadSampled` decisions and the
		 * Cloudflare dashboard sampling — does **not** gate local recording.
		 * Default `1.0` (propagate all as sampled).
		 */
		propagationRatio?: number;
		/**
		 * Maximum total spans buffered across all in-flight traces (default 2048).
		 * When exceeded, the oldest incomplete trace is force-decided and flushed
		 * early to prevent unbounded isolate memory growth.
		 */
		maxBufferedSpans?: number;
	};

	/**
	 * Custom {@link ContextManager} to use for context propagation.
	 *
	 * When omitted, a runtime-appropriate default is used:
	 * - **Browser**: {@link StackContextManager} (simple variable swap, safe for single-threaded JS)
	 * - **Cloudflare**: `AsyncLocalStorage`-backed context manager
	 * - **Node**: managed by `@opentelemetry/sdk-node`
	 */
	contextManager?: ContextManager;

	/**
	 * Environment variable map. Used in runtimes where `process.env` is unavailable
	 * (e.g. Cloudflare Workers). Falls back to `process.env` when omitted.
	 *
	 * Accepts `Record<string, unknown>` for compatibility with Cloudflare's `Env`
	 * bindings — only string values are read; non-string values (KV, D1, etc.)
	 * are silently ignored.
	 */
	env?: Record<string, unknown>;
}

/**
 * Type helper that adds W3C trace propagation fields to an object type.
 *
 * - If `T` extends `object`, the result is `T & { traceparent: string; tracestate?: string; baggage?: string }`.
 * - Otherwise, `T` is returned as-is.
 *
 * Useful for typing workflow params or message payloads that carry trace context.
 *
 * @example
 * ```ts
 * interface MyParams { userId: string }
 *
 * // { userId: string; traceparent: string; tracestate?: string; baggage?: string }
 * type MyCarrier = Carrier<MyParams>;
 *
 * // Non-object types pass through unchanged
 * type Str = Carrier<string>; // string
 * ```
 */
export type Carrier<T> = T extends object
	? T & { traceparent?: string; tracestate?: string; baggage?: string }
	: T;

/**
 * A runtime-specific adapter that the SDK uses to wire up
 * providers, processors, and exporters for a given environment.
 */
export interface RuntimeAdapter {
	/** Unique identifier for this runtime (e.g. `"node"`). */
	name: RuntimeName;

	/**
	 * Create providers, processors, and exporters for this runtime.
	 *
	 * @param config - SDK configuration supplied by the caller.
	 * @returns An {@link SDKResult} containing the initialised providers plus lifecycle helpers.
	 */
	setup(config: SDKConfig): SDKResult;
}

/** Key/value pairs attached to log records. */
export type LogAttributes = Record<string, unknown>;

/** Options for individual log calls. */
export interface LogOptions {
	/** Explicit span context for log-trace correlation. */
	spanContext?: SpanContext;
	/** Explicit timestamp (epoch ms). Defaults to `Date.now()`. */
	timestamp?: number;
}

/** Log severity levels. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured logger with dual output (stderr + OTLP). */
export interface Logger {
	debug(message: string, attrs?: LogAttributes, opts?: LogOptions): void;
	info(message: string, attrs?: LogAttributes, opts?: LogOptions): void;
	warn(message: string, attrs?: LogAttributes, opts?: LogOptions): void;
	error(message: string, attrs?: LogAttributes, opts?: LogOptions): void;
}

/** OTLP signal identifiers for endpoint resolution. */
export type OtlpSignal = "traces" | "metrics" | "logs";

/**
 * The object returned by {@link initSDK} after the SDK has been initialised.
 */
export interface SDKResult {
	/** The merged OpenTelemetry {@link Resource} used by all providers. */
	resource: Resource;

	/** The active `TracerProvider`. */
	provider: TracerProvider;

	/** The active `MeterProvider` (present only when a metrics endpoint resolves). */
	meterProvider?: MeterProvider;

	/** The active `LoggerProvider` (present only when a logs endpoint resolves). */
	loggerProvider?: LoggerProvider;

	/** Structured logger. Always present (noop if no logs endpoint). */
	logger: Logger;

	/** Gracefully shut down all providers and flush pending data. */
	shutdown(): Promise<void>;

	/** Force-flush all pending spans, metrics, and logs without shutting down. */
	forceFlush(): Promise<void>;

	/**
	 * Flush spans for a specific trace by ID (Cloudflare tail-sampling only).
	 *
	 * Called from `ctx.waitUntil` with the current request's root trace ID so that
	 * the tail decision runs for exactly that trace. Falls back to `forceFlush()`
	 * when tail-sampling is not configured.
	 */
	flushTrace?(traceId: string): Promise<void>;
}
