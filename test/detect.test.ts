import { describe, it, expect, afterEach } from "vitest";
import { detectNode, detectCloudflareWorker } from "../src/detect.js";

describe("detectNode", () => {
  it("returns true in Node.js environment", () => {
    expect(detectNode()).toBe(true);
  });

  it("returns false when process.versions.node is absent", () => {
    const origVersions = process.versions;
    Object.defineProperty(process, "versions", {
      value: {},
      configurable: true,
    });
    try {
      expect(detectNode()).toBe(false);
    } finally {
      Object.defineProperty(process, "versions", {
        value: origVersions,
        configurable: true,
      });
    }
  });
});

describe("detectCloudflareWorker", () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
    });
  });

  it("returns true when navigator.userAgent is Cloudflare-Workers", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: "Cloudflare-Workers" },
      configurable: true,
    });
    expect(detectCloudflareWorker()).toBe(true);
  });

  it("returns false when navigator.userAgent is something else", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: "Mozilla/5.0" },
      configurable: true,
    });
    expect(detectCloudflareWorker()).toBe(false);
  });

  it("returns false when navigator is undefined", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: undefined,
      configurable: true,
    });
    expect(detectCloudflareWorker()).toBe(false);
  });
});
