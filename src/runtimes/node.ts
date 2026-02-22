import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  envDetector,
  hostDetector,
  osDetector,
  processDetector,
} from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { detectNode } from "../detect.js";
import { resolveSignalEndpoint } from "../endpoints.js";
import { createLogger } from "../logger.js";
import { noopSDKResult } from "../noop.js";
import { buildResource } from "../resource.js";
import type { RuntimeAdapter, SDKConfig, SDKResult } from "../types.js";

export const nodeAdapter: RuntimeAdapter = {
  name: "node",
  detect: detectNode,
  setup(config: SDKConfig): SDKResult {
    try {
      const { resource, warnings } = buildResource(config, [
        envDetector,
        hostDetector,
        processDetector,
        osDetector,
      ]);
      const resolvedServiceName =
        (resource.attributes[ATTR_SERVICE_NAME] as string) ?? "unknown";

      const tracesEndpoint = resolveSignalEndpoint("traces", config);
      const metricsEndpoint = resolveSignalEndpoint("metrics", config);
      const logsEndpoint = resolveSignalEndpoint("logs", config);

      const traceExporter = tracesEndpoint
        ? new OTLPTraceExporter({ url: tracesEndpoint, headers: config.exporterHeaders })
        : undefined;

      const metricReaders = metricsEndpoint
        ? [
            new PeriodicExportingMetricReader({
              exporter: new OTLPMetricExporter({
                url: metricsEndpoint,
                headers: config.exporterHeaders,
              }),
              exportIntervalMillis: config.metricsExportIntervalMs ?? 60_000,
            }),
          ]
        : [];

      const logRecordProcessors = logsEndpoint
        ? [
            new BatchLogRecordProcessor(
              new OTLPLogExporter({
                url: logsEndpoint,
                headers: config.exporterHeaders,
              }),
            ),
          ]
        : [];

      const sdk = new NodeSDK({
        resource,
        autoDetectResources: false,
        traceExporter,
        metricReader: metricReaders.length ? metricReaders[0] : undefined,
        logRecordProcessors,
        instrumentations: (config.instrumentations ?? []) as never[],
      });

      sdk.start();

      const logger = createLogger(resolvedServiceName);
      for (const w of warnings) logger.warn(w);

      return {
        provider: trace.getTracerProvider(),
        meterProvider: metricsEndpoint ? metrics.getMeterProvider() : undefined,
        loggerProvider: logsEndpoint ? logs.getLoggerProvider() : undefined,
        logger,
        async shutdown() {
          try {
            await sdk.shutdown();
          } catch {
            // Never throw
          }
        },
        async forceFlush() {
          try {
            // NodeSDK doesn't expose forceFlush — flush via global providers
            const tp = trace.getTracerProvider() as { forceFlush?: () => Promise<void> };
            const mp = metrics.getMeterProvider() as { forceFlush?: () => Promise<void> };
            const lp = logs.getLoggerProvider() as { forceFlush?: () => Promise<void> };
            await Promise.all([
              tp.forceFlush?.(),
              mp.forceFlush?.(),
              lp.forceFlush?.(),
            ]);
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
