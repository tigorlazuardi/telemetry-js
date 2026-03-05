/**
 * OTel tracing logic for browser fetch instrumentation.
 *
 * This module is **lazily loaded** by `instrument-fetch-browser.ts` on the
 * first `fetch()` call.  It is never imported at the top level, keeping the
 * initial `instrumentFetch()` call zero-cost.
 *
 * @internal — not part of the public API surface.
 */

import {
	context,
	propagation,
	SpanKind,
	SpanStatusCode,
	type TextMapSetter,
	trace,
} from "@opentelemetry/api";

const headerSetter: TextMapSetter<Headers> = {
	set(carrier, key, value) {
		carrier.set(key, value);
	},
};

/**
 * Execute a fetch call wrapped in an OTel CLIENT span with W3C trace
 * context propagation.
 *
 * Called by the patched `globalThis.fetch` once this module has been
 * dynamically loaded.
 */
export function tracedFetch(
	realFetch: typeof fetch,
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Response> {
	const request = new Request(input, init);
	const method = request.method;
	const url = request.url;
	const tracer = trace.getTracer("fetch");

	return tracer.startActiveSpan(`${method} ${url}`, { kind: SpanKind.CLIENT }, async (span) => {
		try {
			// Inject trace context into outgoing headers
			propagation.inject(context.active(), request.headers, headerSetter);

			const response = await realFetch(request);

			span.setAttribute("http.status_code", response.status);
			if (response.status >= 500) {
				span.setStatus({ code: SpanStatusCode.ERROR });
			}

			// Record response traceparent if present
			const responseTraceparent = response.headers.get("traceparent");
			if (responseTraceparent) {
				span.setAttribute("http.response.traceparent", responseTraceparent);
			}

			return response;
		} catch (error) {
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: error instanceof Error ? error.message : String(error),
			});
			span.recordException(error as Error);
			throw error;
		} finally {
			span.end();
		}
	});
}
