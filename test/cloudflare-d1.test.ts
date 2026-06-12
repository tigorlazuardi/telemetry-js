/**
 * Tests for `instrumentD1`.
 *
 * Uses real OTel SDK (InMemorySpanExporter + InMemoryMetricExporter).
 * Same ALS-backed context manager as cloudflare-kv.test.ts.
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

// ── Minimal ALS context manager (mirrors cloudflare-kv.test.ts) ───────────────

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
import { instrumentD1 } from "../src/cloudflare/bindings/d1.js";
import { _resetBindingHistogram as resetHist } from "../src/cloudflare/bindings/trace-binding.js";
import type {
	D1Database,
	D1PreparedStatement,
	D1Result,
} from "../src/cloudflare/bindings/types.js";
import { _resetInstrumentState } from "../src/cloudflare/instrument.js";

// ── Fake D1 ───────────────────────────────────────────────────────────────────

interface FakeStmt extends D1PreparedStatement {
	_sql: string;
	_bindings: unknown[];
}

function makeFakeStmt(sql: string, seenStmts?: FakeStmt[]): FakeStmt {
	const stmt: FakeStmt = {
		_sql: sql,
		_bindings: [],
		bind(...values: unknown[]) {
			const next = makeFakeStmt(sql, seenStmts);
			next._bindings = values;
			return next;
		},
		first: vi.fn().mockResolvedValue({ id: 1 }),
		all: vi.fn().mockResolvedValue({ results: [{ id: 1 }], success: true, meta: {} }),
		run: vi.fn().mockResolvedValue({ results: [], success: true, meta: {} }),
		raw: vi.fn().mockResolvedValue([[1, "alice"]]),
	};
	if (seenStmts) seenStmts.push(stmt);
	return stmt;
}

interface FakeDB extends D1Database {
	_batchReceived: D1PreparedStatement[];
}

function makeFakeDB(): FakeDB {
	const batchReceived: D1PreparedStatement[] = [];
	return {
		_batchReceived: batchReceived,
		prepare: vi.fn((sql: string) => makeFakeStmt(sql)),
		batch: vi.fn(async (stmts: D1PreparedStatement[]) => {
			batchReceived.push(...stmts);
			return [{ results: [], success: true, meta: {} }] as D1Result[];
		}),
		exec: vi.fn().mockResolvedValue({ count: 1, duration: 5 }),
		dump: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
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

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getAllMetrics() {
	await metricReader.forceFlush();
	return metricExporter
		.getMetrics()
		.flatMap((rm) => rm.scopeMetrics)
		.flatMap((sm) => sm.metrics);
}

function getDurationMetric(
	allMetrics: ReturnType<
		InMemoryMetricExporter["getMetrics"]
	>[number]["scopeMetrics"][number]["metrics"],
) {
	return allMetrics.find((m) => m.descriptor.name === "cloudflare.binding.operation.duration");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("instrumentD1 — prepare + first()", () => {
	it("returns underlying result", async () => {
		const fakeDB = makeFakeDB();
		const db = instrumentD1(fakeDB as any, "DB");

		const tracer = trace.getTracer("test");
		const result = await tracer.startActiveSpan("root", async (root) => {
			const r = await db.prepare("SELECT 1").first();
			root.end();
			return r;
		});

		expect(result).toEqual({ id: 1 });
	});

	it("emits exactly one span named 'D1 DB SELECT'", async () => {
		const fakeDB = makeFakeDB();
		const db = instrumentD1(fakeDB as any, "DB");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await db.prepare("SELECT 1").first();
			root.end();
		});

		const spans = spanExporter.getFinishedSpans().filter((s) => s.name === "D1 DB SELECT");
		expect(spans).toHaveLength(1);
	});

	it("span has correct db.* attributes", async () => {
		const fakeDB = makeFakeDB();
		const db = instrumentD1(fakeDB as any, "DB");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await db.prepare("SELECT 1").first();
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "D1 DB SELECT")!;
		expect(span.attributes["db.system"]).toBe("cloudflare-d1");
		expect(span.attributes["db.statement"]).toBe("SELECT 1");
		expect(span.attributes["db.operation"]).toBe("SELECT");
		expect(span.attributes["db.cloudflare.method"]).toBe("first");
		expect(span.attributes["cloudflare.binding.type"]).toBe("d1");
		expect(span.attributes["cloudflare.binding.name"]).toBe("DB");
	});

	it("span kind is CLIENT", async () => {
		const fakeDB = makeFakeDB();
		const db = instrumentD1(fakeDB as any, "DB");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await db.prepare("SELECT 1").first();
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "D1 DB SELECT")!;
		expect(span.kind).toBe(SpanKind.CLIENT);
	});
});

describe("instrumentD1 — bind() chaining", () => {
	it("prepare+bind+run → one span 'D1 DB INSERT', sql preserved", async () => {
		const fakeDB = makeFakeDB();
		const db = instrumentD1(fakeDB as any, "DB");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await db.prepare("INSERT INTO t VALUES (?)").bind(1).run();
			root.end();
		});

		const spans = spanExporter.getFinishedSpans().filter((s) => s.name === "D1 DB INSERT");
		expect(spans).toHaveLength(1);
		expect(spans[0].attributes["db.statement"]).toBe("INSERT INTO t VALUES (?)");
		expect(spans[0].attributes["db.cloudflare.method"]).toBe("run");
	});

	it("multiple bind() calls still produce one span", async () => {
		const fakeDB = makeFakeDB();
		const db = instrumentD1(fakeDB as any, "DB");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await db.prepare("INSERT INTO t VALUES (?, ?)").bind(1).bind(2).run();
			root.end();
		});

		const insertSpans = spanExporter.getFinishedSpans().filter((s) => s.name === "D1 DB INSERT");
		expect(insertSpans).toHaveLength(1);
	});
});

describe("instrumentD1 — all() and raw()", () => {
	it("all() emits one span with method=all", async () => {
		const fakeDB = makeFakeDB();
		const db = instrumentD1(fakeDB as any, "DB");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await db.prepare("SELECT * FROM users").all();
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "D1 DB SELECT")!;
		expect(span).toBeDefined();
		expect(span.attributes["db.cloudflare.method"]).toBe("all");
	});

	it("raw() emits one span with method=raw", async () => {
		const fakeDB = makeFakeDB();
		const db = instrumentD1(fakeDB as any, "DB");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await db.prepare("SELECT id, name FROM users").raw();
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "D1 DB SELECT")!;
		expect(span).toBeDefined();
		expect(span.attributes["db.cloudflare.method"]).toBe("raw");
	});
});

describe("instrumentD1 — batch()", () => {
	it("one span 'D1 DB BATCH' with batch_size=2", async () => {
		const fakeDB = makeFakeDB();
		const db = instrumentD1(fakeDB as any, "DB");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			const s1 = db.prepare("SELECT 1");
			const s2 = db.prepare("SELECT 2");
			await db.batch([s1, s2]);
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "D1 DB BATCH")!;
		expect(span).toBeDefined();
		expect(span.attributes["db.cloudflare.batch_size"]).toBe(2);
	});

	it("batch receives unwrapped (raw) statements — not proxies", async () => {
		const fakeDB = makeFakeDB();
		const db = instrumentD1(fakeDB as any, "DB");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			const s1 = db.prepare("SELECT 1");
			const s2 = db.prepare("SELECT 2");
			await db.batch([s1, s2]);
			root.end();
		});

		// fakeDB._batchReceived should contain the raw statements, not proxies
		// Verify: raw statements have no RAW_STMT symbol (they're plain objects)
		const received = (fakeDB as FakeDB)._batchReceived;
		expect(received).toHaveLength(2);
		// A proxy would have RAW_STMT accessible — raw stmts do not
		for (const stmt of received) {
			// Real raw stmts are the makeFakeStmt objects which have _sql
			expect((stmt as any)._sql).toBeDefined();
			// And they should NOT themselves be proxies wrapping something
			// (i.e. accessing RAW_STMT on raw should return undefined)
			const innerRaw = (stmt as any)[Symbol.for("d1.raw_stmt")];
			expect(innerRaw).toBeUndefined();
		}
	});
});

describe("instrumentD1 — exec()", () => {
	it("exec('DELETE FROM t') → span 'D1 DB DELETE'", async () => {
		const fakeDB = makeFakeDB();
		const db = instrumentD1(fakeDB as any, "DB");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await db.exec("DELETE FROM t");
			root.end();
		});

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "D1 DB DELETE")!;
		expect(span).toBeDefined();
		expect(span.attributes["db.statement"]).toBe("DELETE FROM t");
		expect(span.attributes["db.operation"]).toBe("DELETE");
		expect(span.attributes["db.cloudflare.method"]).toBe("exec");
	});
});

describe("instrumentD1 — db.statement NOT on metric labels", () => {
	it("metric data point has no db.statement attribute", async () => {
		const fakeDB = makeFakeDB();
		const db = instrumentD1(fakeDB as any, "DB");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await db.prepare("SELECT secret FROM passwords").first();
			root.end();
		});

		const allMetrics = await getAllMetrics();
		const dur = getDurationMetric(allMetrics as any);
		expect(dur).toBeDefined();

		const dp = dur!.dataPoints[0];
		expect(dp.attributes).not.toHaveProperty("db.statement");
		// bounded attrs present
		expect(dp.attributes["cloudflare.binding.type"]).toBe("d1");
		expect(dp.attributes["cloudflare.binding.name"]).toBe("DB");
		expect(dp.attributes.operation).toBe("SELECT");
	});
});

describe("instrumentD1 — metrics", () => {
	it("records duration metric on successful op", async () => {
		const fakeDB = makeFakeDB();
		const db = instrumentD1(fakeDB as any, "DB");

		const tracer = trace.getTracer("test");
		await tracer.startActiveSpan("root", async (root) => {
			await db.prepare("SELECT 1").first();
			root.end();
		});

		const allMetrics = await getAllMetrics();
		const dur = getDurationMetric(allMetrics as any);
		expect(dur).toBeDefined();
		expect(dur!.descriptor.unit).toBe("ms");
		expect(dur!.dataPoints[0].attributes).toMatchObject({
			"cloudflare.binding.type": "d1",
			"cloudflare.binding.name": "DB",
			operation: "SELECT",
			status: "ok",
		});
	});

	it("status=error on thrown op, exception on span, rethrows", async () => {
		const err = new Error("D1 unavailable");
		const fakeDB = makeFakeDB();
		// Make first() throw
		(fakeDB.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
			const stmt = makeFakeStmt(sql);
			(stmt.first as ReturnType<typeof vi.fn>).mockRejectedValue(err);
			return stmt;
		});
		const db = instrumentD1(fakeDB as any, "DB");

		const tracer = trace.getTracer("test");
		await expect(
			tracer.startActiveSpan("root", async (root) => {
				try {
					return await db.prepare("SELECT 1").first();
				} finally {
					root.end();
				}
			}),
		).rejects.toThrow("D1 unavailable");

		const allMetrics = await getAllMetrics();
		const dur = getDurationMetric(allMetrics as any);
		expect(dur!.dataPoints[0].attributes.status).toBe("error");

		const span = spanExporter.getFinishedSpans().find((s) => s.name === "D1 DB SELECT")!;
		expect(span).toBeDefined();
		expect(span.status.code).toBe(SpanStatusCode.ERROR);
		expect(span.events).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "exception" })]),
		);
	});
});

describe("instrumentD1 — trace continuity", () => {
	it("D1 span traceId equals root request span traceId", async () => {
		const fakeDB = makeFakeDB();
		const db = instrumentD1(fakeDB as any, "DB");

		const tracer = trace.getTracer("test-request");
		let rootTraceId: string | undefined;

		await tracer.startActiveSpan("GET /api/users", { kind: SpanKind.SERVER }, async (rootSpan) => {
			rootTraceId = rootSpan.spanContext().traceId;
			await db.prepare("SELECT * FROM users").all();
			rootSpan.end();
		});

		const spans = spanExporter.getFinishedSpans();
		const d1Span = spans.find((s) => s.name === "D1 DB SELECT");
		expect(d1Span).toBeDefined();
		expect(rootTraceId).toBeDefined();
		expect(d1Span!.spanContext().traceId).toBe(rootTraceId);
	});
});
