import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";

// Mock initSDK - all fns defined inside factory to avoid hoisting issues
const { mockForceFlush } = vi.hoisted(() => ({
  mockForceFlush: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/sdk.js", () => {
  return {
    initSDK: vi.fn().mockReturnValue({
      provider: {},
      meterProvider: {},
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      shutdown: vi.fn().mockResolvedValue(undefined),
      forceFlush: mockForceFlush,
    }),
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

import {
  instrument,
  traceHandler,
  _resetInstrumentState,
} from "../src/runtimes/cloudflare/instrument.js";
import { initSDK } from "../src/sdk.js";

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
      const handler = instrument({
        serviceName: "test-service",
        handler: { fetch: originalFetch },
      });

      const req = new Request("https://example.com/api/test");
      const ctx = createMockCtx();

      const response = await handler.fetch!(req, {}, ctx);

      expect(originalFetch).toHaveBeenCalledWith(req, {}, ctx);
      expect(response).toBeInstanceOf(Response);
      expect(mockSpanFns.setAttribute).toHaveBeenCalledWith(
        "http.status_code",
        200,
      );
      expect(mockSpanFns.end).toHaveBeenCalled();
      expect(ctx.waitUntil).toHaveBeenCalled();
    });

    it("sets error status on 5xx responses", async () => {
      const originalFetch = vi
        .fn()
        .mockResolvedValue(new Response("error", { status: 500 }));
      const handler = instrument({
        serviceName: "test-service",
        handler: { fetch: originalFetch },
      });

      const ctx = createMockCtx();
      await handler.fetch!(new Request("https://example.com/"), {}, ctx);

      expect(mockSpanFns.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
      });
    });

    it("records exception on thrown error", async () => {
      const error = new Error("fetch failed");
      const originalFetch = vi.fn().mockRejectedValue(error);
      const handler = instrument({
        serviceName: "test-service",
        handler: { fetch: originalFetch },
      });

      const ctx = createMockCtx();
      await expect(
        handler.fetch!(new Request("https://example.com/"), {}, ctx),
      ).rejects.toThrow("fetch failed");

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
      const handler = instrument({
        serviceName: "test-service",
        handler: { scheduled: originalScheduled },
      });

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
      const handler = instrument({
        serviceName: "test-service",
        handler: { scheduled: originalScheduled },
      });

      const controller = {
        scheduledTime: Date.now(),
        cron: "*/5 * * * *",
        noRetry: vi.fn(),
      };
      const ctx = createMockCtx();

      await expect(
        handler.scheduled!(controller, {}, ctx),
      ).rejects.toThrow("scheduled failed");

      expect(mockSpanFns.recordException).toHaveBeenCalledWith(error);
      expect(mockSpanFns.end).toHaveBeenCalled();
      expect(ctx.waitUntil).toHaveBeenCalled();
    });
  });

  describe("queue handler", () => {
    it("wraps queue handler and creates a span", async () => {
      const originalQueue = vi.fn().mockResolvedValue(undefined);
      const handler = instrument({
        serviceName: "test-service",
        handler: { queue: originalQueue },
      });

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
      const handler = instrument({
        serviceName: "auto-init-test",
        handler: { fetch: vi.fn().mockResolvedValue(new Response("ok")) },
      });

      const ctx = createMockCtx();
      await handler.fetch!(new Request("https://example.com/"), {}, ctx);

      expect(initSDK).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: "auto-init-test",
          runtime: "cloudflare-worker",
        }),
      );
    });

    it("does not re-initialize SDK on subsequent calls", async () => {
      const handler = instrument({
        serviceName: "auto-init-test",
        handler: { fetch: vi.fn().mockResolvedValue(new Response("ok")) },
      });

      const ctx = createMockCtx();
      await handler.fetch!(new Request("https://example.com/"), {}, ctx);
      await handler.fetch!(new Request("https://example.com/other"), {}, ctx);

      expect(initSDK).toHaveBeenCalledTimes(1);
    });
  });

  describe("handler passthrough", () => {
    it("does not wrap handlers that are not defined", () => {
      const handler = instrument({
        serviceName: "test-service",
        handler: {},
      });

      expect(handler.fetch).toBeUndefined();
      expect(handler.scheduled).toBeUndefined();
      expect(handler.queue).toBeUndefined();
    });
  });

  describe("flush", () => {
    it("calls waitUntil with forceFlush promise", async () => {
      const handler = instrument({
        serviceName: "test-service",
        handler: { fetch: vi.fn().mockResolvedValue(new Response("ok")) },
      });

      const ctx = createMockCtx();
      await handler.fetch!(new Request("https://example.com/"), {}, ctx);

      expect(ctx.waitUntil).toHaveBeenCalled();
      const waitUntilArg = ctx.waitUntil.mock.calls[0][0];
      expect(waitUntilArg).toBeInstanceOf(Promise);
    });

    it("forceFlush is called on each request", async () => {
      const handler = instrument({
        serviceName: "test-service",
        exporterEndpoint: "https://otel.example.com",
        handler: { fetch: vi.fn().mockResolvedValue(new Response("ok")) },
      });

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

    await traceHandler(ctx, request, {
      serviceName: "test-service",
      handler: () => new Response("ok"),
    });

    expect(mockSpanFns.setAttribute).toHaveBeenCalledWith(
      "http.status_code",
      200,
    );
    expect(mockSpanFns.end).toHaveBeenCalled();
  });

  it("sets error status on 5xx response", async () => {
    const ctx = createMockCtx();
    const request = new Request("https://example.com/");

    await traceHandler(ctx, request, {
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
      traceHandler(ctx, request, {
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

    await traceHandler(ctx, new Request("https://example.com/"), {
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

    const response = await traceHandler(
      ctx,
      new Request("https://example.com/"),
      {
        serviceName: "test-service",
        handler: () => new Response("ok"),
      },
    );

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

    await traceHandler(ctx, request, {
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

    await traceHandler(ctx, new Request("https://example.com/"), {
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
