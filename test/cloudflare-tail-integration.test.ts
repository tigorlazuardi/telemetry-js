import { SpanStatusCode } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist shared mocks
const { mockExport, mockForceFlush } = vi.hoisted(() => ({
	mockExport: vi.fn((_spans: unknown, cb: (result: { code: number }) => void) => cb({ code: 0 })),
	mockForceFlush: vi.fn().mockResolvedValue(undefined),
}));

// Mock the fetch exporter — use classes so `new FetchTraceExporter(...)` works
vi.mock("../src/shared/exporters.js", () => {
	class FetchTraceExporter {
		export = mockExport;
		shutdown = vi.fn().mockResolvedValue(undefined);
		forceFlush = mockForceFlush;
	}
	class FetchMetricExporter {
		export = vi.fn();
		shutdown = vi.fn().mockResolvedValue(undefined);
	}
	class FetchLogExporter {
		export = vi.fn();
		shutdown = vi.fn().mockResolvedValue(undefined);
	}
	return { FetchTraceExporter, FetchMetricExporter, FetchLogExporter };
});

// Mock perf_hooks (required by adapter.ts top-level side effect)
vi.mock("node:perf_hooks", () => ({
	performance: { timeOrigin: 0, now: () => 0 },
}));

// Mock node:async_hooks (required by adapter.ts)
vi.mock("node:async_hooks", () => {
	class AsyncLocalStorage {
		getStore() {
			return undefined;
		}
		run(_store: unknown, fn: (...args: unknown[]) => unknown, ...args: unknown[]) {
			return fn(...args);
		}
	}
	return { AsyncLocalStorage };
});

import { cloudflareWorkerAdapter } from "../src/cloudflare/adapter.js";
import { keepAll, keepOnError } from "../src/cloudflare/sampling.js";

describe("cloudflare adapter tail-sampling wiring", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(async () => {
		// Reset OTel global providers to prevent state leakage between tests
		const { trace, context, metrics } = await import("@opentelemetry/api");
		trace.disable();
		context.disable();
		metrics.disable();
	});

	it("without sampling config → no flushTrace method, SimpleSpanProcessor used", () => {
		const result = cloudflareWorkerAdapter.setup({
			serviceName: "test",
			exporterEndpoint: "https://otel.example.com",
		});
		expect(result.flushTrace).toBeUndefined();
	});

	it("with sampling config → flushTrace method exists", () => {
		const result = cloudflareWorkerAdapter.setup({
			serviceName: "test",
			exporterEndpoint: "https://otel.example.com",
			sampling: {},
		});
		expect(result.flushTrace).toBeDefined();
		expect(typeof result.flushTrace).toBe("function");
	});

	it("with sampling config → default tail sampler keeps error traces", async () => {
		const result = cloudflareWorkerAdapter.setup({
			serviceName: "test",
			exporterEndpoint: "https://otel.example.com",
			sampling: { tailSampler: keepAll },
		});

		const tracer = result.provider.getTracer("test");
		let rootTraceId = "";

		tracer.startActiveSpan("root", (span) => {
			span.setStatus({ code: SpanStatusCode.ERROR });
			rootTraceId = span.spanContext().traceId;
			span.end();
		});

		await result.flushTrace!(rootTraceId);

		// Export should have been called (keepAll sampler)
		expect(mockExport).toHaveBeenCalled();
	});

	it("with sampling → non-breaking for no-sampling path (exports per span)", async () => {
		const result = cloudflareWorkerAdapter.setup({
			serviceName: "test",
			exporterEndpoint: "https://otel.example.com",
			// No sampling config
		});

		const tracer = result.provider.getTracer("test");
		tracer.startActiveSpan("root", (span) => {
			span.end();
		});

		// Without tail sampling, span is exported immediately on end
		// (SimpleSpanProcessor behavior)
		expect(mockExport).toHaveBeenCalled();
	});

	it("with keepOnError sampler → drops non-error trace", async () => {
		const result = cloudflareWorkerAdapter.setup({
			serviceName: "test",
			exporterEndpoint: "https://otel.example.com",
			sampling: { tailSampler: keepOnError },
		});

		const tracer = result.provider.getTracer("test");
		let rootTraceId = "";
		tracer.startActiveSpan("root", (span) => {
			// No error set — OK status
			rootTraceId = span.spanContext().traceId;
			span.end();
		});

		await result.flushTrace!(rootTraceId);
		// keepOnError drops non-error traces → no export
		expect(mockExport).not.toHaveBeenCalled();
	});
});
