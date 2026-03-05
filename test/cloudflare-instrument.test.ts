import { SpanStatusCode } from "@opentelemetry/api";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock cloudflareWorkerAdapter - all fns defined inside factory to avoid hoisting issues
const { mockForceFlush } = vi.hoisted(() => ({
	mockForceFlush: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/cloudflare/adapter.js", () => {
	return {
		cloudflareWorkerAdapter: {
			name: "cloudflare-worker",
			detect: () => true,
			setup: vi.fn().mockReturnValue({
				resource: { attributes: {} },
				provider: {},
				meterProvider: {},
				logger: { debug() {}, info() {}, warn() {}, error() {} },
				shutdown: vi.fn().mockResolvedValue(undefined),
				forceFlush: mockForceFlush,
			}),
		},
	};
});

// Mock the trace API
const mockSpanFns = {
	setAttribute: vi.fn(),
	setStatus: vi.fn(),
	recordException: vi.fn(),
	end: vi.fn(),
	spanContext: vi.fn().mockReturnValue({
		traceId: "0af7651916cd43dd8448eb211c80319c",
		spanId: "b7ad6b7169203331",
		traceFlags: 1,
	}),
};

const { mockExtract, mockInject } = vi.hoisted(() => ({
	mockExtract: vi.fn((_ctx: unknown, _carrier: unknown, _getter?: unknown) => ({})),
	mockInject: vi.fn(),
}));

vi.mock("@opentelemetry/api", async () => {
	const actual = await vi.importActual("@opentelemetry/api");
	return {
		...actual,
		context: {
			...(actual as Record<string, unknown>).context,
			active: () => ({}),
		},
		propagation: {
			extract: mockExtract,
			inject: mockInject,
		},
		trace: {
			getTracer: () => ({
				startActiveSpan: (
					_name: string,
					_opts: unknown,
					_ctx: unknown,
					fn?: (...args: unknown[]) => unknown,
				) => {
					// Support both 3-arg (name, opts, fn) and 4-arg (name, opts, ctx, fn) overloads
					const callback = typeof _ctx === "function" ? _ctx : fn;
					return (callback as (...args: unknown[]) => unknown)(mockSpanFns);
				},
			}),
		},
	};
});

import { cloudflareWorkerAdapter } from "../src/cloudflare/adapter.js";
import { _resetInstrumentState, instrument, traceHandler } from "../src/cloudflare/instrument.js";

function createMockCtx() {
	return {
		waitUntil: vi.fn(),
		passThroughOnException: vi.fn(),
	};
}

describe("instrument", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_resetInstrumentState();
	});

	describe("fetch handler", () => {
		it("wraps fetch handler and creates a span", async () => {
			const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));
			const handler = instrument({ fetch: originalFetch }, { serviceName: "test-service" });

			const req = new Request("https://example.com/api/test");
			const ctx = createMockCtx();

			const response = await handler.fetch!(req, {}, ctx);

			expect(originalFetch).toHaveBeenCalledWith(req, {}, ctx);
			expect(response).toBeInstanceOf(Response);
			expect(mockSpanFns.setAttribute).toHaveBeenCalledWith("http.status_code", 200);
			expect(mockSpanFns.end).toHaveBeenCalled();
			expect(ctx.waitUntil).toHaveBeenCalled();
		});

		it("sets error status on 5xx responses", async () => {
			const originalFetch = vi.fn().mockResolvedValue(new Response("error", { status: 500 }));
			const handler = instrument({ fetch: originalFetch }, { serviceName: "test-service" });

			const ctx = createMockCtx();
			await handler.fetch!(new Request("https://example.com/"), {}, ctx);

			expect(mockSpanFns.setStatus).toHaveBeenCalledWith({
				code: SpanStatusCode.ERROR,
			});
		});

		it("records exception on thrown error", async () => {
			const error = new Error("fetch failed");
			const originalFetch = vi.fn().mockRejectedValue(error);
			const handler = instrument({ fetch: originalFetch }, { serviceName: "test-service" });

			const ctx = createMockCtx();
			await expect(handler.fetch!(new Request("https://example.com/"), {}, ctx)).rejects.toThrow(
				"fetch failed",
			);

			expect(mockSpanFns.setStatus).toHaveBeenCalledWith({
				code: SpanStatusCode.ERROR,
				message: "fetch failed",
			});
			expect(mockSpanFns.recordException).toHaveBeenCalledWith(error);
			expect(mockSpanFns.end).toHaveBeenCalled();
			expect(ctx.waitUntil).toHaveBeenCalled();
		});
	});

	describe("scheduled handler", () => {
		it("wraps scheduled handler and creates a span", async () => {
			const originalScheduled = vi.fn().mockResolvedValue(undefined);
			const handler = instrument({ scheduled: originalScheduled }, { serviceName: "test-service" });

			const controller = {
				scheduledTime: Date.now(),
				cron: "*/5 * * * *",
				noRetry: vi.fn(),
			};
			const ctx = createMockCtx();

			await handler.scheduled!(controller, {}, ctx);

			expect(originalScheduled).toHaveBeenCalledWith(controller, {}, ctx);
			expect(mockSpanFns.end).toHaveBeenCalled();
			expect(ctx.waitUntil).toHaveBeenCalled();
		});

		it("records exception on thrown error", async () => {
			const error = new Error("scheduled failed");
			const originalScheduled = vi.fn().mockRejectedValue(error);
			const handler = instrument({ scheduled: originalScheduled }, { serviceName: "test-service" });

			const controller = {
				scheduledTime: Date.now(),
				cron: "*/5 * * * *",
				noRetry: vi.fn(),
			};
			const ctx = createMockCtx();

			await expect(handler.scheduled!(controller, {}, ctx)).rejects.toThrow("scheduled failed");

			expect(mockSpanFns.recordException).toHaveBeenCalledWith(error);
			expect(mockSpanFns.end).toHaveBeenCalled();
			expect(ctx.waitUntil).toHaveBeenCalled();
		});
	});

	describe("queue handler", () => {
		it("wraps queue handler and creates a span", async () => {
			const originalQueue = vi.fn().mockResolvedValue(undefined);
			const handler = instrument({ queue: originalQueue }, { serviceName: "test-service" });

			const batch = {
				queue: "my-queue",
				messages: [
					{
						id: "1",
						timestamp: new Date(),
						body: "msg1",
						attempts: 1,
						ack: vi.fn(),
						retry: vi.fn(),
					},
				],
				ackAll: vi.fn(),
				retryAll: vi.fn(),
			};
			const ctx = createMockCtx();

			await handler.queue!(batch, {}, ctx);

			expect(originalQueue).toHaveBeenCalledWith(batch, {}, ctx);
			expect(mockSpanFns.end).toHaveBeenCalled();
			expect(ctx.waitUntil).toHaveBeenCalled();
		});
	});

	describe("auto-init SDK", () => {
		it("initializes SDK on first call", async () => {
			const handler = instrument(
				{ fetch: vi.fn().mockResolvedValue(new Response("ok")) },
				{ serviceName: "auto-init-test" },
			);

			const ctx = createMockCtx();
			await handler.fetch!(new Request("https://example.com/"), {}, ctx);

			expect(cloudflareWorkerAdapter.setup).toHaveBeenCalledWith(
				expect.objectContaining({
					serviceName: "auto-init-test",
				}),
			);
		});

		it("does not re-initialize SDK on subsequent calls", async () => {
			const handler = instrument(
				{ fetch: vi.fn().mockImplementation(() => new Response("ok")) },
				{ serviceName: "auto-init-test" },
			);

			const ctx = createMockCtx();
			await handler.fetch!(new Request("https://example.com/"), {}, ctx);
			await handler.fetch!(new Request("https://example.com/other"), {}, ctx);

			expect(cloudflareWorkerAdapter.setup).toHaveBeenCalledTimes(1);
		});
	});

	describe("handler passthrough", () => {
		it("does not wrap handlers that are not defined", () => {
			const handler = instrument({}, { serviceName: "test-service" });

			expect(handler.fetch).toBeUndefined();
			expect(handler.scheduled).toBeUndefined();
			expect(handler.queue).toBeUndefined();
		});
	});

	describe("flush", () => {
		it("calls waitUntil with forceFlush promise", async () => {
			const handler = instrument(
				{ fetch: vi.fn().mockResolvedValue(new Response("ok")) },
				{ serviceName: "test-service" },
			);

			const ctx = createMockCtx();
			await handler.fetch!(new Request("https://example.com/"), {}, ctx);

			expect(ctx.waitUntil).toHaveBeenCalled();
			const waitUntilArg = ctx.waitUntil.mock.calls[0][0];
			expect(waitUntilArg).toBeInstanceOf(Promise);
		});

		it("forceFlush is called on each request", async () => {
			const handler = instrument(
				{ fetch: vi.fn().mockResolvedValue(new Response("ok")) },
				{ serviceName: "test-service", exporterEndpoint: "https://otel.example.com" },
			);

			const ctx = createMockCtx();
			await handler.fetch!(new Request("https://example.com/"), {}, ctx);

			// waitUntil is called with the result of flush(), which calls sdkResult.forceFlush()
			expect(ctx.waitUntil).toHaveBeenCalled();
			// Await the promise to ensure forceFlush was invoked
			await ctx.waitUntil.mock.calls[0][0];
			expect(mockForceFlush).toHaveBeenCalled();
		});
	});
});

