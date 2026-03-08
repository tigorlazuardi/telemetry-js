/**
 * Structured application error with HTTP status, cause chaining, and
 * public-safe messaging.
 *
 * ```ts
 * import { AppError } from "@tigorhutasuhut/telemetry-js/error";
 *
 * throw AppError.fail("not found", { status: 404, publicMessage: "Resource not found" });
 * ```
 *
 * **Not intended for use inside libraries.** Libraries should define
 * their own `Error` subclass so consumers can distinguish errors via
 * `instanceof`.  `AppError` is designed for **application-level** code
 * (API handlers, services, CLI tools) where a single, consistent error
 * shape across the entire app is more useful than per-package error
 * classes.
 */

export interface AppErrorOptions {
	message?: string;
	publicMessage?: string;
	status?: number;
	fields?: Record<string, unknown>;
	cause?: unknown;
}

/**
 * Walk the cause chain looking for the first {@link AppError} where
 * `predicate` returns a non-undefined value.
 */
function walkCauseChain<T>(err: unknown, predicate: (e: AppError) => T | undefined): T | undefined {
	let current = err;
	while (current instanceof AppError) {
		const result = predicate(current);
		if (result !== undefined) return result;
		current = current.cause;
	}
	return undefined;
}

export class AppError extends Error {
	override readonly name = "AppError" as const;

	private _message: string | undefined;
	private _publicMessage: string | undefined;
	private _status: number | undefined;

	fields: Record<string, unknown> | undefined;
	override cause: unknown;

	constructor(opts?: AppErrorOptions) {
		super(undefined, { cause: opts?.cause });
		// Delete the own `message` property set by Error so our getter
		// on the prototype is reached instead.
		delete (this as { message?: string }).message;
		this._message = opts?.message;
		this._publicMessage = opts?.publicMessage;
		this._status = opts?.status;
		this.fields = opts?.fields;
		this.cause = opts?.cause;
	}

	// ── message ────────────────────────────────────────────────────────

	override get message(): string {
		if (this._message !== undefined) return this._message;
		if (this.cause instanceof Error) return this.cause.message;
		return "Internal Server Error";
	}

	override set message(value: string) {
		this._message = value;
	}

	// ── publicMessage ──────────────────────────────────────────────────

	get publicMessage(): string {
		if (this._publicMessage !== undefined) return this._publicMessage;
		// Walk the cause chain for the first AppError with a publicMessage set
		const found = walkCauseChain(this.cause, (e) => e._publicMessage);
		if (found !== undefined) return found;
		return this.message;
	}

	set publicMessage(value: string) {
		this._publicMessage = value;
	}

	// ── status ─────────────────────────────────────────────────────────

	get status(): number {
		if (this._status !== undefined) return this._status;
		// Walk the cause chain for the first AppError with a status set
		const found = walkCauseChain(this.cause, (e) => e._status);
		if (found !== undefined) return found;
		return 500;
	}

	set status(value: number) {
		this._status = value;
	}

	// ── serialisation ─────────────────────────────────────────────────

	/**
	 * Flat chain of messages from this error through the cause chain,
	 * joined by `": "`.
	 *
	 * ```
	 * "outer message: middle message: root message"
	 * ```
	 */
	override toString(): string {
		const parts: string[] = [];
		let current: unknown = this;
		while (current instanceof Error) {
			const msg = current instanceof AppError ? current._message : current.message;
			if (msg) parts.push(msg);
			current = current.cause;
		}
		return parts.join(": ") || "Internal Server Error";
	}

	/**
	 * Structured JSON representation suitable for API responses and
	 * logging.  Does **not** include the stack trace.
	 */
	toJSON(): {
		name: string;
		message: string;
		publicMessage: string;
		status: number;
		fields?: Record<string, unknown>;
		cause?: unknown;
	} {
		return {
			name: this.name,
			message: this.message,
			publicMessage: this.publicMessage,
			status: this.status,
			...(this.fields !== undefined && { fields: this.fields }),
			...(this.cause !== undefined && {
				cause:
					this.cause instanceof AppError
						? this.cause.toJSON()
						: this.cause instanceof Error
							? { name: this.cause.name, message: this.cause.message, stack: this.cause.stack }
							: this.cause,
			}),
		};
	}

	// ── static constructors ────────────────────────────────────────────

	/**
	 * Wrap an unknown value as an {@link AppError}, always creating a new
	 * instance so every wrap adds a layer to the cause chain.
	 *
	 * If `err` is an `Error`, its stack trace is preserved on the new
	 * `AppError`.
	 */
	static wrap(err: unknown, opts?: Omit<AppErrorOptions, "cause">): AppError {
		const appErr = new AppError({ ...opts, cause: err });

		// Preserve the original stack trace when wrapping an Error
		if (err instanceof Error && err.stack) {
			appErr.stack = err.stack;
		}

		return appErr;
	}

	/**
	 * Create a new {@link AppError} from a message string.
	 */
	static fail(message: string, opts?: Omit<AppErrorOptions, "message">): AppError {
		return new AppError({ ...opts, message });
	}

	/**
	 * Execute `fn` and wrap any thrown value with {@link AppError.wrap}.
	 *
	 * If `fn` returns a `PromiseLike`, the rejection is caught and
	 * wrapped as well.
	 */
	static run<T>(fn: () => T): T {
		try {
			const result = fn();
			if (
				result != null &&
				typeof (result as unknown as PromiseLike<unknown>).then === "function"
			) {
				return (result as unknown as PromiseLike<unknown>).then(undefined, (err: unknown) => {
					if (err instanceof AppError) throw err;
					throw AppError.wrap(err);
				}) as T;
			}
			return result;
		} catch (err) {
			if (err instanceof AppError) throw err;
			throw AppError.wrap(err);
		}
	}

	/**
	 * Walk the `.cause` chain of `err` and return the first instance that
	 * matches `Target`.  Returns `undefined` if no match is found.
	 *
	 * ```ts
	 * try { … } catch (err) {
	 *   const pg = AppError.is(err, PostgresErrorConflict);
	 *   if (pg) { /* handle conflict *\/ }
	 * }
	 * ```
	 */
	static is<T>(err: unknown, Target: new (...args: never[]) => T): T | undefined {
		let current: unknown = err;
		while (current != null) {
			if (current instanceof Target) return current;
			current = current instanceof Error ? current.cause : undefined;
		}
		return undefined;
	}
}
