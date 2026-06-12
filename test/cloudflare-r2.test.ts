/**
 * Tests for `instrumentR2`.
 *
 * Uses real OTel SDK (InMemorySpanExporter + InMemoryMetricExporter) so that
 * span/metric assertions and trace-continuity work without heavy mocking.
 *
 * Key R2 invariant: `get` returns an R2ObjectBody whose `.body` stream must
 * remain unread after instrumentation (bodyUsed === false).
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

// ── Minimal ALS-backed context manager (mirrors CloudflareContextManager) ─────

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
import { instrumentR2 } from "../src/cloudflare/bindings/r2.js";
import { _resetBindingHistogram as resetHist } from "../src/cloudflare/bindings/trace-binding.js";
import { _resetInstrumentState } from "../src/cloudflare/instrument.js";

// ── Fake R2 bucket ────────────────────────────────────────────────────────────

function makeFakeBody() {
	// A minimal ReadableStream that is never consumed — bodyUsed stays false
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(new Uint8Array([104, 101, 108, 108, 111])); // "hello"
			controller.close();
		},
	});
	return {
		key: "test-key",
		version: "v1",
		size: 5,
		etag: '"abc"',
		httpEtag: '"abc"',
		uploaded: new Date(),
		checksums: {},
		body: stream,
		bodyUsed: false,
		arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(5)),
		text: vi.fn().mockResolvedValue("hello"),
		json: vi.fn().mockResolvedValue({}),
		blob: vi.fn().mockResolvedValue(new Blob(["hello"])),
	};
}

function makeFakeObject() {
	return {
		key: "test-key",
		version: "v1",
		size: 5,
		etag: '"abc"',
		httpEtag: '"abc"',
		uploaded: new Date(),
		checksums: {},
	};
}

function makeFakeBucket(overrides: Partial<Record<string, (...args: unknown[]) => unknown>> = {}) {
	const fakeBody = makeFakeBody();
	const fakeObj = makeFakeObject();
	const fakeMultipart = {
		key: "mp-key",
		uploadId: "upload-1",
		uploadPart: vi.fn().mockResolvedValue({ partNumber: 1, etag: '"part"' }),
		abort: vi.fn().mockResolvedValue(undefined),
		complete: vi.fn().mockResolvedValue(fakeObj),
	};
	return {
		_fakeBody: fakeBody,
		_fakeMultipart: fakeMultipart,
		get: vi.fn().mockResolvedValue(fakeBody),
		put: vi.fn().mockResolvedValue(fakeObj),
		head: vi.fn().mockResolvedValue(fakeObj),
		delete: vi.fn().mockResolvedValue(undefined),
		list: vi.fn().mockResolvedValue({ objects: [], truncated: false, delimitedPrefixes: [] }),
		createMultipartUpload: vi.fn().mockResolvedValue(fakeMultipart),
		resumeMultipartUpload: vi.fn().mockReturnValue(fakeMultipart),
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

describe("instrumentR2 — span basics", () => {
	it("get: returns underlying R2ObjectBody untouched", async () => {
		const fakeBucket = makeFakeBucket();
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		const tracer = trace.getTracer("test");
		const result = await tracer.startActiveSpan("root", async (root) => {
			const r = await bucket.get("index.html");
			root.end();
			return r;
		});

		expect(result).toBe(fakeBucket._fakeBody);
		expect(fakeBucket.get).toHaveBeenCalledWith("index.html");
	});

	it("get: emits span named 'R2 ASSETS get'", async () => {
		const fakeBucket = makeFakeBucket();
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await bucket.get("index.html");
			root.end();
		});

		const spans = spanExporter.getFinishedSpans();
		const r2Span = spans.find((s) => s.name === "R2 ASSETS get");
		expect(r2Span).toBeDefined();
	});

	it("get: span kind is CLIENT", async () => {
		const fakeBucket = makeFakeBucket();
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await bucket.get("k");
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "R2 ASSETS get")!;
		expect(span.kind).toBe(SpanKind.CLIENT);
	});

	it("get: span has r2.bucket and r2.operation attrs", async () => {
		const fakeBucket = makeFakeBucket();
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await bucket.get("k");
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "R2 ASSETS get")!;
		expect(span.attributes["cloudflare.r2.bucket"]).toBe("ASSETS");
		expect(span.attributes["cloudflare.r2.operation"]).toBe("get");
	});

	it("put: emits span with correct operation", async () => {
		const fakeBucket = makeFakeBucket();
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await bucket.put("file.txt", "content");
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "R2 ASSETS put")!;
		expect(span).toBeDefined();
		expect(span.attributes["cloudflare.r2.operation"]).toBe("put");
		expect(fakeBucket.put).toHaveBeenCalledWith("file.txt", "content");
	});

	it("head: emits span with correct operation", async () => {
		const fakeBucket = makeFakeBucket();
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await bucket.head("file.txt");
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "R2 ASSETS head")!;
		expect(span).toBeDefined();
		expect(span.attributes["cloudflare.r2.operation"]).toBe("head");
	});

	it("delete(string): emits span with correct operation", async () => {
		const fakeBucket = makeFakeBucket();
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await bucket.delete("old-file.txt");
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "R2 ASSETS delete")!;
		expect(span).toBeDefined();
		expect(span.attributes["cloudflare.r2.operation"]).toBe("delete");
	});

	it("list: emits span with correct operation", async () => {
		const fakeBucket = makeFakeBucket();
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await bucket.list({ prefix: "images/" });
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "R2 ASSETS list")!;
		expect(span).toBeDefined();
		expect(span.attributes["cloudflare.r2.operation"]).toBe("list");
	});

	it("createMultipartUpload: emits span with correct operation", async () => {
		const fakeBucket = makeFakeBucket();
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await bucket.createMultipartUpload("big-file.bin");
			root.end();
		});

		const span = spanExporter
			.getFinishedSpans()
			.find((s) => s.name === "R2 ASSETS createMultipartUpload")!;
		expect(span).toBeDefined();
		expect(span.attributes["cloudflare.r2.operation"]).toBe("createMultipartUpload");
	});
});

describe("instrumentR2 — body stream not consumed", () => {
	it("get returns R2ObjectBody with bodyUsed === false (stream unread)", async () => {
		const fakeBucket = makeFakeBucket();
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		const tracer = trace.getTracer("test");
		const result = await tracer.startActiveSpan("root", async (root) => {
			const r = await bucket.get("index.html");
			root.end();
			return r;
		});

		// bodyUsed must still be false — instrumentation must not consume the stream
		expect(result).not.toBeNull();
		expect((result as any).bodyUsed).toBe(false);
		// body stream reference still present and readable
		expect((result as any).body).toBeInstanceOf(ReadableStream);
		// Instrumentation must not have called any body consumption methods
		expect(fakeBucket._fakeBody.arrayBuffer).not.toHaveBeenCalled();
		expect(fakeBucket._fakeBody.text).not.toHaveBeenCalled();
		expect(fakeBucket._fakeBody.json).not.toHaveBeenCalled();
		expect(fakeBucket._fakeBody.blob).not.toHaveBeenCalled();
	});
});

describe("instrumentR2 — key redaction", () => {
	it("cloudflare.r2.key ABSENT by default (get)", async () => {
		const fakeBucket = makeFakeBucket();
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await bucket.get("secret.txt");
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "R2 ASSETS get")!;
		expect(span.attributes).not.toHaveProperty("cloudflare.r2.key");
	});

	it("cloudflare.r2.key PRESENT when bindingCaptureKeys true (get)", async () => {
		setBindingConfig({ bindingCaptureKeys: true });
		const fakeBucket = makeFakeBucket();
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await bucket.get("secret.txt");
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "R2 ASSETS get")!;
		expect(span.attributes["cloudflare.r2.key"]).toBe("secret.txt");
	});

	it("list has no key attr even with captureKeys true", async () => {
		setBindingConfig({ bindingCaptureKeys: true });
		const fakeBucket = makeFakeBucket();
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await bucket.list({ prefix: "images/" });
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "R2 ASSETS list")!;
		expect(span.attributes).not.toHaveProperty("cloudflare.r2.key");
	});

	it("delete(string): key captured when bindingCaptureKeys true", async () => {
		setBindingConfig({ bindingCaptureKeys: true });
		const fakeBucket = makeFakeBucket();
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await bucket.delete("old-file.txt");
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "R2 ASSETS delete")!;
		expect(span.attributes["cloudflare.r2.key"]).toBe("old-file.txt");
	});

	it("delete(string[]): no key attr even when bindingCaptureKeys true", async () => {
		setBindingConfig({ bindingCaptureKeys: true });
		const fakeBucket = makeFakeBucket();
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await bucket.delete(["a.txt", "b.txt"]);
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "R2 ASSETS delete")!;
		expect(span.attributes).not.toHaveProperty("cloudflare.r2.key");
	});
});

describe("instrumentR2 — metrics", () => {
	it("records cloudflare.binding.operation.duration on successful get", async () => {
		const fakeBucket = makeFakeBucket();
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await bucket.get("k");
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
			"cloudflare.binding.type": "r2",
			"cloudflare.binding.name": "ASSETS",
			operation: "get",
			status: "ok",
		});
	});

	it("metric has status=error on thrown op", async () => {
		const err = new Error("R2 unavailable");
		const fakeBucket = makeFakeBucket({ get: vi.fn().mockRejectedValue(err) });
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		const tracer = trace.getTracer("test");
		await expect(
			tracer.startActiveSpan("root", async (root) => {
				try {
					await bucket.get("k");
				} finally {
					root.end();
				}
			}),
		).rejects.toThrow("R2 unavailable");

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
		const err = new Error("r2 fail");
		const fakeBucket = makeFakeBucket({ get: vi.fn().mockRejectedValue(err) });
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		const tracer = trace.getTracer("test");
		await expect(
			tracer.startActiveSpan("root", async (root) => {
				try {
					return await bucket.get("k");
				} finally {
					root.end();
				}
			}),
		).rejects.toThrow("r2 fail");

		const finishedSpans = spanExporter.getFinishedSpans();
		const r2Span = finishedSpans.find((s) => s.name === "R2 ASSETS get");
		expect(r2Span).toBeDefined();
		expect(r2Span!.status.code).toBe(SpanStatusCode.ERROR);
		expect(r2Span!.events).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "exception" })]),
		);
	});
});

describe("instrumentR2 — trace continuity", () => {
	it("R2 span traceId equals root request span traceId (same trace)", async () => {
		const fakeBucket = makeFakeBucket();
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		const tracer = trace.getTracer("test-request");
		let rootTraceId: string | undefined;

		await tracer.startActiveSpan("GET /api/asset", { kind: SpanKind.SERVER }, async (rootSpan) => {
			rootTraceId = rootSpan.spanContext().traceId;
			await bucket.get("logo.png");
			rootSpan.end();
		});

		const spans = spanExporter.getFinishedSpans();
		const r2Span = spans.find((s) => s.name === "R2 ASSETS get");
		expect(r2Span).toBeDefined();

		const r2TraceId = r2Span!.spanContext().traceId;
		expect(rootTraceId).toBeDefined();
		expect(r2TraceId).toBe(rootTraceId);
	});
});

describe("instrumentR2 — orphan guard", () => {
	it("orphan skip (default): no span emitted but metric recorded when no active span", async () => {
		const fakeBucket = makeFakeBucket();
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		await bucket.get("k");

		const r2Spans = spanExporter.getFinishedSpans().filter((s) => s.name === "R2 ASSETS get");
		expect(r2Spans).toHaveLength(0);

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
		const fakeBucket = makeFakeBucket();
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		await bucket.get("k");

		const r2Span = spanExporter.getFinishedSpans().find((s) => s.name === "R2 ASSETS get");
		expect(r2Span).toBeDefined();
	});
});

describe("instrumentR2 — non-wrapped property passthrough", () => {
	it("extraProp passes through as-is", () => {
		const fakeBucket = makeFakeBucket();
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");
		expect((bucket as any).extraProp).toBe("non-wrapped-prop");
	});

	it("resumeMultipartUpload passes through untraced (synchronous)", () => {
		const fakeBucket = makeFakeBucket();
		const bucket = instrumentR2(fakeBucket as any, "ASSETS");

		const result = bucket.resumeMultipartUpload("mp-key", "upload-1");
		expect(fakeBucket.resumeMultipartUpload).toHaveBeenCalledWith("mp-key", "upload-1");
		expect(result).toBe(fakeBucket._fakeMultipart);

		// No span emitted for resumeMultipartUpload
		const spans = spanExporter.getFinishedSpans();
		const mpSpan = spans.find((s) => s.name.includes("resumeMultipartUpload"));
		expect(mpSpan).toBeUndefined();
	});
});