describe("traceHandler", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("creates span with HTTP attributes from request", async () => {
		const ctx = createMockCtx();
		const request = new Request("https://example.com/api/test?q=1");

		await traceHandler({
			context: ctx,
			env: {},
			request,
			serviceName: "test-service",
			handler: () => new Response("ok"),
		});

		expect(mockSpanFns.setAttribute).toHaveBeenCalledWith("http.status_code", 200);
		expect(mockSpanFns.end).toHaveBeenCalled();
	});

	it("sets error status on 5xx response", async () => {
		const ctx = createMockCtx();
		const request = new Request("https://example.com/");

		await traceHandler({
			context: ctx,
			env: {},
			request,
			serviceName: "test-service",
			handler: () => new Response("error", { status: 503 }),
		});

		expect(mockSpanFns.setStatus).toHaveBeenCalledWith({
			code: SpanStatusCode.ERROR,
		});
	});

	it("records exception on thrown error", async () => {
		const ctx = createMockCtx();
		const request = new Request("https://example.com/");
		const error = new Error("handler failed");

		await expect(
			traceHandler({
				context: ctx,
				env: {},
				request,
				serviceName: "test-service",
				handler: () => {
					throw error;
				},
			}),
		).rejects.toThrow("handler failed");

		expect(mockSpanFns.setStatus).toHaveBeenCalledWith({
			code: SpanStatusCode.ERROR,
			message: "handler failed",
		});
		expect(mockSpanFns.recordException).toHaveBeenCalledWith(error);
		expect(mockSpanFns.end).toHaveBeenCalled();
	});

	it("calls ctx.waitUntil with onFlush", async () => {
		const ctx = createMockCtx();
		const onFlush = vi.fn().mockResolvedValue(undefined);

		await traceHandler({
			context: ctx,
			env: {},
			request: new Request("https://example.com/"),
			serviceName: "test-service",
			handler: () => new Response("ok"),
			onFlush,
		});

		expect(ctx.waitUntil).toHaveBeenCalled();
		await ctx.waitUntil.mock.calls[0][0];
		expect(onFlush).toHaveBeenCalled();
	});

	it("works without onFlush (no crash)", async () => {
		const ctx = createMockCtx();

		const response = await traceHandler({
			context: ctx,
			env: {},
			request: new Request("https://example.com/"),
			serviceName: "test-service",
			handler: () => new Response("ok"),
		});

		expect(response).toBeInstanceOf(Response);
		expect(ctx.waitUntil).toHaveBeenCalled();
	});

	it("extracts trace context from request headers", async () => {
		const ctx = createMockCtx();
		const request = new Request("https://example.com/", {
			headers: {
				traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
				tracestate: "congo=t61rcWkgMzE",
			},
		});

		await traceHandler({
			context: ctx,
			env: {},
			request,
			serviceName: "test-service",
			handler: () => new Response("ok"),
		});

		expect(mockExtract).toHaveBeenCalledWith(
			expect.anything(),
			request.headers,
			expect.objectContaining({
				keys: expect.any(Function),
				get: expect.any(Function),
			}),
		);
	});

	it("injects trace context into response headers", async () => {
		const ctx = createMockCtx();

		await traceHandler({
			context: ctx,
			env: {},
			request: new Request("https://example.com/"),
			serviceName: "test-service",
			handler: () => new Response("ok"),
		});

		expect(mockInject).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(Headers),
			expect.objectContaining({
				set: expect.any(Function),
			}),
		);
	});
});

