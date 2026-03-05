import { ExportResultCode } from "@opentelemetry/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the serializers
vi.mock("@opentelemetry/otlp-transformer", () => ({
	JsonTraceSerializer: {
		serializeRequest: vi.fn((spans: unknown[]) =>
			new TextEncoder().encode(JSON.stringify({ resourceSpans: spans })),
		),
	},
	JsonLogsSerializer: {
		serializeRequest: vi.fn((logs: unknown[]) =>
			new TextEncoder().encode(JSON.stringify({ resourceLogs: logs })),
		),
	},
	JsonMetricsSerializer: {
		serializeRequest: vi.fn((metrics: unknown) =>
			new TextEncoder().encode(JSON.stringify({ resourceMetrics: metrics })),
		),
	},
}));

const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

// Mock getOriginalFetch to return our mockFetch
vi.mock("../src/instrument-fetch.js", async () => {
	const actual = await vi.importActual<typeof import("../src/instrument-fetch.js")>(
		"../src/instrument-fetch.js",
	);
	return {
		...actual,
		getOriginalFetch: () => mockFetch,
	};
});

import { FetchLogExporter, FetchMetricExporter, FetchTraceExporter } from "../src/exporters.js";

beforeEach(() => {
	mockFetch.mockReset();
	mockFetch.mockResolvedValue(new Response(null, { status: 200 }));
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("FetchTraceExporter", () => {
	it("sends spans via fetch POST to configured URL", async () => {
		const exporter = new FetchTraceExporter({
			url: "https://otel.example.com/v1/traces",
		});

		const result = await new Promise<{ code: number }>((resolve) => {
			exporter.export([{ name: "test-span" }] as any, resolve);
		});

		expect(result.code).toBe(ExportResultCode.SUCCESS);
		expect(mockFetch).toHaveBeenCalledOnce();

		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toBe("https://otel.example.com/v1/traces");
		expect(init?.method).toBe("POST");
		expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
	});

	it("passes custom headers", async () => {
		const exporter = new FetchTraceExporter({
			url: "https://otel.example.com/v1/traces",
			headers: { "X-API-Key": "secret" },
		});

		await new Promise<{ code: number }>((resolve) => {
			exporter.export([{ name: "span" }] as any, resolve);
		});

		const [, init] = mockFetch.mock.calls[0];
		expect((init?.headers as Record<string, string>)["X-API-Key"]).toBe("secret");
	});

	it("returns FAILED on HTTP error", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(null, { status: 500, statusText: "Server Error" }),
		);

		const exporter = new FetchTraceExporter({
			url: "https://otel.example.com/v1/traces",
		});

		const result = await new Promise<{ code: number; error?: Error }>((resolve) => {
			exporter.export([{ name: "span" }] as any, resolve);
		});

		expect(result.code).toBe(ExportResultCode.FAILED);
		expect(result.error?.message).toContain("500");
	});

	it("returns FAILED on network error", async () => {
		mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

		const exporter = new FetchTraceExporter({
			url: "https://otel.example.com/v1/traces",
		});

		const result = await new Promise<{ code: number; error?: Error }>((resolve) => {
			exporter.export([{ name: "span" }] as any, resolve);
		});

		expect(result.code).toBe(ExportResultCode.FAILED);
		expect(result.error?.message).toBe("Failed to fetch");
	});

	it("returns FAILED after shutdown", async () => {
		const exporter = new FetchTraceExporter({
			url: "https://otel.example.com/v1/traces",
		});

		await exporter.shutdown();

		const result = await new Promise<{ code: number; error?: Error }>((resolve) => {
			exporter.export([{ name: "span" }] as any, resolve);
		});

		expect(result.code).toBe(ExportResultCode.FAILED);
		expect(result.error?.message).toContain("shut down");
		expect(mockFetch).not.toHaveBeenCalled();
	});
});

