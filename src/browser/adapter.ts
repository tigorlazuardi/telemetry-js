/**
 * Browser runtime adapter.
 *
 * Uses the shared fetch-based OTLP exporters ({@link FetchTraceExporter},
 * {@link FetchLogExporter}, {@link FetchMetricExporter}) which are far
 * lighter than the Node.js `@opentelemetry/exporter-*-otlp-http` packages
 * that pull in `http`/`https`/`zlib`.
 *
 * Context propagation uses the OTel API's default context manager (no
 * Zone.js dependency). This works for browser code because the JS main
 * thread is single-threaded — `tracer.startActiveSpan()` correctly
 * propagates context through `await` chains as long as there is no
 * concurrent interleaving of unrelated traces.
 *
 * `globalThis.fetch` is automatically monkey-patched via
 * {@link instrumentFetch} so outgoing fetch calls are traced and W3C
 * trace context headers (`traceparent`/`tracestate`) are injected.
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
import { resolveSignalEndpoint } from "../shared/endpoints.js";
import { FetchLogExporter, FetchMetricExporter, FetchTraceExporter } from "../shared/exporters.js";
import { createLogger, setDefaultLogger } from "../shared/logger.js";
import { noopSDKResult } from "../shared/noop.js";
import { buildResource } from "../shared/resource.js";
import type { RuntimeAdapter, SDKConfig, SDKResult } from "../shared/types.js";
import { getOriginalFetch, instrumentFetch, isFetchPatched } from "./fetch/patch.js";

export const browserAdapter: RuntimeAdapter = {
	name: "browser",
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
					fetchFn: getOriginalFetch,
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

			// Monkey-patch globalThis.fetch so outgoing requests are traced
			// and W3C trace context headers are injected automatically.
			// Skip if the consumer already called instrumentFetch() eagerly.
			if (!isFetchPatched()) {
				instrumentFetch();
			}

			// Meter provider
			let meterProvider: MeterProvider | undefined;
			if (metricsEndpoint) {
				const metricExporter = new FetchMetricExporter({
					url: metricsEndpoint,
					headers: config.exporterHeaders,
					fetchFn: getOriginalFetch,
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
					fetchFn: getOriginalFetch,
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
