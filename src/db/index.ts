/**
 * Lightweight database query naming via OpenTelemetry context propagation.
 *
 * ```ts
 * import { withQueryName, getQueryName } from "@tigorhutasuhut/telemetry-js/db";
 *
 * const user = await withQueryName("getUser", () => db.query("SELECT …"));
 *
 * // Inside your db driver wrapper:
 * const name = getQueryName(); // "getUser"
 * ```
 *
 * `withQueryName` stores the query name in the active OTel context and
 * creates a {@link SpanKind.CLIENT CLIENT} span around the callback.
 * Works in every runtime (Node, Cloudflare Workers, Browser) as long as
 * a context manager has been registered via `initSDK`.
 */

import { context, createContextKey, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

const QUERY_NAME_KEY = createContextKey("telemetry-js:query-name");

/**
 * Read the current query name from the active OTel context.
 *
 * Returns `undefined` when called outside a {@link withQueryName} scope.
 */
export function getQueryName(): string | undefined {
	return context.active().getValue(QUERY_NAME_KEY) as string | undefined;
}

/**
 * Execute `fn` inside a new {@link SpanKind.CLIENT CLIENT} span, storing
 * `name` in the OTel context so downstream code can retrieve it via
 * {@link getQueryName}.
 *
 * @param name  - Logical query name (e.g. `"getUser"`, `"listOrders"`).
 * @param fn    - The function to execute within the named context.
 * @returns Whatever `fn` returns (or a `Promise` thereof).
 */
export function withQueryName<T>(name: string, fn: () => T): T {
	const tracer = trace.getTracer("@tigorhutasuhut/telemetry-js/db");
	const parentCtx = context.active().setValue(QUERY_NAME_KEY, name);

	return tracer.startActiveSpan(
		`db.${name}`,
		{ kind: SpanKind.CLIENT, attributes: { "db.query.name": name } },
		parentCtx,
		(span) => {
			let result: T;
			try {
				result = fn();
			} catch (error) {
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: error instanceof Error ? error.message : String(error),
				});
				span.recordException(error as Error);
				span.end();
				throw error;
			}

			if (
				result != null &&
				typeof (result as unknown as PromiseLike<unknown>).then === "function"
			) {
				return (result as unknown as PromiseLike<unknown>).then(
					(value) => {
						span.end();
						return value;
					},
					(error: unknown) => {
						span.setStatus({
							code: SpanStatusCode.ERROR,
							message: error instanceof Error ? error.message : String(error),
						});
						span.recordException(error as Error);
						span.end();
						throw error;
					},
				) as T;
			}

			span.end();
			return result;
		},
	);
}
