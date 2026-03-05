/**
 * Fetch-based OTLP exporters for non-Node runtimes.
 *
 * The official `@opentelemetry/exporter-*-otlp-http` packages use Node.js
 * `http`/`https` modules under the hood (the "node" platform variant).
 * Runtimes like Cloudflare Workers and browsers do **not** support these
 * modules, so the exports silently fail at runtime.
 *
 * These lightweight exporters use the **un-instrumented** `fetch` obtained
 * via {@link getOriginalFetch} to avoid infinite export loops when
 * `globalThis.fetch` has been monkey-patched by {@link instrumentFetch}.
 *
 * Used by both the Cloudflare Worker adapter and the browser adapter.
 */

import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import {
	JsonLogsSerializer,
	JsonMetricsSerializer,
	JsonTraceSerializer,
} from "@opentelemetry/otlp-transformer";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ResourceMetrics } from "@opentelemetry/sdk-metrics";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { getOriginalFetch } from "./instrument-fetch.js";

/* ------------------------------------------------------------------ */
/*  Shared fetch transport                                            */
/* ------------------------------------------------------------------ */

interface FetchSendOptions {
	url: string;
	headers?: Record<string, string>;
	body: Uint8Array | undefined;
	timeoutMs?: number;
}

async function fetchSend(opts: FetchSendOptions): Promise<ExportResult> {
	if (!opts.body) {
		return { code: ExportResultCode.FAILED, error: new Error("Serializer returned empty body") };
	}

	const controller = new AbortController();
	const timeout = opts.timeoutMs ?? 30_000;
	const timer = setTimeout(() => controller.abort(), timeout);

	try {
		const rawFetch = getOriginalFetch();
		const response = await rawFetch(opts.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...opts.headers,
			},
			body: opts.body as BodyInit,
			signal: controller.signal,
		});

		if (response.status >= 200 && response.status < 300) {
			return { code: ExportResultCode.SUCCESS };
		}

		return {
			code: ExportResultCode.FAILED,
			error: new Error(`OTLP export failed: HTTP ${response.status} ${response.statusText}`),
		};
	} catch (error) {
		return {
			code: ExportResultCode.FAILED,
			error: error instanceof Error ? error : new Error(String(error)),
		};
	} finally {
		clearTimeout(timer);
	}
}

/* ------------------------------------------------------------------ */
/*  Trace exporter                                                    */
/* ------------------------------------------------------------------ */

export interface FetchExporterConfig {
	url: string;
	headers?: Record<string, string>;
	timeoutMs?: number;
}

/**
 * OTLP/HTTP span exporter that uses `fetch` instead of Node `http` module.
 */
export class FetchTraceExporter {
	private _url: string;
	private _headers: Record<string, string>;
	private _timeoutMs: number;
	private _shutdown = false;

	constructor(config: FetchExporterConfig) {
		this._url = config.url;
		this._headers = config.headers ?? {};
		this._timeoutMs = config.timeoutMs ?? 30_000;
	}

	export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
		if (this._shutdown) {
			resultCallback({ code: ExportResultCode.FAILED, error: new Error("Exporter is shut down") });
			return;
		}

		const body = JsonTraceSerializer.serializeRequest(spans);
		fetchSend({
			url: this._url,
			headers: this._headers,
			body,
			timeoutMs: this._timeoutMs,
		}).then(resultCallback, (error) => resultCallback({ code: ExportResultCode.FAILED, error }));
	}

	async shutdown(): Promise<void> {
		this._shutdown = true;
	}

	async forceFlush(): Promise<void> {
		// Nothing buffered — SimpleSpanProcessor exports synchronously.
	}
}

/* ------------------------------------------------------------------ */
/*  Log exporter (with monotonic timestamp bumping)                   */
/* ------------------------------------------------------------------ */

/**
 * OTLP/HTTP log exporter that uses `fetch`.
 *
 * Because OTLP log timestamps have only millisecond precision, log records
 * emitted within the same millisecond can arrive at the collector in
 * arbitrary order.  To preserve ordering, each record in a batch whose
 * `hrTime` collides with the previous entry is bumped by 1 ms.
 */
export class FetchLogExporter {
	private _url: string;
	private _headers: Record<string, string>;
	private _timeoutMs: number;
	private _shutdown = false;

	constructor(config: FetchExporterConfig) {
		this._url = config.url;
		this._headers = config.headers ?? {};
		this._timeoutMs = config.timeoutMs ?? 30_000;
	}

	export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
		if (this._shutdown) {
			resultCallback({ code: ExportResultCode.FAILED, error: new Error("Exporter is shut down") });
			return;
		}

		deduplicateTimestamps(logs);

		const body = JsonLogsSerializer.serializeRequest(logs);
		fetchSend({
			url: this._url,
			headers: this._headers,
			body,
			timeoutMs: this._timeoutMs,
		}).then(resultCallback, (error) => resultCallback({ code: ExportResultCode.FAILED, error }));
	}

	async shutdown(): Promise<void> {
		this._shutdown = true;
	}
}

/**
 * Bump `hrTime` on log records that share the same millisecond timestamp.
 *
 * `hrTime` is `[seconds, nanoseconds]`.  Two records collide when both
 * components are equal.  When a collision is detected, the later entry
 * gets +1 ms (1_000_000 ns), accumulating for consecutive collisions.
 *
 * Mutates the array items in-place.
 */
function deduplicateTimestamps(logs: ReadableLogRecord[]): void {
	for (let i = 1; i < logs.length; i++) {
		const prev = logs[i - 1].hrTime;
		const curr = logs[i].hrTime;

		if (curr[0] <= prev[0] && curr[1] <= prev[1]) {
			// Bump by 1ms (1_000_000 ns) past the previous entry
			let ns = prev[1] + 1_000_000;
			let s = prev[0];
			if (ns >= 1_000_000_000) {
				s += 1;
				ns -= 1_000_000_000;
			}
			// hrTime is readonly in the type, but we need to mutate for ordering
			(logs[i] as { hrTime: [number, number] }).hrTime = [s, ns];
		}
	}
}

/* ------------------------------------------------------------------ */
/*  Metric exporter                                                   */
/* ------------------------------------------------------------------ */

/**
 * OTLP/HTTP metric exporter that uses `fetch`.
 */
export class FetchMetricExporter {
	private _url: string;
	private _headers: Record<string, string>;
	private _timeoutMs: number;
	private _shutdown = false;

	constructor(config: FetchExporterConfig) {
		this._url = config.url;
		this._headers = config.headers ?? {};
		this._timeoutMs = config.timeoutMs ?? 30_000;
	}

	export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
		if (this._shutdown) {
			resultCallback({ code: ExportResultCode.FAILED, error: new Error("Exporter is shut down") });
			return;
		}

		const body = JsonMetricsSerializer.serializeRequest(metrics);
		fetchSend({
			url: this._url,
			headers: this._headers,
			body,
			timeoutMs: this._timeoutMs,
		}).then(resultCallback, (error) => resultCallback({ code: ExportResultCode.FAILED, error }));
	}

	async forceFlush(): Promise<void> {
		// Nothing buffered.
	}

	async shutdown(): Promise<void> {
		this._shutdown = true;
	}
}
