import { type Span, SpanStatusCode } from "@opentelemetry/api";

// Satu sumber untuk redaksi galat di span. Dipakai `withQueryName` (db) dan `withTrace`.
// Dipasang lewat `configureDb({ redactParams })` dari subpath /db.

let redactParams = false;

export function setRedactParams(on: boolean): void {
	redactParams = on;
}

const PARAMS_MARKER = "\nparams:";

function redactMessage(message: string): string {
	const i = message.indexOf(PARAMS_MARKER);
	return i === -1 ? message : message.slice(0, i);
}

/** What goes on the span for a failed query, honouring {@link DbOptions.redactParams}. */
function failure(error: unknown): { message: string; exception: Error } {
	if (!(error instanceof Error)) return { message: String(error), exception: error as Error };
	if (!redactParams) return { message: error.message, exception: error };
	const message = redactMessage(error.message);
	if (message === error.message) return { message, exception: error };
	const safe = new Error(message);
	safe.name = error.name;
	if (error.stack) safe.stack = error.stack.split(error.message).join(message);
	return { message, exception: safe };
}

export function markFailed(span: Span, error: unknown): void {
	const { message, exception } = failure(error);
	span.setStatus({ code: SpanStatusCode.ERROR, message });
	span.recordException(exception);
}
