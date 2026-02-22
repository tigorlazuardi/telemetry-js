import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";

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

import { traced } from "../src/traced.js";
import type { TracedCallContext } from "../src/traced.js";

describe("traced", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("span name resolution", () => {
    it("uses ClassName.methodName as default span name", () => {
      class MyService {
        @traced()
        doWork() {
          return 42;
        }
      }

      new MyService().doWork();

      expect(startActiveSpanSpy).toHaveBeenCalledWith(
        "MyService.doWork",
        expect.any(Object),
        expect.anything(),
        expect.any(Function),
      );
    });

    it("uses static name override", () => {
      class MyService {
        @traced({ name: "custom" })
        doWork() {
          return 42;
        }
      }

      new MyService().doWork();

      expect(startActiveSpanSpy).toHaveBeenCalledWith(
        "custom",
        expect.any(Object),
        expect.anything(),
        expect.any(Function),
      );
    });
  });

  describe("options passthrough", () => {
    it("passes kind and attributes to span options", () => {
      class MyService {
        @traced({ kind: SpanKind.CLIENT, attributes: { "rpc.system": "grpc" } })
        call() {
          return "ok";
        }
      }

      new MyService().call();

      expect(startActiveSpanSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          kind: SpanKind.CLIENT,
          attributes: { "rpc.system": "grpc" },
        }),
        expect.anything(),
        expect.any(Function),
      );
    });
  });

  describe("factory function", () => {
    it("calls factory with className, methodName, and args", () => {
      const factory = vi.fn((_ctx: TracedCallContext) => ({}));

      class UserService {
        @traced(factory)
        getUser(id: string) {
          return id;
        }
      }

      new UserService().getUser("u-123");

      expect(factory).toHaveBeenCalledWith({
        className: "UserService",
        methodName: "getUser",
        args: ["u-123"],
      });
    });

    it("uses factory-returned attributes", () => {
      class UserService {
        @traced(({ args }) => ({
          attributes: { "user.id": String(args[0]) },
        }))
        getUser(id: string) {
          return id;
        }
      }

      new UserService().getUser("u-456");

      expect(startActiveSpanSpy).toHaveBeenCalledWith(
        "UserService.getUser",
        expect.objectContaining({
          attributes: { "user.id": "u-456" },
        }),
        expect.anything(),
        expect.any(Function),
      );
    });
  });

  describe("sync methods", () => {
    it("returns the value and ends the span", () => {
      class Svc {
        @traced()
        compute() {
          return 42;
        }
      }

      const result = new Svc().compute();
      expect(result).toBe(42);
      expect(mockSpan.end).toHaveBeenCalled();
    });
  });

  describe("async methods", () => {
    it("returns the resolved value and ends the span", async () => {
      class Svc {
        @traced()
        async fetch() {
          return "data";
        }
      }

      const result = await new Svc().fetch();
      expect(result).toBe("data");
      expect(mockSpan.end).toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("sets ERROR status, records exception, and re-throws for sync errors", () => {
      const error = new Error("sync boom");

      class Svc {
        @traced()
        fail() {
          throw error;
        }
      }

      expect(() => new Svc().fail()).toThrow("sync boom");

      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: "sync boom",
      });
      expect(mockSpan.recordException).toHaveBeenCalledWith(error);
      expect(mockSpan.end).toHaveBeenCalled();
    });

    it("sets ERROR status, records exception, and re-throws for async errors", async () => {
      const error = new Error("async boom");

      class Svc {
        @traced()
        async fail() {
          throw error;
        }
      }

      await expect(new Svc().fail()).rejects.toThrow("async boom");

      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: "async boom",
      });
      expect(mockSpan.recordException).toHaveBeenCalledWith(error);
      expect(mockSpan.end).toHaveBeenCalled();
    });
  });
});
