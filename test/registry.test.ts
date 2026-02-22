import { describe, it, expect, vi } from "vitest";

// We need to test the registry in isolation, so we mock the built-in adapters
vi.mock("../src/runtimes/node.js", () => ({
  nodeAdapter: {
    name: "node",
    detect: () => false,
    setup: vi.fn(),
  },
}));

vi.mock("../src/runtimes/cloudflare/worker.js", () => ({
  cloudflareWorkerAdapter: {
    name: "cloudflare-worker",
    detect: () => false,
    setup: vi.fn(),
  },
}));

// Mock noop module
vi.mock("../src/noop.js", () => ({
  noopSDKResult: () => ({
    provider: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    async shutdown() {},
    async forceFlush() {},
  }),
}));

describe("registry", () => {
  it("resolves adapter by explicit name", async () => {
    const { resolve } = await import("../src/registry.js");
    const adapter = resolve("node");
    expect(adapter.name).toBe("node");
  });

  it("resolves cloudflare-worker adapter by name", async () => {
    const { resolve } = await import("../src/registry.js");
    const adapter = resolve("cloudflare-worker");
    expect(adapter.name).toBe("cloudflare-worker");
  });

  it("returns noop adapter when no adapter matches the given name", async () => {
    const { resolve } = await import("../src/registry.js");
    const adapter = resolve("unknown-runtime");
    expect(adapter.name).toBe("noop");
  });

  it("returns noop adapter when no runtime is detected and none specified", async () => {
    const { resolve } = await import("../src/registry.js");
    // Both mocked adapters return detect() = false
    const adapter = resolve();
    expect(adapter.name).toBe("noop");
  });

  it("noop adapter setup returns a valid SDKResult", async () => {
    const { resolve } = await import("../src/registry.js");
    const adapter = resolve("unknown-runtime");
    const result = adapter.setup({ serviceName: "test" });
    expect(result).toHaveProperty("provider");
    expect(result).toHaveProperty("logger");
    expect(result).toHaveProperty("shutdown");
    expect(result).toHaveProperty("forceFlush");
  });

  it("registers and resolves a custom adapter", async () => {
    const { register, resolve } = await import("../src/registry.js");
    const customAdapter = {
      name: "custom",
      detect: () => true,
      setup: vi.fn().mockReturnValue({
        provider: {},
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        shutdown: vi.fn(),
        forceFlush: vi.fn(),
      }),
    };

    register(customAdapter);
    const resolved = resolve("custom");
    expect(resolved.name).toBe("custom");
  });

  it("auto-detects custom adapter when it returns true", async () => {
    const { resolve } = await import("../src/registry.js");
    // The previously registered custom adapter has detect() = true
    // and is last in the list after CF (false) and Node (false)
    const resolved = resolve();
    expect(resolved.name).toBe("custom");
  });

  it("returns all registered adapters", async () => {
    const { getRegisteredAdapters } = await import("../src/registry.js");
    const adapters = getRegisteredAdapters();
    expect(adapters.length).toBeGreaterThanOrEqual(2);
    expect(adapters[0].name).toBe("cloudflare-worker");
    expect(adapters[1].name).toBe("node");
  });
});
