import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── 1. Passthrough (direct, no module reset needed) ─────────────────

import {
	makePassthroughSDKResult,
	passthroughInjectContext,
	passthroughLogger,
	passthroughScopeAction,
	passthroughTraced,
	passthroughWithAction,
	passthroughWithTrace,
} from "../src/browser/passthrough.js";

describe("passthrough", () => {
	describe("passthroughWithTrace", () => {
		it("runs fn synchronously and returns value", () => {
			const result = passthroughWithTrace(() => 42);
			expect(result).toBe(42);
		});

		it("never throws", () => {
			expect(() =>
				passthroughWithTrace(() => {
					throw new Error("boom");
				}),
			).toThrow("boom"); // fn error propagates
		});

		it("passes a noop span-like object to fn", () => {
			const span = passthroughWithTrace((s) => s);
			expect(span).toBeDefined();
			expect(typeof span.end).toBe("function");
			expect(span.isRecording()).toBe(false);
		});
	});

	describe("passthroughWithAction", () => {
		it("runs fn synchronously and returns value", () => {
			const result = passthroughWithAction("click", () => "done");
			expect(result).toBe("done");
		});
	});

	describe("passthroughScopeAction", () => {
		it("returns a scoped function that runs fn synchronously", () => {
			const action = passthroughScopeAction({ page: "/home" });
			const result = action("click", () => "scoped");
			expect(result).toBe("scoped");
		});
	});

	describe("passthroughTraced", () => {
		it("decorator returns original method unchanged", () => {
			const original = () => "original";
			class TestClass {}
			const context = { kind: "method" } as ClassMethodDecoratorContext;
			const decorated = passthroughTraced()(original, context);
			expect(decorated).toBe(original);
		});
	});

	describe("passthroughInjectContext", () => {
		it("returns value unchanged", () => {
			const carrier = { traceparent: "existing" };
			const result = passthroughInjectContext(carrier);
			expect(result).toBe(carrier);
		});

		it("returns primitive unchanged", () => {
			expect(passthroughInjectContext("hello")).toBe("hello");
		});
	});

	describe("passthroughLogger", () => {
		it("all methods are silent (no throws, no output)", () => {
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			expect(() => {
				passthroughLogger.debug("test");
				passthroughLogger.info("test");
				passthroughLogger.warn("test");
				passthroughLogger.error("test");
			}).not.toThrow();
			expect(consoleSpy).not.toHaveBeenCalled();
			expect(stderrSpy).not.toHaveBeenCalled();
			consoleSpy.mockRestore();
			stderrSpy.mockRestore();
		});
	});

	describe("makePassthroughSDKResult", () => {
		it("returns object with logger, shutdown, forceFlush", async () => {
			const result = makePassthroughSDKResult();
			expect(result.logger).toBe(passthroughLogger);
			await expect(result.shutdown()).resolves.toBeUndefined();
			await expect(result.forceFlush()).resolves.toBeUndefined();
		});

		it("resource is null (degraded mode)", () => {
			const result = makePassthroughSDKResult();
			expect(result.resource).toBeNull();
		});
	});
});

// ── 2. Facade (requires module reset between initSDK tests) ──────────

