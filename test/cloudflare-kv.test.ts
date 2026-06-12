/**
 * Tests for `instrumentKV` and the shared `traceBinding` helper.
 *
 * Uses real OTel SDK (InMemorySpanExporter + InMemoryMetricExporter) so that
 * span/metric assertions and trace-continuity work without heavy mocking.
 *
 * `NodeTracerProvider` is used for its built-in AsyncLocalStorage context
 * manager — this ensures `context.active()` propagates across awaits, which
 * is the same mechanism the Cloudflare adapter uses at runtime.
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

// ── Minimal ALS-backed context manager (mirrors CloudflareContextManager) ────
// Cannot use @opentelemetry/context-async-hooks (not a top-level dep).
// Cannot use NodeTracerProvider (sdk-node is CJS, no ESM named exports in vitest).
// This minimal implementation is sufficient for test context propagation.

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

import { _resetBindingConfig, setBindingConfig } from "../src/cloudflare/bindings/config.js";
import { instrumentKV } from "../src/cloudflare/bindings/kv.js";
import { _resetBindingHistogram as resetHist } from "../src/cloudflare/bindings/trace-binding.js";
import { _resetInstrumentState } from "../src/cloudflare/instrument.js";

// ── KV fake ──────────────────────────────────────────────────────────────────

function makeFakeKV(overrides: Partial<Record<string, (...args: unknown[]) => unknown>> = {}) {
	return {
		get: vi.fn().mockResolvedValue("fake-value"),
		getWithMetadata: vi.fn().mockResolvedValue({ value: "meta-value", metadata: null }),
		put: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
		list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
		extraProp: "non-wrapped-prop",
		...overrides,
	};
}

// ── Provider helpers ─────────────────────────────────────────────────────────

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
		exportIntervalMillis: 100_000, // manual flush via reader.forceFlush()
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
	// ALS context manager — propagates context.active() across await boundaries.
	// Must be set before provider.register so that spans inherit parent context.
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
	resetHist(); // re-create histogram with the fresh metric provider
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("instrumentKV — span basics", () => {
	it("returns the underlying value", async () => {
		const fakeKV = makeFakeKV();
		const kv = instrumentKV(fakeKV as any, "SESSIONS");

		// Need a root span so orphan guard doesn't skip
		const tracer = trace.getTracer("test");
		const result = await tracer.startActiveSpan("root", async (root) => {
			const r = await kv.get("token");
			root.end();
			return r;
		});

		expect(result).toBe("fake-value");
		expect(fakeKV.get).toHaveBeenCalledWith("token");
	});

	it("emits a span named 'KV SESSIONS get'", async () => {
		const fakeKV = makeFakeKV();
		const kv = instrumentKV(fakeKV as any, "SESSIONS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await kv.get("some-key");
			root.end();
		});

		const spans = spanExporter.getFinishedSpans();
		const kvSpan = spans.find((s) => s.name === "KV SESSIONS get");
		expect(kvSpan).toBeDefined();
	});

	it("span kind is CLIENT", async () => {
		const fakeKV = makeFakeKV();
		const kv = instrumentKV(fakeKV as any, "SESSIONS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await kv.get("k");
			root.end();
		});

		const spans = spanExporter.getFinishedSpans();
		const kvSpan = spans.find((s) => s.name === "KV SESSIONS get");
		expect(kvSpan!.kind).toBe(SpanKind.CLIENT);
	});

	it("span has binding.type / binding.name / kv.operation attrs", async () => {
		const fakeKV = makeFakeKV();
		const kv = instrumentKV(fakeKV as any, "SESSIONS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await kv.get("k");
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "KV SESSIONS get")!;
		expect(span.attributes["cloudflare.binding.type"]).toBe("kv");
		expect(span.attributes["cloudflare.binding.name"]).toBe("SESSIONS");
		expect(span.attributes["cloudflare.kv.operation"]).toBe("get");
	});

	it("original method called with correct args", async () => {
		const fakeKV = makeFakeKV();
		const kv = instrumentKV(fakeKV as any, "SESSIONS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await kv.put("my-key", "my-value");
			root.end();
		});

		expect(fakeKV.put).toHaveBeenCalledWith("my-key", "my-value");
	});
});

describe("instrumentKV — key redaction", () => {
	it("cloudflare.kv.key ABSENT by default", async () => {
		const fakeKV = makeFakeKV();
		const kv = instrumentKV(fakeKV as any, "SESSIONS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await kv.get("secret-key");
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "KV SESSIONS get")!;
		expect(span.attributes).not.toHaveProperty("cloudflare.kv.key");
	});

	it("cloudflare.kv.key PRESENT when bindingCaptureKeys true", async () => {
		setBindingConfig({ bindingCaptureKeys: true });
		const fakeKV = makeFakeKV();
		const kv = instrumentKV(fakeKV as any, "SESSIONS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await kv.get("secret-key");
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "KV SESSIONS get")!;
		expect(span.attributes["cloudflare.kv.key"]).toBe("secret-key");
	});

	it("list has no key attr even with captureKeys true", async () => {
		setBindingConfig({ bindingCaptureKeys: true });
		const fakeKV = makeFakeKV();
		const kv = instrumentKV(fakeKV as any, "SESSIONS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await kv.list({ prefix: "user:" });
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "KV SESSIONS list")!;
		expect(span.attributes).not.toHaveProperty("cloudflare.kv.key");
	});
});

describe("instrumentKV — metrics", () => {
	it("records cloudflare.binding.operation.duration on successful op", async () => {
		const fakeKV = makeFakeKV();
		const kv = instrumentKV(fakeKV as any, "CACHE");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await kv.get("k");
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
			"cloudflare.binding.type": "kv",
			"cloudflare.binding.name": "CACHE",
			operation: "get",
			status: "ok",
		});
	});

	it("metric has status=error on thrown op", async () => {
		const err = new Error("KV unavailable");
		const fakeKV = makeFakeKV({ get: vi.fn().mockRejectedValue(err) });
		const kv = instrumentKV(fakeKV as any, "SESSIONS");

		const tracer = trace.getTracer("test");
		await expect(
			tracer.startActiveSpan("root", async (root) => {
				try {
					await kv.get("k");
				} finally {
					root.end();
				}
			}),
		).rejects.toThrow("KV unavailable");

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

	it("exception recorded on span and re-thrown when op throws inside root span", async () => {
		const err = new Error("kv fail");
		const fakeKV = makeFakeKV({ get: vi.fn().mockRejectedValue(err) });
		const kv = instrumentKV(fakeKV as any, "SESSIONS");

		const tracer = trace.getTracer("test");
		await expect(
			tracer.startActiveSpan("root", async (root) => {
				try {
					return await kv.get("k");
				} finally {
					root.end();
				}
			}),
		).rejects.toThrow("kv fail");

		const finishedSpans = spanExporter.getFinishedSpans();
		const kvSpan = finishedSpans.find((s) => s.name === "KV SESSIONS get");
		expect(kvSpan).toBeDefined();
		expect(kvSpan!.status.code).toBe(SpanStatusCode.ERROR);
		expect(kvSpan!.events).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "exception" })]),
		);
	});
});

describe("instrumentKV — explicit buckets", () => {
	it("histogram created with default explicit boundaries [1,2,5,10,20,50,100,200,500,1000,2000,5000]", async () => {
		const fakeKV = makeFakeKV();
		const kv = instrumentKV(fakeKV as any, "SESSIONS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await kv.get("k");
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
		const value = dp.value as { buckets: { boundaries: number[] } };
		expect(value.buckets.boundaries).toEqual([
			1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000,
		]);
	});

	it("uses configured boundaries when set before first use", async () => {
		const customBoundaries = [5, 25, 100, 500];
		setBindingConfig({ bindingHistogramBoundaries: customBoundaries });
		resetHist(); // ensure fresh histogram picks up new config

		const fakeKV = makeFakeKV();
		const kv = instrumentKV(fakeKV as any, "SESSIONS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await kv.get("k");
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
		const value = dp.value as { buckets: { boundaries: number[] } };
		expect(value.buckets.boundaries).toEqual(customBoundaries);
	});
});

describe("instrumentKV — trace continuity", () => {
	it("KV span traceId equals root request span traceId (same trace)", async () => {
		const fakeKV = makeFakeKV();
		const kv = instrumentKV(fakeKV as any, "SESSIONS");

		const tracer = trace.getTracer("test-request");
		let rootTraceId: string | undefined;

		// Simulates a traceHandler root span wrapping the handler
		await tracer.startActiveSpan("GET /api/test", { kind: SpanKind.SERVER }, async (rootSpan) => {
			rootTraceId = rootSpan.spanContext().traceId;
			await kv.get("session-token");
			rootSpan.end();
		});

		const spans = spanExporter.getFinishedSpans();
		const kvSpan = spans.find((s) => s.name === "KV SESSIONS get");
		expect(kvSpan).toBeDefined();

		const kvTraceId = kvSpan!.spanContext().traceId;
		expect(rootTraceId).toBeDefined();
		expect(kvTraceId).toBe(rootTraceId);
	});
});

describe("instrumentKV — orphan guard", () => {
	it("orphan skip (default): no span emitted but metric recorded when no active span", async () => {
		// Default orphan = "skip" — call outside any startActiveSpan
		const fakeKV = makeFakeKV();
		const kv = instrumentKV(fakeKV as any, "SESSIONS");

		await kv.get("k");

		const kvSpans = spanExporter.getFinishedSpans().filter((s) => s.name === "KV SESSIONS get");
		expect(kvSpans).toHaveLength(0);

		// Metric IS still recorded
		await metricReader.forceFlush();
		const allMetrics = metricExporter
			.getMetrics()
			.flatMap((rm) => rm.scopeMetrics)
			.flatMap((sm) => sm.metrics);
		const dur = allMetrics.find(
			(m) => m.descriptor.name === "cloudflare.binding.operation.duration",
		);
		expect(dur).toBeDefined();
		expect(dur!.dataPoints.length).toBeGreaterThan(0);
	});

	it("orphan root: span IS emitted even with no active span", async () => {
		setBindingConfig({ orphanBindingSpans: "root" });
		const fakeKV = makeFakeKV();
		const kv = instrumentKV(fakeKV as any, "SESSIONS");

		await kv.get("k");

		const kvSpan = spanExporter.getFinishedSpans().find((s) => s.name === "KV SESSIONS get");
		expect(kvSpan).toBeDefined();
	});
});

describe("instrumentKV — non-wrapped property passthrough", () => {
	it("extraProp passes through as-is", () => {
		const fakeKV = makeFakeKV();
		const kv = instrumentKV(fakeKV as any, "SESSIONS");
		expect((kv as any).extraProp).toBe("non-wrapped-prop");
	});

	it("delete wrapped and delegates correctly", async () => {
		const fakeKV = makeFakeKV();
		const kv = instrumentKV(fakeKV as any, "SESSIONS");

		setBindingConfig({ orphanBindingSpans: "root" }); // emit span without root
		await kv.delete("some-key");

		expect(fakeKV.delete).toHaveBeenCalledWith("some-key");
		const span = spanExporter.getFinishedSpans().find((s) => s.name === "KV SESSIONS delete");
		expect(span).toBeDefined();
	});
});
