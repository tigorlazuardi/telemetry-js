/**
 * Tests for `instrumentDOStorage`.
 *
 * Uses real OTel SDK (InMemorySpanExporter + InMemoryMetricExporter) so that
 * span/metric assertions and trace-continuity work without heavy mocking.
 *
 * `TestContextManager` uses AsyncLocalStorage so `context.active()` propagates
 * across awaits — same mechanism the Cloudflare adapter uses at runtime.
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
import { instrumentDOStorage } from "../src/cloudflare/bindings/do-storage.js";
import { _resetBindingHistogram as resetHist } from "../src/cloudflare/bindings/trace-binding.js";
import { _resetInstrumentState } from "../src/cloudflare/instrument.js";

// ── Fake DurableObjectStorage ─────────────────────────────────────────────────

function makeFakeStorage(overrides: Partial<Record<string, (...args: unknown[]) => unknown>> = {}) {
	return {
		get: vi.fn().mockResolvedValue("fake-value"),
		put: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(true),
		list: vi.fn().mockResolvedValue(new Map()),
		deleteAll: vi.fn().mockResolvedValue(undefined),
		// Non-wrapped pass-through methods
		transaction: vi.fn().mockResolvedValue(undefined),
		getAlarm: vi.fn().mockResolvedValue(null),
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

// ── Setup / teardown ──────────────────────────────────────────────────────────

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

describe("instrumentDOStorage — span basics", () => {
	it("returns the underlying value for get", async () => {
		const fake = makeFakeStorage();
		const storage = instrumentDOStorage(fake as any, "Counter");

		const tracer = trace.getTracer("test");
		const result = await tracer.startActiveSpan("root", async (root) => {
			const r = await storage.get("count");
			root.end();
			return r;
		});

		expect(result).toBe("fake-value");
		expect(fake.get).toHaveBeenCalledWith("count");
	});

	it("emits span 'DO Counter get'", async () => {
		const fake = makeFakeStorage();
		const storage = instrumentDOStorage(fake as any, "Counter");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await storage.get("count");
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "DO Counter get");
		expect(span).toBeDefined();
	});

	it("span kind is CLIENT", async () => {
		const fake = makeFakeStorage();
		const storage = instrumentDOStorage(fake as any, "Counter");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await storage.get("count");
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "DO Counter get")!;
		expect(span.kind).toBe(SpanKind.CLIENT);
	});

	it("span has cloudflare.binding.type=do / cloudflare.do.storage.operation=get", async () => {
		const fake = makeFakeStorage();
		const storage = instrumentDOStorage(fake as any, "Counter");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await storage.get("count");
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "DO Counter get")!;
		expect(span.attributes["cloudflare.binding.type"]).toBe("do");
		expect(span.attributes["cloudflare.binding.name"]).toBe("Counter");
		expect(span.attributes["cloudflare.do.storage.operation"]).toBe("get");
	});
});

describe("instrumentDOStorage — all wrapped methods", () => {
	it("put: emits one span with operation=put", async () => {
		const fake = makeFakeStorage();
		const storage = instrumentDOStorage(fake as any, "Counter");
		setBindingConfig({ orphanBindingSpans: "root" });

		await storage.put("count", 42);

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "DO Counter put");
		expect(span).toBeDefined();
		expect(span!.attributes["cloudflare.do.storage.operation"]).toBe("put");
		expect(fake.put).toHaveBeenCalledWith("count", 42);
	});

	it("delete: emits one span with operation=delete", async () => {
		const fake = makeFakeStorage();
		const storage = instrumentDOStorage(fake as any, "Counter");
		setBindingConfig({ orphanBindingSpans: "root" });

		await storage.delete("count");

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "DO Counter delete");
		expect(span).toBeDefined();
		expect(span!.attributes["cloudflare.do.storage.operation"]).toBe("delete");
	});

	it("list: emits one span with operation=list", async () => {
		const fake = makeFakeStorage();
		const storage = instrumentDOStorage(fake as any, "Counter");
		setBindingConfig({ orphanBindingSpans: "root" });

		await storage.list();

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "DO Counter list");
		expect(span).toBeDefined();
		expect(span!.attributes["cloudflare.do.storage.operation"]).toBe("list");
	});

	it("deleteAll: emits one span with operation=deleteAll", async () => {
		const fake = makeFakeStorage();
		const storage = instrumentDOStorage(fake as any, "Counter");
		setBindingConfig({ orphanBindingSpans: "root" });

		await storage.deleteAll();

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "DO Counter deleteAll");
		expect(span).toBeDefined();
		expect(span!.attributes["cloudflare.do.storage.operation"]).toBe("deleteAll");
	});
});

describe("instrumentDOStorage — key handling", () => {
	it("single-string get: no cloudflare.do.key by default", async () => {
		const fake = makeFakeStorage();
		const storage = instrumentDOStorage(fake as any, "Counter");
		setBindingConfig({ orphanBindingSpans: "root" });

		await storage.get("count");

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "DO Counter get")!;
		expect(span.attributes).not.toHaveProperty("cloudflare.do.key");
	});

	it("single-string get: cloudflare.do.key present when bindingCaptureKeys=true", async () => {
		setBindingConfig({ bindingCaptureKeys: true, orphanBindingSpans: "root" });
		const fake = makeFakeStorage();
		const storage = instrumentDOStorage(fake as any, "Counter");

		await storage.get("count");

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "DO Counter get")!;
		expect(span.attributes["cloudflare.do.key"]).toBe("count");
	});

	it("array get: no key attr even with captureKeys=true", async () => {
		setBindingConfig({ bindingCaptureKeys: true, orphanBindingSpans: "root" });
		const fake = makeFakeStorage({
			get: vi.fn().mockResolvedValue(
				new Map([
					["a", 1],
					["b", 2],
				]),
			),
		});
		const storage = instrumentDOStorage(fake as any, "Counter");

		await storage.get(["a", "b"] as any);

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "DO Counter get")!;
		expect(span.attributes).not.toHaveProperty("cloudflare.do.key");
	});

	it("Record put: no key attr even with captureKeys=true", async () => {
		setBindingConfig({ bindingCaptureKeys: true, orphanBindingSpans: "root" });
		const fake = makeFakeStorage();
		const storage = instrumentDOStorage(fake as any, "Counter");

		await storage.put({ a: 1, b: 2 } as any);

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "DO Counter put")!;
		expect(span.attributes).not.toHaveProperty("cloudflare.do.key");
	});

	it("array delete: no key attr even with captureKeys=true", async () => {
		setBindingConfig({ bindingCaptureKeys: true, orphanBindingSpans: "root" });
		const fake = makeFakeStorage({
			delete: vi.fn().mockResolvedValue(2),
		});
		const storage = instrumentDOStorage(fake as any, "Counter");

		await storage.delete(["a", "b"] as any);

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "DO Counter delete")!;
		expect(span.attributes).not.toHaveProperty("cloudflare.do.key");
	});

	it("list: no key attr even with captureKeys=true", async () => {
		setBindingConfig({ bindingCaptureKeys: true, orphanBindingSpans: "root" });
		const fake = makeFakeStorage();
		const storage = instrumentDOStorage(fake as any, "Counter");

		await storage.list();

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "DO Counter list")!;
		expect(span.attributes).not.toHaveProperty("cloudflare.do.key");
	});

	it("deleteAll: no key attr even with captureKeys=true", async () => {
		setBindingConfig({ bindingCaptureKeys: true, orphanBindingSpans: "root" });
		const fake = makeFakeStorage();
		const storage = instrumentDOStorage(fake as any, "Counter");

		await storage.deleteAll();

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "DO Counter deleteAll")!;
		expect(span.attributes).not.toHaveProperty("cloudflare.do.key");
	});

	it("single-string put: key captured when captureKeys=true", async () => {
		setBindingConfig({ bindingCaptureKeys: true, orphanBindingSpans: "root" });
		const fake = makeFakeStorage();
		const storage = instrumentDOStorage(fake as any, "Counter");

		await storage.put("count", 5);

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "DO Counter put")!;
		expect(span.attributes["cloudflare.do.key"]).toBe("count");
	});

	it("single-string delete: key captured when captureKeys=true", async () => {
		setBindingConfig({ bindingCaptureKeys: true, orphanBindingSpans: "root" });
		const fake = makeFakeStorage();
		const storage = instrumentDOStorage(fake as any, "Counter");

		await storage.delete("count");

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "DO Counter delete")!;
		expect(span.attributes["cloudflare.do.key"]).toBe("count");
	});
});

describe("instrumentDOStorage — metrics", () => {
	it("records cloudflare.binding.operation.duration on successful op", async () => {
		const fake = makeFakeStorage();
		const storage = instrumentDOStorage(fake as any, "Counter");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await storage.get("count");
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
			"cloudflare.binding.type": "do",
			"cloudflare.binding.name": "Counter",
			operation: "get",
			status: "ok",
		});
	});

	it("metric has status=error on thrown op", async () => {
		const err = new Error("storage unavailable");
		const fake = makeFakeStorage({ get: vi.fn().mockRejectedValue(err) });
		const storage = instrumentDOStorage(fake as any, "Counter");

		const tracer = trace.getTracer("test");
		await expect(
			tracer.startActiveSpan("root", async (root) => {
				try {
					await storage.get("count");
				} finally {
					root.end();
				}
			}),
		).rejects.toThrow("storage unavailable");

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
		const err = new Error("storage fail");
		const fake = makeFakeStorage({ put: vi.fn().mockRejectedValue(err) });
		const storage = instrumentDOStorage(fake as any, "Counter");

		const tracer = trace.getTracer("test");
		await expect(
			tracer.startActiveSpan("root", async (root) => {
				try {
					return await storage.put("count", 1);
				} finally {
					root.end();
				}
			}),
		).rejects.toThrow("storage fail");

		const finishedSpans = spanExporter.getFinishedSpans();
		const doSpan = finishedSpans.find((s) => s.name === "DO Counter put");
		expect(doSpan).toBeDefined();
		expect(doSpan!.status.code).toBe(SpanStatusCode.ERROR);
		expect(doSpan!.events).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "exception" })]),
		);
	});
});

describe("instrumentDOStorage — trace continuity", () => {
	it("storage span traceId equals root request span traceId (same trace)", async () => {
		const fake = makeFakeStorage();
		const storage = instrumentDOStorage(fake as any, "Counter");

		const tracer = trace.getTracer("test-request");
		let rootTraceId: string | undefined;

		await tracer.startActiveSpan("GET /counter", { kind: SpanKind.SERVER }, async (rootSpan) => {
			rootTraceId = rootSpan.spanContext().traceId;
			await storage.get("count");
			rootSpan.end();
		});

		const spans = spanExporter.getFinishedSpans();
		const doSpan = spans.find((s) => s.name === "DO Counter get");
		expect(doSpan).toBeDefined();

		const doTraceId = doSpan!.spanContext().traceId;
		expect(rootTraceId).toBeDefined();
		expect(doTraceId).toBe(rootTraceId);
	});
});

describe("instrumentDOStorage — passthrough", () => {
	it("transaction passes through and is callable", async () => {
		const fake = makeFakeStorage();
		const storage = instrumentDOStorage(fake as any, "Counter");

		await (storage as any).transaction(async () => {});

		expect(fake.transaction).toHaveBeenCalled();
	});

	it("getAlarm passes through and is callable", async () => {
		const fake = makeFakeStorage();
		const storage = instrumentDOStorage(fake as any, "Counter");

		const result = await (storage as any).getAlarm();

		expect(fake.getAlarm).toHaveBeenCalled();
		expect(result).toBeNull();
	});

	it("no span emitted for non-wrapped method", async () => {
		const fake = makeFakeStorage();
		const storage = instrumentDOStorage(fake as any, "Counter");
		setBindingConfig({ orphanBindingSpans: "root" });

		await (storage as any).transaction(async () => {});

		const spans = spanExporter.getFinishedSpans().filter((s) => s.name.startsWith("DO Counter"));
		expect(spans).toHaveLength(0);
	});
});
