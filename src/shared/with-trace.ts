import {
	context,
	propagation,
	ROOT_CONTEXT,
	type Span,
	SpanKind,
	SpanStatusCode,
	type TextMapGetter,
	trace,
} from "@opentelemetry/api";

/**
 * Options for {@link withTrace}.
 */
export interface WithTraceOptions {
	/** Override auto-detected span name. */
	name?: string;
	/** Span kind (default: {@link SpanKind.INTERNAL}). */
	kind?: SpanKind;
	/** Initial span attributes. */
	attributes?: Record<string, string>;
	/**
	 * Component name that prefixes the span name and is set as `ui.component`.
	 *
	 * When provided, the span name becomes `"Component.name"` (or
	 * `"Component.autoDetectedName"` when `name` is omitted).
	 */
	component?: string;
	/**
	 * Parent context — either an existing {@link Span} or a W3C `traceparent`
	 * string (e.g. `"00-<traceId>-<spanId>-01"`).
	 *
	 * When omitted the current active context is inherited.
	 */
	parent?: Span | string;
	/**
	 * An opaque carrier object (e.g. incoming headers, workflow params) from
	 * which trace context is extracted using the globally registered textmap
	 * propagator.
	 *
	 * If both `parent` and `carrier` are provided, `parent` takes precedence.
	 * The carrier is only used when `parent` is not set.
	 *
	 * The value must be a non-null object whose string-valued properties are
	 * read by the propagator (e.g. `{ traceparent: "00-…", tracestate: "…" }`).
	 * Non-object values are silently ignored.
	 */
	carrier?: unknown;
}

/**
 * Derive a human-readable span name for the given function.
 *
 * Resolution order:
 * 1. `fn.name` (works for named functions / methods)
 * 2. Parse `new Error().stack` for caller file:line
 * 3. Fallback `"anonymous"`
 */
function deriveSpanName(fn: (...args: never[]) => unknown): string {
	if (fn.name) return fn.name;

	const stack = new Error().stack;
	if (stack) {
		const lines = stack.split("\n");
		// Skip Error line, deriveSpanName frame, withTrace frame → caller is at index 3
		const callerLine = lines[3]?.trim();
		if (callerLine) {
			// Match "at <file>:<line>:<col>" or "at <name> (<file>:<line>:<col>)"
			const fileMatch =
				callerLine.match(/\((.+):(\d+):\d+\)/) ?? callerLine.match(/at (.+):(\d+):\d+/);
			if (fileMatch) {
				const filePath = fileMatch[1];
				const line = fileMatch[2];
				const fileName = filePath.split("/").pop() ?? filePath;
				return `${fileName}:${line}`;
			}
		}
	}

	return "anonymous";
}

/**
 * Derive a tracer name from the call-site file or fall back to the package name.
 */
function deriveTracerName(): string {
	const stack = new Error().stack;
	if (stack) {
		const lines = stack.split("\n");
		const callerLine = lines[3]?.trim();
		if (callerLine) {
			const fileMatch = callerLine.match(/\((.+):\d+:\d+\)/) ?? callerLine.match(/at (.+):\d+:\d+/);
			if (fileMatch) {
				const filePath = fileMatch[1];
				return filePath.split("/").pop() ?? "@tigorhutasuhut/telemetry-js";
			}
		}
	}
	return "@tigorhutasuhut/telemetry-js";
}

const objectGetter: TextMapGetter<Record<string, unknown>> = {
	keys(carrier) {
		return Object.keys(carrier);
	},
	get(carrier, key) {
		const value = carrier[key];
		return typeof value === "string" ? value : undefined;
	},
};

/**
 * Build the parent context from the `parent` and `carrier` options.
 *
 * Resolution order:
 * 1. `parent` (Span or traceparent string) — highest priority
 * 2. `carrier` (object extracted via textmap propagator)
 * 3. `context.active()` — fallback
 */
function resolveParentContext(parent?: Span | string, carrier?: unknown) {
	if (parent) {
		if (typeof parent === "string") {
			return propagation.extract(ROOT_CONTEXT, { traceparent: parent });
		}
		// parent is a Span
		return trace.setSpan(context.active(), parent);
	}

	if (carrier != null && typeof carrier === "object") {
		return propagation.extract(ROOT_CONTEXT, carrier as Record<string, unknown>, objectGetter);
	}

	return context.active();
}

/**
 * Execute `fn` inside a new OpenTelemetry span, returning whatever `fn` returns.
 *
 * The span is automatically named from the function (or caller location) unless
 * overridden via `opts.name`. Errors are recorded on the span and re-thrown.
 *
 * **Cloudflare Workers caveat:** `performance.now()` only advances after I/O
 * in Workers (Spectre mitigation). Spans wrapping **pure CPU work** (no `fetch`,
 * KV, R2, D1, etc.) will report a duration of **0 ms**. Use `withTrace` for
 * operations that involve at least one I/O call.
 *
 * @param fn - The function to trace. Receives the active {@link Span} as its argument.
 * @param opts - Optional tracing configuration.
 * @returns The return value of `fn` (or a `Promise` thereof).
 *
 * @example
 * ```ts
 * import { withTrace } from "@tigorhutasuhut/telemetry-js";
 *
 * // Named function — span name is "fetchUser"
 * const user = await withTrace(async function fetchUser(span) {
 *   span.setAttribute("user.id", id);
 *   return db.users.find(id);
 * });
 *
 * // Explicit name + attributes
 * const result = withTrace(
 *   (span) => compute(span),
 *   { name: "heavy-computation", attributes: { "input.size": "42" } },
 * );
 * ```
 */
export function withTrace<T>(fn: (span: Span) => T, opts?: WithTraceOptions): T {
	const baseName = opts?.name ?? deriveSpanName(fn);
	const spanName = opts?.component ? `${opts.component}.${baseName}` : baseName;
	const tracerName = deriveTracerName();
	const tracer = trace.getTracer(tracerName);
	const parentCtx = resolveParentContext(opts?.parent, opts?.carrier);

	const attributes: Record<string, string> = { ...opts?.attributes };
	if (opts?.component) attributes["ui.component"] = opts.component;

	return tracer.startActiveSpan(
		spanName,
		{
			kind: opts?.kind ?? SpanKind.INTERNAL,
			...(Object.keys(attributes).length > 0 ? { attributes } : {}),
		},
		parentCtx,
		(span: Span) => {
			let result: T;
			try {
				result = fn(span);
			} catch (error) {
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: error instanceof Error ? error.message : String(error),
				});
				span.recordException(error as Error);
				span.end();
				throw error;
			}

			if (result instanceof Promise) {
				return result.then(
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
