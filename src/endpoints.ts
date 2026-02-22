import type { OtlpSignal, SDKConfig } from "./types.js";

/**
 * Normalise a URL string:
 * - empty/undefined → `undefined`
 * - already has `http://` or `https://` → keep as-is
 * - no protocol → prepend `https://`
 *
 * Trailing slashes are stripped.
 */
export function normalizeEndpoint(url: string | undefined): string | undefined {
  if (!url || url.trim() === "") return undefined;
  let normalized = url.trim();
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }
  return normalized.replace(/\/+$/, "");
}

/**
 * Read an environment variable from `config.env` (Cloudflare Workers)
 * or `process.env` (Node.js).
 */
function readEnv(key: string, config: SDKConfig): string | undefined {
  if (config.env) {
    return config.env[key];
  }
  if (typeof process !== "undefined" && process.env) {
    return process.env[key];
  }
  return undefined;
}

const SIGNAL_SUFFIX: Record<OtlpSignal, string> = {
  traces: "/v1/traces",
  metrics: "/v1/metrics",
  logs: "/v1/logs",
};

/**
 * Resolve the full OTLP endpoint URL for a given signal.
 *
 * Priority (highest first):
 * 1. `OTEL_EXPORTER_OTLP_{SIGNAL}_ENDPOINT` env var (full URL)
 * 2. `OTEL_EXPORTER_OTLP_ENDPOINT` env var + `/v1/{signal}` suffix
 * 3. `config.{signal}ExporterEndpoint` (full URL)
 * 4. `config.exporterEndpoint` + `/v1/{signal}` suffix
 * 5. `undefined` → signal is disabled
 */
export function resolveSignalEndpoint(
  signal: OtlpSignal,
  config: SDKConfig,
): string | undefined {
  const signalUpper = signal.toUpperCase();
  const suffix = SIGNAL_SUFFIX[signal];

  // 1. Per-signal env var (full URL)
  const perSignalEnv = readEnv(`OTEL_EXPORTER_OTLP_${signalUpper}_ENDPOINT`, config);
  if (perSignalEnv) {
    return normalizeEndpoint(perSignalEnv);
  }

  // 2. Base env var + suffix
  const baseEnv = readEnv("OTEL_EXPORTER_OTLP_ENDPOINT", config);
  if (baseEnv) {
    const base = normalizeEndpoint(baseEnv);
    return base ? `${base}${suffix}` : undefined;
  }

  // 3. Per-signal config (full URL)
  const configKey = `${signal}ExporterEndpoint` as keyof SDKConfig;
  const perSignalConfig = config[configKey] as string | undefined;
  if (perSignalConfig) {
    return normalizeEndpoint(perSignalConfig);
  }

  // 4. Base config + suffix
  // For metrics, also check the legacy metricsExporterEndpoint
  if (signal === "metrics" && config.metricsExporterEndpoint) {
    return normalizeEndpoint(config.metricsExporterEndpoint);
  }

  if (config.exporterEndpoint) {
    const base = normalizeEndpoint(config.exporterEndpoint);
    return base ? `${base}${suffix}` : undefined;
  }

  // 5. Not configured
  return undefined;
}
