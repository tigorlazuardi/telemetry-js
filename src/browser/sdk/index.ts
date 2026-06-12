/**
 * Browser SDK primitives — heavy, opt-in subpath.
 *
 * ```ts
 * import { FetchTraceExporter, StackContextManager } from "@tigorhutasuhut/telemetry-js/browser/sdk";
 * ```
 *
 * This subpath intentionally pulls all OTel dependencies. Use it for custom
 * provider setup. For lazy initialization, use `initSDK` from `/browser` instead.
 */

export { metrics } from "@opentelemetry/api";
export { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
export { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
export { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
export type { FetchExporterConfig } from "../../shared/exporters.js";
export {
	FetchLogExporter,
	FetchMetricExporter,
	FetchTraceExporter,
} from "../../shared/exporters.js";
export { createLogger, getLogger, runWithLogger, setDefaultLogger } from "../../shared/logger.js";
export { noopLogger, noopSDKResult } from "../../shared/noop.js";
export { StackContextManager } from "../context-manager.js";
