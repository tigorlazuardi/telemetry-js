import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock cloudflareWorkerAdapter
const { mockForceFlush, mockSetup } = vi.hoisted(() => ({
	mockForceFlush: vi.fn().mockResolvedValue(undefined),
	mockSetup: vi.fn().mockReturnValue({
		resource: { attributes: {} },
		provider: {},
		meterProvider: {},
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		shutdown: vi.fn().mockResolvedValue(undefined),
		forceFlush: vi.fn().mockResolvedValue(undefined),
	}),
}));

vi.mock("../src/cloudflare/adapter.js", () => {
	return {
		cloudflareWorkerAdapter: {
			name: "cloudflare-worker",
			detect: () => true,
			setup: mockSetup,
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

const { mockExtract, mockInject, mockGetBaggage } = vi.hoisted(() => ({
	mockExtract: vi.fn((_ctx: unknown, _carrier: unknown, _getter?: unknown) => ({})),
	mockInject: vi.fn(),
	mockGetBaggage: vi.fn().mockReturnValue(undefined),
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
			getBaggage: mockGetBaggage,
		},
		trace: {
			getSpan: () => mockSpanFns,
			getTracer: () => ({
				startActiveSpan: (
					_name: string,
					_opts: unknown,
					_ctx: unknown,
					fn?: (...args: unknown[]) => unknown,
				) => {
					const callback = typeof _ctx === "function" ? _ctx : fn;
					return (callback as (...args: unknown[]) => unknown)(mockSpanFns);
				},
			}),
		},
	};
});

import type { ResolveConfigFn, Trigger } from "../src/cloudflare/instrument.js";
import { _resetInstrumentState, instrument, traceHandler } from "../src/cloudflare/instrument.js";

interface TestEnv {
	SVC: string;
	OTEL_ENDPOINT?: string;
}

function createMockCtx() {
	return {
		waitUntil: vi.fn(),
		passThroughOnException: vi.fn(),
		props: {},
	};
}

describe("instrument() — config factory overload", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_resetInstrumentState();
	});

	// ── Object form smoke test (regression guard) ──────────────────────

	describe("object form (unchanged behaviour)", () => {
		it("wraps fetch and runs handler", async () => {
			const fetchFn = vi.fn().mockResolvedValue(new Response("hi"));
			const handler = instrument({ fetch: fetchFn }, { serviceName: "static-service" });

			const req = new Request("https://example.com/test");
			const ctx = createMockCtx();
			const env: TestEnv = { SVC: "static-service" };

			const res = await handler.fetch!(req, env, ctx);

			expect(fetchFn).toHaveBeenCalledWith(req, env, ctx);
			expect(res).toBeInstanceOf(Response);
			expect(mockSpanFns.end).toHaveBeenCalled();
			expect(ctx.waitUntil).toHaveBeenCalled();
		});

		it("passes serviceName from opts to SDK setup", async () => {
			const fetchFn = vi.fn().mockResolvedValue(new Response("ok"));
			const handler = instrument({ fetch: fetchFn }, { serviceName: "my-static-svc" });

			const ctx = createMockCtx();
			await handler.fetch!(new Request("https://example.com/"), {}, ctx);

			expect(mockSetup).toHaveBeenCalledWith(
				expect.objectContaining({ serviceName: "my-static-svc" }),
			);
		});
	});

	// ── Factory form ────────────────────────────────────────────────────

	describe("factory form", () => {
		it("calls the factory with live env + request trigger", async () => {
			const factory = vi.fn<ResolveConfigFn<TestEnv>>((env, _trigger) => ({
				serviceName: env.SVC,
			}));
			const fetchFn = vi.fn().mockResolvedValue(new Response("ok"));
			const handler = instrument<TestEnv>({ fetch: fetchFn }, factory);

			const req = new Request("https://example.com/api");
			const env: TestEnv = { SVC: "factory-service" };
			const ctx = createMockCtx();

			await handler.fetch!(req, env, ctx);

			// Factory was called once with the live env and the request as trigger
			expect(factory).toHaveBeenCalledTimes(1);
			const [calledEnv, calledTrigger] = factory.mock.calls[0];
			expect(calledEnv).toBe(env);
			expect(calledTrigger).toBe(req);
		});

		it("uses the resolved serviceName from factory config", async () => {
			const factory = vi.fn<ResolveConfigFn<TestEnv>>((env) => ({
				serviceName: env.SVC,
			}));
			const fetchFn = vi.fn().mockResolvedValue(new Response("ok"));
			const handler = instrument<TestEnv>({ fetch: fetchFn }, factory);

			const env: TestEnv = { SVC: "resolved-service" };
			const ctx = createMockCtx();

			await handler.fetch!(new Request("https://example.com/"), env, ctx);

			// SDK setup was called with the factory-resolved serviceName
			expect(mockSetup).toHaveBeenCalledWith(
				expect.objectContaining({ serviceName: "resolved-service" }),
			);
		});

		it("handler still runs when factory returns config without serviceName", async () => {
			const factory: ResolveConfigFn<TestEnv> = () => ({});
			const fetchFn = vi.fn().mockResolvedValue(new Response("fine"));
			const handler = instrument<TestEnv>({ fetch: fetchFn }, factory);

			const ctx = createMockCtx();
			const res = await handler.fetch!(new Request("https://example.com/"), { SVC: "x" }, ctx);

			expect(fetchFn).toHaveBeenCalled();
			expect(res).toBeInstanceOf(Response);
		});

		it("scheduled: factory called with controller as trigger", async () => {
			const factory = vi.fn<ResolveConfigFn<TestEnv>>((env) => ({
				serviceName: env.SVC,
			}));
			const scheduledFn = vi.fn().mockResolvedValue(undefined);
			const handler = instrument<TestEnv>({ scheduled: scheduledFn }, factory);

			const controller = {
				scheduledTime: Date.now(),
				cron: "0 * * * *",
				noRetry: vi.fn(),
			};
			const env: TestEnv = { SVC: "sched-service" };
			const ctx = createMockCtx();

			await handler.scheduled!(controller, env, ctx);

			expect(factory).toHaveBeenCalledTimes(1);
			const [calledEnv, calledTrigger] = factory.mock.calls[0];
			expect(calledEnv).toBe(env);
			expect(calledTrigger).toBe(controller);
			expect(scheduledFn).toHaveBeenCalledWith(controller, env, ctx);
		});

		it("queue: factory called with batch as trigger", async () => {
			const factory = vi.fn<ResolveConfigFn<TestEnv>>((env) => ({
				serviceName: env.SVC,
			}));
			const queueFn = vi.fn().mockResolvedValue(undefined);
			const handler = instrument<TestEnv>({ queue: queueFn }, factory);

			const batch = {
				queue: "my-q",
				messages: [
					{
						id: "1",
						timestamp: new Date(),
						body: "hello",
						attempts: 1,
						ack: vi.fn(),
						retry: vi.fn(),
					},
				],
				ackAll: vi.fn(),
				retryAll: vi.fn(),
			};
			const env: TestEnv = { SVC: "queue-service" };
			const ctx = createMockCtx();

			await handler.queue!(batch, env, ctx);

			expect(factory).toHaveBeenCalledTimes(1);
			const [calledEnv, calledTrigger] = factory.mock.calls[0];
			expect(calledEnv).toBe(env);
			expect(calledTrigger).toBe(batch);
			expect(queueFn).toHaveBeenCalled();
		});
	});

	// ── Factory throw → fail-silent ─────────────────────────────────────

	describe("factory throw — fail-silent", () => {
		it("handler still runs when factory throws", async () => {
			const throwingFactory: ResolveConfigFn<TestEnv> = () => {
				throw new Error("secret unavailable");
			};
			const fetchFn = vi.fn().mockResolvedValue(new Response("still running"));
			const handler = instrument<TestEnv>({ fetch: fetchFn }, throwingFactory);

			const ctx = createMockCtx();
			// Must NOT throw — worker must still get a response
			let res: Response | undefined;
			await expect(
				(async () => {
					res = await handler.fetch!(
						new Request("https://example.com/"),
						{ SVC: "irrelevant" },
						ctx,
					);
				})(),
			).resolves.toBeUndefined(); // the outer promise resolves

			expect(fetchFn).toHaveBeenCalled();
			expect(res).toBeInstanceOf(Response);
			expect(await res!.text()).toBe("still running");
		});

		it("no crash on scheduled when factory throws", async () => {
			const throwingFactory: ResolveConfigFn<TestEnv> = () => {
				throw new Error("boom");
			};
			const scheduledFn = vi.fn().mockResolvedValue(undefined);
			const handler = instrument<TestEnv>({ scheduled: scheduledFn }, throwingFactory);

			const controller = { scheduledTime: Date.now(), cron: "* * * * *", noRetry: vi.fn() };
			const ctx = createMockCtx();

			await expect(handler.scheduled!(controller, { SVC: "x" }, ctx)).resolves.toBeUndefined();

			expect(scheduledFn).toHaveBeenCalled();
		});
	});

	// ── traceHandler config field ────────────────────────────────────────

	describe("traceHandler — config field", () => {
		it("accepts a static InstrumentOptions as config", async () => {
			const handlerFn = vi.fn().mockResolvedValue(new Response("th-static"));
			const ctx = createMockCtx();

			await traceHandler({
				serviceName: "base",
				config: { serviceName: "override-static" },
				context: ctx,
				request: new Request("https://example.com/"),
				handler: handlerFn,
			});

			expect(handlerFn).toHaveBeenCalled();
			expect(mockSetup).toHaveBeenCalledWith(
				expect.objectContaining({ serviceName: "override-static" }),
			);
		});

		it("accepts a ResolveConfigFn as config, resolves with env + request", async () => {
			const configFactory = vi.fn((_env: unknown, _trigger: Trigger) => ({
				serviceName: "from-factory",
			}));
			const handlerFn = vi.fn().mockResolvedValue(new Response("th-factory"));
			const ctx = createMockCtx();
			const env = { TOKEN: "abc" };
			const req = new Request("https://example.com/hook");

			await traceHandler({
				serviceName: "base",
				config: configFactory,
				context: ctx,
				env,
				request: req,
				handler: handlerFn,
			});

			expect(configFactory).toHaveBeenCalledTimes(1);
			expect(configFactory).toHaveBeenCalledWith(env, req);
			expect(mockSetup).toHaveBeenCalledWith(
				expect.objectContaining({ serviceName: "from-factory" }),
			);
		});

		it("traceHandler: factory throw → handler still runs", async () => {
			const throwingConfig: ResolveConfigFn = () => {
				throw new Error("bad");
			};
			const handlerFn = vi.fn().mockResolvedValue(new Response("th-ok"));
			const ctx = createMockCtx();

			await expect(
				traceHandler({
					serviceName: "base",
					config: throwingConfig,
					context: ctx,
					request: new Request("https://example.com/"),
					handler: handlerFn,
				}),
			).resolves.toBeInstanceOf(Response);

			expect(handlerFn).toHaveBeenCalled();
		});
	});
});
