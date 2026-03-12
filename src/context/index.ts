/**
 * Go-style context utilities built on top of OpenTelemetry context propagation.
 *
 * Provides value storage, cancellation, timeouts, and deadlines — all
 * propagated through the active OTel context and backed by native
 * {@link AbortSignal}.
 *
 * ```ts
 * import {
 *   withValue, getValue,
 *   withCancel, withTimeout, withDeadline,
 *   getSignal, isCanceled,
 * } from "@tigorhutasuhut/telemetry-js/context";
 * ```
 *
 * Requires Node 20+, Cloudflare Workers, or modern browsers
 * (`AbortSignal.any()` support).
 */

import { context, createContextKey } from "@opentelemetry/api";
import { SIGNAL_KEY } from "../shared/signal.js";

// ── Errors ────────────────────────────────────────────────────────────

/**
 * Thrown (or set as `signal.reason`) when a context is explicitly canceled
 * via `cancel()` from {@link withCancel}.
 *
 * Equivalent to Go's `context.Canceled`.
 *
 * ```ts
 * try { … } catch (err) {
 *   if (err instanceof ContextCanceledError) { /* canceled *\/ }
 * }
 * ```
 */
export class ContextCanceledError extends Error {
	override readonly name = "ContextCanceledError" as const;
	constructor() {
		super("context canceled");
	}
}

/**
 * Thrown (or set as `signal.reason`) when a context deadline or timeout
 * expires in {@link withTimeout} or {@link withDeadline}.
 *
 * Equivalent to Go's `context.DeadlineExceeded`.
 *
 * ```ts
 * try { … } catch (err) {
 *   if (err instanceof DeadlineExceededError) { /* timed out *\/ }
 * }
 * ```
 */
export class DeadlineExceededError extends Error {
	override readonly name = "DeadlineExceededError" as const;
	constructor() {
		super("context deadline exceeded");
	}
}

// ── Values ────────────────────────────────────────────────────────────

/**
 * Execute `fn` with `key`=`value` stored in the active OTel context.
 *
 * @param key   - Context key created via `createContextKey()` from `@opentelemetry/api`.
 * @param value - Value to store.
 * @param fn    - Function to execute within the scoped context.
 * @returns Whatever `fn` returns (or a `Promise` thereof).
 */
export function withValue<T>(key: symbol, value: unknown, fn: () => T): T {
	const ctx = context.active().setValue(createContextKey(key.toString()), value);
	return context.with(ctx, fn);
}

/**
 * Read a value from the active OTel context.
 *
 * @param key - The same `symbol` passed to {@link withValue}.
 * @returns The stored value, or `undefined` if not set.
 */
export function getValue<T = unknown>(key: symbol): T | undefined {
	return context.active().getValue(createContextKey(key.toString())) as T | undefined;
}

// ── Signal ────────────────────────────────────────────────────────────

/**
 * Read the {@link AbortSignal} from the active OTel context.
 *
 * Returns `undefined` when called outside a {@link withCancel},
 * {@link withTimeout}, or {@link withDeadline} scope.
 */
export function getSignal(): AbortSignal | undefined {
	return context.active().getValue(SIGNAL_KEY) as AbortSignal | undefined;
}

/**
 * Shorthand for `getSignal()?.aborted ?? false`.
 */
export function isCanceled(): boolean {
	return getSignal()?.aborted ?? false;
}

// ── Internal helpers ──────────────────────────────────────────────────

/**
 * Combine a new child signal with any existing parent signal in the
 * active context. If a parent signal exists, the returned signal aborts
 * when **either** the parent or the child aborts.
 */
function deriveSignal(childSignal: AbortSignal): AbortSignal {
	const parentSignal = context.active().getValue(SIGNAL_KEY) as AbortSignal | undefined;
	if (!parentSignal) return childSignal;
	return AbortSignal.any([parentSignal, childSignal]);
}

/**
 * Shared implementation for withCancel / withTimeout / withDeadline.
 *
 * Stores the (derived) signal in context, invokes `fn`, and runs
 * cleanup on completion (sync or async).  No spans are created —
 * tracing is the caller's responsibility via `withTrace`.
 *
 * For async callbacks the result is **raced** against the signal:
 * if the signal aborts before `fn` settles, the returned promise
 * rejects with `signal.reason` (a {@link ContextCanceledError} or
 * {@link DeadlineExceededError}).  Sync callbacks always return
 * normally — the timer cannot fire during synchronous execution.
 */
