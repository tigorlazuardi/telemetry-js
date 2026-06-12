/**
 * Cloudflare Workers entry point.
 *
 * ```ts
 * import { instrument } from "@tigorhutasuhut/telemetry-js/cloudflare";
 * ```
 *
 * Only Cloudflare Workers runtime code is included — Node.js and browser
 * adapter code is never pulled in, ensuring a clean tree-shake.
 */

import type { Resource } from "@opentelemetry/resources";
import { noopSDKResult } from "../shared/noop.js";
import type { SDKConfig, SDKResult } from "../shared/types.js";
import { cloudflareWorkerAdapter } from "./adapter.js";

/** Module-level reference to the last initialised resource. */
let _globalResource: Resource | null = null;

/**
 * Initialise the OpenTelemetry SDK for Cloudflare Workers.
 *
 * @param config - SDK configuration options.
 * @returns An {@link SDKResult} with the active providers and lifecycle helpers.
 */
export function initSDK(config: SDKConfig): SDKResult {
	try {
		const result = cloudflareWorkerAdapter.setup(config);
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
export type { ActionOptions, ActionScope, ScopedAction } from "../shared/action.js";
export { scopeAction, withAction } from "../shared/action.js";
export { normalizeEndpoint, resolveSignalEndpoint } from "../shared/endpoints.js";
export type { FetchExporterConfig } from "../shared/exporters.js";
export { FetchLogExporter, FetchMetricExporter, FetchTraceExporter } from "../shared/exporters.js";
export type { InstrumentFetchConfig } from "../shared/fetch.js";
export { getOriginalFetch, instrumentFetch } from "../shared/fetch.js";
export { createLogger, getLogger, runWithLogger, setDefaultLogger } from "../shared/logger.js";
export { noopLogger, noopSDKResult } from "../shared/noop.js";
export type { TracedCallContext, TracedInput } from "../shared/traced.js";
export { traced } from "../shared/traced.js";
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
} from "../shared/types.js";
export type { WithTraceOptions } from "../shared/with-trace.js";
export { withTrace } from "../shared/with-trace.js";

// ── Cloudflare-specific APIs ────────────────────────────────────────────

export type {
	ExecutionContext,
	ExportedHandler,
	FetchHandler,
	InstrumentOptions,
	Message,
	MessageBatch,
	MessageRetryOptions,
	MinimalExecutionContext,
	QueueHandler,
	ResolveConfigFn,
	ScheduledController,
	ScheduledHandler,
	TraceHandlerOptions,
	Trigger,
} from "./instrument.js";
export { instrument, traceHandler } from "./instrument.js";
export type {
	InjectContextOptions,
	InstrumentWorkflowOptions,
} from "./workflow.js";
export {
	extractContext,
	extractSpan,
	extractTraceparent,
	injectContext,
	instrumentWorkflow,
} from "./workflow.js";

// ── Binding instrumentation ─────────────────────────────────────────────────

export type {
	D1Database,
	D1ExecResult,
	D1PreparedStatement,
	D1Result,
	KVGetOptions,
	KVListOptions,
	KVListResult,
	KVNamespace,
	KVPutOptions,
	R2Bucket,
	R2MultipartUpload,
	R2Object,
	R2ObjectBody,
	R2Objects,
	TraceBindingOpts,
} from "./bindings/index.js";
export { instrumentD1, instrumentKV, instrumentR2, traceBinding } from "./bindings/index.js";
