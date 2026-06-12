import { SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import type { TailSampleFn } from "../shared/types.js";

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
