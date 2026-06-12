import { type Histogram, metrics, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { getBindingConfig } from "./config.js";

/**
 * Options for {@link traceBinding}.
 */
export interface TraceBindingOpts {
	/** Binding type identifier, e.g. `"kv"`. Used in span/metric attrs. */
	bindingType: string;
	/** User-supplied binding name, e.g. `"SESSIONS"`. */
	bindingName: string;
	/** Operation name, e.g. `"get"` | `"put"`. */
	operation: string;
	/**
	 * OTel span kind.
	 * @default SpanKind.CLIENT
	 */
	spanKind?: SpanKind;
	/**
	 * Extra attributes added to the span (NOT to metric labels).
	 * Use for operation-specific semantic attrs like `"cloudflare.kv.operation"`.
	 */
	attributes?: Record<string, string | number | boolean>;
	/**
	 * The binding key for the operation (e.g. KV key, R2 object key).
	 * Added as `<type>.key` span attr ONLY when `bindingCaptureKeys === true`.
	 * Never added to metric labels.
	 */
	key?: string;
}

// ── Lazily-created histogram (module-level singleton) ─────────────────────────

let _bindingDuration: Histogram | null = null;

function getBindingHistogram(): Histogram {
	if (!_bindingDuration) {
		const config = getBindingConfig();
		_bindingDuration = metrics
			.getMeter("cloudflare.bindings")
			.createHistogram("cloudflare.binding.operation.duration", {
				description: "Duration of Cloudflare binding operations in milliseconds",
				unit: "ms",
				advice: {
					explicitBucketBoundaries: config.boundaries,
				},
			});
	}
	return _bindingDuration;
}

/**
 * Reset the cached histogram (for testing — allows re-creation with new boundaries).
 * @internal
 */
export function _resetBindingHistogram(): void {
	_bindingDuration = null;
}

// ── Core helper ───────────────────────────────────────────────────────────────

/**
 * Trace a Cloudflare binding operation with a child span and a duration histogram.
 *
 * - Span name: `<TYPE> <name> <op>` (e.g. `KV SESSIONS get`).
 * - Histogram: `cloudflare.binding.operation.duration` (ms) with bounded metric attrs only.
 * - Key capture: `<type>.key` span attr added only when `bindingCaptureKeys` is `true`.
 * - Orphan guard: if no active recording span exists, honours `orphanBindingSpans`:
 *   - `"skip"` (default) → record metric only, no span.
 *   - `"root"` → emit a root span anyway.
 *
 * @param opts - Binding operation metadata.
 * @param fn - The async operation to time and trace.
 * @returns The result of `fn`.
 *
 * @example
 * ```ts
 * return traceBinding(
 *   { bindingType: "kv", bindingName: "SESSIONS", operation: "get", key: cacheKey },
 *   () => kv.get(cacheKey),
 * );
 * ```
 */
export async function traceBinding<T>(opts: TraceBindingOpts, fn: () => Promise<T>): Promise<T> {
	const { bindingType, bindingName, operation, spanKind = SpanKind.CLIENT, attributes, key } = opts;

	const config = getBindingConfig();
	const spanName = `${bindingType.toUpperCase()} ${bindingName} ${operation}`;

	// Bounded metric attributes only — never include keys
	const metricAttrs: Record<string, string> = {
		"cloudflare.binding.type": bindingType,
		"cloudflare.binding.name": bindingName,
		operation,
	};

	// Span attributes (may include key when opted in)
	const spanAttrs: Record<string, string | number | boolean> = {
		"cloudflare.binding.type": bindingType,
		"cloudflare.binding.name": bindingName,
		...attributes,
	};
	if (key !== undefined && config.captureKeys) {
		spanAttrs[`cloudflare.${bindingType}.key`] = key;
	}

	const histogram = getBindingHistogram();

	// Orphan guard: check for an active recording span
	const activeSpan = trace.getActiveSpan();
	const hasActiveSpan = activeSpan?.isRecording();

	if (!hasActiveSpan && config.orphan === "skip") {
		// Metric only — no span
		const t0 = Date.now();
		try {
			const result = await fn();
			histogram.record(Date.now() - t0, { ...metricAttrs, status: "ok" });
			return result;
		} catch (err) {
			histogram.record(Date.now() - t0, { ...metricAttrs, status: "error" });
			throw err;
		}
	}

	// Either we have an active span OR orphan === "root" — open a child/root span
	const tracer = trace.getTracer("cloudflare.bindings");
	const t0 = Date.now();

	return tracer.startActiveSpan(
		spanName,
		{ kind: spanKind, attributes: spanAttrs },
		async (span) => {
			try {
				const result = await fn();
				histogram.record(Date.now() - t0, { ...metricAttrs, status: "ok" });
				return result;
			} catch (err) {
				span.recordException(err as Error);
				span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
				histogram.record(Date.now() - t0, { ...metricAttrs, status: "error" });
				throw err;
			} finally {
				span.end();
			}
		},
	);
}
