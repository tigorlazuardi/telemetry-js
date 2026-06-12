import type { Attributes, Context, Link, SpanKind } from "@opentelemetry/api";
import { SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import type { Sampler, SamplingResult } from "@opentelemetry/sdk-trace-base";
import {
	AlwaysOnSampler,
	ParentBasedSampler,
	SamplingDecision,
} from "@opentelemetry/sdk-trace-base";
import type { TailSampleFn } from "../shared/types.js";

/**
 * Sampler that returns RECORD_AND_SAMPLED with probability `ratio` (traceId-deterministic),
 * and RECORD otherwise. NEVER returns NOT_RECORD.
 *
 * Used as the root sampler in {@link createRecordAllHeadSampler}. The ratio controls the
 * W3C `traceparent` SAMPLED flag propagated to downstream services — it does NOT gate
 * local span recording.
 */
class RecordAllRatioSampler implements Sampler {
	private readonly _upperBound: number;
	private readonly _ratio: number;

	constructor(ratio: number) {
		this._ratio = ratio >= 1 ? 1 : ratio <= 0 ? 0 : ratio;
		this._upperBound = Math.floor(this._ratio * 0xffffffff);
	}

	shouldSample(
		_ctx: Context,
		traceId: string,
		_name: string,
		_kind: SpanKind,
		_attrs: Attributes,
		_links: Link[],
	): SamplingResult {
		// Short-circuit saturated case: ratio=1 must always return RECORD_AND_SAMPLED.
		// Without this, traceIds that accumulate to exactly 0xffffffff would fall through
		// to RECORD (off-by-one) since floor(1.0 * 0xffffffff) = 0xffffffff and
		// `0xffffffff < 0xffffffff` is false.
		if (this._ratio >= 1) return { decision: SamplingDecision.RECORD_AND_SAMPLED };
		return {
			decision:
				this._accumulate(traceId) < this._upperBound
					? SamplingDecision.RECORD_AND_SAMPLED
					: SamplingDecision.RECORD,
		};
	}

	toString(): string {
		return `RecordAllRatio{${this._ratio}}`;
	}

	private _accumulate(traceId: string): number {
		let acc = 0;
		for (let i = 0; i < traceId.length / 8; i++) {
			const pos = i * 8;
			const part = parseInt(traceId.slice(pos, pos + 8), 16);
			acc = (acc ^ part) >>> 0;
		}
		return acc;
	}
}

/**
 * Sampler that always returns RECORD (never NOT_RECORD, never RECORD_AND_SAMPLED).
 *
 * Used for "parent not sampled" slots in ParentBasedSampler to ensure all child spans
 * are always recorded even when the parent propagated a not-sampled decision.
 */
class RecordOnlySampler implements Sampler {
	shouldSample(): SamplingResult {
		return { decision: SamplingDecision.RECORD };
	}

	toString(): string {
		return "RecordOnly";
	}
}

/**
 * Creates a head sampler that records ALL spans while propagating the SAMPLED flag
 * to downstream services at the given ratio.
 *
 * Behaviour matrix:
 * - Root span: RECORD_AND_SAMPLED with probability `propagationRatio`, else RECORD.
 * - Remote parent sampled: RECORD_AND_SAMPLED (follow upstream decision).
 * - Remote parent not sampled: RECORD (override — tail sampler needs the spans).
 * - Local parent sampled: RECORD_AND_SAMPLED (follow local parent).
 * - Local parent not sampled: RECORD (override — tail sampler needs the spans).
 *
 * The SAMPLED flag controls the W3C `traceparent` header sent to downstream services
 * and influences `keepOnHeadSampled` in the default tail policy. It does NOT gate
 * local span recording — that is governed by the tail decision at trace end.
 *
 * @param propagationRatio - Fraction of new traces (0–1) to mark SAMPLED in the
 *   propagated traceparent. Default `1.0` (mark all as sampled).
 */
export function createRecordAllHeadSampler(propagationRatio = 1.0): Sampler {
	const recordOnly = new RecordOnlySampler();
	return new ParentBasedSampler({
		root: new RecordAllRatioSampler(propagationRatio),
		remoteParentSampled: new AlwaysOnSampler(),
		remoteParentNotSampled: recordOnly,
		localParentSampled: new AlwaysOnSampler(),
		localParentNotSampled: recordOnly,
	});
}

/**
 * Built-in tail sampler: keep traces whose root span ended with status ERROR.
 */
export const keepOnError: TailSampleFn = (trace) =>
	trace.rootSpan.status.code === SpanStatusCode.ERROR;

/**
 * Built-in tail sampler: keep traces whose root span has the SAMPLED trace flag set.
 *
 * Use this to honour the head-sampling decision at the tail — a trace that was
 * propagated as sampled will be exported regardless of local tail policy.
 */
export const keepOnHeadSampled: TailSampleFn = (trace) =>
	(trace.rootSpan.spanContext().traceFlags & TraceFlags.SAMPLED) !== 0;

/**
 * Built-in tail sampler: keep all traces unconditionally.
 */
export const keepAll: TailSampleFn = () => true;

/**
 * Returns a tail sampler that keeps traces whose root span duration exceeds
 * `thresholdMs` milliseconds.
 *
 * @param thresholdMs - Minimum duration in milliseconds to trigger export.
 */
export function keepOnSlow(thresholdMs: number): TailSampleFn {
	return (trace) => {
		const [startSec, startNano] = trace.rootSpan.startTime;
		const [endSec, endNano] = trace.rootSpan.endTime;
		const durationMs = (endSec - startSec) * 1000 + (endNano - startNano) / 1_000_000;
		return durationMs > thresholdMs;
	};
}

/**
 * Combines multiple tail samplers with OR logic: the trace is kept when **any**
 * of the provided samplers returns `true`.
 *
 * @param fns - Array of tail sampler functions.
 */
export function multiTailSampler(fns: TailSampleFn[]): TailSampleFn {
	return (trace) => fns.some((fn) => fn(trace));
}
