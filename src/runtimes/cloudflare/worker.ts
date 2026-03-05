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
import { performance as _perfHooksPerf } from "node:perf_hooks";

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

import { AsyncLocalStorage } from "node:async_hooks";
import {
	type Context,
	type ContextManager,
	context,
	metrics,
	propagation,
	ROOT_CONTEXT,
	type TracerProvider,
	trace,
} from "@opentelemetry/api";
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
import { detectCloudflareWorker } from "../../detect.js";
import { resolveSignalEndpoint } from "../../endpoints.js";
import { FetchLogExporter, FetchMetricExporter, FetchTraceExporter } from "../../exporters.js";
import { createLogger, setDefaultLogger } from "../../logger.js";
import { noopSDKResult } from "../../noop.js";
import { buildResource } from "../../resource.js";
import type { RuntimeAdapter, SDKConfig, SDKResult } from "../../types.js";

/**
 * Lightweight {@link ContextManager} backed by {@link AsyncLocalStorage}.
 *
 * Cloudflare Workers support `AsyncLocalStorage` from `node:async_hooks` but
 * `@opentelemetry/context-async-hooks` imports the `events` module which is
 * **not** available in Workers.  This minimal implementation provides only
 * the three methods the OTel API needs (`active`, `with`, `bind`) without
 * pulling in Node-specific EventEmitter patching.
 */
class CloudflareContextManager implements ContextManager {
	private _storage = new AsyncLocalStorage<Context>();

	active(): Context {
		return this._storage.getStore() ?? ROOT_CONTEXT;
	}

	with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
		ctx: Context,
		fn: F,
		thisArg?: ThisParameterType<F>,
		...args: A
	): ReturnType<F> {
		const cb = thisArg == null ? fn : fn.bind(thisArg);
		return this._storage.run(ctx, cb as (...a: any[]) => ReturnType<F>, ...(args as any[]));
	}

	bind<T>(ctx: Context, target: T): T {
		if (typeof target === "function") {
			const manager = this;
			const fn = target as unknown as (...a: unknown[]) => unknown;
			const bound = function (this: unknown, ...args: unknown[]) {
				return manager.with(ctx, () => fn.apply(this, args));
			};
			Object.defineProperty(bound, "length", {
				value: fn.length,
				configurable: true,
			});
			return bound as unknown as T;
		}
		return target;
	}

	enable(): this {
		return this;
	}

	disable(): this {
		return this;
	}
}

export const cloudflareWorkerAdapter: RuntimeAdapter = {
	name: "cloudflare-worker",
	detect: detectCloudflareWorker,
	setup(config: SDKConfig): SDKResult {
		try {
			const { resource, warnings } = buildResource(config, []);
			const resolvedServiceName = (resource.attributes[ATTR_SERVICE_NAME] as string) ?? "unknown";

			// Register context manager so that context.active() / context.with()
			// propagate the active span across async boundaries.  Without this,
			// the OTel API falls back to NoopContextManager and trace correlation
			// (trace_id / span_id on logs) silently breaks.
			context.setGlobalContextManager(new CloudflareContextManager());

			const tracesEndpoint = resolveSignalEndpoint("traces", config);
			const metricsEndpoint = resolveSignalEndpoint("metrics", config);
			const logsEndpoint = resolveSignalEndpoint("logs", config);

			// Trace provider (only if endpoint resolves)
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

			// Propagators are always set for context propagation
			propagation.setGlobalPropagator(
				new CompositePropagator({
					propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
				}),
			);

			// Meter provider (only if endpoint resolves)
			let meterProvider: MeterProvider | undefined;
			if (metricsEndpoint) {
				const metricExporter = new FetchMetricExporter({
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
