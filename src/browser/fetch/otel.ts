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
	type Context,
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
 * Extract method and URL from fetch arguments without constructing a
 * Request object (avoids header guard / body consumption issues).
 */
function parseFetchArgs(input: string | URL | Request, init?: RequestInit) {
	if (input instanceof Request) {
		return { method: init?.method ?? input.method, url: input.url };
	}
	return { method: init?.method ?? "GET", url: String(input) };
}

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
	init: RequestInit | undefined,
	parentCtx?: Context,
): Promise<Response> {
	const { method, url } = parseFetchArgs(input, init);
	const tracer = trace.getTracer("fetch");
	const activeCtx = parentCtx ?? context.active();

	return tracer.startActiveSpan(
		`${method} ${url}`,
		{ kind: SpanKind.CLIENT },
		activeCtx,
		async (span) => {
			try {
				const headers = new Headers(
					init?.headers || (input instanceof Request ? input.headers : {}),
				);
				const ctx = trace.setSpan(context.active(), span);
				propagation.inject(ctx, headers, headerSetter);

				const mergedInit: RequestInit = { ...init, headers };

				const response = await realFetch(input instanceof Request ? input.url : input, mergedInit);

				span.setAttribute("http.status_code", response.status);
				if (response.status >= 500) {
					span.setStatus({ code: SpanStatusCode.ERROR });
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
		},
	);
}
