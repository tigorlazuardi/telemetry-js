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

import type { Span } from "@opentelemetry/api";
import { withTrace } from "./with-trace.js";

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
	return withTrace(fn, {
		name: action,
		component: opts?.component,
		attributes: buildAttributes(action, opts),
	});
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
