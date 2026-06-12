import type { ActionOptions, ActionScope, ScopedAction } from "../shared/action.js";
import type { InjectContextOptions } from "../shared/context.js";
import type { TracedCallContext, TracedInput } from "../shared/traced.js";
import type { Carrier, Logger, SDKResult } from "../shared/types.js";
import type { WithTraceOptions } from "../shared/with-trace.js";

// Minimal span-like interface — mirrors subset of OTel's Span without importing it.
interface NoopSpanLike {
	setAttribute(key: string, value: unknown): NoopSpanLike;
	setAttributes(attrs: Record<string, unknown>): NoopSpanLike;
	setStatus(status: { code: number; message?: string }): NoopSpanLike;
	recordException(exception: unknown, attrs?: unknown): void;
	addEvent(name: string, attrs?: unknown): NoopSpanLike;
	end(endTime?: unknown): void;
	isRecording(): boolean;
	spanContext(): { traceId: string; spanId: string; traceFlags: number };
	updateName(name: string): NoopSpanLike;
	addLink(link: unknown): NoopSpanLike;
	addLinks(links: unknown[]): NoopSpanLike;
}

const NOOP_SPAN: NoopSpanLike = {
	setAttribute() {
		return NOOP_SPAN;
	},
	setAttributes() {
		return NOOP_SPAN;
	},
	setStatus() {
		return NOOP_SPAN;
	},
	recordException() {},
	addEvent() {
		return NOOP_SPAN;
	},
	end() {},
	isRecording() {
		return false;
	},
	updateName() {
		return NOOP_SPAN;
	},
	addLink() {
		return NOOP_SPAN;
	},
	addLinks() {
		return NOOP_SPAN;
	},
	spanContext() {
		return {
			traceId: "00000000000000000000000000000000",
			spanId: "0000000000000000",
			traceFlags: 0,
		};
	},
};

export const passthroughLogger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

export function passthroughWithTrace<T>(
	fn: (span: NoopSpanLike) => T,
	_opts?: WithTraceOptions,
): T {
	return fn(NOOP_SPAN);
}

export function passthroughWithAction<T>(
	_action: string,
	fn: (span: NoopSpanLike) => T,
	_opts?: ActionOptions,
): T {
	return fn(NOOP_SPAN);
}

export function passthroughScopeAction(_scope: ActionScope): ScopedAction {
	return (_action: string, fn: (span: NoopSpanLike) => any, _opts?: any) => fn(NOOP_SPAN);
}

export function passthroughTraced(_optsOrFactory?: TracedInput) {
	return <This, Args extends unknown[], Value>(
		originalMethod: (this: This, ...args: Args) => Value,
		_context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Value>,
	) => originalMethod;
}

export function passthroughInjectContext<T>(value: T, _opts?: InjectContextOptions): Carrier<T> {
	return value as Carrier<T>;
}

export function makePassthroughSDKResult(): SDKResult {
	return {
		resource: null as any,
		provider: {
			getTracer() {
				return {
					startSpan() {
						return NOOP_SPAN as any;
					},
					startActiveSpan(...args: any[]) {
						const fn = args[args.length - 1];
						if (typeof fn === "function") return fn(NOOP_SPAN as any);
					},
				} as any;
			},
			getDelegateTracer() {
				return undefined;
			},
			getDelegate() {
				return this;
			},
		} as any,
		logger: passthroughLogger,
		async shutdown() {},
		async forceFlush() {},
	};
}
