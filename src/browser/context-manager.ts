/**
 * Minimal {@link ContextManager} for browser environments.
 *
 * The browser JS main thread is single-threaded, so a simple variable swap
 * is sufficient — no `AsyncLocalStorage` or Zone.js required.
 *
 * @internal
 */

import { type Context, type ContextManager, ROOT_CONTEXT } from "@opentelemetry/api";

export class StackContextManager implements ContextManager {
	private _currentContext = ROOT_CONTEXT;

	active(): Context {
		return this._currentContext;
	}

	with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
		ctx: Context,
		fn: F,
		thisArg?: ThisParameterType<F>,
		...args: A
	): ReturnType<F> {
		const prev = this._currentContext;
		this._currentContext = ctx;
		try {
			return fn.call(thisArg!, ...args);
		} finally {
			this._currentContext = prev;
		}
	}

	bind<T>(ctx: Context, target: T): T {
		if (typeof target === "function") {
			const fn = target as unknown as (...a: unknown[]) => unknown;
			return ((...args: unknown[]) => this.with(ctx, () => fn(...args))) as unknown as T;
		}
		return target;
	}

	enable(): this {
		return this;
	}

	disable(): this {
		this._currentContext = ROOT_CONTEXT;
		return this;
	}
}
