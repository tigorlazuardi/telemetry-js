// Patch perf_hooks for Cloudflare Workers.
//
// CF Workers polyfill `perf_hooks` with empty objects ({}) but
// `@opentelemetry/core` imports `performance` from `perf_hooks` and reads
// `timeOrigin` / `now()`.  Without this patch, `sdk-logs` crashes with
// "Cannot convert object to primitive value" (opentelemetry-js#5500).
//
// We import the same module so we get the same object reference that
// `@opentelemetry/core` holds in `otperformance`.  Mutating it here
// makes the fix visible everywhere.  In Node.js `timeOrigin` is already
// a number, so the guard makes this a no-op.
import { performance as _perfHooksPerf } from "perf_hooks";

const _perf = _perfHooksPerf as unknown as Record<string, unknown>;
if (_perf && typeof _perf.timeOrigin !== "number") {
  const _gp = globalThis.performance;
  if (_gp) {
    _perf.timeOrigin = _gp.timeOrigin;
    if (typeof _perf.now !== "function") {
      _perf.now = _gp.now.bind(_gp);
    }
  }
}

import {
  metrics,
  propagation,
  trace,
  type TracerProvider,
} from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { detectCloudflareWorker } from "../../detect.js";
import { resolveSignalEndpoint } from "../../endpoints.js";
import { createLogger } from "../../logger.js";
import { noopSDKResult } from "../../noop.js";
import { buildResource } from "../../resource.js";
import type { RuntimeAdapter, SDKConfig, SDKResult } from "../../types.js";

export const cloudflareWorkerAdapter: RuntimeAdapter = {
  name: "cloudflare-worker",
  detect: detectCloudflareWorker,
  setup(config: SDKConfig): SDKResult {
    try {
      const { resource, warnings } = buildResource(config, []);
      const resolvedServiceName =
        (resource.attributes[ATTR_SERVICE_NAME] as string) ?? "unknown";

      const tracesEndpoint = resolveSignalEndpoint("traces", config);
      const metricsEndpoint = resolveSignalEndpoint("metrics", config);
      const logsEndpoint = resolveSignalEndpoint("logs", config);

      // Trace provider (only if endpoint resolves)
      let provider: BasicTracerProvider | undefined;
      if (tracesEndpoint) {
        const traceExporter = new OTLPTraceExporter({
          url: tracesEndpoint,
          headers: config.exporterHeaders,
        });

        provider = new BasicTracerProvider({
          resource,
          spanProcessors: [new SimpleSpanProcessor(traceExporter)],
        });

        trace.setGlobalTracerProvider(provider as unknown as TracerProvider);
      }

      // Propagators are always set for context propagation
      propagation.setGlobalPropagator(
        new CompositePropagator({
          propagators: [
            new W3CTraceContextPropagator(),
            new W3CBaggagePropagator(),
          ],
        }),
      );

      // Meter provider (only if endpoint resolves)
      let meterProvider: MeterProvider | undefined;
      if (metricsEndpoint) {
        const metricExporter = new OTLPMetricExporter({
          url: metricsEndpoint,
          headers: config.exporterHeaders,
        });

        const metricReader = new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: 2_147_483_647, // Disable periodic; rely on manual flush via ctx.waitUntil
        });

        meterProvider = new MeterProvider({
          resource,
          readers: [metricReader],
        });

        metrics.setGlobalMeterProvider(meterProvider);
      }

      // Logger provider (only if endpoint resolves)
      let loggerProvider: LoggerProvider | undefined;
      if (logsEndpoint) {
        const logExporter = new OTLPLogExporter({
          url: logsEndpoint,
          headers: config.exporterHeaders,
        });

        loggerProvider = new LoggerProvider({
          resource,
          processors: [new SimpleLogRecordProcessor(logExporter)],
        });

        logs.setGlobalLoggerProvider(loggerProvider);
      }

      const logger = createLogger(resolvedServiceName);
      for (const w of warnings) logger.warn(w);

      return {
        provider: provider
          ? (provider as unknown as TracerProvider)
          : trace.getTracerProvider(),
        meterProvider,
        loggerProvider,
        logger,
        async shutdown() {
          try {
            await provider?.shutdown();
            await meterProvider?.shutdown();
            await loggerProvider?.shutdown();
          } catch {
            // Never throw
          }
        },
        async forceFlush() {
          try {
            await provider?.forceFlush();
            await meterProvider?.forceFlush();
            await loggerProvider?.forceFlush();
          } catch (err) {
            logger.warn("forceFlush failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
      };
    } catch {
      return noopSDKResult();
    }
  },
};
