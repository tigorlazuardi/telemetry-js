import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSpan, startActiveSpanSpy, mockExtract } = vi.hoisted(() => {
	const span = {
		setStatus: vi.fn(),
		recordException: vi.fn(),
		end: vi.fn(),
		setAttribute: vi.fn(),
	};
	return {
		mockSpan: span,
		startActiveSpanSpy: vi.fn(
			(_name: string, _opts: unknown, _ctx: unknown, fn: (s: typeof span) => unknown) => fn(span),
		),
		mockExtract: vi.fn((_ctx: unknown, _carrier: unknown, _getter?: unknown) => ({
			__extractedFrom: "carrier",
		})),
	};
});

vi.mock("@opentelemetry/api", async () => {
	const actual = await vi.importActual("@opentelemetry/api");
	return {
		...actual,
		propagation: {
			...(actual as Record<string, unknown>).propagation,
			extract: mockExtract,
		},
		trace: {
			...(actual as Record<string, unknown>).trace,
			getTracer: () => ({
				startActiveSpan: startActiveSpanSpy,
			}),
			setSpan: (actual as { trace: { setSpan: unknown } }).trace.setSpan,
		},
	};
});

import { withTrace } from "../src/shared/with-trace.js";

describe("withTrace", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("span name resolution", () => {
		it("uses function name for named functions", () => {
			withTrace(function myOperation(_span) {
				return 42;
			});

			expect(startActiveSpanSpy).toHaveBeenCalledWith(
				"myOperation",
				expect.any(Object),
				expect.anything(),
				expect.any(Function),
			);
		});

		it("derives name from stack for anonymous functions", () => {
			withTrace((_span) => 42);

			const spanName = startActiveSpanSpy.mock.calls[0][0] as string;
			// Should be either a file:line string or "anonymous"
			expect(typeof spanName).toBe("string");
			expect(spanName.length).toBeGreaterThan(0);
		});

		it("uses opts.name when provided, overriding auto-detect", () => {
			withTrace(
				function autoName(_span) {
					return 42;
				},
				{ name: "custom-name" },
			);

			expect(startActiveSpanSpy).toHaveBeenCalledWith(
				"custom-name",
				expect.any(Object),
				expect.anything(),
				expect.any(Function),
			);
		});
	});

	describe("options passthrough", () => {
		it("passes kind to span options", () => {
			withTrace((_span) => 42, { kind: SpanKind.SERVER });

			expect(startActiveSpanSpy).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ kind: SpanKind.SERVER }),
				expect.anything(),
				expect.any(Function),
			);
		});

		it("passes attributes to span options", () => {
			withTrace((_span) => 42, {
				attributes: { "test.key": "test-value" },
			});

			expect(startActiveSpanSpy).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					attributes: { "test.key": "test-value" },
				}),
				expect.anything(),
				expect.any(Function),
			);
		});

		it("defaults kind to INTERNAL when not specified", () => {
			withTrace((_span) => 42);

			expect(startActiveSpanSpy).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ kind: SpanKind.INTERNAL }),
				expect.anything(),
				expect.any(Function),
			);
		});
	});

	describe("parent context", () => {
		it("accepts a Span as parent", () => {
			const parentSpan = {
				spanContext: () => ({
					traceId: "abc123",
					spanId: "def456",
					traceFlags: 1,
				}),
			};

			// Should not throw
			withTrace((_span) => 42, { parent: parentSpan as never });

			expect(startActiveSpanSpy).toHaveBeenCalled();
		});

		it("accepts a W3C traceparent string as parent", () => {
			const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

			// Should not throw
			withTrace((_span) => 42, { parent: traceparent });

			expect(startActiveSpanSpy).toHaveBeenCalled();
		});
	});

	describe("sync functions", () => {
		it("returns the value from a sync function", () => {
			const result = withTrace((_span) => 42);
			expect(result).toBe(42);
		});

		it("ends the span after sync return", () => {
			withTrace((_span) => "hello");
			expect(mockSpan.end).toHaveBeenCalled();
		});
	});

	describe("async functions", () => {
		it("returns the value from an async function", async () => {
			const result = await withTrace(async (_span) => 42);
			expect(result).toBe(42);
		});

		it("ends the span after async resolution", async () => {
			await withTrace(async (_span) => "hello");
			expect(mockSpan.end).toHaveBeenCalled();
		});
	});

	describe("error handling", () => {
		it("sets ERROR status, records exception, and re-throws for sync errors", () => {
			const error = new Error("sync boom");

			expect(() =>
				withTrace((_span) => {
					throw error;
				}),
			).toThrow("sync boom");

			expect(mockSpan.setStatus).toHaveBeenCalledWith({
				code: SpanStatusCode.ERROR,
				message: "sync boom",
			});
			expect(mockSpan.recordException).toHaveBeenCalledWith(error);
			expect(mockSpan.end).toHaveBeenCalled();
		});

		it("sets ERROR status, records exception, and re-throws for async errors", async () => {
			const error = new Error("async boom");

			await expect(
				withTrace(async (_span) => {
					throw error;
				}),
			).rejects.toThrow("async boom");

			expect(mockSpan.setStatus).toHaveBeenCalledWith({
				code: SpanStatusCode.ERROR,
				message: "async boom",
			});
			expect(mockSpan.recordException).toHaveBeenCalledWith(error);
			expect(mockSpan.end).toHaveBeenCalled();
		});

		it("handles non-Error thrown values", () => {
			expect(() =>
				withTrace((_span) => {
					throw "string error";
				}),
			).toThrow("string error");

			expect(mockSpan.setStatus).toHaveBeenCalledWith({
				code: SpanStatusCode.ERROR,
				message: "string error",
			});
		});
	});

	describe("carrier option", () => {
		it("extracts context from a carrier object via propagation.extract", () => {
			const { ROOT_CONTEXT } = require("@opentelemetry/api");
			const carrier = {
				traceparent: "00-abc123-def456-01",
				tracestate: "vendor=opaque",
			};

			withTrace((_span) => 42, { carrier });

			expect(mockExtract).toHaveBeenCalledOnce();
			const [ctx, carrierArg, getter] = mockExtract.mock.calls[0] as unknown[];
			expect(ctx).toBe(ROOT_CONTEXT);
			expect(carrierArg).toBe(carrier);
			// Verify the getter reads string values correctly
			const g = getter as {
				keys: (c: Record<string, unknown>) => string[];
				get: (c: Record<string, unknown>, k: string) => string | undefined;
			};
			expect(g.keys(carrier)).toEqual(["traceparent", "tracestate"]);
			expect(g.get(carrier, "traceparent")).toBe("00-abc123-def456-01");

			// The extracted context should be passed to startActiveSpan
			const parentCtx = startActiveSpanSpy.mock.calls[0][2];
			expect(parentCtx).toEqual({ __extractedFrom: "carrier" });
		});

		it("parent takes precedence over carrier", () => {
			const carrier = {
				traceparent: "00-abc123-def456-01",
			};
			const traceparent = "00-ffff-aaaa-01";

			withTrace((_span) => 42, { parent: traceparent, carrier });

			// propagation.extract is called for the parent string, not the carrier
			expect(mockExtract).toHaveBeenCalledOnce();
			const [, carrierArg] = mockExtract.mock.calls[0] as unknown[];
			// The carrier passed to extract should be { traceparent } from the parent string path
			expect(carrierArg).toEqual({ traceparent });
		});

		it("ignores non-object carrier values", () => {
			withTrace((_span) => 42, { carrier: "not-an-object" });

			// Should not call propagation.extract for the carrier
			expect(mockExtract).not.toHaveBeenCalled();
		});

		it("ignores null carrier", () => {
			withTrace((_span) => 42, { carrier: null });

			expect(mockExtract).not.toHaveBeenCalled();
		});

		it("ignores undefined carrier", () => {
			withTrace((_span) => 42, { carrier: undefined });

			expect(mockExtract).not.toHaveBeenCalled();
		});

		it("getter returns undefined for non-string values in carrier", () => {
			const carrier = {
				traceparent: "00-abc123-def456-01",
				numericField: 42,
				nullField: null,
			};

			withTrace((_span) => 42, { carrier });

			const getter = mockExtract.mock.calls[0][2] as {
				get: (c: Record<string, unknown>, k: string) => string | undefined;
			};
			expect(getter.get(carrier, "traceparent")).toBe("00-abc123-def456-01");
			expect(getter.get(carrier, "numericField")).toBeUndefined();
			expect(getter.get(carrier, "nullField")).toBeUndefined();
		});
	});
});
