import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @opentelemetry/api-logs
const mockEmit = vi.fn();
vi.mock("@opentelemetry/api-logs", () => ({
	logs: {
		getLogger: () => ({ emit: mockEmit }),
	},
	SeverityNumber: {
		DEBUG: 5,
		INFO: 9,
		WARN: 13,
		ERROR: 17,
	},
}));

// Mock @opentelemetry/api to control span context
const mockSpanContext = vi.fn().mockReturnValue({
	traceId: "00000000000000000000000000000000",
	spanId: "0000000000000000",
});
vi.mock("@opentelemetry/api", () => ({
	context: { active: () => ({}) },
	trace: {
		getSpan: () => ({ spanContext: mockSpanContext }),
		setSpanContext: (_ctx: unknown, spanCtx: unknown) => spanCtx,
	},
}));

import { AsyncLocalStorage } from "node:async_hooks";
import {
	createLogger,
	getLogger,
	runWithLogger,
	setDefaultLogger,
	setLoggerStorage,
} from "../src/shared/logger.js";
import { noopLogger } from "../src/shared/noop.js";

const ANSI = {
	reset: "\u001B[0m",
	dim: "\u001B[2m",
	gray: "\u001B[90m",
	cyan: "\u001B[36m",
	green: "\u001B[32m",
} as const;

// Register AsyncLocalStorage for tests (simulates what runtime adapters do)
setLoggerStorage(new AsyncLocalStorage());

function withTTY(value: boolean | undefined, fn: () => void) {
	const desc = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
	Object.defineProperty(process.stderr, "isTTY", {
		value,
		writable: true,
		configurable: true,
	});
	try {
		fn();
	} finally {
		if (desc) {
			Object.defineProperty(process.stderr, "isTTY", desc);
		} else {
			delete (process.stderr as Record<string, unknown>).isTTY;
		}
	}
}

