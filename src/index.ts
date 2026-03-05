/**
 * @packageDocumentation
 *
 * `@tigorhutasuhut/telemetry-js` — OpenTelemetry SDK setup abstraction for multiple runtimes.
 *
 * @example
 * ```ts
 * import { initSDK } from "@tigorhutasuhut/telemetry-js";
 *
 * const sdk = initSDK({ serviceName: "my-api" });
 * ```
 */

export type {
	Counter,
	Histogram,
	Meter,
	MeterProvider,
	UpDownCounter,
} from "@opentelemetry/api";
// Metrics API re-exports
export { metrics } from "@opentelemetry/api";
// Resource re-exports
export type { Resource } from "@opentelemetry/resources";
export { normalizeEndpoint, resolveSignalEndpoint } from "./endpoints.js";
export type { FetchExporterConfig } from "./exporters.js";
export { FetchLogExporter, FetchMetricExporter, FetchTraceExporter } from "./exporters.js";
export type { InstrumentFetchConfig } from "./instrument-fetch.js";
export { getOriginalFetch, instrumentFetch } from "./instrument-fetch.js";
export { createLogger, getLogger, runWithLogger, setDefaultLogger } from "./logger.js";
export { noopLogger, noopSDKResult } from "./noop.js";
export { getRegisteredAdapters, register, resolve } from "./registry.js";
export type {
	InstrumentOptions,
	MinimalExecutionContext,
	TraceHandlerOptions,
} from "./runtimes/cloudflare/instrument.js";
export { instrument, traceHandler } from "./runtimes/cloudflare/instrument.js";
export type {
	InjectContextOptions,
	InstrumentWorkflowOptions,
} from "./runtimes/cloudflare/workflow.js";
export {
	extractContext,
	extractSpan,
	extractTraceparent,
	injectContext,
	instrumentWorkflow,
} from "./runtimes/cloudflare/workflow.js";
export { getResource, initSDK } from "./sdk.js";
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
