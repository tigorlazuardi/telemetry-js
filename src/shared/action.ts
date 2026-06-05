/**
 * UI action tracing — wraps user interactions (button clicks, form submits,
 * etc.) in OpenTelemetry spans with page/component context.
 *
 * @example
 * ```ts
 * // One-off action
 * await withAction("submit", async () => {
 *   return authClient.signIn.email({ email, password });
 * });
 *
 * // Scoped — reuse page/component context across multiple actions
 * const action = scopeAction({ page: "/auth/sign-in", component: "SignInForm" });
 * await action("submit", () => authClient.signIn.email({ email, password }));
 * await action("reset", () => resetForm());
 * ```
 */

import { type Histogram, metrics, type Span, type UpDownCounter } from "@opentelemetry/api";
import { withTrace } from "./with-trace.js";

let _hist: Histogram | undefined;
let _active: UpDownCounter | undefined;

function durationHistogram(): Histogram {
	if (!_hist) {
		_hist = metrics
			.getMeter("@tigorhutasuhut/telemetry-js/ui-action")
			.createHistogram("ui.action.duration", {
				unit: "s",
				description: "Duration of a UI action (success or failure), in seconds.",
				advice: {
					explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
				},
			});
	}
	return _hist;
}

function activeCounter(): UpDownCounter {
	if (!_active) {
		_active = metrics
			.getMeter("@tigorhutasuhut/telemetry-js/ui-action")
			.createUpDownCounter("ui.action.active", {
				unit: "{action}",
				description: "Number of UI actions currently in flight.",
			});
	}
	return _active;
}

/** Internal: reset cached instruments (tests). @internal */
export function _resetActionMetrics(): void {
	_hist = undefined;
	_active = undefined;
}

/**
 * Scope for UI action tracing — identifies where the action originates.
 */
export interface ActionScope {
	/** Page route or path (e.g. `"/auth/sign-in"`). */
	page?: string;
	/** Component name (e.g. `"SignInForm"`). */
	component?: string;
}

/**
 * Options for {@link withAction}.
 */
export interface ActionOptions extends ActionScope {
	/** Extra span attributes to attach. */
	attributes?: Record<string, string>;
}

function buildAttributes(
	action: string,
	opts?: ActionScope & { attributes?: Record<string, string> },
): Record<string, string> {
	const attrs: Record<string, string> = { "ui.action": action, ...opts?.attributes };
	if (opts?.page) attrs["ui.page"] = opts.page;
	return attrs;
}

/**
 * Execute `fn` inside a span representing a user interaction.
 *
 * The span is named `action` (or `Component.action` when a component is
 * provided) and carries `ui.action`, `ui.page`, and `ui.component` attributes.
 *
 * Also emits metrics: `ui.action.duration` (Histogram, seconds) and
 * `ui.action.active` (UpDownCounter) via the global MeterProvider.
 *
 * @param action - Short action name (e.g. `"submit"`, `"toggle-password"`).
 * @param fn - The function to execute inside the span.
 * @param opts - Optional page/component scope and extra attributes.
 * @returns The return value of `fn`.
 *
 * @example
 * ```ts
 * await withAction("submit", () => authClient.signIn.email({ email, password }), {
 *   page: "/auth/sign-in",
 *   component: "SignInForm",
 * });
 * ```
 */
export function withAction<T>(action: string, fn: (span: Span) => T, opts?: ActionOptions): T {
	const baseAttrs: Record<string, string> = { "ui.action": action };
	if (opts?.component) baseAttrs["ui.component"] = opts.component;
	if (opts?.page) baseAttrs["ui.page"] = opts.page;

	const hist = durationHistogram();
	const active = activeCounter();
	const start = performance.now();

	const record = (errorType?: string) => {
		const attrs = errorType ? { ...baseAttrs, "error.type": errorType } : baseAttrs;
		hist.record((performance.now() - start) / 1000, attrs);
	};
	const errType = (e: unknown) =>
		e instanceof Error ? e.name || e.constructor?.name || "Error" : "Error";

	active.add(1, baseAttrs);

	try {
		const result = withTrace(fn, {
			name: action,
			component: opts?.component,
			attributes: buildAttributes(action, opts),
		});

		if (result != null && typeof (result as unknown as PromiseLike<unknown>).then === "function") {
			return (result as unknown as PromiseLike<unknown>).then(
				(value) => {
					active.add(-1, baseAttrs);
					record();
					return value;
				},
				(error: unknown) => {
					active.add(-1, baseAttrs);
					record(errType(error));
					throw error;
				},
			) as T;
		}

		active.add(-1, baseAttrs);
		record();
		return result;
	} catch (error) {
		active.add(-1, baseAttrs);
		record(errType(error));
		throw error;
	}
}

/**
 * A scoped action runner returned by {@link scopeAction}.
 *
 * Call it with an action name and function to create a span that inherits
 * the page/component scope.
 */
export type ScopedAction = <T>(
	action: string,
	fn: (span: Span) => T,
	attributes?: Record<string, string>,
) => T;

/**
 * Create a scoped action runner that pre-fills page/component context.
 *
 * Useful at the component level so every action inherits the same scope
 * without repeating `page`/`component` on every call.
 *
 * @param scope - The page and/or component context to attach to every action.
 * @returns A {@link ScopedAction} function.
 *
 * @example
 * ```ts
 * const action = scopeAction({ page: "/auth/sign-in", component: "SignInForm" });
 *
 * // Each call creates a span: "SignInForm.submit" with ui.page, ui.component attrs
 * await action("submit", () => authClient.signIn.email({ email, password }));
 * await action("reset", () => resetForm());
 *
 * // Extra attributes per-call
 * await action("submit", () => signIn(), { "auth.method": "email" });
 * ```
 */
export function scopeAction(scope: ActionScope): ScopedAction {
	return <T>(action: string, fn: (span: Span) => T, attributes?: Record<string, string>): T => {
		return withAction(action, fn, { ...scope, attributes });
	};
}
