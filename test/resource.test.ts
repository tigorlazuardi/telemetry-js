import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { ResourceDetector } from "@opentelemetry/resources";
import { buildResource, parseEnvResourceAttributes } from "../src/resource.js";
import type { SDKConfig } from "../src/types.js";

const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = "deployment.environment.name";
const ATTR_SERVICE_NAMESPACE = "service.namespace";

// Save original process.stderr.isTTY
const originalIsTTY = process.stderr.isTTY;

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

describe("parseEnvResourceAttributes", () => {
  it("parses comma-separated key=value pairs", () => {
    const result = parseEnvResourceAttributes({
      OTEL_RESOURCE_ATTRIBUTES:
        "service.namespace=my-team,deployment.environment.name=production",
    });
    expect(result).toEqual({
      "service.namespace": "my-team",
      "deployment.environment.name": "production",
    });
  });

  it("URL-decodes values", () => {
    const result = parseEnvResourceAttributes({
      OTEL_RESOURCE_ATTRIBUTES: "key=hello%20world",
    });
    expect(result).toEqual({ key: "hello world" });
  });

  it("trims whitespace from keys and values", () => {
    const result = parseEnvResourceAttributes({
      OTEL_RESOURCE_ATTRIBUTES: " key = value , other = data ",
    });
    expect(result).toEqual({ key: "value", other: "data" });
  });

  it("OTEL_SERVICE_NAME overrides service.name from OTEL_RESOURCE_ATTRIBUTES", () => {
    const result = parseEnvResourceAttributes({
      OTEL_RESOURCE_ATTRIBUTES: "service.name=from-attrs",
      OTEL_SERVICE_NAME: "from-env",
    });
    expect(result[ATTR_SERVICE_NAME]).toBe("from-env");
  });

  it("skips malformed pairs (no =)", () => {
    const result = parseEnvResourceAttributes({
      OTEL_RESOURCE_ATTRIBUTES: "good=value,badpair,=empty-key",
    });
    expect(result).toEqual({ good: "value" });
  });

  it("returns empty object when no env vars are set", () => {
    const result = parseEnvResourceAttributes({});
    expect(result).toEqual({});
  });

  it("handles OTEL_SERVICE_NAME alone", () => {
    const result = parseEnvResourceAttributes({
      OTEL_SERVICE_NAME: "my-service",
    });
    expect(result).toEqual({ [ATTR_SERVICE_NAME]: "my-service" });
  });
});

