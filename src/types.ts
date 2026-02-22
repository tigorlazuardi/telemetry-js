import type { MeterProvider, SpanContext, TracerProvider } from "@opentelemetry/api";
import type { LoggerProvider } from "@opentelemetry/api-logs";

/**
 * Supported runtime identifiers.
 *
 * Built-in values are `"node"` and `"cloudflare-worker"`.
 * Any other string is accepted for custom adapters.
 */
export type RuntimeName = "node" | "cloudflare-worker" | (string & {});

/**
 * Configuration passed to {@link initSDK} to initialise tracing, metrics, and logging.
 */
export interface SDKConfig {
  /** The logical name of the service reported in every span. */
  serviceName?: string;

  /**
   * Explicit runtime to use. When omitted the SDK auto-detects
   * by calling each registered adapter's `detect()` method.
   */
  runtime?: RuntimeName;

  /**
   * Base OTLP HTTP endpoint (e.g. `"https://otel.example.com"`).
   *
   * The SDK appends per-signal paths (`/v1/traces`, `/v1/metrics`, `/v1/logs`)
   * automatically. Use signal-specific endpoints to override individual signals.
   */
  exporterEndpoint?: string;

  /** Additional headers sent with every OTLP export request (e.g. auth tokens). */
  exporterHeaders?: Record<string, string>;

  /** Extra key/value pairs merged into the OpenTelemetry `Resource`. */
  resourceAttributes?: Record<string, string>;

  /** OTLP HTTP endpoint for the metrics exporter. Falls back to `exporterEndpoint + /v1/metrics` when omitted. */
  metricsExporterEndpoint?: string;

  /** Metrics collection interval in milliseconds (default `60000`). */
  metricsExportIntervalMs?: number;

  /** Signal-specific OTLP endpoint for traces (full URL, no suffix appended). */
  tracesExporterEndpoint?: string;

  /** Signal-specific OTLP endpoint for logs (full URL, no suffix appended). */
  logsExporterEndpoint?: string;

  /** OpenTelemetry instrumentations to register (Node only). */
  instrumentations?: unknown[];

  /**
   * Environment variable map. Used in runtimes where `process.env` is unavailable
   * (e.g. Cloudflare Workers). Falls back to `process.env` when omitted.
   */
  env?: Record<string, string | undefined>;
}

/**
 * A runtime-specific adapter that the SDK uses to wire up
 * providers, processors, and exporters for a given environment.
 */
export interface RuntimeAdapter {
  /** Unique identifier for this runtime (e.g. `"node"`). */
  name: RuntimeName;

  /**
   * Return `true` if the current process is running in this runtime.
   * Called during auto-detection when no explicit `runtime` is provided.
   */
  detect(): boolean;

  /**
   * Create providers, processors, and exporters for this runtime.
   *
   * @param config - SDK configuration supplied by the caller.
   * @returns An {@link SDKResult} containing the initialised providers plus lifecycle helpers.
   */
  setup(config: SDKConfig): SDKResult;
}

/** Key/value pairs attached to log records. */
export type LogAttributes = Record<string, string | number | boolean | undefined>;

/** Options for individual log calls. */
export interface LogOptions {
  /** Explicit span context for log-trace correlation. */
  spanContext?: SpanContext;
  /** Explicit timestamp (epoch ms). Defaults to `Date.now()`. */
  timestamp?: number;
}

/** Log severity levels. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured logger with dual output (stderr + OTLP). */
export interface Logger {
  debug(message: string, attrs?: LogAttributes, opts?: LogOptions): void;
  info(message: string, attrs?: LogAttributes, opts?: LogOptions): void;
  warn(message: string, attrs?: LogAttributes, opts?: LogOptions): void;
  error(message: string, attrs?: LogAttributes, opts?: LogOptions): void;
}

/** OTLP signal identifiers for endpoint resolution. */
export type OtlpSignal = "traces" | "metrics" | "logs";

/**
 * The object returned by {@link initSDK} after the SDK has been initialised.
 */
export interface SDKResult {
  /** The active `TracerProvider`. */
  provider: TracerProvider;

  /** The active `MeterProvider` (present only when a metrics endpoint resolves). */
  meterProvider?: MeterProvider;

  /** The active `LoggerProvider` (present only when a logs endpoint resolves). */
  loggerProvider?: LoggerProvider;

  /** Structured logger. Always present (noop if no logs endpoint). */
  logger: Logger;

  /** Gracefully shut down all providers and flush pending data. */
  shutdown(): Promise<void>;

  /** Force-flush all pending spans, metrics, and logs without shutting down. */
  forceFlush(): Promise<void>;
}
