/**
 * Cloudflare binding instrumentation wrappers.
 *
 * Each wrapper is a transparent `Proxy` that adds OpenTelemetry child spans
 * and a `cloudflare.binding.operation.duration` histogram to every binding call.
 */

export { instrumentKV } from "./kv.js";
export type { TraceBindingOpts } from "./trace-binding.js";
export { traceBinding } from "./trace-binding.js";
export type {
	KVGetOptions,
	KVListOptions,
	KVListResult,
	KVNamespace,
	KVPutOptions,
} from "./types.js";
