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

export { initSDK, getResource } from "./sdk.js";
export { register, resolve, getRegisteredAdapters } from "./registry.js";
export { instrument, traceHandler } from "./runtimes/cloudflare/instrument.js";
export type { InstrumentOptions, TraceHandlerOptions, MinimalExecutionContext } from "./runtimes/cloudflare/instrument.js";
export { instrumentWorkflow, injectTraceparent, extractTraceparent } from "./runtimes/cloudflare/workflow.js";
export type { InstrumentWorkflowOptions } from "./runtimes/cloudflare/workflow.js";
export { withTrace } from "./with-trace.js";
export type { WithTraceOptions } from "./with-trace.js";
export { traced } from "./traced.js";
export type { TracedInput, TracedCallContext } from "./traced.js";
export { resolveSignalEndpoint, normalizeEndpoint } from "./endpoints.js";
export { instrumentFetch } from "./instrument-fetch.js";
export type { InstrumentFetchConfig } from "./instrument-fetch.js";
export { createLogger, getLogger, runWithLogger, setDefaultLogger } from "./logger.js";
export { noopSDKResult, noopLogger } from "./noop.js";
export type {
  RuntimeName,
  SDKConfig,
  RuntimeAdapter,
  SDKResult,
  Logger,
  LogAttributes,
  LogOptions,
  LogLevel,
  OtlpSignal,
} from "./types.js";

// Metrics API re-exports
export { metrics } from "@opentelemetry/api";
export type {
  MeterProvider,
  Meter,
  Counter,
  Histogram,
  UpDownCounter,
} from "@opentelemetry/api";

// Resource re-exports
export type { Resource } from "@opentelemetry/resources";
