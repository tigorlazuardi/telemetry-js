import type { Context } from "@opentelemetry/api";
import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, Span as SdkSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";
import { keepAll, keepOnError } from "../src/cloudflare/sampling.js";
import { TailSampleSpanProcessor } from "../src/cloudflare/tail-processor.js";

function makeSpan(opts: {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	statusCode?: number;
	traceFlags?: number;
}): ReadableSpan {
	return {
		name: opts.spanId,
		kind: SpanKind.INTERNAL,
		spanContext: () => ({
			traceId: opts.traceId,
			spanId: opts.spanId,
			traceFlags: opts.traceFlags ?? TraceFlags.NONE,
			isRemote: false,
		}),
		parentSpanContext: opts.parentSpanId
			? { traceId: opts.traceId, spanId: opts.parentSpanId, traceFlags: 0, isRemote: false }
			: undefined,
		startTime: [0, 0],
		endTime: [0, 1_000_000],
		status: { code: opts.statusCode ?? SpanStatusCode.UNSET },
		attributes: {},
		links: [],
		events: [],
		duration: [0, 1_000_000],
		ended: true,
		resource: {} as any,
		instrumentationScope: { name: "test", version: "0" },
		droppedAttributesCount: 0,
		droppedEventsCount: 0,
		droppedLinksCount: 0,
	} as ReadableSpan;
}

function asStartSpan(span: ReadableSpan): SdkSpan {
	return span as unknown as SdkSpan;
}

function makeExporter() {
	const exported: ReadableSpan[][] = [];
	return {
		export: vi.fn((spans: ReadableSpan[], cb: (r: { code: number }) => void) => {
			exported.push([...spans]);
			cb({ code: ExportResultCode.SUCCESS });
		}),
		shutdown: vi.fn().mockResolvedValue(undefined),
		forceFlush: vi.fn().mockResolvedValue(undefined),
		exported,
	};
}

const ctx = {} as Context;

