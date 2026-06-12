import { traceBinding } from "./trace-binding.js";
import type { KVNamespace } from "./types.js";

/** KV methods that are wrapped with tracing. */
const WRAPPED_METHODS = new Set(["get", "getWithMetadata", "put", "delete", "list"]);

/**
 * Wrap a `KVNamespace` binding with OpenTelemetry tracing and metrics.
 *
 * Returns a transparent `Proxy<T>` so the wrapped value is assignment-compatible
 * with the original binding type. Every call to `get`, `getWithMetadata`, `put`,
 * `delete`, or `list` opens a child span (when inside a traced request) and records
 * a `cloudflare.binding.operation.duration` histogram data point.
 *
 * Key capture is opt-in (see `bindingCaptureKeys` in {@link SDKConfig}); by default
 * keys are omitted from span attributes to avoid PII leakage.
 *
 * @param kv - The original `KVNamespace` to instrument.
 * @param name - Human-readable name for this binding (e.g. `"SESSIONS"`).
 *   Used in span names (`KV SESSIONS get`) and metric labels.
 * @returns A `Proxy<T>` with identical type; non-wrapped properties pass through unchanged.
 *
 * @example
 * ```ts
 * import { instrumentKV } from "@tigorhutasuhut/telemetry-js/cloudflare";
 *
 * export default {
 *   async fetch(request, env, ctx) {
 *     const kv = instrumentKV(env.SESSIONS, "SESSIONS");
 *     const value = await kv.get("token");            // → span "KV SESSIONS get"
 *     return new Response(value);
 *   },
 * };
 * ```
 */
export function instrumentKV<T extends KVNamespace>(kv: T, name: string): T {
	return new Proxy(kv, {
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
				// Extract the key for get/getWithMetadata/put/delete (first string arg)
				// list has no single key
				const key =
					prop !== "list" && typeof args[0] === "string" ? (args[0] as string) : undefined;

				return traceBinding(
					{
						bindingType: "kv",
						bindingName: name,
						operation: prop,
						attributes: { "cloudflare.kv.operation": prop },
						key,
					},
					() => bound(...args) as Promise<unknown>,
				);
			};
		},
	});
}
