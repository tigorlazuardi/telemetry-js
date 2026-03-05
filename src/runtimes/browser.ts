/**
 * Browser runtime adapter.
 *
 * Uses the shared fetch-based OTLP exporters ({@link FetchTraceExporter},
 * {@link FetchLogExporter}, {@link FetchMetricExporter}) which are far
 * lighter than the Node.js `@opentelemetry/exporter-*-otlp-http` packages
 * that pull in `http`/`https`/`zlib`.
 *
 * Context propagation uses {@link AsyncLocalStorage}-free span tracking
 * via the OTel `ZoneContextManager` pattern — but since Zone.js is heavy,
 * we use the simpler `StackContextManager` approach (just the global API
 * default) which works for non-concurrent browser code.
 */

import { metrics, propagation, type TracerProvider, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
	CompositePropagator,
	W3CBaggagePropagator,
	W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { detectBrowser } from "../detect.js";
import { resolveSignalEndpoint } from "../endpoints.js";
import { FetchLogExporter, FetchMetricExporter, FetchTraceExporter } from "../exporters.js";
import { createLogger, setDefaultLogger } from "../logger.js";
import { noopSDKResult } from "../noop.js";
import { buildResource } from "../resource.js";
import type { RuntimeAdapter, SDKConfig, SDKResult } from "../types.js";

export const browserAdapter: RuntimeAdapter = {
	name: "browser",
	detect: detectBrowser,
	setup(config: SDKConfig): SDKResult {
		try {
			const { resource, warnings } = buildResource(config, []);
			const resolvedServiceName = (resource.attributes[ATTR_SERVICE_NAME] as string) ?? "unknown";

			const tracesEndpoint = resolveSignalEndpoint("traces", config);
			const metricsEndpoint = resolveSignalEndpoint("metrics", config);
			const logsEndpoint = resolveSignalEndpoint("logs", config);

			// Trace provider
			let provider: BasicTracerProvider | undefined;
			if (tracesEndpoint) {
				const traceExporter = new FetchTraceExporter({
					url: tracesEndpoint,
					headers: config.exporterHeaders,
				});

				provider = new BasicTracerProvider({
					resource,
					spanProcessors: [new SimpleSpanProcessor(traceExporter)],
				});

				trace.setGlobalTracerProvider(provider as unknown as TracerProvider);
			}

			// Propagators
			propagation.setGlobalPropagator(
				new CompositePropagator({
					propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
				}),
			);

			// Meter provider
			let meterProvider: MeterProvider | undefined;
			if (metricsEndpoint) {
				const metricExporter = new FetchMetricExporter({
					url: metricsEndpoint,
					headers: config.exporterHeaders,
				});

				const metricReader = new PeriodicExportingMetricReader({
					exporter: metricExporter,
					exportIntervalMillis: config.metricsExportIntervalMs ?? 60_000,
				});

				meterProvider = new MeterProvider({
					resource,
					readers: [metricReader],
				});

				metrics.setGlobalMeterProvider(meterProvider);
			}

			// Logger provider
			let loggerProvider: LoggerProvider | undefined;
			if (logsEndpoint) {
				const logExporter = new FetchLogExporter({
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
			setDefaultLogger(logger);
			for (const w of warnings) logger.warn(w);

			return {
				resource,
				provider: provider ? (provider as unknown as TracerProvider) : trace.getTracerProvider(),
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
