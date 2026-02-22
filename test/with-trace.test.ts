import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";

// Collect calls to startActiveSpan so we can inspect span name, options, context
const mockSpan = {
  setStatus: vi.fn(),
  recordException: vi.fn(),
  end: vi.fn(),
  setAttribute: vi.fn(),
};

const startActiveSpanSpy = vi.fn(
  (
    _name: string,
    _opts: unknown,
    _ctx: unknown,
    fn: (span: typeof mockSpan) => unknown,
  ) => fn(mockSpan),
);

vi.mock("@opentelemetry/api", async () => {
  const actual = await vi.importActual("@opentelemetry/api");
  return {
    ...actual,
    trace: {
      ...(actual as Record<string, unknown>).trace,
      getTracer: () => ({
        startActiveSpan: startActiveSpanSpy,
      }),
      setSpan: (actual as { trace: { setSpan: unknown } }).trace.setSpan,
    },
  };
});

import { withTrace } from "../src/with-trace.js";

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
      withTrace(function autoName(_span) {
        return 42;
      }, { name: "custom-name" });

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
});