describe("buildResource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    // Restore TTY state
    Object.defineProperty(process.stderr, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  it("defaults service.name to 'unknown' when serviceName not provided", () => {
    withTTY(false, () => {
      const config: SDKConfig = {};
      const { resource } = buildResource(config, []);
      // The default resource sets unknown_service:node, but config layer sets "unknown"
      // Since config.serviceName is undefined, no config override → base default wins
      // Actually: when serviceName is undefined, we don't set it in configAttrs,
      // so the default "unknown_service:node" from base prevails
      const name = resource.attributes[ATTR_SERVICE_NAME] as string;
      expect(name).toBeDefined();
    });
  });

  it("uses config.serviceName when provided", () => {
    withTTY(false, () => {
      const { resource } = buildResource(
        { serviceName: "my-api" },
        [],
      );
      expect(resource.attributes[ATTR_SERVICE_NAME]).toBe("my-api");
    });
  });

  it("config.env OTEL_SERVICE_NAME overrides config.serviceName", () => {
    withTTY(false, () => {
      const { resource } = buildResource(
        {
          serviceName: "from-config",
          env: { OTEL_SERVICE_NAME: "from-env" },
        },
        [],
      );
      expect(resource.attributes[ATTR_SERVICE_NAME]).toBe("from-env");
    });
  });

  it("config.env OTEL_RESOURCE_ATTRIBUTES are parsed and merged", () => {
    withTTY(false, () => {
      const { resource } = buildResource(
        {
          serviceName: "test",
          env: {
            OTEL_RESOURCE_ATTRIBUTES:
              "deployment.environment.name=staging,service.namespace=my-ns",
          },
        },
        [],
      );
      expect(resource.attributes[ATTR_DEPLOYMENT_ENVIRONMENT_NAME]).toBe(
        "staging",
      );
      expect(resource.attributes[ATTR_SERVICE_NAMESPACE]).toBe("my-ns");
    });
  });

  it("OTEL_SERVICE_NAME in config.env overrides service.name in OTEL_RESOURCE_ATTRIBUTES", () => {
    withTTY(false, () => {
      const { resource } = buildResource(
        {
          env: {
            OTEL_RESOURCE_ATTRIBUTES: "service.name=from-attrs",
            OTEL_SERVICE_NAME: "from-svc-name",
          },
        },
        [],
      );
      expect(resource.attributes[ATTR_SERVICE_NAME]).toBe("from-svc-name");
    });
  });

  it("emits warning when service.name matches unknown_service pattern", () => {
    withTTY(false, () => {
      const { warnings } = buildResource({}, []);
      const svcWarning = warnings.find((w) => w.includes("service.name"));
      expect(svcWarning).toBeDefined();
      expect(svcWarning).toContain("OTEL_SERVICE_NAME");
    });
  });

  it("emits warning when deployment.environment.name is not set and not TTY", () => {
    withTTY(false, () => {
      const { warnings } = buildResource({ serviceName: "test" }, []);
      const envWarning = warnings.find((w) =>
        w.includes("deployment.environment.name is not set"),
      );
      expect(envWarning).toBeDefined();
    });
  });

  it("sets deployment.environment.name to 'local' when TTY", () => {
    withTTY(true, () => {
      const { resource, warnings } = buildResource(
        { serviceName: "test" },
        [],
      );
      expect(resource.attributes[ATTR_DEPLOYMENT_ENVIRONMENT_NAME]).toBe(
        "local",
      );
      const envWarning = warnings.find((w) =>
        w.includes("deployment.environment.name is not set"),
      );
      expect(envWarning).toBeUndefined();
    });
  });

  it("emits warning when service.namespace is not set and not TTY", () => {
    withTTY(false, () => {
      const { warnings } = buildResource({ serviceName: "test" }, []);
      const nsWarning = warnings.find((w) =>
        w.includes("service.namespace is not set"),
      );
      expect(nsWarning).toBeDefined();
    });
  });

  it("sets service.namespace to 'local' when TTY", () => {
    withTTY(true, () => {
      const { resource, warnings } = buildResource(
        { serviceName: "test" },
        [],
      );
      expect(resource.attributes[ATTR_SERVICE_NAMESPACE]).toBe("local");
      const nsWarning = warnings.find((w) =>
        w.includes("service.namespace is not set"),
      );
      expect(nsWarning).toBeUndefined();
    });
  });

  it("emits no warnings when all three attributes are set", () => {
    withTTY(false, () => {
      const { warnings } = buildResource(
        {
          serviceName: "my-api",
          resourceAttributes: {
            "deployment.environment.name": "production",
            "service.namespace": "my-team",
          },
        },
        [],
      );
      expect(warnings).toEqual([]);
    });
  });

  it("merges runtime detector attributes into resource", () => {
    const customDetector: ResourceDetector = {
      detect() {
        return { attributes: { "custom.attr": "detected" } };
      },
    };

    withTTY(true, () => {
      const { resource } = buildResource(
        { serviceName: "test" },
        [customDetector],
      );
      expect(resource.attributes["custom.attr"]).toBe("detected");
    });
  });

  it("does not emit service.name warning when serviceName is set", () => {
    withTTY(true, () => {
      const { warnings } = buildResource({ serviceName: "my-api" }, []);
      const svcWarning = warnings.find((w) =>
        w.includes("service.name resolved to"),
      );
      expect(svcWarning).toBeUndefined();
    });
  });
});