describe("createLogger", () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		// Reset span context to invalid (no active span)
		mockSpanContext.mockReturnValue({
			traceId: "00000000000000000000000000000000",
			spanId: "0000000000000000",
		});
		// Reset default logger so tests are isolated
		setDefaultLogger(undefined as never);
	});

	afterEach(() => {
		stderrSpy.mockRestore();
	});

	describe("all log levels", () => {
		it("logger has debug, info, warn, error methods", () => {
			const logger = createLogger("test-service");
			expect(typeof logger.debug).toBe("function");
			expect(typeof logger.info).toBe("function");
			expect(typeof logger.warn).toBe("function");
			expect(typeof logger.error).toBe("function");
		});

		it("info writes to stderr", () => {
			const logger = createLogger("test-service");
			logger.info("hello world");
			expect(stderrSpy).toHaveBeenCalled();
			const output = stderrSpy.mock.calls[0][0] as string;
			expect(output).toContain("hello world");
		});

		it("debug writes to stderr", () => {
			const logger = createLogger("test-service");
			logger.debug("debug msg");
			expect(stderrSpy).toHaveBeenCalled();
			const output = stderrSpy.mock.calls[0][0] as string;
			expect(output).toContain("debug msg");
		});

		it("warn writes to stderr", () => {
			const logger = createLogger("test-service");
			logger.warn("warn msg");
			expect(stderrSpy).toHaveBeenCalled();
		});

		it("error writes to stderr", () => {
			const logger = createLogger("test-service");
			logger.error("error msg");
			expect(stderrSpy).toHaveBeenCalled();
		});
	});

	describe("optional serviceName", () => {
		it("creates a logger without serviceName", () => {
			const logger = createLogger();
			logger.info("no service");
			expect(stderrSpy).toHaveBeenCalled();
			const output = stderrSpy.mock.calls[0][0] as string;
			expect(output).toContain("no service");
		});

		it("omits service field from JSON when no serviceName", () => {
			const logger = createLogger();
			logger.info("no svc");
			const output = stderrSpy.mock.calls[0][0] as string;
			const parsed = JSON.parse(output.trim());
			expect(parsed.service).toBeUndefined();
			expect(parsed.msg).toBe("no svc");
		});

		it("includes service name in JSON when serviceName provided", () => {
			const logger = createLogger("my-svc");
			logger.info("with svc");
			const output = stderrSpy.mock.calls[0][0] as string;
			const parsed = JSON.parse(output.trim());
			// pino uses `name`, built-in uses `service`
			const svc = parsed.service ?? parsed.name;
			expect(svc).toBe("my-svc");
		});
	});

	describe("JSON output", () => {
		it("outputs valid JSON to stderr", () => {
			const logger = createLogger("test-service");
			logger.info("json test");
			const output = stderrSpy.mock.calls[0][0] as string;
			const parsed = JSON.parse(output.trim());
			// Works with both pino (msg) and built-in (msg) formats
			expect(parsed.msg).toBe("json test");
		});

		it("includes attributes in output", () => {
			const logger = createLogger("test-service");
			logger.info("with attrs", { userId: "123", count: 42, active: true });
			const output = stderrSpy.mock.calls[0][0] as string;
			const parsed = JSON.parse(output.trim());
			expect(parsed.userId).toBe("123");
			expect(parsed.count).toBe(42);
			expect(parsed.active).toBe(true);
		});

		it("serializes object attributes in JSON output", () => {
			const logger = createLogger("test-service");
			logger.info("with object attrs", { details: { code: 502, retryable: false } });
			const output = stderrSpy.mock.calls[0][0] as string;
			const parsed = JSON.parse(output.trim());
			expect(parsed.details).toEqual({ code: 502, retryable: false });
		});
	});

	describe("TTY pretty output", () => {
		it("formats logs with a multiline JSON details block", () => {
			withTTY(true, () => {
				const logger = createLogger("test-service");
				logger.error(
					"request failed",
					{ details: { code: 502, retryable: false }, "http.error": { reason: "upstream" } },
					{ timestamp: Date.parse("2026-04-21T05:37:36.905Z") },
				);
			});

			const output = stderrSpy.mock.calls[0][0] as string;
			expect(output).toBe(
				`\u001B[31m[ERROR]${ANSI.reset} ${ANSI.dim}[2026-04-21T05:37:36.905Z]${ANSI.reset} ${ANSI.cyan}[test-service]${ANSI.reset} request failed\n${JSON.stringify({ details: { code: 502, retryable: false }, "http.error": { reason: "upstream" } }, null, 2)}\n\n`,
			);
		});

		it("colors later TTY logs after async highlighter loads", async () => {
			await vi.resetModules();
			vi.doMock("cli-highlight", () => ({
				highlight: (json: string) => `<<colored>>\n${json}\n<</colored>>`,
			}));

			const { createLogger: createReloadedLogger } = await import("../src/shared/logger.js");

			withTTY(true, () => {
				const logger = createReloadedLogger("test-service");
				logger.info("first log", { details: { ok: true } }, { timestamp: 0 });
			});

			expect(stderrSpy.mock.calls.at(-1)?.[0]).toBe(
				`${ANSI.green}[INFO]${ANSI.reset} ${ANSI.dim}[1970-01-01T00:00:00.000Z]${ANSI.reset} ${ANSI.cyan}[test-service]${ANSI.reset} first log\n${JSON.stringify({ details: { ok: true } }, null, 2)}\n\n`,
			);

			const expectedColored = `${ANSI.green}[INFO]${ANSI.reset} ${ANSI.dim}[1970-01-01T00:00:00.001Z]${ANSI.reset} ${ANSI.cyan}[test-service]${ANSI.reset} second log\n<<colored>>\n${JSON.stringify({ details: { ok: true } }, null, 2)}\n<</colored>>\n\n`;

			// The highlighter loads via dynamic import (/* @vite-ignore */) which
			// bypasses Vitest's mock system and uses Node's native loader — resolution
			// time is non-deterministic. Poll until the second log produces colored
			// output instead of relying on a fixed delay.
			await vi.waitFor(
				() => {
					withTTY(true, () => {
						const logger = createReloadedLogger("test-service");
						logger.info("second log", { details: { ok: true } }, { timestamp: 1 });
					});
					expect(stderrSpy.mock.calls.at(-1)?.[0]).toBe(expectedColored);
				},
				{ timeout: 2000, interval: 10 },
			);
		});

		it("falls back cleanly when JSON colorizer is unavailable", async () => {
			await vi.resetModules();
			vi.doMock("cli-highlight", () => {
				throw new Error("module unavailable");
			});

			const { createLogger: createReloadedLogger } = await import("../src/shared/logger.js");

			withTTY(true, () => {
				const logger = createReloadedLogger("test-service");
				logger.info("colored maybe", { details: { ok: true } }, { timestamp: 0 });
			});

			const output = stderrSpy.mock.calls.at(-1)?.[0] as string;
			expect(output).toBe(
				`${ANSI.green}[INFO]${ANSI.reset} ${ANSI.dim}[1970-01-01T00:00:00.000Z]${ANSI.reset} ${ANSI.cyan}[test-service]${ANSI.reset} colored maybe\n${JSON.stringify({ details: { ok: true } }, null, 2)}\n\n`,
			);
		});

		it("omits JSON block when there are no extra fields", () => {
			withTTY(true, () => {
				const logger = createLogger("test-service");
				logger.info("hello tty", undefined, { timestamp: Date.parse("2026-04-21T05:37:36.905Z") });
			});

			const output = stderrSpy.mock.calls[0][0] as string;
			expect(output).toBe(
				`${ANSI.green}[INFO]${ANSI.reset} ${ANSI.dim}[2026-04-21T05:37:36.905Z]${ANSI.reset} ${ANSI.cyan}[test-service]${ANSI.reset} hello tty\n\n`,
			);
		});

		it("does not attempt colorizer loading outside Node runtimes", async () => {
			await vi.resetModules();
			const nodeDesc = Object.getOwnPropertyDescriptor(process.versions, "node");
			Object.defineProperty(process.versions, "node", {
				value: undefined,
				configurable: true,
			});

			const cliHighlightFactory = vi.fn(() => ({
				highlight: vi.fn((json: string) => json),
			}));
			vi.doMock("cli-highlight", cliHighlightFactory);

			try {
				const { createLogger: createReloadedLogger } = await import("../src/shared/logger.js");
				const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);

				createReloadedLogger("cf-service").info(
					"cloudflare-safe",
					{ details: { ok: true } },
					{ timestamp: 0 },
				);

				expect(consoleInfo).toHaveBeenCalledWith(
					JSON.stringify({
						level: "info",
						time: 0,
						msg: "cloudflare-safe",
						service: "cf-service",
						details: { ok: true },
					}),
				);
				expect(cliHighlightFactory).not.toHaveBeenCalled();
				consoleInfo.mockRestore();
			} finally {
				if (nodeDesc) {
					Object.defineProperty(process.versions, "node", nodeDesc);
				}
			}
		});
	});

	describe("OTLP bridge", () => {
		it("emits to OTLP logger on every call", () => {
			const logger = createLogger("test-service");
			logger.info("otlp test");
			expect(mockEmit).toHaveBeenCalledWith(
				expect.objectContaining({
					severityNumber: 9,
					severityText: "INFO",
					body: "otlp test",
				}),
			);
		});

		it("emits correct severity for each level", () => {
			const logger = createLogger("test-service");

			logger.debug("d");
			expect(mockEmit).toHaveBeenCalledWith(
				expect.objectContaining({ severityNumber: 5, severityText: "DEBUG" }),
			);

			logger.warn("w");
			expect(mockEmit).toHaveBeenCalledWith(
				expect.objectContaining({ severityNumber: 13, severityText: "WARN" }),
			);

			logger.error("e");
			expect(mockEmit).toHaveBeenCalledWith(
				expect.objectContaining({ severityNumber: 17, severityText: "ERROR" }),
			);
		});

		it("passes attributes to OTLP emit", () => {
			const logger = createLogger("test-service");
			logger.warn("with attrs", { key: "value" });
			expect(mockEmit).toHaveBeenCalledWith(
				expect.objectContaining({
					severityText: "WARN",
					attributes: { key: "value" },
				}),
			);
		});

		it("stringifies object attributes for OTLP emit", () => {
			const logger = createLogger("test-service");
			logger.warn("with object attrs", { details: { code: 502 } });
			expect(mockEmit).toHaveBeenCalledWith(
				expect.objectContaining({
					severityText: "WARN",
					attributes: { details: '{"code":502}' },
				}),
			);
		});
	});

	describe("log-trace correlation", () => {
		it("includes traceId and spanId when explicit spanContext is provided", () => {
			const logger = createLogger("test-service");
			const spanContext = {
				traceId: "abc123def456789012345678abcdef01",
				spanId: "1234567890abcdef",
				traceFlags: 1,
			};
			logger.info("correlated", undefined, { spanContext });
			const output = stderrSpy.mock.calls[0][0] as string;
			const parsed = JSON.parse(output.trim());
			expect(parsed.traceId).toBe("abc123def456789012345678abcdef01");
			expect(parsed.spanId).toBe("1234567890abcdef");
		});
	});

	describe("no-throw guarantee", () => {
		it("does not throw when stderr.write fails", () => {
			stderrSpy.mockImplementation(() => {
				throw new Error("write failed");
			});
			const logger = createLogger("test-service");
			expect(() => logger.info("should not throw")).not.toThrow();
		});

		it("does not throw when OTLP emit fails", () => {
			mockEmit.mockImplementation(() => {
				throw new Error("emit failed");
			});
			const logger = createLogger("test-service");
			expect(() => logger.info("should not throw")).not.toThrow();
		});

		it("does not throw with null/undefined message edge cases", () => {
			const logger = createLogger("test-service");
			expect(() => logger.info("")).not.toThrow();
			expect(() => logger.info(null as unknown as string)).not.toThrow();
		});
	});
});

