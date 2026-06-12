import type { Context } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import type {
	ReadableSpan,
	Span,
	SpanExporter,
	SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { LocalTrace, TailSampleFn } from "../shared/types.js";
import { keepOnError, keepOnHeadSampled, multiTailSampler } from "./sampling.js";

const DEFAULT_MAX_BUFFERED_SPANS = 2048;
const DEFAULT_TAIL_SAMPLER: TailSampleFn = multiTailSampler([keepOnHeadSampled, keepOnError]);

interface TraceBuffer {
	spans: ReadableSpan[];
	inProgress: Set<string>; // spanIds still running
	rootSpan: ReadableSpan | undefined;
	arrivalOrder: number; // FIFO for eviction
}

/**
 * Buffers spans by traceId and defers the export decision to trace end.
 *
 * Tail-sampling semantics:
 * - All spans are recorded (head sampler must never return NOT_RECORD).
 * - Once a trace is complete (all in-flight spans ended), the `tailSampler`
 *   decides whether to export the full trace or drop it.
 * - On overflow (`maxBufferedSpans` exceeded), the oldest incomplete trace is
 *   force-decided and flushed early.
 * - `forceFlush(traceId)` from `ctx.waitUntil` allows the adapter to
 *   flush a specific trace after the response has been sent.
 */
export class TailSampleSpanProcessor implements SpanProcessor {
	private readonly _exporter: SpanExporter;
	private readonly _tailSampler: TailSampleFn;
	private readonly _maxBufferedSpans: number;
	private readonly _traces = new Map<string, TraceBuffer>();
	private _totalBuffered = 0;
	private _arrivalCounter = 0;

	constructor(
		exporter: SpanExporter,
		options?: {
			tailSampler?: TailSampleFn;
			maxBufferedSpans?: number;
		},
	) {
		this._exporter = exporter;
		this._tailSampler = options?.tailSampler ?? DEFAULT_TAIL_SAMPLER;
		this._maxBufferedSpans = options?.maxBufferedSpans ?? DEFAULT_MAX_BUFFERED_SPANS;
	}

	onStart(span: Span, _parentContext: Context): void {
		const { traceId, spanId } = span.spanContext();
		let buffer = this._traces.get(traceId);
		if (!buffer) {
			buffer = {
				spans: [],
				inProgress: new Set(),
				rootSpan: undefined,
				arrivalOrder: this._arrivalCounter++,
			};
			this._traces.set(traceId, buffer);
		}
		buffer.inProgress.add(spanId);
	}

	onEnd(span: ReadableSpan): void {
		const { traceId, spanId } = span.spanContext();
		const buffer = this._traces.get(traceId);
		if (!buffer) return;

		buffer.inProgress.delete(spanId);
		buffer.spans.push(span);
		this._totalBuffered++;

		if (!span.parentSpanContext) {
			buffer.rootSpan = span;
		}

		// Overflow: evict oldest trace (skip current if others exist)
		if (this._totalBuffered > this._maxBufferedSpans) {
			this._evictOldest(traceId);
		}

		// All spans complete → tail decision (check trace still exists after eviction)
		const current = this._traces.get(traceId);
		if (current && current.inProgress.size === 0) {
			this._decide(traceId, current);
		}
	}

	/**
	 * Force a tail decision for a specific trace, or for all buffered traces.
	 *
	 * Called from `ctx.waitUntil` after response to flush the current request's trace.
	 *
	 * @param traceId - When provided, only that trace is flushed; otherwise all are.
	 */
	forceFlush(traceId?: string): Promise<void> {
		if (traceId !== undefined) {
			const buffer = this._traces.get(traceId);
			if (buffer) this._decide(traceId, buffer);
		} else {
			for (const [id, buffer] of [...this._traces.entries()]) {
				this._decide(id, buffer);
			}
		}
		return this._exporter.forceFlush?.() ?? Promise.resolve();
	}

	shutdown(): Promise<void> {
		return this.forceFlush();
	}

	private _decide(traceId: string, buffer: TraceBuffer): void {
		this._traces.delete(traceId);
		this._totalBuffered -= buffer.spans.length;

		if (buffer.spans.length === 0) return;

		// Root span fallback: if no span had !parentSpanContext, use first ended span
		const rootSpan = buffer.rootSpan ?? buffer.spans[0];

		const trace: LocalTrace = {
			traceId,
			spans: buffer.spans,
			rootSpan,
		};

		if (this._tailSampler(trace)) {
			// Sort root first so OTLP collectors that assume parent-before-child order work correctly.
			const sorted = buffer.rootSpan
				? [buffer.rootSpan, ...buffer.spans.filter((s) => s !== buffer.rootSpan)]
				: buffer.spans;
			this._exporter.export(sorted, (result) => {
				if (result.code !== ExportResultCode.SUCCESS) {
					console.warn(
						`[TailSampleSpanProcessor] export failed for trace ${traceId}:`,
						result.error,
					);
				}
			});
		}
	}

	private _evictOldest(skipTraceId: string): void {
		let oldest: { traceId: string; buffer: TraceBuffer } | undefined;
		for (const [id, buf] of this._traces) {
			if (id === skipTraceId) continue;
			if (!oldest || buf.arrivalOrder < oldest.buffer.arrivalOrder) {
				oldest = { traceId: id, buffer: buf };
			}
		}
		if (oldest) {
			console.warn(
				`[TailSampleSpanProcessor] maxBufferedSpans exceeded; force-flushing trace ${oldest.traceId}`,
			);
			this._decide(oldest.traceId, oldest.buffer);
		} else {
			// Only the current trace — evict it too
			const buf = this._traces.get(skipTraceId);
			if (buf) {
				console.warn(
					`[TailSampleSpanProcessor] maxBufferedSpans exceeded; force-flushing current trace ${skipTraceId}`,
				);
				this._decide(skipTraceId, buf);
			}
		}
	}
}
