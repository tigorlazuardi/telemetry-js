/**
 * Node.js entry point.
 *
 * ```ts
 * import { initSDK } from "@tigorhutasuhut/telemetry-js/node";
 * ```
 *
 * Only Node.js runtime code is included — Cloudflare Workers and browser
 * adapter code is never pulled in, ensuring a clean tree-shake.
 */

import type { Resource } from "@opentelemetry/resources";
import { noopSDKResult } from "../shared/noop.js";
import type { SDKConfig, SDKResult } from "../shared/types.js";
import { nodeAdapter } from "./adapter.js";

/** Module-level reference to the last initialised resource. */
let _globalResource: Resource | null = null;

/**
 * Initialise the OpenTelemetry SDK for Node.js.
 *
 * @param config - SDK configuration options.
 * @returns An {@link SDKResult} with the active providers and lifecycle helpers.
 */
export function initSDK(config: SDKConfig): SDKResult {
	try {
		const result = nodeAdapter.setup(config);
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
export type { InjectContextOptions } from "../shared/context.js";
export { injectContext } from "../shared/context.js";
export { normalizeEndpoint, resolveSignalEndpoint } from "../shared/endpoints.js";
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
