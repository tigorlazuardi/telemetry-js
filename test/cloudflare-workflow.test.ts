import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";

// Mock initSDK
vi.mock("../src/sdk.js", () => ({
  initSDK: vi.fn().mockReturnValue({
    provider: {},
    meterProvider: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    shutdown: vi.fn().mockResolvedValue(undefined),
    forceFlush: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Hoist all variables referenced inside vi.mock factories
const { mockExtract, mockInject, mockSpans, createMockSpan, activeCtxStack } =
  vi.hoisted(() => {
    type MockSpan = {
      name: string;
      opts: Record<string, unknown>;
      parentCtx: unknown;
      setAttribute: ReturnType<typeof vi.fn>;
      setStatus: ReturnType<typeof vi.fn>;
      recordException: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };

    const spans: MockSpan[] = [];
    // Stack to simulate context propagation via startActiveSpan
    const ctxStack: unknown[] = [{ activeCtx: true }];

    return {
      mockExtract: vi.fn(
        (_ctx: unknown, _carrier: unknown) => ({ extracted: true }),
      ),
      mockInject: vi.fn(
        (
          _ctx: unknown,
          carrier: Record<string, string>,
          setter?: {
            set: (
              c: Record<string, string>,
              k: string,
              v: string,
            ) => void;
          },
        ) => {
          if (setter) {
            setter.set(carrier, "traceparent", "00-abc123-def456-01");
          }
        },
      ),
      mockSpans: spans,
      createMockSpan: () => {
        const span: MockSpan = {
          name: "",
          opts: {},
          parentCtx: undefined,
          setAttribute: vi.fn(),
          setStatus: vi.fn(),
          recordException: vi.fn(),
          end: vi.fn(),
        };
        spans.push(span);
        return span;
      },
      activeCtxStack: ctxStack,
    };
  });

vi.mock("@opentelemetry/api", async () => {
  const actual = await vi.importActual("@opentelemetry/api");
  return {
    ...actual,
    ROOT_CONTEXT: {},
    context: {
      ...(actual as Record<string, unknown>).context,
      active: () => activeCtxStack[activeCtxStack.length - 1],
    },
    propagation: {
      extract: mockExtract,
      inject: mockInject,
    },
    trace: {
      getTracer: () => ({
        startActiveSpan: async (
          name: string,
          opts: unknown,
          ctx: unknown,
          fn?: (...args: unknown[]) => unknown,
        ) => {
          const callback = typeof ctx === "function" ? ctx : fn;
          const span = createMockSpan();
          span.name = name;
          span.opts = opts as Record<string, unknown>;
          span.parentCtx = typeof ctx === "function" ? undefined : ctx;
          // Simulate context propagation: push new context with this span
          const childCtx = { __span: span, __parent: ctx };
          activeCtxStack.push(childCtx);
          try {
            return await (callback as (...args: unknown[]) => unknown)(span);
          } finally {
            activeCtxStack.pop();
          }
        },
      }),
      setSpan: vi.fn(
        (ctx: unknown, span: unknown) => ({ ...Object(ctx), __span: span }),
      ),
    },
  };
});

import {
  instrumentWorkflow,
  injectTraceparent,
  extractTraceparent,
} from "../src/runtimes/cloudflare/workflow.js";
import { initSDK } from "../src/sdk.js";
import { _resetInstrumentState } from "../src/runtimes/cloudflare/instrument.js";

function createMockStep() {
  return {
    do: vi.fn(
      (
        _name: string,
        configOrCallback: unknown,
        maybeCallback?: () => Promise<unknown>,
      ) => {
        const callback =
          typeof configOrCallback === "function"
            ? configOrCallback
            : maybeCallback;
        return (callback as () => Promise<unknown>)();
      },
    ),
    sleep: vi.fn().mockResolvedValue(undefined),
    sleepUntil: vi.fn().mockResolvedValue(undefined),
  };
}

/** Helper: apply the decorator manually (no decorator syntax needed in tests). */
function applyDecorator(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cls: new (...args: unknown[]) => any,
  opts: Parameters<typeof instrumentWorkflow>[0] = {},
) {
  const decorator = instrumentWorkflow(opts);
  // TC39 class decorator signature: (target, context)
  return decorator(cls, {
    kind: "class",
    name: cls.name,
  } as ClassDecoratorContext<typeof cls>);
}

describe("instrumentWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpans.length = 0;
    activeCtxStack.length = 1; // reset to base context
    _resetInstrumentState();
  });

  it("calls ensureSDK with SDK opts + env from this.env", async () => {
    const step = createMockStep();
    const mockEnv = { OTEL_KEY: "test-key" };

    class TestWorkflow {
      env = mockEnv;
      async run(_event: unknown, step: Record<string, unknown>) {
        return step.do("test-step", async () => "result");
      }
    }

    const Decorated = applyDecorator(TestWorkflow, {
      serviceName: "my-workflow",
      exporterEndpoint: "https://otel.example.com",
    });

    const instance = new Decorated();
    await instance.run({ payload: {} }, step);

    expect(initSDK).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: "my-workflow",
        exporterEndpoint: "https://otel.example.com",
        env: mockEnv,
        runtime: "cloudflare-worker",
      }),
    );
  });

  it("persists traceparent as first step", async () => {
    const step = createMockStep();

    class TestWorkflow {
      env = {};
      async run(_event: unknown, step: Record<string, unknown>) {
        await step.do("my-step", async () => "ok");
      }
    }

    const Decorated = applyDecorator(TestWorkflow, { serviceName: "wf" });
    const instance = new Decorated();
    await instance.run({ payload: {} }, step);

    // First call to step.do should be __traceparent
    expect(step.do).toHaveBeenCalledWith(
      "__traceparent",
      expect.any(Function),
    );
    // Verify __traceparent was called before my-step
    const calls = step.do.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls[0]).toBe("__traceparent");
    expect(calls[1]).toBe("my-step");
  });

  it("wraps step.do with span using user's step name", async () => {
    const step = createMockStep();

    class TestWorkflow {
      env = {};
      async run(_event: unknown, step: Record<string, unknown>) {
        await step.do("fetch-data", async () => ({ data: 42 }));
      }
    }

    const Decorated = applyDecorator(TestWorkflow, { serviceName: "wf" });
    const instance = new Decorated();
    await instance.run({ payload: {} }, step);

    const userSpan = mockSpans.find((s) => s.name === "fetch-data");
    expect(userSpan).toBeDefined();
    expect(userSpan!.opts).toEqual(
      expect.objectContaining({ kind: SpanKind.INTERNAL }),
    );
    expect(userSpan!.end).toHaveBeenCalled();
  });

  it("forwards WorkflowStepConfig to original step.do", async () => {
    const step = createMockStep();
    const config = { retries: { limit: 3 }, timeout: "30s" };

    class TestWorkflow {
      env = {};
      async run(_event: unknown, step: Record<string, unknown>) {
        await step.do("with-config", config, async () => "ok");
      }
    }

    const Decorated = applyDecorator(TestWorkflow, { serviceName: "wf" });
    const instance = new Decorated();
    await instance.run({ payload: {} }, step);

    const userCall = step.do.mock.calls.find(
      (c: unknown[]) => c[0] === "with-config",
    );
    expect(userCall).toBeDefined();
    expect(userCall![1]).toEqual(config);
    expect(typeof userCall![2]).toBe("function");
  });

  it("records error and re-throws on failure", async () => {
    const step = createMockStep();
    step.do.mockImplementation(
      (
        name: string,
        configOrCallback: unknown,
        maybeCallback?: () => Promise<unknown>,
      ) => {
        if (name === "__traceparent") {
          return (configOrCallback as () => Promise<unknown>)();
        }
        const callback =
          typeof configOrCallback === "function"
            ? configOrCallback
            : maybeCallback;
        return (callback as () => Promise<unknown>)();
      },
    );

    const error = new Error("step failed");

    class TestWorkflow {
      env = {};
      async run(_event: unknown, step: Record<string, unknown>) {
        await step.do("failing-step", async () => {
          throw error;
        });
      }
    }

    const Decorated = applyDecorator(TestWorkflow, { serviceName: "wf" });
    const instance = new Decorated();

    await expect(instance.run({ payload: {} }, step)).rejects.toThrow(
      "step failed",
    );

    const failSpan = mockSpans.find((s) => s.name === "failing-step");
    expect(failSpan).toBeDefined();
    expect(failSpan!.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "step failed",
    });
    expect(failSpan!.recordException).toHaveBeenCalledWith(error);
    expect(failSpan!.end).toHaveBeenCalled();
  });

  it("wraps sleep with span", async () => {
    const step = createMockStep();

    class TestWorkflow {
      env = {};
      async run(_event: unknown, step: Record<string, unknown>) {
        await step.sleep("wait-a-bit", "10s");
      }
    }

    const Decorated = applyDecorator(TestWorkflow, { serviceName: "wf" });
    const instance = new Decorated();
    await instance.run({ payload: {} }, step);

    expect(step.sleep).toHaveBeenCalledWith("wait-a-bit", "10s");
    const sleepSpan = mockSpans.find((s) => s.name === "wait-a-bit");
    expect(sleepSpan).toBeDefined();
    expect(sleepSpan!.end).toHaveBeenCalled();
  });

  it("wraps sleepUntil with span", async () => {
    const step = createMockStep();
    const target = new Date("2025-01-01T00:00:00Z");

    class TestWorkflow {
      env = {};
      async run(_event: unknown, step: Record<string, unknown>) {
        await step.sleepUntil("wait-until", target);
      }
    }

    const Decorated = applyDecorator(TestWorkflow, { serviceName: "wf" });
    const instance = new Decorated();
    await instance.run({ payload: {} }, step);

    expect(step.sleepUntil).toHaveBeenCalledWith("wait-until", target);
    const sleepSpan = mockSpans.find((s) => s.name === "wait-until");
    expect(sleepSpan).toBeDefined();
    expect(sleepSpan!.end).toHaveBeenCalled();
  });

  it("auto-extracts traceparent from event.payload.__traceparent", async () => {
    const step = createMockStep();
    const tp = "00-abc123-def456-01";

    class TestWorkflow {
      env = {};
      async run(_event: unknown, step: Record<string, unknown>) {
        await step.do("test-step", async () => "ok");
      }
    }

    const Decorated = applyDecorator(TestWorkflow, { serviceName: "wf" });
    const instance = new Decorated();
    await instance.run({ payload: { __traceparent: tp } }, step);

    const tpCall = step.do.mock.calls.find(
      (c: unknown[]) => c[0] === "__traceparent",
    );
    expect(tpCall).toBeDefined();
    const tpResult = await (tpCall![1] as () => Promise<string>)();
    expect(tpResult).toBe(tp);
  });

  it("serializes active context when no traceparent in payload", async () => {
    const step = createMockStep();

    class TestWorkflow {
      env = {};
      async run(_event: unknown, step: Record<string, unknown>) {
        await step.do("test-step", async () => "ok");
      }
    }

    const Decorated = applyDecorator(TestWorkflow, { serviceName: "wf" });
    const instance = new Decorated();
    await instance.run({ payload: {} }, step);

    expect(mockInject).toHaveBeenCalled();
  });

  it("proxies unknown step properties to original step", async () => {
    const step = createMockStep();
    (step as Record<string, unknown>).customProp = "hello";
    (step as Record<string, unknown>).waitForEvent = vi.fn();

    class TestWorkflow {
      env = {};
      async run(_event: unknown, step: Record<string, unknown>) {
        // Access the proxied properties
        return {
          custom: step.customProp,
          hasWaitForEvent: typeof step.waitForEvent,
        };
      }
    }

    const Decorated = applyDecorator(TestWorkflow, { serviceName: "wf" });
    const instance = new Decorated();
    const result = await instance.run({ payload: {} }, step);

    expect(result.custom).toBe("hello");
    expect(result.hasWaitForEvent).toBe("function");
  });

  it("creates a root workflow.run span wrapping the entire run", async () => {
    const step = createMockStep();

    class TestWorkflow {
      env = {};
      async run(_event: unknown, step: Record<string, unknown>) {
        await step.do("step-a", async () => "a");
      }
    }

    const Decorated = applyDecorator(TestWorkflow, { serviceName: "wf" });
    const instance = new Decorated();
    await instance.run({ payload: {} }, step);

    const rootSpan = mockSpans.find((s) => s.name === "workflow.run");
    expect(rootSpan).toBeDefined();
    expect(rootSpan!.opts).toEqual(
      expect.objectContaining({ kind: SpanKind.INTERNAL }),
    );
    expect(rootSpan!.end).toHaveBeenCalled();
  });

  it("step spans are children of workflow.run via active context", async () => {
    const step = createMockStep();

    class TestWorkflow {
      env = {};
      async run(_event: unknown, step: Record<string, unknown>) {
        await step.do("child-step", async () => "ok");
      }
    }

    const Decorated = applyDecorator(TestWorkflow, { serviceName: "wf" });
    const instance = new Decorated();
    await instance.run({ payload: {} }, step);

    const rootSpan = mockSpans.find((s) => s.name === "workflow.run");
    const childSpan = mockSpans.find((s) => s.name === "child-step");
    expect(rootSpan).toBeDefined();
    expect(childSpan).toBeDefined();

    // child-step's parentCtx should contain the workflow.run span
    const parentCtx = childSpan!.parentCtx as Record<string, unknown>;
    expect(parentCtx).toBeDefined();
    expect(parentCtx.__span).toBe(rootSpan);
  });

  it("nested step.do spans become children of outer step span", async () => {
    const step = createMockStep();

    class TestWorkflow {
      env = {};
      async run(_event: unknown, step: Record<string, unknown>) {
        await (step.do as CallableFunction)(
          "outer",
          async () =>
            (step.do as CallableFunction)("inner", async () => "nested"),
        );
      }
    }

    const Decorated = applyDecorator(TestWorkflow, { serviceName: "wf" });
    const instance = new Decorated();
    await instance.run({ payload: {} }, step);

    const outerSpan = mockSpans.find((s) => s.name === "outer");
    const innerSpan = mockSpans.find((s) => s.name === "inner");
    expect(outerSpan).toBeDefined();
    expect(innerSpan).toBeDefined();

    // inner's parentCtx should contain the outer span (not workflow.run)
    const innerParent = innerSpan!.parentCtx as Record<string, unknown>;
    expect(innerParent.__span).toBe(outerSpan);
  });

  it("root span records error when run() throws", async () => {
    const step = createMockStep();
    step.do.mockImplementation(
      (
        name: string,
        configOrCallback: unknown,
        maybeCallback?: () => Promise<unknown>,
      ) => {
        if (name === "__traceparent") {
          return (configOrCallback as () => Promise<unknown>)();
        }
        const callback =
          typeof configOrCallback === "function"
            ? configOrCallback
            : maybeCallback;
        return (callback as () => Promise<unknown>)();
      },
    );

    const error = new Error("run crashed");

    class TestWorkflow {
      env = {};
      async run(_event: unknown, _step: Record<string, unknown>) {
        throw error;
      }
    }

    const Decorated = applyDecorator(TestWorkflow, { serviceName: "wf" });
    const instance = new Decorated();

    await expect(instance.run({ payload: {} }, step)).rejects.toThrow(
      "run crashed",
    );

    const rootSpan = mockSpans.find((s) => s.name === "workflow.run");
    expect(rootSpan).toBeDefined();
    expect(rootSpan!.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "run crashed",
    });
    expect(rootSpan!.recordException).toHaveBeenCalledWith(error);
    expect(rootSpan!.end).toHaveBeenCalled();
  });

  it("caches wrapped step methods across accesses", async () => {
    const step = createMockStep();
    let doRef1: unknown;
    let doRef2: unknown;
    let sleepRef1: unknown;
    let sleepRef2: unknown;

    class TestWorkflow {
      env = {};
      async run(_event: unknown, step: Record<string, unknown>) {
        doRef1 = step.do;
        doRef2 = step.do;
        sleepRef1 = step.sleep;
        sleepRef2 = step.sleep;
        await (step.do as CallableFunction)("test", async () => "ok");
      }
    }

    const Decorated = applyDecorator(TestWorkflow, { serviceName: "wf" });
    const instance = new Decorated();
    await instance.run({ payload: {} }, step);

    expect(doRef1).toBe(doRef2);
    expect(sleepRef1).toBe(sleepRef2);
  });

  it("uses opts.env when provided, falls back to this.env", async () => {
    const step = createMockStep();
    const optsEnv = { CUSTOM_KEY: "from-opts" };
    const instanceEnv = { CUSTOM_KEY: "from-instance" };

    class TestWorkflow {
      env = instanceEnv;
      async run(_event: unknown, step: Record<string, unknown>) {
        await step.do("test-step", async () => "ok");
      }
    }

    // With opts.env — should use opts.env
    const Decorated = applyDecorator(TestWorkflow, {
      serviceName: "wf",
      env: optsEnv,
    });
    const instance = new Decorated();
    await instance.run({ payload: {} }, step);

    expect(initSDK).toHaveBeenCalledWith(
      expect.objectContaining({ env: optsEnv }),
    );

    vi.clearAllMocks();
    mockSpans.length = 0;
    _resetInstrumentState();

    // Without opts.env — should use this.env
    const Decorated2 = applyDecorator(TestWorkflow, { serviceName: "wf" });
    const instance2 = new Decorated2();
    await instance2.run({ payload: {} }, step);

    expect(initSDK).toHaveBeenCalledWith(
      expect.objectContaining({ env: instanceEnv }),
    );
  });
});