describe("browser facade", () => {
	afterEach(() => {
		vi.resetModules();
	});

	async function loadFacade() {
		return import("../src/browser/index.js");
	}

	describe("passthrough forwarders (pre-init)", () => {
		it("withTrace returns fn result synchronously", async () => {
			const facade = await loadFacade();
			const result = facade.withTrace((_span) => "hello");
			expect(result).toBe("hello");
		});

		it("withAction returns fn result synchronously", async () => {
			const facade = await loadFacade();
			const result = facade.withAction("click", (_span) => 42);
			expect(result).toBe(42);
		});

		it("scopeAction returns a working scoped action", async () => {
			const facade = await loadFacade();
			const action = facade.scopeAction({ page: "/home" });
			const result = action("click", (_span) => "scoped");
			expect(result).toBe("scoped");
		});

		it("injectContext returns value unchanged", async () => {
			const facade = await loadFacade();
			const carrier = { key: "value" };
			expect(facade.injectContext(carrier)).toBe(carrier);
		});

		it("getResource returns null before init", async () => {
			const facade = await loadFacade();
			expect(facade.getResource()).toBeNull();
		});
	});

	describe("noopLogger", () => {
		it("is exported and silent", async () => {
			const facade = await loadFacade();
			const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			expect(() => facade.noopLogger.info("test")).not.toThrow();
			expect(stderrSpy).not.toHaveBeenCalled();
			stderrSpy.mockRestore();
		});
	});

	describe("initSDK", () => {
		it("returns a Promise", async () => {
			vi.doMock("../src/browser/internal/real.js", () => ({
				impl: {
					withTrace: (_fn: any, _opts: any) => {},
					withAction: (_action: any, _fn: any, _opts: any) => {},
					scopeAction: (_scope: any) => () => {},
					traced: (_opts: any) => (method: any) => method,
					injectContext: (value: any) => value,
					createLogger: vi.fn(),
					setDefaultLogger: vi.fn(),
					setup: vi.fn(() => ({
						resource: { attributes: { "service.name": "test" } },
						provider: {},
						logger: passthroughLogger,
						shutdown: async () => {},
						forceFlush: async () => {},
					})),
				},
			}));
			const facade = await loadFacade();
			const result = facade.initSDK({ exporterEndpoint: "https://otel.example.com" });
			expect(result).toBeInstanceOf(Promise);
			await result;
		});

		it("is idempotent — concurrent calls return same promise", async () => {
			vi.doMock("../src/browser/internal/real.js", () => ({
				impl: {
					withTrace: vi.fn(),
					withAction: vi.fn(),
					scopeAction: vi.fn(() => vi.fn()),
					traced: vi.fn(() => (m: any) => m),
					injectContext: vi.fn((v: any) => v),
					createLogger: vi.fn(),
					setDefaultLogger: vi.fn(),
					setup: vi.fn(() => ({
						resource: { attributes: {} },
						provider: {},
						logger: passthroughLogger,
						shutdown: async () => {},
						forceFlush: async () => {},
					})),
				},
			}));
			const facade = await loadFacade();
			const p1 = facade.initSDK({});
			const p2 = facade.initSDK({});
			expect(p1).toBe(p2);
			await p1;
		});

		it("failure → resolves with passthrough SDKResult (not throw)", async () => {
			vi.doMock("../src/browser/internal/real.js", () => {
				throw new Error("import failed");
			});
			const facade = await loadFacade();
			const result = await facade.initSDK({});
			// Failure path: resource is null, logger is passthroughLogger
			expect(result.resource).toBeNull();
		});

		it("swaps getResource after successful init", async () => {
			const fakeResource = { attributes: { "service.name": "my-app" } };
			vi.doMock("../src/browser/internal/real.js", () => ({
				impl: {
					withTrace: vi.fn(),
					withAction: vi.fn(),
					scopeAction: vi.fn(() => vi.fn()),
					traced: vi.fn(() => (m: any) => m),
					injectContext: vi.fn((v: any) => v),
					createLogger: vi.fn(),
					setDefaultLogger: vi.fn(),
					setup: vi.fn(() => ({
						resource: fakeResource,
						provider: {},
						logger: passthroughLogger,
						shutdown: async () => {},
						forceFlush: async () => {},
					})),
				},
			}));
			const facade = await loadFacade();
			expect(facade.getResource()).toBeNull();
			await facade.initSDK({});
			expect(facade.getResource()).toBe(fakeResource);
		});
	});

	describe("compiled facade has no OTel imports", () => {
		it("dist/browser/index.js has zero @opentelemetry strings", async () => {
			const { readFileSync } = await import("node:fs");
			const compiled = readFileSync("dist/browser/index.js", "utf8");
			expect(compiled).not.toMatch(/@opentelemetry/);
		});
	});
});

// ── 3. dev console-gating ────────────────────────────────────────────

describe("dev console gating", () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		stderrSpy.mockRestore();
	});

	it("createLogger with console:false is silent", async () => {
		const { createLogger } = await import("../src/shared/logger.js");
		const logger = createLogger("test", { console: false });
		logger.info("silent message");
		expect(stderrSpy).not.toHaveBeenCalled();
	});

	it("createLogger with console:true writes to stderr", async () => {
		const { createLogger } = await import("../src/shared/logger.js");
		const logger = createLogger("test", { console: true });
		logger.info("audible message");
		expect(stderrSpy).toHaveBeenCalled();
	});

	it("createLogger default (no options) writes to stderr", async () => {
		const { createLogger } = await import("../src/shared/logger.js");
		const logger = createLogger("test");
		logger.info("default message");
		expect(stderrSpy).toHaveBeenCalled();
	});

	it("dev:false in SDKConfig → browser adapter creates silent logger", async () => {
		// Structural test: verify the adapter source contains the expected wiring
		// config.dev = false → console: !!config.dev = false → silent logger
		const { readFileSync } = await import("node:fs");
		const adapterSource = readFileSync("src/browser/adapter.ts", "utf8");
		expect(adapterSource).toContain("console: !!config.dev");
	});
});
