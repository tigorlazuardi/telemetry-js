import { traceBinding } from "./trace-binding.js";
import type { R2Bucket } from "./types.js";

/** R2 methods that are wrapped with tracing (all async). */
const WRAPPED_METHODS = new Set(["get", "put", "head", "delete", "list", "createMultipartUpload"]);

/**
 * Wrap an `R2Bucket` binding with OpenTelemetry tracing and metrics.
 *
 * Returns a transparent `Proxy<T>` so the wrapped value is assignment-compatible
 * with the original binding type. Every call to `get`, `put`, `head`, `delete`,
 * `list`, or `createMultipartUpload` opens a child span (when inside a traced
 * request) and records a `cloudflare.binding.operation.duration` histogram data
 * point.
 *
 * **Streaming caveat**: `get` returns an `R2ObjectBody` whose `.body` stream is
 * left completely untouched. The span measures only the promise-resolution latency
 * (i.e. the time until the response headers/metadata arrive), not the time to
 * drain the body. This matches the semantics of the underlying Workers API and
 * ensures callers can still stream the body after instrumentation.
 *
 * Key capture is opt-in (see `bindingCaptureKeys` in {@link SDKConfig}); by default
 * keys are omitted from span attributes to avoid PII leakage. For `delete` with an
 * array argument no key is captured even when `bindingCaptureKeys` is `true`.
 *
 * `resumeMultipartUpload` is synchronous and returns an `R2MultipartUpload` handle
 * directly; it is passed through untraced.
 *
 * @param bucket - The original `R2Bucket` to instrument.
 * @param name   - Human-readable name for this binding (e.g. `"ASSETS"`).
 *   Used in span names (`R2 ASSETS get`) and metric labels.
 * @returns A `Proxy<T>` with identical type; non-wrapped properties pass through unchanged.
 *
 * @example
 * ```ts
 * import { instrumentR2 } from "@tigorhutasuhut/telemetry-js/cloudflare";
 *
 * export default {
 *   async fetch(request, env, ctx) {
 *     const bucket = instrumentR2(env.ASSETS, "ASSETS");
 *     const obj = await bucket.get("index.html");  // → span "R2 ASSETS get"
 *     if (!obj) return new Response("not found", { status: 404 });
 *     return new Response(obj.body);               // body stream untouched
 *   },
 * };
 * ```
 */
export function instrumentR2<T extends R2Bucket>(bucket: T, name: string): T {
	return new Proxy(bucket, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);

			if (typeof prop !== "string" || !WRAPPED_METHODS.has(prop)) {
				return value;
			}

			if (typeof value !== "function") {
				return value;
			}

			// Bind method to original target so `this` is correct inside CF runtime
			const bound = (value as (...a: unknown[]) => unknown).bind(target);

			return (...args: unknown[]) => {
				// Key extraction rules:
				// - get/put/head/createMultipartUpload: first arg is always a string key
				// - delete: first arg may be string | string[] → only capture when string
				// - list: no key
				let key: string | undefined;
				if (prop !== "list") {
					const firstArg = args[0];
					if (typeof firstArg === "string") {
						key = firstArg;
					}
					// For delete(string[]) firstArg is an array → key stays undefined (no capture)
				}

				return traceBinding(
					{
						bindingType: "r2",
						bindingName: name,
						operation: prop,
						attributes: {
							"cloudflare.r2.bucket": name,
							"cloudflare.r2.operation": prop,
						},
						key,
					},
					// NOTE: we simply await the method promise and return the result object
					// as-is. We deliberately do NOT touch result.body — the stream remains
					// unread, so the caller receives a fully readable R2ObjectBody.
					() => bound(...args) as Promise<unknown>,
				);
			};
		},
	});
}