describe("TailSampleSpanProcessor", () => {
	it("keeps trace when tailSampler returns true", () => {
		const exporter = makeExporter();
		const processor = new TailSampleSpanProcessor(exporter, { tailSampler: keepAll });

		const span = makeSpan({ traceId: "t1", spanId: "s1" });
		processor.onStart(asStartSpan(span), ctx);
		processor.onEnd(span);

		expect(exporter.export).toHaveBeenCalledOnce();
		expect(exporter.exported[0]).toHaveLength(1);
	});

	it("drops trace when tailSampler returns false", () => {
		const exporter = makeExporter();
		const processor = new TailSampleSpanProcessor(exporter, { tailSampler: () => false });

		const span = makeSpan({ traceId: "t1", spanId: "s1" });
		processor.onStart(asStartSpan(span), ctx);
		processor.onEnd(span);

		expect(exporter.export).not.toHaveBeenCalled();
	});

	it("buffers multiple spans, exports all when last ends", () => {
		const exporter = makeExporter();
		const processor = new TailSampleSpanProcessor(exporter, { tailSampler: keepAll });

		const root = makeSpan({ traceId: "t1", spanId: "root" });
		const child1 = makeSpan({ traceId: "t1", spanId: "c1", parentSpanId: "root" });
		const child2 = makeSpan({ traceId: "t1", spanId: "c2", parentSpanId: "root" });

		processor.onStart(asStartSpan(root), ctx);
		processor.onStart(asStartSpan(child1), ctx);
		processor.onStart(asStartSpan(child2), ctx);

		processor.onEnd(child1);
		expect(exporter.export).not.toHaveBeenCalled();

		processor.onEnd(child2);
		expect(exporter.export).not.toHaveBeenCalled();

		processor.onEnd(root);
		expect(exporter.export).toHaveBeenCalledOnce();
		expect(exporter.exported[0]).toHaveLength(3);
	});

	it("does not export before all in-progress spans end", () => {
		const exporter = makeExporter();
		const processor = new TailSampleSpanProcessor(exporter, { tailSampler: keepAll });

		const root = makeSpan({ traceId: "t1", spanId: "root" });
		const child = makeSpan({ traceId: "t1", spanId: "c1", parentSpanId: "root" });

		processor.onStart(asStartSpan(root), ctx);
		processor.onStart(asStartSpan(child), ctx);

		processor.onEnd(root);
		expect(exporter.export).not.toHaveBeenCalled();
	});

	it("identifies root span correctly (no parentSpanContext)", () => {
		const exporter = makeExporter();
		// keepOnError only keeps traces where root span has ERROR status
		const processor = new TailSampleSpanProcessor(exporter, { tailSampler: keepOnError });

		// Root with ERROR, child without
		const root = makeSpan({ traceId: "t1", spanId: "root", statusCode: SpanStatusCode.ERROR });
		const child = makeSpan({
			traceId: "t1",
			spanId: "c1",
			parentSpanId: "root",
			statusCode: SpanStatusCode.OK,
		});

		processor.onStart(asStartSpan(root), ctx);
		processor.onStart(asStartSpan(child), ctx);
		processor.onEnd(child);
		processor.onEnd(root);

		expect(exporter.export).toHaveBeenCalledOnce();

		// Now with root OK, child ERROR — should NOT export
		const exporter2 = makeExporter();
		const processor2 = new TailSampleSpanProcessor(exporter2, { tailSampler: keepOnError });

		const root2 = makeSpan({ traceId: "t2", spanId: "root2", statusCode: SpanStatusCode.OK });
		const child2 = makeSpan({
			traceId: "t2",
			spanId: "c2",
			parentSpanId: "root2",
			statusCode: SpanStatusCode.ERROR,
		});

		processor2.onStart(asStartSpan(root2), ctx);
		processor2.onStart(asStartSpan(child2), ctx);
		processor2.onEnd(child2);
		processor2.onEnd(root2);

		expect(exporter2.export).not.toHaveBeenCalled();
	});

	it("default sampler: SAMPLED flag → export; ERROR → export; neither → drop", () => {
		// SAMPLED → keep
		{
			const exporter = makeExporter();
			const processor = new TailSampleSpanProcessor(exporter);
			const span = makeSpan({ traceId: "t1", spanId: "s1", traceFlags: TraceFlags.SAMPLED });
			processor.onStart(asStartSpan(span), ctx);
			processor.onEnd(span);
			expect(exporter.export).toHaveBeenCalledOnce();
		}

		// ERROR → keep
		{
			const exporter = makeExporter();
			const processor = new TailSampleSpanProcessor(exporter);
			const span = makeSpan({ traceId: "t2", spanId: "s2", statusCode: SpanStatusCode.ERROR });
			processor.onStart(asStartSpan(span), ctx);
			processor.onEnd(span);
			expect(exporter.export).toHaveBeenCalledOnce();
		}

		// Neither → drop
		{
			const exporter = makeExporter();
			const processor = new TailSampleSpanProcessor(exporter);
			const span = makeSpan({
				traceId: "t3",
				spanId: "s3",
				traceFlags: TraceFlags.NONE,
				statusCode: SpanStatusCode.OK,
			});
			processor.onStart(asStartSpan(span), ctx);
			processor.onEnd(span);
			expect(exporter.export).not.toHaveBeenCalled();
		}
	});

	it("forceFlush(traceId) flushes specific in-flight trace", async () => {
		const exporter = makeExporter();
		const processor = new TailSampleSpanProcessor(exporter, { tailSampler: keepAll });

		const root = makeSpan({ traceId: "t1", spanId: "root" });
		const child = makeSpan({ traceId: "t1", spanId: "c1", parentSpanId: "root" });

		// Start both, end only child — trace incomplete
		processor.onStart(asStartSpan(root), ctx);
		processor.onStart(asStartSpan(child), ctx);
		processor.onEnd(child);

		expect(exporter.export).not.toHaveBeenCalled();

		await processor.forceFlush("t1");
		expect(exporter.export).toHaveBeenCalledOnce();
	});

	it("forceFlush() with no arg flushes all traces", async () => {
		const exporter = makeExporter();
		const processor = new TailSampleSpanProcessor(exporter, { tailSampler: keepAll });

		// Two traces, each with a root + child; end root but keep child in-progress
		const r1 = makeSpan({ traceId: "t1", spanId: "r1" });
		const c1 = makeSpan({ traceId: "t1", spanId: "c1", parentSpanId: "r1" });
		const r2 = makeSpan({ traceId: "t2", spanId: "r2" });
		const c2 = makeSpan({ traceId: "t2", spanId: "c2", parentSpanId: "r2" });

		processor.onStart(asStartSpan(r1), ctx);
		processor.onStart(asStartSpan(c1), ctx);
		processor.onStart(asStartSpan(r2), ctx);
		processor.onStart(asStartSpan(c2), ctx);

		// End root spans (add data to buffers) but keep children in-progress
		processor.onEnd(r1);
		processor.onEnd(r2);
		expect(exporter.export).not.toHaveBeenCalled();

		await processor.forceFlush();
		expect(exporter.export).toHaveBeenCalledTimes(2);
	});

	it("shutdown calls forceFlush", async () => {
		const exporter = makeExporter();
		const processor = new TailSampleSpanProcessor(exporter, { tailSampler: keepAll });

		// Root + child; end root only so trace is buffered but incomplete
		const root = makeSpan({ traceId: "t1", spanId: "root" });
		const child = makeSpan({ traceId: "t1", spanId: "child", parentSpanId: "root" });
		processor.onStart(asStartSpan(root), ctx);
		processor.onStart(asStartSpan(child), ctx);
		processor.onEnd(root);
		expect(exporter.export).not.toHaveBeenCalled();

		await processor.shutdown();
		expect(exporter.export).toHaveBeenCalledOnce();
	});

	it("maxBufferedSpans overflow evicts oldest trace", () => {
		const exporter = makeExporter();
		// maxBufferedSpans=2: after 3rd span added, oldest trace is evicted
		const processor = new TailSampleSpanProcessor(exporter, {
			tailSampler: keepAll,
			maxBufferedSpans: 2,
		});

		// Trace A: start + end one span (arrivalOrder=0, 1 buffered span)
		const sA = makeSpan({ traceId: "tA", spanId: "sA" });
		processor.onStart(asStartSpan(sA), ctx);
		processor.onEnd(sA);
		// tA is complete → decided immediately, exported, removed from buffer
		// totalBuffered=0 after decide

		// Trace B: start span (arrivalOrder=1)
		const sB1 = makeSpan({ traceId: "tB", spanId: "sB1" });
		processor.onStart(asStartSpan(sB1), ctx);
		processor.onEnd(sB1);
		// tB complete → decided, exported
		// Reset for a real overflow test

		// Use fresh processor
		const exporter2 = makeExporter();
		const proc2 = new TailSampleSpanProcessor(exporter2, {
			tailSampler: keepAll,
			maxBufferedSpans: 2,
		});

		// Trace A: start 2 spans but don't end them (in-progress, buffered=0 so far)
		const a1 = makeSpan({ traceId: "tA", spanId: "a1" });
		const a2 = makeSpan({ traceId: "tA", spanId: "a2", parentSpanId: "a1" });
		proc2.onStart(asStartSpan(a1), ctx);
		proc2.onStart(asStartSpan(a2), ctx);

		// End a1 → tA has 1 buffered span, inProgress={a2}
		proc2.onEnd(a1);
		expect(exporter2.export).not.toHaveBeenCalled();

		// End a2 → tA has 2 buffered spans, inProgress={}  → totalBuffered=2, not yet over limit
		proc2.onEnd(a2);
		// tA complete → exported immediately
		expect(exporter2.export).toHaveBeenCalledOnce();
		// Now buffer is empty again

		// Trace B: start one span
		const b1 = makeSpan({ traceId: "tB", spanId: "b1" });
		proc2.onStart(asStartSpan(b1), ctx);

		// Trace C: start one span
		const c1 = makeSpan({ traceId: "tC", spanId: "c1" });
		proc2.onStart(asStartSpan(c1), ctx);

		// End b1 → tB: 1 buffered, totalBuffered=1
		proc2.onEnd(b1);
		// tB complete → exported
		expect(exporter2.export).toHaveBeenCalledTimes(2);

		// Fresh start for actual overflow scenario
		const exporter3 = makeExporter();
		const proc3 = new TailSampleSpanProcessor(exporter3, {
			tailSampler: keepAll,
			maxBufferedSpans: 2,
		});

		// Trace X: start 2 spans, end both → buffers then decides
		// Actually let's test overflow: keep traces incomplete
		const x1 = makeSpan({ traceId: "tX", spanId: "x1" });
		const x2 = makeSpan({ traceId: "tX", spanId: "x2", parentSpanId: "x1" });
		const y1 = makeSpan({ traceId: "tY", spanId: "y1" });

		proc3.onStart(asStartSpan(x1), ctx);
		proc3.onStart(asStartSpan(x2), ctx);
		proc3.onStart(asStartSpan(y1), ctx);

		// End x1 → totalBuffered=1, no overflow
		proc3.onEnd(x1);
		expect(exporter3.export).not.toHaveBeenCalled();

		// End x2 → totalBuffered=2, no overflow (not > 2)
		proc3.onEnd(x2);
		// tX complete → decided
		expect(exporter3.export).toHaveBeenCalledOnce();
		// totalBuffered=0 after decide

		// End y1 → tY complete → decided
		proc3.onEnd(y1);
		expect(exporter3.export).toHaveBeenCalledTimes(2);

		// Real overflow test: maxBufferedSpans=1, two incomplete traces
		const exporter4 = makeExporter();
		const proc4 = new TailSampleSpanProcessor(exporter4, {
			tailSampler: keepAll,
			maxBufferedSpans: 1,
		});

		const p1 = makeSpan({ traceId: "tP", spanId: "p1" });
		const p2 = makeSpan({ traceId: "tP", spanId: "p2", parentSpanId: "p1" });
		const q1 = makeSpan({ traceId: "tQ", spanId: "q1" });

		proc4.onStart(asStartSpan(p1), ctx);
		proc4.onStart(asStartSpan(p2), ctx);
		proc4.onStart(asStartSpan(q1), ctx);

		// End p1: totalBuffered=1, not > 1, no eviction; tP still has p2 in-progress
		proc4.onEnd(p1);
		expect(exporter4.export).not.toHaveBeenCalled();

		// End q1: totalBuffered=2 > 1 → evict oldest (tP, arrivalOrder=0)
		proc4.onEnd(q1);
		// tP evicted (force-decided) → exported
		// tQ also complete (q1 was its only span) → also decided
		expect(exporter4.export).toHaveBeenCalledTimes(2);
	});
});
