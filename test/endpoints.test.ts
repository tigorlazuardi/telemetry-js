import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { normalizeEndpoint, resolveSignalEndpoint } from "../src/endpoints.js";
import type { SDKConfig } from "../src/types.js";

describe("normalizeEndpoint", () => {
  it("returns undefined for undefined input", () => {
    expect(normalizeEndpoint(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(normalizeEndpoint("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(normalizeEndpoint("   ")).toBeUndefined();
  });

  it("keeps https:// URLs as-is", () => {
    expect(normalizeEndpoint("https://otel.example.com")).toBe("https://otel.example.com");
  });

  it("keeps http:// URLs as-is", () => {
    expect(normalizeEndpoint("http://localhost:4318")).toBe("http://localhost:4318");
  });

  it("prepends https:// when no protocol", () => {
    expect(normalizeEndpoint("otel.example.com")).toBe("https://otel.example.com");
  });

  it("strips trailing slashes", () => {
    expect(normalizeEndpoint("https://otel.example.com/")).toBe("https://otel.example.com");
    expect(normalizeEndpoint("https://otel.example.com///")).toBe("https://otel.example.com");
  });

  it("trims whitespace", () => {
    expect(normalizeEndpoint("  https://otel.example.com  ")).toBe("https://otel.example.com");
  });
});

describe("resolveSignalEndpoint", () => {
  const baseConfig: SDKConfig = { serviceName: "test" };
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("priority ordering", () => {
    it("returns undefined when nothing is configured", () => {
      expect(resolveSignalEndpoint("traces", baseConfig)).toBeUndefined();
    });

    it("uses config.exporterEndpoint + suffix as lowest priority", () => {
      const config: SDKConfig = {
        ...baseConfig,
        exporterEndpoint: "https://otel.example.com",
      };
      expect(resolveSignalEndpoint("traces", config)).toBe("https://otel.example.com/v1/traces");
      expect(resolveSignalEndpoint("metrics", config)).toBe("https://otel.example.com/v1/metrics");
      expect(resolveSignalEndpoint("logs", config)).toBe("https://otel.example.com/v1/logs");
    });

    it("uses config.tracesExporterEndpoint (full URL) over base config", () => {
      const config: SDKConfig = {
        ...baseConfig,
        exporterEndpoint: "https://base.example.com",
        tracesExporterEndpoint: "https://traces.example.com/custom",
      };
      expect(resolveSignalEndpoint("traces", config)).toBe("https://traces.example.com/custom");
    });

    it("uses config.logsExporterEndpoint (full URL) over base config", () => {
      const config: SDKConfig = {
        ...baseConfig,
        exporterEndpoint: "https://base.example.com",
        logsExporterEndpoint: "https://logs.example.com/custom",
      };
      expect(resolveSignalEndpoint("logs", config)).toBe("https://logs.example.com/custom");
    });

    it("uses OTEL_EXPORTER_OTLP_ENDPOINT env + suffix over config", () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://env-base.example.com";
      const config: SDKConfig = {
        ...baseConfig,
        exporterEndpoint: "https://config.example.com",
        tracesExporterEndpoint: "https://config-traces.example.com",
      };
      expect(resolveSignalEndpoint("traces", config)).toBe(
        "https://env-base.example.com/v1/traces",
      );
    });

    it("uses OTEL_EXPORTER_OTLP_TRACES_ENDPOINT env (full URL) as highest priority", () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://env-base.example.com";
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "https://env-traces.example.com/full";
      const config: SDKConfig = {
        ...baseConfig,
        exporterEndpoint: "https://config.example.com",
        tracesExporterEndpoint: "https://config-traces.example.com",
      };
      expect(resolveSignalEndpoint("traces", config)).toBe(
        "https://env-traces.example.com/full",
      );
    });

    it("uses OTEL_EXPORTER_OTLP_LOGS_ENDPOINT env for logs", () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "https://env-logs.example.com/full";
      expect(resolveSignalEndpoint("logs", baseConfig)).toBe(
        "https://env-logs.example.com/full",
      );
    });

    it("uses OTEL_EXPORTER_OTLP_METRICS_ENDPOINT env for metrics", () => {
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "https://env-metrics.example.com/full";
      expect(resolveSignalEndpoint("metrics", baseConfig)).toBe(
        "https://env-metrics.example.com/full",
      );
    });
  });

  describe("config.env (Cloudflare Workers)", () => {
    it("reads env from config.env when provided", () => {
      const config: SDKConfig = {
        ...baseConfig,
        env: {
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://cf-traces.example.com",
        },
      };
      expect(resolveSignalEndpoint("traces", config)).toBe("https://cf-traces.example.com");
    });

    it("config.env takes precedence over process.env", () => {
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "https://process-traces.example.com";
      const config: SDKConfig = {
        ...baseConfig,
        env: {
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://cf-traces.example.com",
        },
      };
      expect(resolveSignalEndpoint("traces", config)).toBe("https://cf-traces.example.com");
    });
  });

  describe("protocol normalization", () => {
    it("adds https:// to env var values without protocol", () => {
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "otel.example.com/v1/traces";
      expect(resolveSignalEndpoint("traces", baseConfig)).toBe(
        "https://otel.example.com/v1/traces",
      );
    });

    it("adds https:// to config values without protocol", () => {
      const config: SDKConfig = {
        ...baseConfig,
        exporterEndpoint: "otel.example.com",
      };
      expect(resolveSignalEndpoint("traces", config)).toBe(
        "https://otel.example.com/v1/traces",
      );
    });
  });

  describe("legacy metricsExporterEndpoint", () => {
    it("uses metricsExporterEndpoint for metrics signal", () => {
      const config: SDKConfig = {
        ...baseConfig,
        metricsExporterEndpoint: "https://metrics.example.com/v1/metrics",
      };
      expect(resolveSignalEndpoint("metrics", config)).toBe(
        "https://metrics.example.com/v1/metrics",
      );
    });
  });
});
