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

import { configureDb, getQueryName, withQueryName } from "../src/db/index.js";

describe("db", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		configureDb();
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
	// ── configureDb({ redactParams }) ─────────────────────────────

	describe("redactParams", () => {
		const SECRET = "Budi Santoso";
		const failedQuery = () => {
			const err = new Error(`Failed query: update "t" set "name" = $1\nparams: ${SECRET},42`);
			err.name = "DrizzleQueryError";
			return err;
		};
		const everything = () =>
			JSON.stringify([
				mockSpan.setStatus.mock.calls,
				mockSpan.recordException.mock.calls.map(([e]: [Error]) => ({
					name: e.name,
					message: e.message,
					stack: e.stack,
				})),
			]);

		it("is off by default: the params stay in status and exception", async () => {
			// Fresh module instance: `beforeEach` calls configureDb(), which would hide the module default.
			vi.resetModules();
			const fresh = await import("../src/db/index.js");
			const err = failedQuery();
			await expect(fresh.withQueryName("q", () => Promise.reject(err))).rejects.toBe(err);
			expect(everything()).toContain(SECRET);
			expect(mockSpan.recordException).toHaveBeenCalledWith(err);
		});

		it("drops the params from status, exception message and stack (async)", async () => {
			configureDb({ redactParams: true });
			await expect(withQueryName("q", () => Promise.reject(failedQuery()))).rejects.toThrow();
			expect(everything()).not.toContain(SECRET);
			expect(mockSpan.setStatus).toHaveBeenCalledWith({
				code: SpanStatusCode.ERROR,
				message: 'Failed query: update "t" set "name" = $1',
			});
			const [recorded] = mockSpan.recordException.mock.calls[0] as [Error];
			expect(recorded.name).toBe("DrizzleQueryError");
			expect(recorded.message).toBe('Failed query: update "t" set "name" = $1');
		});

		it("drops the params on a sync throw too", () => {
			configureDb({ redactParams: true });
			expect(() =>
				withQueryName("q", () => {
					throw failedQuery();
				}),
			).toThrow();
			expect(everything()).not.toContain(SECRET);
		});

		it("re-throws the ORIGINAL error unchanged", async () => {
			configureDb({ redactParams: true });
			const err = failedQuery();
			await expect(withQueryName("q", () => Promise.reject(err))).rejects.toBe(err);
			expect(err.message).toContain(SECRET);
		});

		it("leaves an error without a params line alone", async () => {
			configureDb({ redactParams: true });
			const err = new Error("connection refused");
			await expect(withQueryName("q", () => Promise.reject(err))).rejects.toBe(err);
			expect(mockSpan.recordException).toHaveBeenCalledWith(err);
			expect(mockSpan.setStatus).toHaveBeenCalledWith({
				code: SpanStatusCode.ERROR,
				message: "connection refused",
			});
		});

		it("handles a non-Error thrown value", () => {
			configureDb({ redactParams: true });
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

		it("configureDb() with no argument turns it back off", async () => {
			configureDb({ redactParams: true });
			configureDb();
			await expect(withQueryName("q", () => Promise.reject(failedQuery()))).rejects.toThrow();
			expect(everything()).toContain(SECRET);
		});
	});
});
