import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import { createLogger } from "../src/logger.js";

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