describe("injectTraceparent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds __traceparent to params", () => {
    const params = { userId: "abc", count: 42 };
    const result = injectTraceparent(params);

    expect(result.__traceparent).toBe("00-abc123-def456-01");
    expect(result.userId).toBe("abc");
    expect(result.count).toBe(42);
  });

  it("does not mutate original params", () => {
    const params = { userId: "abc" };
    const result = injectTraceparent(params);

    expect(params).toEqual({ userId: "abc" });
    expect(result).not.toBe(params);
    expect(result.__traceparent).toBeDefined();
  });
});

describe("extractTraceparent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts __traceparent from params", () => {
    const params = {
      userId: "abc",
      __traceparent: "00-abc123-def456-01",
    };
    const result = extractTraceparent(params);

    expect(result.traceparent).toBe("00-abc123-def456-01");
    expect(result.params).toEqual({ userId: "abc" });
    expect("__traceparent" in result.params).toBe(false);
  });

  it("returns undefined traceparent when not present", () => {
    const params = { userId: "abc" };
    const result = extractTraceparent(params);

    expect(result.traceparent).toBeUndefined();
    expect(result.params).toEqual({ userId: "abc" });
  });

  it("does not mutate original params", () => {
    const params = {
      userId: "abc",
      __traceparent: "00-abc123-def456-01",
    };
    const original = { ...params };
    extractTraceparent(params);

    expect(params).toEqual(original);
  });
});
