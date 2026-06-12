/**
 * Tests for `instrumentQueue` — Queue producer wrapper.
 *
 * Uses real OTel SDK (InMemorySpanExporter + InMemoryMetricExporter) so span/metric
 * assertions and trace-continuity work without heavy mocking.
 *
 * Pattern mirrors cloudflare-kv.test.ts — same TestContextManager, same setup/teardown.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
	type Context,
	type ContextManager,
	context,
	metrics,
	ROOT_CONTEXT,
	SpanKind,
	SpanStatusCode,
	trace,
} from "@opentelemetry/api";
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Minimal ALS-backed context manager ───────────────────────────────────────

class TestContextManager implements ContextManager {
	private _storage = new AsyncLocalStorage<Context>();

	active(): Context {
		return this._storage.getStore() ?? ROOT_CONTEXT;
	}

	with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
		ctx: Context,
		fn: F,
		thisArg?: ThisParameterType<F>,
		...args: A
	): ReturnType<F> {
		const cb = thisArg == null ? fn : fn.bind(thisArg);
		return this._storage.run(ctx, cb as (...a: unknown[]) => ReturnType<F>, ...(args as unknown[]));
	}

	bind<T>(ctx: Context, target: T): T {
		if (typeof target === "function") {
			const manager = this;
			const fn = target as unknown as (...a: unknown[]) => unknown;
			const bound = function (this: unknown, ...args: unknown[]) {
				return manager.with(ctx, () => fn.apply(this, args));
			};
			return bound as unknown as T;
		}
		return target;
	}

	enable(): this {
		return this;
	}

	disable(): this {
		return this;
	}
}

import { _resetBindingConfig } from "../src/cloudflare/bindings/config.js";
import { instrumentQueue } from "../src/cloudflare/bindings/queue.js";
import { _resetBindingHistogram as resetHist } from "../src/cloudflare/bindings/trace-binding.js";
import { _resetInstrumentState } from "../src/cloudflare/instrument.js";

// ── Fake Queue ────────────────────────────────────────────────────────────────

function makeFakeQueue(overrides: Partial<Record<string, (...args: unknown[]) => unknown>> = {}) {
	return {
		send: vi.fn().mockResolvedValue(undefined),
		sendBatch: vi.fn().mockResolvedValue(undefined),
		extraProp: "non-wrapped-prop",
		...overrides,
	};
}

// ── Provider helpers ──────────────────────────────────────────────────────────

function makeSpanProvider() {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});
	return { provider, exporter };
}

function makeMetricProvider() {
	const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
	const reader = new PeriodicExportingMetricReader({
		exporter,
		exportIntervalMillis: 100_000,
	});
	const provider = new MeterProvider({ readers: [reader] });
	return { provider, exporter, reader };
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

let spanProvider: BasicTracerProvider;
let spanExporter: InMemorySpanExporter;
let metricProvider: MeterProvider;
let metricExporter: InMemoryMetricExporter;
let metricReader: PeriodicExportingMetricReader;

beforeEach(() => {
	const cm = new TestContextManager().enable();
	context.setGlobalContextManager(cm);

	const sp = makeSpanProvider();
	spanProvider = sp.provider;
	spanExporter = sp.exporter;
	trace.setGlobalTracerProvider(spanProvider);

	const mp = makeMetricProvider();
	metricProvider = mp.provider;
	metricExporter = mp.exporter;
	metricReader = mp.reader;
	metrics.setGlobalMeterProvider(metricProvider);

	_resetBindingConfig();
	resetHist();
});

afterEach(async () => {
	await spanProvider.shutdown();
	await metricProvider.shutdown();
	trace.disable();
	metrics.disable();
	_resetBindingConfig();
	resetHist();
	_resetInstrumentState();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("instrumentQueue — send span", () => {
	it("emits span named 'QUEUE JOBS send' with PRODUCER kind", async () => {
		const fakeQueue = makeFakeQueue();
		const q = instrumentQueue(fakeQueue as any, "JOBS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await q.send({ x: 1 });
			root.end();
		});

		const spans = spanExporter.getFinishedSpans();
		const qSpan = spans.find((s) => s.name === "QUEUE JOBS send");
		expect(qSpan).toBeDefined();
		expect(qSpan!.kind).toBe(SpanKind.PRODUCER);
	});

	it("span has messaging.* attrs", async () => {
		const fakeQueue = makeFakeQueue();
		const q = instrumentQueue(fakeQueue as any, "JOBS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await q.send({ x: 1 });
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "QUEUE JOBS send")!;
		expect(span.attributes["messaging.system"]).toBe("cloudflare-queues");
		expect(span.attributes["messaging.destination.name"]).toBe("JOBS");
		expect(span.attributes["messaging.operation"]).toBe("send");
	});

	it("original send called with the message", async () => {
		const fakeQueue = makeFakeQueue();
		const q = instrumentQueue(fakeQueue as any, "JOBS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await q.send({ x: 1 });
			root.end();
		});

		expect(fakeQueue.send).toHaveBeenCalledWith({ x: 1 }, undefined);
	});

	it("original send called with options when provided", async () => {
		const fakeQueue = makeFakeQueue();
		const q = instrumentQueue(fakeQueue as any, "JOBS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await q.send({ x: 1 }, { contentType: "json" });
			root.end();
		});

		expect(fakeQueue.send).toHaveBeenCalledWith({ x: 1 }, { contentType: "json" });
	});
});

describe("instrumentQueue — sendBatch span", () => {
	it("emits span named 'QUEUE JOBS sendBatch' with PRODUCER kind", async () => {
		const fakeQueue = makeFakeQueue();
		const q = instrumentQueue(fakeQueue as any, "JOBS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await q.sendBatch([{ body: 1 }, { body: 2 }]);
			root.end();
		});

		const spans = spanExporter.getFinishedSpans();
		const qSpan = spans.find((s) => s.name === "QUEUE JOBS sendBatch");
		expect(qSpan).toBeDefined();
		expect(qSpan!.kind).toBe(SpanKind.PRODUCER);
	});

	it("sendBatch span has messaging.batch.message_count=2", async () => {
		const fakeQueue = makeFakeQueue();
		const q = instrumentQueue(fakeQueue as any, "JOBS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await q.sendBatch([{ body: 1 }, { body: 2 }]);
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "QUEUE JOBS sendBatch")!;
		expect(span.attributes["messaging.batch.message_count"]).toBe(2);
	});

	it("real sendBatch receives all messages (not drained)", async () => {
		const fakeQueue = makeFakeQueue();
		const q = instrumentQueue(fakeQueue as any, "JOBS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await q.sendBatch([{ body: 1 }, { body: 2 }]);
			root.end();
		});

		// sendBatch should be called with a 2-element array
		expect(fakeQueue.sendBatch).toHaveBeenCalledOnce();
		const passedMessages = (fakeQueue.sendBatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(passedMessages).toHaveLength(2);
		expect(passedMessages[0]).toEqual({ body: 1 });
		expect(passedMessages[1]).toEqual({ body: 2 });
	});

	it("sendBatch with a GENERATOR iterable — counted correctly, real sendBatch receives all messages", async () => {
		const fakeQueue = makeFakeQueue();
		const q = instrumentQueue(fakeQueue as any, "JOBS");

		// Generator produces 3 messages — one-shot, would be drained if counted naively
		function* makeMessages() {
			yield { body: "a" };
			yield { body: "b" };
			yield { body: "c" };
		}

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await q.sendBatch(makeMessages());
			root.end();
		});

		// Span should show count=3
		const span = spanExporter.getFinishedSpans().find((s) => s.name === "QUEUE JOBS sendBatch")!;
		expect(span.attributes["messaging.batch.message_count"]).toBe(3);

		// Real sendBatch received all 3 messages (not drained before call)
		const passedMessages = (fakeQueue.sendBatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(passedMessages).toHaveLength(3);
		expect(passedMessages[0]).toEqual({ body: "a" });
		expect(passedMessages[2]).toEqual({ body: "c" });
	});
});

describe("instrumentQueue — metrics", () => {
	it("records cloudflare.binding.operation.duration on successful send", async () => {
		const fakeQueue = makeFakeQueue();
		const q = instrumentQueue(fakeQueue as any, "JOBS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await q.send({ x: 1 });
			root.end();
		});

		await metricReader.forceFlush();
		const allMetrics = metricExporter
			.getMetrics()
			.flatMap((rm) => rm.scopeMetrics)
			.flatMap((sm) => sm.metrics);

		const dur = allMetrics.find(
			(m) => m.descriptor.name === "cloudflare.binding.operation.duration",
		);
		expect(dur).toBeDefined();
		expect(dur!.descriptor.unit).toBe("ms");

		const dp = dur!.dataPoints[0];
		expect(dp.attributes).toMatchObject({
			"cloudflare.binding.type": "queue",
			"cloudflare.binding.name": "JOBS",
			operation: "send",
			status: "ok",
		});
	});

	it("metric operation attr is bounded — messaging.* NOT in metric labels", async () => {
		const fakeQueue = makeFakeQueue();
		const q = instrumentQueue(fakeQueue as any, "JOBS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await q.sendBatch([{ body: 1 }]);
			root.end();
		});

		await metricReader.forceFlush();
		const allMetrics = metricExporter
			.getMetrics()
			.flatMap((rm) => rm.scopeMetrics)
			.flatMap((sm) => sm.metrics);

		const dur = allMetrics.find(
			(m) => m.descriptor.name === "cloudflare.binding.operation.duration",
		);
		expect(dur).toBeDefined();
		const dp = dur!.dataPoints[0];
		// messaging.* are span attrs, not metric labels
		expect(dp.attributes).not.toHaveProperty("messaging.system");
		expect(dp.attributes).not.toHaveProperty("messaging.batch.message_count");
	});

	it("metric status=error on thrown send", async () => {
		const err = new Error("Queue unavailable");
		const fakeQueue = makeFakeQueue({ send: vi.fn().mockRejectedValue(err) });
		const q = instrumentQueue(fakeQueue as any, "JOBS");

		const tracer = trace.getTracer("test");
		await expect(
			tracer.startActiveSpan("root", async (root) => {
				try {
					await q.send({ x: 1 });
				} finally {
					root.end();
				}
			}),
		).rejects.toThrow("Queue unavailable");

		await metricReader.forceFlush();
		const allMetrics = metricExporter
			.getMetrics()
			.flatMap((rm) => rm.scopeMetrics)
			.flatMap((sm) => sm.metrics);

		const dur = allMetrics.find(
			(m) => m.descriptor.name === "cloudflare.binding.operation.duration",
		);
		expect(dur).toBeDefined();
		expect(dur!.dataPoints[0].attributes.status).toBe("error");
	});

	it("exception recorded on span and re-thrown when send throws inside root span", async () => {
		const err = new Error("queue fail");
		const fakeQueue = makeFakeQueue({ send: vi.fn().mockRejectedValue(err) });
		const q = instrumentQueue(fakeQueue as any, "JOBS");

		const tracer = trace.getTracer("test");
		await expect(
			tracer.startActiveSpan("root", async (root) => {
				try {
					return await q.send({ x: 1 });
				} finally {
					root.end();
				}
			}),
		).rejects.toThrow("queue fail");

		const finishedSpans = spanExporter.getFinishedSpans();
		const qSpan = finishedSpans.find((s) => s.name === "QUEUE JOBS send");
		expect(qSpan).toBeDefined();
		expect(qSpan!.status.code).toBe(SpanStatusCode.ERROR);
		expect(qSpan!.events).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "exception" })]),
		);
	});
});

describe("instrumentQueue — trace continuity", () => {
	it("send span traceId equals root request span traceId", async () => {
		const fakeQueue = makeFakeQueue();
		const q = instrumentQueue(fakeQueue as any, "JOBS");

		const tracer = trace.getTracer("test-request");
		let rootTraceId: string | undefined;

		await tracer.startActiveSpan("POST /work", { kind: SpanKind.SERVER }, async (rootSpan) => {
			rootTraceId = rootSpan.spanContext().traceId;
			await q.send({ taskId: "abc" });
			rootSpan.end();
		});

		const spans = spanExporter.getFinishedSpans();
		const qSpan = spans.find((s) => s.name === "QUEUE JOBS send");
		expect(qSpan).toBeDefined();

		const qTraceId = qSpan!.spanContext().traceId;
		expect(rootTraceId).toBeDefined();
		expect(qTraceId).toBe(rootTraceId);
	});
});

describe("instrumentQueue — passthrough", () => {
	it("extraProp passes through as-is", () => {
		const fakeQueue = makeFakeQueue();
		const q = instrumentQueue(fakeQueue as any, "JOBS");
		expect((q as any).extraProp).toBe("non-wrapped-prop");
	});
});