describe("FetchLogExporter", () => {
	it("sends logs via fetch POST", async () => {
		const exporter = new FetchLogExporter({
			url: "https://otel.example.com/v1/logs",
		});

		const result = await new Promise<{ code: number }>((resolve) => {
			exporter.export([{ hrTime: [100, 0], body: "test log" }] as any, resolve);
		});

		expect(result.code).toBe(ExportResultCode.SUCCESS);
		expect(mockFetch).toHaveBeenCalledOnce();
	});

	it("deduplicates timestamps — bumps colliding entries by 1ms", async () => {
		const exporter = new FetchLogExporter({
			url: "https://otel.example.com/v1/logs",
		});

		const logs = [
			{ hrTime: [100, 500_000_000], body: "log-1" },
			{ hrTime: [100, 500_000_000], body: "log-2" },
			{ hrTime: [100, 500_000_000], body: "log-3" },
		] as any;

		await new Promise<{ code: number }>((resolve) => {
			exporter.export(logs, resolve);
		});

		// After dedup: log-1 stays, log-2 gets +1ms, log-3 gets +2ms
		expect(logs[0].hrTime).toEqual([100, 500_000_000]);
		expect(logs[1].hrTime).toEqual([100, 501_000_000]);
		expect(logs[2].hrTime).toEqual([100, 502_000_000]);
	});

	it("handles nanosecond overflow when bumping timestamps", async () => {
		const exporter = new FetchLogExporter({
			url: "https://otel.example.com/v1/logs",
		});

		const logs = [
			{ hrTime: [100, 999_000_000], body: "log-1" },
			{ hrTime: [100, 999_000_000], body: "log-2" },
		] as any;

		await new Promise<{ code: number }>((resolve) => {
			exporter.export(logs, resolve);
		});

		// 999_000_000 + 1_000_000 = 1_000_000_000 → overflow → [101, 0]
		expect(logs[0].hrTime).toEqual([100, 999_000_000]);
		expect(logs[1].hrTime).toEqual([101, 0]);
	});

	it("does not bump if timestamps are already ordered", async () => {
		const exporter = new FetchLogExporter({
			url: "https://otel.example.com/v1/logs",
		});

		const logs = [
			{ hrTime: [100, 0], body: "log-1" },
			{ hrTime: [100, 5_000_000], body: "log-2" },
			{ hrTime: [101, 0], body: "log-3" },
		] as any;

		await new Promise<{ code: number }>((resolve) => {
			exporter.export(logs, resolve);
		});

		// Timestamps already ordered — no changes
		expect(logs[0].hrTime).toEqual([100, 0]);
		expect(logs[1].hrTime).toEqual([100, 5_000_000]);
		expect(logs[2].hrTime).toEqual([101, 0]);
	});

	it("returns FAILED after shutdown", async () => {
		const exporter = new FetchLogExporter({
			url: "https://otel.example.com/v1/logs",
		});

		await exporter.shutdown();

		const result = await new Promise<{ code: number; error?: Error }>((resolve) => {
			exporter.export([{ hrTime: [100, 0] }] as any, resolve);
		});

		expect(result.code).toBe(ExportResultCode.FAILED);
		expect(mockFetch).not.toHaveBeenCalled();
	});
});

describe("FetchMetricExporter", () => {
	it("sends metrics via fetch POST", async () => {
		const exporter = new FetchMetricExporter({
			url: "https://otel.example.com/v1/metrics",
		});

		const result = await new Promise<{ code: number }>((resolve) => {
			exporter.export({ resource: {}, scopeMetrics: [] } as any, resolve);
		});

		expect(result.code).toBe(ExportResultCode.SUCCESS);
		expect(mockFetch).toHaveBeenCalledOnce();
	});

	it("returns FAILED after shutdown", async () => {
		const exporter = new FetchMetricExporter({
			url: "https://otel.example.com/v1/metrics",
		});

		await exporter.shutdown();

		const result = await new Promise<{ code: number; error?: Error }>((resolve) => {
			exporter.export({ resource: {}, scopeMetrics: [] } as any, resolve);
		});

		expect(result.code).toBe(ExportResultCode.FAILED);
		expect(mockFetch).not.toHaveBeenCalled();
	});
});
