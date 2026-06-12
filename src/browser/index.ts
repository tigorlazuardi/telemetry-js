/**
 * Browser entry point — lazy facade.
 *
 * Pure-JS eager facade. Zero OTel static import in the compiled output.
 * The heavy SDK (adapter, exporters, all OTel packages) loads lazily via
 * `initSDK()` → `await import("./internal/real.js")`.
 *
 * ```ts
 * import { initSDK } from "@tigorhutasuhut/telemetry-js/browser";
 * await initSDK({ exporterEndpoint: "https://otel.example.com", dev: import.meta.env.DEV });
 * ```
 */

// Type-only imports — all erase at build, zero @opentelemetry in compiled dist
import type { Span } from "@opentelemetry/api";
import type { Resource } from "@opentelemetry/resources";
import type { scopeAction as _SA, withAction as _WA } from "../shared/action.js";
import type { injectContext as _IC } from "../shared/context.js";
import type { traced as _TR } from "../shared/traced.js";
import type { SDKConfig, SDKResult } from "../shared/types.js";
import type { withTrace as _WT } from "../shared/with-trace.js";
// Pure-JS passthrough — no OTel imports, always loaded
import {
	makePassthroughSDKResult,
	passthroughInjectContext,
	passthroughLogger,
	passthroughScopeAction,
	passthroughTraced,
	passthroughWithAction,
	passthroughWithTrace,
} from "./passthrough.js";

// Safe static value exports — endpoints.ts has no OTel imports
export { normalizeEndpoint, resolveSignalEndpoint } from "../shared/endpoints.js";

// noopLogger — pure-JS silent noop (replaces shared/noop re-export)
export { passthroughLogger as noopLogger } from "./passthrough.js";

/* ── Mutable impl ref ─────────────────────────────────────────────────── */

type Impl = {
	withTrace: typeof _WT;
	withAction: typeof _WA;
	scopeAction: typeof _SA;
	traced: typeof _TR;
	injectContext: typeof _IC;
};

let _impl: Impl = {
	withTrace: passthroughWithTrace as any,
	withAction: passthroughWithAction as any,
	scopeAction: passthroughScopeAction as any,
	traced: passthroughTraced as any,
	injectContext: passthroughInjectContext as any,
};

/* ── State ────────────────────────────────────────────────────────────── */

let _globalResource: Resource | null = null;
let _initPromise: Promise<SDKResult> | null = null;

/* ── Core API ─────────────────────────────────────────────────────────── */

/**
 * Initialise the OpenTelemetry SDK for browser environments.
 *
 * Async and idempotent — concurrent calls share one `import()`.
 * On failure the facade stays passthrough and returns a pure-JS {@link SDKResult}.
 *
 * @param config - SDK configuration options.
 */
export function initSDK(config: SDKConfig): Promise<SDKResult> {
	if (_initPromise !== null) return _initPromise;
	_initPromise = (async () => {
		try {
			const real = await import("./internal/real.js");
			const result = real.impl.setup(config);
			_impl = real.impl as Impl;
			_globalResource = result.resource;
			return result;
		} catch {
			return makePassthroughSDKResult();
		}
	})();
	return _initPromise;
}

/**
 * Return the {@link Resource} created by the most recent {@link initSDK} call,
 * or `null` if the SDK has not been initialised yet.
 */
export function getResource(): Resource | null {
	return _globalResource;
}

/* ── Thin forwarders ─────────────────────────────────────────────────── */

export function withTrace<T>(fn: (span: Span) => T, opts?: Parameters<typeof _WT>[1]): T {
	return _impl.withTrace(fn, opts);
}

export function withAction<T>(
	action: string,
	fn: (span: Span) => T,
	opts?: Parameters<typeof _WA>[2],
): T {
	return _impl.withAction(action, fn, opts);
}

export function scopeAction(scope: Parameters<typeof _SA>[0]): ReturnType<typeof _SA> {
	return _impl.scopeAction(scope);
}

export function traced(optsOrFactory?: Parameters<typeof _TR>[0]): ReturnType<typeof _TR> {
	return _impl.traced(optsOrFactory);
}

export function injectContext<T>(
	value: T,
	opts?: Parameters<typeof _IC>[1],
): ReturnType<typeof _IC<T>> {
	return _impl.injectContext(value, opts) as ReturnType<typeof _IC<T>>;
}

/* ── Type-only re-exports ─────────────────────────────────────────────── */

export type { Counter, Histogram, Meter, MeterProvider, UpDownCounter } from "@opentelemetry/api";
export type { Resource } from "@opentelemetry/resources";
export type { ActionOptions, ActionScope, ScopedAction } from "../shared/action.js";
export type { InjectContextOptions } from "../shared/context.js";
export type { TracedCallContext, TracedInput } from "../shared/traced.js";
export type {
	Carrier,
	LogAttributes,
	Logger,
	LogLevel,
	LogOptions,
	OtlpSignal,
	RuntimeAdapter,
	RuntimeName,
	SDKConfig,
	SDKResult,
} from "../shared/types.js";
export type { WithTraceOptions } from "../shared/with-trace.js";