describe("traceHandler auto-logging", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_resetInstrumentState();
	});

	function createMockLogger() {
		return {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};
	}

	it("logs info for 2xx responses with correct message format", async () => {
		const logger = createMockLogger();
		const ctx = createMockCtx();
		const body = JSON.stringify({ ok: true });

		await traceHandler({
			context: ctx,
			env: {},
			request: new Request("https://example.com/api/test?q=1"),
			serviceName: "test",
			handler: () => new Response(body, { headers: { "content-length": "12" } }),
			logger,
		});

		expect(logger.info).toHaveBeenCalledTimes(1);
		const [message, attrs] = logger.info.mock.calls[0];
		expect(message).toMatch(/^GET \/api\/test -- 200 \d+ms 12B$/);
		expect(attrs["http.request.method"]).toBe("GET");
		expect(attrs["http.request.path"]).toBe("/api/test");
		expect(attrs["http.request.query"]).toBe("?q=1");
		expect(attrs["http.response.status"]).toBe(200);
		expect(attrs["http.duration_ms"]).toBeTypeOf("number");
	});

	it("logs warn for 4xx responses", async () => {
		const logger = createMockLogger();
		const ctx = createMockCtx();

		await traceHandler({
			context: ctx,
			env: {},
			request: new Request("https://example.com/api/test"),
			serviceName: "test",
			handler: () => new Response("not found", { status: 404 }),
			logger,
		});

		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.info).not.toHaveBeenCalled();
		const [message] = logger.warn.mock.calls[0];
		expect(message).toMatch(/^GET \/api\/test -- 404/);
	});

	it("logs error for 5xx responses", async () => {
		const logger = createMockLogger();
		const ctx = createMockCtx();

		await traceHandler({
			context: ctx,
			env: {},
			request: new Request("https://example.com/api/test"),
			serviceName: "test",
			handler: () => new Response("server error", { status: 500 }),
			logger,
		});

		expect(logger.error).toHaveBeenCalledTimes(1);
		const [message] = logger.error.mock.calls[0];
		expect(message).toMatch(/^GET \/api\/test -- 500/);
	});

	it("logs error on thrown exceptions", async () => {
		const logger = createMockLogger();
		const ctx = createMockCtx();

		await expect(
			traceHandler({
				context: ctx,
				env: {},
				request: new Request("https://example.com/api/test"),
				serviceName: "test",
				handler: () => {
					throw new Error("boom");
				},
				logger,
			}),
		).rejects.toThrow("boom");

		expect(logger.error).toHaveBeenCalledTimes(1);
		const [message, attrs] = logger.error.mock.calls[0];
		expect(message).toMatch(/^GET \/api\/test -- FAILED/);
		expect(attrs["http.error"]).toBe("boom");
		expect(attrs["http.request.method"]).toBe("GET");
		expect(attrs["http.request.path"]).toBe("/api/test");
	});

	it("does not log when logger is false", async () => {
		const ctx = createMockCtx();

		await traceHandler({
			context: ctx,
			env: {},
			request: new Request("https://example.com/api/test"),
			serviceName: "test",
			handler: () => new Response("ok"),
			logger: false,
		});

		// No crash, no logger called
		expect(mockSpanFns.end).toHaveBeenCalled();
	});

	it("redacts sensitive headers by default", async () => {
		const logger = createMockLogger();
		const ctx = createMockCtx();

		await traceHandler({
			context: ctx,
			env: {},
			request: new Request("https://example.com/api/test", {
				headers: {
					authorization: "Bearer secret",
					"x-custom": "visible",
				},
			}),
			serviceName: "test",
			handler: () => new Response("ok"),
			logger,
		});

		const attrs = logger.info.mock.calls[0][1];
		const reqHeaders = JSON.parse(attrs["http.request.headers"] as string);
		expect(reqHeaders.authorization).toBe("[REDACTED]");
		expect(reqHeaders["x-custom"]).toBe("visible");
	});

	it("uses custom sensitiveHeaders when provided", async () => {
		const logger = createMockLogger();
		const ctx = createMockCtx();

		await traceHandler({
			context: ctx,
			env: {},
			request: new Request("https://example.com/api/test", {
				headers: {
					authorization: "Bearer secret",
					"x-secret": "hidden",
				},
			}),
			serviceName: "test",
			handler: () => new Response("ok"),
			sensitiveHeaders: ["x-secret"],
			logger,
		});

		const attrs = logger.info.mock.calls[0][1];
		const reqHeaders = JSON.parse(attrs["http.request.headers"] as string);
		// authorization NOT redacted because custom list overrides defaults
		expect(reqHeaders.authorization).toBe("Bearer secret");
		expect(reqHeaders["x-secret"]).toBe("[REDACTED]");
	});

	it("includes JSON request body in log", async () => {
		const logger = createMockLogger();
		const ctx = createMockCtx();
		const body = JSON.stringify({ name: "test" });

		await traceHandler({
			context: ctx,
			env: {},
			request: new Request("https://example.com/api/test", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			}),
			serviceName: "test",
			handler: () => new Response("ok"),
			logger,
		});

		const attrs = logger.info.mock.calls[0][1];
		expect(attrs["http.request.body"]).toBe(body);
	});

	it("includes JSON response body in log", async () => {
		const logger = createMockLogger();
		const ctx = createMockCtx();
		const responseBody = JSON.stringify({ result: "ok" });

		await traceHandler({
			context: ctx,
			env: {},
			request: new Request("https://example.com/api/test"),
			serviceName: "test",
			handler: () =>
				new Response(responseBody, {
					headers: { "content-type": "application/json" },
				}),
			logger,
		});

		const attrs = logger.info.mock.calls[0][1];
		expect(attrs["http.response.body"]).toBe(responseBody);
	});

	it("shows mimetype for non-loggable body types", async () => {
		const logger = createMockLogger();
		const ctx = createMockCtx();

		await traceHandler({
			context: ctx,
			env: {},
			request: new Request("https://example.com/api/test", {
				method: "POST",
				headers: { "content-type": "multipart/form-data" },
				body: "binary-data",
			}),
			serviceName: "test",
			handler: () =>
				new Response("image-data", {
					headers: { "content-type": "image/png" },
				}),
			logger,
		});

		const attrs = logger.info.mock.calls[0][1];
		expect(attrs["http.request.body"]).toBe("[multipart/form-data]");
		expect(attrs["http.response.body"]).toBe("[image/png]");
	});

	it("does not include query when absent", async () => {
		const logger = createMockLogger();
		const ctx = createMockCtx();

		await traceHandler({
			context: ctx,
			env: {},
			request: new Request("https://example.com/api/test"),
			serviceName: "test",
			handler: () => new Response("ok"),
			logger,
		});

		const attrs = logger.info.mock.calls[0][1];
		expect(attrs["http.request.query"]).toBeUndefined();
	});

	it("accepts logger: true to use getLogger()", async () => {
		// When logger: true is passed, it should use getLogger() which returns
		// the noop logger (since no default is set in test). No crash expected.
		const ctx = createMockCtx();

		const response = await traceHandler({
			context: ctx,
			env: {},
			request: new Request("https://example.com/api/test"),
			serviceName: "test",
			handler: () => new Response("ok"),
			logger: true,
		});

		expect(response).toBeInstanceOf(Response);
	});

	it("human-readable response size", async () => {
		const logger = createMockLogger();
		const ctx = createMockCtx();

		await traceHandler({
			context: ctx,
			env: {},
			request: new Request("https://example.com/api/test"),
			serviceName: "test",
			handler: () =>
				new Response("ok", {
					headers: { "content-length": "2048" },
				}),
			logger,
		});

		const attrs = logger.info.mock.calls[0][1];
		expect(attrs["http.response.size"]).toBe("2.0KB");
		const [message] = logger.info.mock.calls[0];
		expect(message).toContain("2.0KB");
	});

	it("includes user-agent in request attributes", async () => {
		const logger = createMockLogger();
		const ctx = createMockCtx();

		await traceHandler({
			context: ctx,
			env: {},
			request: new Request("https://example.com/api/test", {
				headers: { "user-agent": "Mozilla/5.0 TestBrowser" },
			}),
			serviceName: "test",
			handler: () => new Response("ok"),
			logger,
		});

		const attrs = logger.info.mock.calls[0][1];
		expect(attrs["http.request.user_agent"]).toBe("Mozilla/5.0 TestBrowser");
	});

	it("omits user-agent when not present", async () => {
		const logger = createMockLogger();
		const ctx = createMockCtx();

		await traceHandler({
			context: ctx,
			env: {},
			request: new Request("https://example.com/api/test"),
			serviceName: "test",
			handler: () => new Response("ok"),
			logger,
		});

		const attrs = logger.info.mock.calls[0][1];
		expect(attrs["http.request.user_agent"]).toBeUndefined();
	});
});
