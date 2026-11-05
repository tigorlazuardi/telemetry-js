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

import {
	context,
	createContextKey,
	type Span,
	SpanKind,
	SpanStatusCode,
	trace,
} from "@opentelemetry/api";

const QUERY_NAME_KEY = createContextKey("telemetry-js:query-name");

/** Options for {@link configureDb}. */
export interface DbOptions {
	/**
	 * Keep bound query parameters out of the span when a query fails (default `false`).
	 *
	 * Drivers such as Drizzle put the parameters in the error message
	 * (`"Failed query: <sql>\nparams: <values>"`). `withQueryName` copies that message into the
	 * span status and `recordException` copies message and stack trace into an exception event,
	 * so the values reach the trace backend. With this on, everything from the `params:` line
	 * onward is dropped from the status message, the exception message and the stack trace header.
	 * The SQL text, the error name and the stack frames stay.
	 *
	 * This only covers the span `withQueryName` creates. The error still carries the parameters:
	 * a parent span that records the same error (for example `withTrace`) will record them too.
	 */
	redactParams?: boolean;
}

let redactParams = false;

/**
 * Configure `withQueryName` process-wide. Call once at startup. Calling again replaces the
 * previous options, so an omitted field returns to its default.
 *
 * @example
 * ```ts
 * import { configureDb } from "@tigorhutasuhut/telemetry-js/db";
 *
 * configureDb({ redactParams: true });
 * ```
 */
export function configureDb(opts: DbOptions = {}): void {
	redactParams = opts.redactParams ?? false;
}

const PARAMS_MARKER = "\nparams:";

function redactMessage(message: string): string {
	const i = message.indexOf(PARAMS_MARKER);
	return i === -1 ? message : message.slice(0, i);
}

/** What goes on the span for a failed query, honouring {@link DbOptions.redactParams}. */
function failure(error: unknown): { message: string; exception: Error } {
	if (!(error instanceof Error)) return { message: String(error), exception: error as Error };
	if (!redactParams) return { message: error.message, exception: error };
	const message = redactMessage(error.message);
	if (message === error.message) return { message, exception: error };
	const safe = new Error(message);
	safe.name = error.name;
	if (error.stack) safe.stack = error.stack.split(error.message).join(message);
	return { message, exception: safe };
}

function markFailed(span: Span, error: unknown): void {
	const { message, exception } = failure(error);
	span.setStatus({ code: SpanStatusCode.ERROR, message });
	span.recordException(exception);
}

/**
 * Read the current query name from the active OTel context.
 *
 * Returns `undefined` when called outside a {@link withQueryName} scope.
 *
 * @example
 * ```ts
 * import { getQueryName } from "@tigorhutasuhut/telemetry-js/db";
 *
 * // Inside your db driver wrapper:
 * const name = getQueryName(); // "getUser" (set by withQueryName)
 * ```
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
 *
 * @example
 * ```ts
 * import { withQueryName } from "@tigorhutasuhut/telemetry-js/db";
 *
 * const user = await withQueryName("getUser", () => db.query("SELECT * FROM users WHERE id = ?", [id]));
 * ```
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
				markFailed(span, error);
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
						markFailed(span, error);
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
