import { type Context, context, propagation, type TextMapSetter } from "@opentelemetry/api";
import type { Carrier } from "./types";

const objectSetter: TextMapSetter<Record<string, string>> = {
	set(carrier, key, value) {
		carrier[key] = value;
	},
};
/**
 * Options for {@link injectContext}.
 */
export interface InjectContextOptions {
	/**
	 * The OpenTelemetry {@link Context} to inject from.
	 *
	 * When omitted, the current active context (`context.active()`) is used.
	 */
	context?: Context;
}

/**
 * Inject trace context into an arbitrary value using the globally registered
 * textmap propagator.
 *
 * - If `value` is a non-null object, propagation fields (`traceparent`,
 *   `tracestate`, etc.) are merged into a shallow copy and the augmented
 *   object is returned.
 * - For any other type the value is returned unchanged.
 *
 * @param value - The value to (potentially) augment with trace context.
 * @param opts  - Optional settings (e.g. explicit {@link Context}).
 * @returns The original value (non-objects) or a new object with propagation
 *          fields added.
 *
 * @example
 * ```ts
 * // Object — trace context is injected from the active context
 * const params = injectContext({ userId: "abc" });
 * // => { userId: "abc", traceparent: "00-…", tracestate: "…" }
 *
 * // Explicit context
 * const params = injectContext({ userId: "abc" }, { context: parentCtx });
 *
 * // Non-object — returned as-is
 * const str = injectContext("hello");
 * // => "hello"
 * ```
 */
export function injectContext<T = unknown>(value: T, opts?: InjectContextOptions): Carrier<T>;
export function injectContext(value: unknown, opts?: InjectContextOptions): unknown {
	if (value == null || typeof value !== "object") {
		return value;
	}
	const carrier: Record<string, string> = {};
	propagation.inject(opts?.context ?? context.active(), carrier, objectSetter);
	return { ...(value as Record<string, unknown>), ...carrier };
}
