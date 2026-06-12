/**
 * Cloudflare binding instrumentation wrappers.
 *
 * Each wrapper is a transparent `Proxy` that adds OpenTelemetry child spans
 * and a `cloudflare.binding.operation.duration` histogram to every binding call.
 */

export { instrumentD1 } from "./d1.js";
export { instrumentKV } from "./kv.js";
export { instrumentR2 } from "./r2.js";
export type { TraceBindingOpts } from "./trace-binding.js";
export { traceBinding } from "./trace-binding.js";
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
} from "./types.js";
