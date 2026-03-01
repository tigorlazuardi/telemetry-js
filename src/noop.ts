import { trace } from "@opentelemetry/api";
import { emptyResource } from "@opentelemetry/resources";
import type { Logger, SDKResult } from "./types.js";

/** A logger that silently discards all messages. */
export const noopLogger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

/** Return a no-op {@link SDKResult} that does nothing. */
export function noopSDKResult(): SDKResult {
	return {
		resource: emptyResource(),
		provider: trace.getTracerProvider(),
		logger: noopLogger,
		async shutdown() {},
		async forceFlush() {},
	};
}
