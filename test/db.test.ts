import { type context, createContextKey, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSpan, startActiveSpanSpy } = vi.hoisted(() => {
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
	};
});

vi.mock("@opentelemetry/api", async () => {
	const actual = await vi.importActual<typeof import("@opentelemetry/api")>("@opentelemetry/api");
	return {
		...actual,
		trace: {
			...actual.trace,
			getTracer: () => ({
				startActiveSpan: startActiveSpanSpy,
			}),
		},
	};
});

import { getQueryName, withQueryName } from "../src/db/index.js";

describe("db", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ── getQueryName ──────────────────────────────────────────────

	describe("getQueryName", () => {
		it("returns undefined outside withQueryName scope", () => {
			expect(getQueryName()).toBeUndefined();
		});
	});

	// ── withQueryName ─────────────────────────────────────────────

	describe("withQueryName", () => {
		it("returns sync value from callback", () => {
			const result = withQueryName("getUser", () => 42);
			expect(result).toBe(42);
		});

		it("returns resolved promise from async callback", async () => {
			const result = withQueryName("getUser", () => Promise.resolve("alice"));
			await expect(result).resolves.toBe("alice");
		});

		it("creates a CLIENT span with the query name", () => {
			withQueryName("listOrders", () => "ok");

			expect(startActiveSpanSpy).toHaveBeenCalledWith(
				"db.listOrders",
				{ kind: SpanKind.CLIENT, attributes: { "db.query.name": "listOrders" } },
				expect.anything(),
				expect.any(Function),
			);
		});

		it("ends span after sync callback", () => {
			withQueryName("q", () => "ok");
			expect(mockSpan.end).toHaveBeenCalledOnce();
		});

		it("ends span after async callback resolves", async () => {
			await withQueryName("q", () => Promise.resolve("ok"));
			expect(mockSpan.end).toHaveBeenCalledOnce();
		});

		it("records error and re-throws on sync throw", () => {
			const err = new Error("sync fail");
			expect(() =>
				withQueryName("q", () => {
					throw err;
				}),
			).toThrow(err);
			expect(mockSpan.setStatus).toHaveBeenCalledWith({
				code: SpanStatusCode.ERROR,
				message: "sync fail",
			});
			expect(mockSpan.recordException).toHaveBeenCalledWith(err);
			expect(mockSpan.end).toHaveBeenCalledOnce();
		});

		it("records error and re-throws on async rejection", async () => {
			const err = new Error("async fail");
			await expect(withQueryName("q", () => Promise.reject(err))).rejects.toThrow(err);
			expect(mockSpan.setStatus).toHaveBeenCalledWith({
				code: SpanStatusCode.ERROR,
				message: "async fail",
			});
			expect(mockSpan.recordException).toHaveBeenCalledWith(err);
			expect(mockSpan.end).toHaveBeenCalledOnce();
		});

		it("records non-Error thrown value", () => {
			expect(() =>
				withQueryName("q", () => {
					throw "string error";
				}),
			).toThrow("string error");
			expect(mockSpan.setStatus).toHaveBeenCalledWith({
				code: SpanStatusCode.ERROR,
				message: "string error",
			});
		});

		it("sets query name in context for the callback", () => {
			// Use real context to verify the context key is set.
			// We need to intercept the context passed to startActiveSpan.
			let capturedCtx: unknown;
			startActiveSpanSpy.mockImplementationOnce(
				(_name: string, _opts: unknown, ctx: unknown, fn: (s: typeof mockSpan) => unknown) => {
					capturedCtx = ctx;
					return fn(mockSpan);
				},
			);

			withQueryName("findById", () => "ok");

			// The context passed to startActiveSpan should contain our query name.
			// We verify by checking it's a context object with our value set.
			const ctx = capturedCtx as ReturnType<typeof context.active>;
			expect(ctx.getValue(createContextKey("telemetry-js:query-name"))).toBe("findById");
		});
	});
});
