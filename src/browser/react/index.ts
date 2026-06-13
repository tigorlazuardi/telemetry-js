/**
 * React hooks for UI action tracing + metrics — **runtime-light**.
 *
 * Only `react` (`useMemo`) is imported at runtime. The `scopeAction`/`withAction`
 * implementation loads lazily via dynamic `import()` on first use, keeping the
 * React entry point bundle minimal.
 *
 * @example
 * ```tsx
 * import { useScopeAction, useAction } from "@tigorhutasuhut/telemetry-js/browser/react";
 *
 * function SignInForm() {
 *   const action = useScopeAction({ page: "/auth/sign-in", component: "SignInForm" });
 *
 *   const handleSubmit = async () => {
 *     await action("submit", () => authClient.signIn.email({ email, password }));
 *   };
 * }
 * ```
 */

import type { Span } from "@opentelemetry/api";
import { useMemo } from "react";
import type { ActionOptions, ActionScope, ScopedAction } from "../../shared/action.js";

export type { ActionOptions, ActionScope, ScopedAction };

/** Async scoped action — resolves once the lazily-loaded action module is ready. */
export type AsyncScopedAction = <T>(
	action: string,
	fn: (span: Span) => T,
	attributes?: Record<string, string>,
) => Promise<Awaited<T>>;

/** Async one-off action runner. */
export type AsyncAction = <T>(
	action: string,
	fn: (span: Span) => T,
	opts?: ActionOptions,
) => Promise<Awaited<T>>;

type ActionMod = typeof import("../../shared/action.js");

let _mod: ActionMod | null = null;
let _modPromise: Promise<ActionMod> | null = null;

/** Kick off (or return) the lazy load of the action module. Idempotent. */
function ensureActionModule(): Promise<ActionMod> {
	if (_mod) return Promise.resolve(_mod);
	if (!_modPromise) {
		_modPromise = import("../../shared/action.js").then((m) => {
			_mod = m;
			return m;
		});
	}
	return _modPromise;
}

/** Reset lazy-load state (tests). @internal */
export function _resetReactActionModule(): void {
	_mod = null;
	_modPromise = null;
}

/** Internal factory — testable without a React renderer. @internal */
export function createScopedAction(scope: ActionScope): AsyncScopedAction {
	return async <T>(
		action: string,
		fn: (span: Span) => T,
		attributes?: Record<string, string>,
	): Promise<Awaited<T>> => {
		const mod = _mod ?? (await ensureActionModule());
		return mod.scopeAction(scope)(action, fn, attributes) as Awaited<ReturnType<typeof fn>>;
	};
}

/** Internal factory — testable without a React renderer. @internal */
export function createOneOffAction(): AsyncAction {
	return async <T>(
		action: string,
		fn: (span: Span) => T,
		opts?: ActionOptions,
	): Promise<Awaited<T>> => {
		const mod = _mod ?? (await ensureActionModule());
		return mod.withAction(action, fn, opts) as Awaited<ReturnType<typeof fn>>;
	};
}

/**
 * React hook: a scoped UI-action runner that lazily loads the tracing/metrics
 * code (non-blocking during render). The returned callback awaits that lazy
 * load on first use, so an action triggered before the module is ready simply
 * resolves once it arrives.
 *
 * @example
 * ```tsx
 * import { useScopeAction } from "@tigorhutasuhut/telemetry-js/browser/react";
 *
 * function SignInForm() {
 *   const action = useScopeAction({ page: "/auth/sign-in", component: "SignInForm" });
 *   const handleSubmit = async () => {
 *     await action("submit", () => authClient.signIn.email({ email, password }));
 *   };
 * }
 * ```
 */
export function useScopeAction(scope: ActionScope): AsyncScopedAction {
	// Kick the lazy load during render — non-blocking, idempotent.
	ensureActionModule();
	const { page, component } = scope;
	return useMemo(() => createScopedAction({ page, component }), [page, component]);
}

/**
 * React hook: a one-off UI-action runner (lazy, like {@link useScopeAction}).
 *
 * @example
 * ```tsx
 * import { useAction } from "@tigorhutasuhut/telemetry-js/browser/react";
 *
 * function LogoutButton() {
 *   const run = useAction();
 *   const handleClick = async () => {
 *     await run("logout", () => authClient.signOut(), { page: "/settings" });
 *   };
 * }
 * ```
 */
export function useAction(): AsyncAction {
	ensureActionModule();
	return useMemo(() => createOneOffAction(), []);
}
