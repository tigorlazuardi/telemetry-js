import { traceBinding } from "./trace-binding.js";
import type { DurableObjectStorage } from "./types.js";

/** DO storage methods that are wrapped with tracing. */
const WRAPPED_METHODS = new Set(["get", "put", "delete", "list", "deleteAll"]);

/**
 * Wrap a `DurableObjectStorage` instance with OpenTelemetry tracing and metrics.
 *
 * Returns a transparent `Proxy<T>` so the wrapped value is assignment-compatible
 * with the original storage type. Every call to `get`, `put`, `delete`, `list`,
 * or `deleteAll` opens a child span (when inside a traced request) and records
 * a `cloudflare.binding.operation.duration` histogram data point.
 *
 * Non-instrumented methods (alarms, transactions, sync methods, etc.) pass
 * through unchanged.
 *
 * Key capture is opt-in (see `bindingCaptureKeys` in {@link SDKConfig}); by default
 * keys are omitted from span attributes to avoid PII leakage. Only single-string-key
 * calls (e.g. `get("count")`, `put("count", 1)`, `delete("count")`) capture the
 * key — array/Record forms and `list`/`deleteAll` never capture a key.
 *
 * @param storage - The `DurableObjectState.storage` to instrument.
 * @param name - Human-readable name for this Durable Object (e.g. `"Counter"`).
 *   Used in span names (`DO Counter get`) and metric labels.
 * @returns A `Proxy<T>` with identical type; non-wrapped properties pass through unchanged.
 *
 * @example
 * ```ts
 * import { instrumentDOStorage } from "@tigorhutasuhut/telemetry-js/cloudflare";
 *
 * export class Counter implements DurableObject {
 *   private storage: DurableObjectStorage;
 *   constructor(state: DurableObjectState, env: Env) {
 *     this.storage = instrumentDOStorage(state.storage, "Counter");
 *   }
 *   async fetch(req: Request) {
 *     const count = (await this.storage.get<number>("count")) ?? 0;   // span "DO Counter get"
 *     await this.storage.put("count", count + 1);
 *     return new Response(String(count));
 *   }
 * }
 * ```
 */
export function instrumentDOStorage<T extends DurableObjectStorage>(storage: T, name: string): T {
	return new Proxy(storage, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);

			if (typeof prop !== "string" || !WRAPPED_METHODS.has(prop)) {
				return typeof value === "function" ? value.bind(target) : value;
			}

			if (typeof value !== "function") {
				return value;
			}

			// Bind method to original target so `this` is correct inside CF runtime
			const bound = (value as (...a: unknown[]) => unknown).bind(target);

			return (...args: unknown[]) => {
				// Extract single-string key for get/put/delete only.
				// Array/Record forms and list/deleteAll → no key.
				const key =
					prop !== "list" && prop !== "deleteAll" && typeof args[0] === "string"
						? (args[0] as string)
						: undefined;

				return traceBinding(
					{
						bindingType: "do",
						bindingName: name,
						operation: prop,
						attributes: { "cloudflare.do.storage.operation": prop },
						key,
					},
					() => bound(...args) as Promise<unknown>,
				);
			};
		},
	});
}
