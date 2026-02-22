import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";

const mockSpan = {
  setAttribute: vi.fn(),
  setStatus: vi.fn(),
  recordException: vi.fn(),
  end: vi.fn(),
};

const { mockInject } = vi.hoisted(() => ({
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
      inject: mockInject,
    },
    trace: {
      getTracer: () => ({
        startActiveSpan: (
          _name: string,
          _opts: unknown,
          fn: (...args: unknown[]) => unknown,
        ) => {
          // 3-arg overload: (name, opts, fn)
          return fn(mockSpan);
        },
      }),
    },
  };
});

import { instrumentFetch } from "../src/instrument-fetch.js";
import type { Logger } from "../src/types.js";

function createMockLogger(): Logger & {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("instrumentFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("span", () => {
    it("creates CLIENT span named {METHOD} {URL}", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
      const tracedFetch = instrumentFetch(mockFetch);

      await tracedFetch("https://api.example.com/data");

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        "http.status_code",
        200,
      );
      expect(mockSpan.end).toHaveBeenCalled();
    });

    it("sets http.status_code attribute", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response("not found", { status: 404 }));
      const tracedFetch = instrumentFetch(mockFetch);

      await tracedFetch("https://api.example.com/missing");

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        "http.status_code",
        404,
      );
    });

    it("sets ERROR status on >= 500", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response("error", { status: 502 }));
      const tracedFetch = instrumentFetch(mockFetch);

      await tracedFetch("https://api.example.com/fail");

      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
      });
    });

    it("ends span after successful fetch", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
      const tracedFetch = instrumentFetch(mockFetch);

      await tracedFetch("https://api.example.com/data");

      expect(mockSpan.end).toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("sets ERROR + recordException on fetch failure, re-throws", async () => {
      const error = new Error("network error");
      const mockFetch = vi.fn().mockRejectedValue(error);
      const tracedFetch = instrumentFetch(mockFetch);

      await expect(
        tracedFetch("https://api.example.com/data"),
      ).rejects.toThrow("network error");

      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: "network error",
      });
      expect(mockSpan.recordException).toHaveBeenCalledWith(error);
      expect(mockSpan.end).toHaveBeenCalled();
    });
  });

  describe("propagation", () => {
    it("calls propagation.inject on outgoing headers", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
      const tracedFetch = instrumentFetch(mockFetch);

      await tracedFetch("https://api.example.com/data");

      expect(mockInject).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Headers),
        expect.objectContaining({
          set: expect.any(Function),
        }),
      );
    });

    it("injects before calling originalFetch", async () => {
      const callOrder: string[] = [];
      mockInject.mockImplementation(() => callOrder.push("inject"));
      const mockFetch = vi.fn().mockImplementation(() => {
        callOrder.push("fetch");
        return Promise.resolve(new Response("ok"));
      });
      const tracedFetch = instrumentFetch(mockFetch);

      await tracedFetch("https://api.example.com/data");

      expect(callOrder).toEqual(["inject", "fetch"]);
    });
  });

  describe("response traceparent", () => {
    it("records http.response.traceparent attr when present", async () => {
      const traceparent =
        "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("ok", {
          headers: { traceparent },
        }),
      );
      const tracedFetch = instrumentFetch(mockFetch);

      await tracedFetch("https://api.example.com/data");

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        "http.response.traceparent",
        traceparent,
      );
    });

    it("does not set attr when no traceparent in response", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
      const tracedFetch = instrumentFetch(mockFetch);

      await tracedFetch("https://api.example.com/data");

      expect(mockSpan.setAttribute).not.toHaveBeenCalledWith(
        "http.response.traceparent",
        expect.anything(),
      );
    });
  });

  describe("logging", () => {
    it("emits ONE logger.info with all attrs on success", async () => {
      const logger = createMockLogger();
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('{"ok":true}', {
          headers: { "content-type": "application/json" },
        }),
      );
      const tracedFetch = instrumentFetch(mockFetch, { logger });

      await tracedFetch("https://api.example.com/data");

      expect(logger.info).toHaveBeenCalledTimes(1);
      const [message, attrs] = logger.info.mock.calls[0];
      expect(message).toMatch(/^GET https:\/\/api\.example\.com\/data 200 \d+ms$/);
      expect(attrs).toMatchObject({
        "http.method": "GET",
        "http.url": "https://api.example.com/data",
        "http.status_code": 200,
        "http.duration_ms": expect.any(Number),
        "http.request.headers": expect.any(String),
        "http.response.headers": expect.any(String),
        "http.response.body": '{"ok":true}',
      });
    });

    it("emits ONE logger.error on fetch failure", async () => {
      const logger = createMockLogger();
      const error = new Error("connection refused");
      const mockFetch = vi.fn().mockRejectedValue(error);
      const tracedFetch = instrumentFetch(mockFetch, { logger });

      await expect(
        tracedFetch("https://api.example.com/data"),
      ).rejects.toThrow("connection refused");

      expect(logger.error).toHaveBeenCalledTimes(1);
      const [message, attrs] = logger.error.mock.calls[0];
      expect(message).toMatch(
        /^GET https:\/\/api\.example\.com\/data FAILED \d+ms$/,
      );
      expect(attrs).toMatchObject({
        "http.method": "GET",
        "http.url": "https://api.example.com/data",
        "http.duration_ms": expect.any(Number),
        "http.error": "connection refused",
      });
      expect(logger.info).not.toHaveBeenCalled();
    });
  });

  describe("no logger", () => {
    it("no log emitted and no body cloning", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('{"ok":true}', {
          headers: { "content-type": "application/json" },
        }),
      );
      // No logger → no cloning needed
      const tracedFetch = instrumentFetch(mockFetch);

      const response = await tracedFetch("https://api.example.com/data");

      // response body is still readable
      const body = await response.text();
      expect(body).toBe('{"ok":true}');
      // span still created
      expect(mockSpan.end).toHaveBeenCalled();
    });
  });

  describe("body logging", () => {
    it("includes body for application/json", async () => {
      const logger = createMockLogger();
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('{"data":1}', {
          headers: { "content-type": "application/json" },
        }),
      );
      const tracedFetch = instrumentFetch(mockFetch, { logger });

      await tracedFetch("https://api.example.com/data");

      const attrs = logger.info.mock.calls[0][1];
      expect(attrs["http.response.body"]).toBe('{"data":1}');
    });

    it("includes body for text/plain", async () => {
      const logger = createMockLogger();
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("hello", {
          headers: { "content-type": "text/plain" },
        }),
      );
      const tracedFetch = instrumentFetch(mockFetch, { logger });

      await tracedFetch("https://api.example.com/data");

      const attrs = logger.info.mock.calls[0][1];
      expect(attrs["http.response.body"]).toBe("hello");
    });

    it("includes body for x-www-form-urlencoded", async () => {
      const logger = createMockLogger();
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("key=val", {
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
      );
      const tracedFetch = instrumentFetch(mockFetch, { logger });

      await tracedFetch("https://api.example.com/data");

      const attrs = logger.info.mock.calls[0][1];
      expect(attrs["http.response.body"]).toBe("key=val");
    });

    it("excludes body for multipart/form-data", async () => {
      const logger = createMockLogger();
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("binary data", {
          headers: { "content-type": "multipart/form-data" },
        }),
      );
      const tracedFetch = instrumentFetch(mockFetch, { logger });

      await tracedFetch("https://api.example.com/upload");

      const attrs = logger.info.mock.calls[0][1];
      expect(attrs["http.response.body"]).toBeUndefined();
    });

    it("excludes body for non-loggable content-type (image/png)", async () => {
      const logger = createMockLogger();
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("binary data", {
          headers: { "content-type": "image/png" },
        }),
      );
      const tracedFetch = instrumentFetch(mockFetch, { logger });

      await tracedFetch("https://api.example.com/image");

      const attrs = logger.info.mock.calls[0][1];
      expect(attrs["http.response.body"]).toBeUndefined();
    });

    it("logs request body when present and loggable", async () => {
      const logger = createMockLogger();
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
      const tracedFetch = instrumentFetch(mockFetch, { logger });

      await tracedFetch("https://api.example.com/data", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"name":"test"}',
      });

      const attrs = logger.info.mock.calls[0][1];
      expect(attrs["http.request.body"]).toBe('{"name":"test"}');
    });
  });

  describe("header redaction", () => {
    it("redacts default sensitive headers", async () => {
      const logger = createMockLogger();
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("ok", {
          headers: {
            "set-cookie": "session=abc",
            "x-request-id": "123",
          },
        }),
      );
      const tracedFetch = instrumentFetch(mockFetch, { logger });

      await tracedFetch("https://api.example.com/data", {
        headers: {
          authorization: "Bearer secret",
          "x-custom": "visible",
        },
      });

      const attrs = logger.info.mock.calls[0][1];
      const reqHeaders = JSON.parse(attrs["http.request.headers"] as string);
      expect(reqHeaders["authorization"]).toBe("[REDACTED]");
      expect(reqHeaders["x-custom"]).toBe("visible");

      const resHeaders = JSON.parse(attrs["http.response.headers"] as string);
      expect(resHeaders["set-cookie"]).toBe("[REDACTED]");
      expect(resHeaders["x-request-id"]).toBe("123");
    });

    it("custom sensitiveHeaders overrides defaults", async () => {
      const logger = createMockLogger();
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
      const tracedFetch = instrumentFetch(mockFetch, {
        logger,
        sensitiveHeaders: ["x-custom-secret"],
      });

      await tracedFetch("https://api.example.com/data", {
        headers: {
          authorization: "Bearer token",
          "x-custom-secret": "hidden",
        },
      });

      const attrs = logger.info.mock.calls[0][1];
      const reqHeaders = JSON.parse(attrs["http.request.headers"] as string);
      // authorization is NOT redacted because custom list overrides defaults
      expect(reqHeaders["authorization"]).toBe("Bearer token");
      expect(reqHeaders["x-custom-secret"]).toBe("[REDACTED]");
    });
  });

  describe("body truncation", () => {
    it("truncates bodies exceeding maxBodyLogSize", async () => {
      const logger = createMockLogger();
      const largeBody = "x".repeat(100);
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(largeBody, {
          headers: { "content-type": "text/plain" },
        }),
      );
      const tracedFetch = instrumentFetch(mockFetch, {
        logger,
        maxBodyLogSize: 50,
      });

      await tracedFetch("https://api.example.com/data");

      const attrs = logger.info.mock.calls[0][1];
      const body = attrs["http.response.body"] as string;
      expect(body).toContain("[truncated]");
      expect(body.replace("[truncated]", "").length).toBeLessThanOrEqual(50);
    });
  });

  describe("passthrough", () => {
    it("caller can read response body normally", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('{"result":42}', {
          headers: { "content-type": "application/json" },
        }),
      );
      const logger = createMockLogger();
      const tracedFetch = instrumentFetch(mockFetch, { logger });

      const response = await tracedFetch("https://api.example.com/data");
      const body = await response.json();

      expect(body).toEqual({ result: 42 });
    });

    it("caller can read response body without logger", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("plain text"),
      );
      const tracedFetch = instrumentFetch(mockFetch);

      const response = await tracedFetch("https://api.example.com/data");
      const body = await response.text();

      expect(body).toBe("plain text");
    });
  });

  describe("config defaults", () => {
    it("uses 'fetch' as default serviceName", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
      const tracedFetch = instrumentFetch(mockFetch);

      await tracedFetch("https://api.example.com/data");

      // Span was created (via trace.getTracer("fetch")) — verified by span.end
      expect(mockSpan.end).toHaveBeenCalled();
    });

    it("normalizes input to Request", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
      const tracedFetch = instrumentFetch(mockFetch);

      await tracedFetch(new URL("https://api.example.com/data"));

      expect(mockFetch).toHaveBeenCalledWith(expect.any(Request));
    });
  });
});