describe("getLogger", () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		// Reset default logger so tests are isolated
		setDefaultLogger(undefined as never);
	});

	afterEach(() => {
		stderrSpy.mockRestore();
	});

	it("returns a working logger when nothing is configured", () => {
		const logger = getLogger();
		expect(typeof logger.info).toBe("function");
		logger.info("fallback");
		expect(stderrSpy).toHaveBeenCalled();
	});

	it("returns the default logger set via setDefaultLogger", () => {
		const custom = createLogger("default-svc");
		setDefaultLogger(custom);
		const logger = getLogger();
		expect(logger).toBe(custom);
	});

	it("returns the context-scoped logger inside runWithLogger", () => {
		const outer = createLogger("outer");
		const inner = createLogger("inner");

		setDefaultLogger(outer);

		runWithLogger(inner, () => {
			expect(getLogger()).toBe(inner);
		});

		// Outside the runWithLogger scope, falls back to default
		expect(getLogger()).toBe(outer);
	});

	it("context-scoped logger takes precedence over default", () => {
		const defaultLogger = createLogger("default");
		const scopedLogger = createLogger("scoped");
		setDefaultLogger(defaultLogger);

		runWithLogger(scopedLogger, () => {
			const logger = getLogger();
			expect(logger).toBe(scopedLogger);
			expect(logger).not.toBe(defaultLogger);
		});
	});

	it("nested runWithLogger scopes work correctly", () => {
		const a = createLogger("a");
		const b = createLogger("b");

		runWithLogger(a, () => {
			expect(getLogger()).toBe(a);

			runWithLogger(b, () => {
				expect(getLogger()).toBe(b);
			});

			// After inner scope exits, reverts to outer
			expect(getLogger()).toBe(a);
		});
	});

	it("runWithLogger works with async functions", async () => {
		const custom = createLogger("async-svc");

		await runWithLogger(custom, async () => {
			// Simulate async work
			await new Promise((r) => setTimeout(r, 10));
			expect(getLogger()).toBe(custom);
		});
	});

	it("can use noopLogger as the context-scoped logger", () => {
		runWithLogger(noopLogger, () => {
			expect(getLogger()).toBe(noopLogger);
		});
	});
});