function withSignal<T>(
	signal: AbortSignal,
	cleanup: (() => void) | undefined,
	fn: (cancel: () => void) => T,
	cancel: () => void,
): T {
	const derived = deriveSignal(signal);
	const ctx = context.active().setValue(SIGNAL_KEY, derived);

	return context.with(ctx, () => {
		let result: T;
		try {
			result = fn(cancel);
		} catch (error) {
			cleanup?.();
			throw error;
		}

		if (result != null && typeof (result as unknown as PromiseLike<unknown>).then === "function") {
			// Race fn's promise against signal abort.
			const fnPromise = (result as unknown as PromiseLike<unknown>).then(
				(value) => {
					cleanup?.();
					return value;
				},
				(error: unknown) => {
					cleanup?.();
					throw error;
				},
			);

			// If already aborted, reject immediately.
			if (derived.aborted) {
				cleanup?.();
				return Promise.reject(derived.reason) as T;
			}

			const raced = new Promise<unknown>((resolve, reject) => {
				const onAbort = () => {
					cleanup?.();
					reject(derived.reason);
				};
				derived.addEventListener("abort", onAbort, { once: true });
				fnPromise.then(
					(value) => {
						derived.removeEventListener("abort", onAbort);
						resolve(value);
					},
					(error) => {
						derived.removeEventListener("abort", onAbort);
						reject(error);
					},
				);
			});

			return raced as T;
		}

		cleanup?.();
		return result;
	});
}

// ── External signal ───────────────────────────────────────────────────

/**
 * Propagate an external {@link AbortSignal} (e.g. `request.signal` from
 * Hono / Cloudflare Workers) into the active OTel context so downstream
 * code can read it via {@link getSignal}.
 *
 * If a parent signal already exists in the context (from an outer
 * `withCancel`, `withTimeout`, `withDeadline`, or `withAbortSignal`),
 * the signals are merged via `AbortSignal.any()` — the derived signal
 * aborts when **either** fires.
 *
 * Unlike `withCancel` / `withTimeout` / `withDeadline`, this function
 * does **not** create a span — it is purely signal wiring.
 *
 * @param signal - The external signal to propagate.
 * @param fn     - Function to execute within the scoped context.
 * @returns Whatever `fn` returns (or a `Promise` thereof).
 *
 * @example
 * ```ts
 * // Hono handler
 * app.get("/users/:id", (c) => {
 *   return withAbortSignal(c.req.raw.signal, async () => {
 *     // getSignal() now returns request.signal (or derived)
 *     const user = await fetchUser(c.req.param("id"));
 *     return c.json(user);
 *   });
 * });
 * ```
 */
export function withAbortSignal<T>(signal: AbortSignal, fn: () => T): T {
	const derived = deriveSignal(signal);
	const ctx = context.active().setValue(SIGNAL_KEY, derived);
	return context.with(ctx, fn);
}

// ── Detach signal ─────────────────────────────────────────────────────

/**
 * Execute `fn` with a context that **removes** the cancellation signal
 * while preserving all other context values.
 *
 * Inside the scope, {@link getSignal} returns `undefined` and
 * {@link isCanceled} returns `false`, regardless of any parent
 * `withCancel` / `withTimeout` / `withDeadline` / `withAbortSignal`.
 *
 * Equivalent to Go's `context.WithoutCancel` — useful for
 * fire-and-forget work (audit logging, cleanup) that must continue
 * even if the parent context is canceled.
 *
 * @param fn - Function to execute without cancellation.
 * @returns Whatever `fn` returns (or a `Promise` thereof).
 *
 * @example
 * ```ts
 * await withTimeout(5000, async () => {
 *   const data = await fetchData();
 *   // Audit log must complete even if parent times out
 *   withoutCancel(async () => {
 *     await auditLog("fetched", data);
 *   });
 *   return data;
 * });
 * ```
 */
export function withoutCancel<T>(fn: () => T): T {
	const ctx = context.active().deleteValue(SIGNAL_KEY);
	return context.with(ctx, fn);
}

// ── Cancellation ──────────────────────────────────────────────────────

/**
 * Execute `fn` with a cancellable context. The callback receives a
 * `cancel()` function; downstream code reads the signal via
 * {@link getSignal}.
 *
 * If a parent signal exists (from an outer `withCancel` / `withTimeout` /
 * `withDeadline`), the child is automatically canceled when the parent is.
 *
 * **Async race semantics:** when `fn` returns a `Promise`, the result is
 * raced against the signal. If `cancel()` fires before `fn` settles, the
 * returned promise rejects with {@link ContextCanceledError}. Sync
 * callbacks always return normally.
 *
 * **Cloudflare `waitUntil` caveat:** code after an `await` inside `fn`
 * will not execute if the signal aborts first (the promise rejects
 * immediately). If you need fire-and-forget work that must survive
 * cancellation (e.g. `ctx.waitUntil`), wrap it in {@link withoutCancel}.
 *
 * @param fn - Receives `cancel()`. Call it to abort the signal.
 * @returns Whatever `fn` returns (or a `Promise` thereof).
 *
 * @example
 * ```ts
 * await withCancel(async (cancel) => {
 *   const signal = getSignal();
 *   const res = await fetch(url, { signal });
 *   cancel(); // manual cancel
 * });
 * ```
 */
export function withCancel<T>(fn: (cancel: () => void) => T): T {
	const ac = new AbortController();
	const cancel = () => ac.abort(new ContextCanceledError());
	return withSignal(ac.signal, undefined, fn, cancel);
}

/**
 * Execute `fn` with a context that auto-cancels after `ms` milliseconds.
 *
 * The callback receives a `cancel()` function for early cancellation.
 * The timer is cleared when `fn` completes (success or error).
 *
 * **Async race semantics:** when `fn` returns a `Promise`, the result is
 * raced against the timer. If `ms` elapses before `fn` settles, the
 * returned promise rejects with {@link DeadlineExceededError}. If
 * `cancel()` is called first, it rejects with
 * {@link ContextCanceledError}. Sync callbacks always return normally.
 *
 * **Cloudflare `waitUntil` caveat:** code after an `await` inside `fn`
 * will not execute if the timeout fires first. Wrap fire-and-forget work
 * in {@link withoutCancel} to ensure it survives cancellation.
 *
 * @param ms - Timeout in milliseconds.
 * @param fn - Receives `cancel()`.
 * @returns Whatever `fn` returns (or a `Promise` thereof).
 *
 * @example
 * ```ts
 * await withTimeout(5000, async (cancel) => {
 *   const signal = getSignal();
 *   const res = await fetch(url, { signal });
 *   return res.json();
 * });
 * ```
 */
export function withTimeout<T>(ms: number, fn: (cancel: () => void) => T): T {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(new DeadlineExceededError()), ms);
	const cleanup = () => clearTimeout(timer);
	const cancel = () => {
		clearTimeout(timer);
		ac.abort(new ContextCanceledError());
	};
	return withSignal(ac.signal, cleanup, fn, cancel);
}

/**
 * Execute `fn` with a context that auto-cancels at `deadline`.
 *
 * The callback receives a `cancel()` function for early cancellation.
 * The timer is cleared when `fn` completes (success or error).
 *
 * **Async race semantics:** when `fn` returns a `Promise`, the result is
 * raced against the deadline. If the deadline passes before `fn` settles,
 * the returned promise rejects with {@link DeadlineExceededError}. If
 * `cancel()` is called first, it rejects with
 * {@link ContextCanceledError}. Sync callbacks always return normally.
 *
 * **Cloudflare `waitUntil` caveat:** code after an `await` inside `fn`
 * will not execute if the deadline fires first. Wrap fire-and-forget work
 * in {@link withoutCancel} to ensure it survives cancellation.
 *
 * @param deadline - Absolute time (Date) at which the context is canceled.
 * @param fn       - Receives `cancel()`.
 * @returns Whatever `fn` returns (or a `Promise` thereof).
 *
 * @example
 * ```ts
 * const deadline = new Date(Date.now() + 10_000);
 * await withDeadline(deadline, async (cancel) => {
 *   const signal = getSignal();
 *   const res = await fetch(url, { signal });
 *   return res.json();
 * });
 * ```
 */
export function withDeadline<T>(deadline: Date, fn: (cancel: () => void) => T): T {
	const ms = Math.max(0, deadline.getTime() - Date.now());
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(new DeadlineExceededError()), ms);
	const cleanup = () => clearTimeout(timer);
	const cancel = () => {
		clearTimeout(timer);
		ac.abort(new ContextCanceledError());
	};
	return withSignal(ac.signal, cleanup, fn, cancel);
}
