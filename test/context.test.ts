import { context } from "@opentelemetry/api";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StackContextManager } from "../src/browser/context-manager.js";
import {
	ContextCanceledError,
	DeadlineExceededError,
	getSignal,
	getValue,
	isCanceled,
	withAbortSignal,
	withCancel,
	withDeadline,
	withoutCancel,
	withTimeout,
	withValue,
} from "../src/context/index.js";

// Register a real context manager so context.with() propagates values.
const ctxManager = new StackContextManager();
beforeAll(() => {
	context.setGlobalContextManager(ctxManager.enable());
});
afterAll(() => {
	context.disable();
});

describe("context", () => {
	// ── withValue / getValue ──────────────────────────────────────

	describe("withValue / getValue", () => {
		it("stores and retrieves a value by symbol key", () => {
			const key = Symbol("user-id");
			let captured: unknown;
			withValue(key, "alice", () => {
				captured = getValue(key);
			});
			expect(captured).toBe("alice");
		});

		it("returns undefined outside scope", () => {
			const key = Symbol("missing");
			expect(getValue(key)).toBeUndefined();
		});

		it("supports nested values with different keys", () => {
			const k1 = Symbol("k1");
			const k2 = Symbol("k2");
			let v1: unknown;
			let v2: unknown;
			withValue(k1, "a", () => {
				withValue(k2, "b", () => {
					v1 = getValue(k1);
					v2 = getValue(k2);
				});
			});
			expect(v1).toBe("a");
			expect(v2).toBe("b");
		});

		it("inner value shadows outer with same key", () => {
			const key = Symbol("key");
			let inner: unknown;
			let outer: unknown;
			withValue(key, "outer", () => {
				withValue(key, "inner", () => {
					inner = getValue(key);
				});
				outer = getValue(key);
			});
			expect(inner).toBe("inner");
			expect(outer).toBe("outer");
		});

		it("returns sync value from callback", () => {
			const key = Symbol("k");
			const result = withValue(key, 1, () => 42);
			expect(result).toBe(42);
		});

		it("returns async value from callback", async () => {
			const key = Symbol("k");
			const result = withValue(key, 1, () => Promise.resolve("async"));
			await expect(result).resolves.toBe("async");
		});
	});

	// ── getSignal / isCanceled ────────────────────────────────────

	describe("getSignal / isCanceled", () => {
		it("getSignal returns undefined outside cancel scope", () => {
			expect(getSignal()).toBeUndefined();
		});

		it("isCanceled returns false outside cancel scope", () => {
			expect(isCanceled()).toBe(false);
		});
	});

	// ── Error classes ────────────────────────────────────────────

	describe("ContextCanceledError", () => {
		it("has name ContextCanceledError", () => {
			const err = new ContextCanceledError();
			expect(err.name).toBe("ContextCanceledError");
		});

		it("has message 'context canceled'", () => {
			const err = new ContextCanceledError();
			expect(err.message).toBe("context canceled");
		});

		it("is instanceof Error", () => {
			const err = new ContextCanceledError();
			expect(err).toBeInstanceOf(Error);
			expect(err).toBeInstanceOf(ContextCanceledError);
		});
	});

	describe("DeadlineExceededError", () => {
		it("has name DeadlineExceededError", () => {
			const err = new DeadlineExceededError();
			expect(err.name).toBe("DeadlineExceededError");
		});

		it("has message 'context deadline exceeded'", () => {
			const err = new DeadlineExceededError();
			expect(err.message).toBe("context deadline exceeded");
		});

		it("is instanceof Error", () => {
			const err = new DeadlineExceededError();
			expect(err).toBeInstanceOf(Error);
			expect(err).toBeInstanceOf(DeadlineExceededError);
		});
	});

	// ── withCancel ────────────────────────────────────────────────

	describe("withCancel", () => {
		it("returns sync value from callback", () => {
			const result = withCancel(() => 42);
			expect(result).toBe(42);
		});

		it("returns resolved promise from async callback", async () => {
			const result = withCancel(() => Promise.resolve("ok"));
			await expect(result).resolves.toBe("ok");
		});

		it("provides signal via getSignal inside callback", () => {
			let signal: AbortSignal | undefined;
			withCancel(() => {
				signal = getSignal();
			});
			expect(signal).toBeInstanceOf(AbortSignal);
			expect(signal?.aborted).toBe(false);
		});

		it("cancel() aborts the signal", () => {
			let signal: AbortSignal | undefined;
			withCancel((cancel) => {
				signal = getSignal();
				expect(signal?.aborted).toBe(false);
				cancel();
				expect(signal?.aborted).toBe(true);
			});
		});

		it("isCanceled() reflects cancellation", () => {
			withCancel((cancel) => {
				expect(isCanceled()).toBe(false);
				cancel();
				expect(isCanceled()).toBe(true);
			});
		});

		it("signal.reason is ContextCanceledError after cancel()", () => {
			let signal: AbortSignal | undefined;
			withCancel((cancel) => {
				signal = getSignal();
				cancel();
			});
			expect(signal?.reason).toBeInstanceOf(ContextCanceledError);
			expect(signal?.reason.message).toBe("context canceled");
		});

		it("re-throws sync errors", () => {
			const err = new Error("boom");
			expect(() =>
				withCancel(() => {
					throw err;
				}),
			).toThrow(err);
		});

		it("re-throws async rejections", async () => {
			const err = new Error("async boom");
			await expect(withCancel(() => Promise.reject(err))).rejects.toThrow(err);
		});

		it("rejects with ContextCanceledError when cancel() fires during async fn", async () => {
			const result = withCancel((cancel) => {
				return new Promise((resolve) => {
					// Simulate async work that never resolves
					setTimeout(resolve, 10_000);
					// Cancel immediately
					cancel();
				});
			});
			await expect(result).rejects.toBeInstanceOf(ContextCanceledError);
		});

		it("async fn that resolves before cancel returns normally", async () => {
			const result = withCancel((_cancel) => {
				return Promise.resolve("fast");
			});
			await expect(result).resolves.toBe("fast");
		});
	});

	// ── withTimeout ───────────────────────────────────────────────

	describe("withTimeout", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("returns sync value before timeout", () => {
			const result = withTimeout(1000, () => "fast");
			expect(result).toBe("fast");
		});

		it("provides signal that is not aborted during sync execution", () => {
			let signal: AbortSignal | undefined;
			withTimeout(100, () => {
				signal = getSignal();
			});
			// Timer cleared on sync completion, signal should not abort
			expect(signal?.aborted).toBe(false);
		});

		it("clears timer on sync completion", () => {
			const clearSpy = vi.spyOn(globalThis, "clearTimeout");
			withTimeout(5000, () => "done");
			expect(clearSpy).toHaveBeenCalled();
			clearSpy.mockRestore();
		});

		it("cancel() triggers abort immediately", () => {
			let signal: AbortSignal | undefined;
			withTimeout(5000, (cancel) => {
				signal = getSignal();
				cancel();
				expect(signal?.aborted).toBe(true);
			});
		});

		it("cancel() sets ContextCanceledError as signal.reason", () => {
			let signal: AbortSignal | undefined;
			withTimeout(5000, (cancel) => {
				signal = getSignal();
				cancel();
			});
			expect(signal?.reason).toBeInstanceOf(ContextCanceledError);
		});

		it("timeout expiry sets DeadlineExceededError as signal.reason", () => {
			let signal: AbortSignal | undefined;
			withTimeout(100, () => {
				signal = getSignal();
				// Don't resolve — let the timer fire
				vi.advanceTimersByTime(200);
			});
			expect(signal?.aborted).toBe(true);
			expect(signal?.reason).toBeInstanceOf(DeadlineExceededError);
			expect(signal?.reason.message).toBe("context deadline exceeded");
		});

		it("clears timer on async completion", async () => {
			const clearSpy = vi.spyOn(globalThis, "clearTimeout");
			await withTimeout(5000, () => Promise.resolve("done"));
			expect(clearSpy).toHaveBeenCalled();
			clearSpy.mockRestore();
		});

		it("clears timer on sync error", () => {
			const clearSpy = vi.spyOn(globalThis, "clearTimeout");
			expect(() =>
				withTimeout(5000, () => {
					throw new Error("fail");
				}),
			).toThrow("fail");
			expect(clearSpy).toHaveBeenCalled();
			clearSpy.mockRestore();
		});

		it("rejects with DeadlineExceededError when timer fires during async fn", async () => {
			const result = withTimeout(100, () => {
				// Return a promise that won't resolve before the timer
				return new Promise((resolve) => setTimeout(resolve, 10_000));
			});
			// Advance past the 100ms timeout
			vi.advanceTimersByTime(200);
			await expect(result).rejects.toBeInstanceOf(DeadlineExceededError);
		});

		it("rejects with ContextCanceledError when cancel() called during async fn", async () => {
			const result = withTimeout(5000, (cancel) => {
				return new Promise((resolve) => {
					setTimeout(resolve, 10_000);
					cancel();
				});
			});
			await expect(result).rejects.toBeInstanceOf(ContextCanceledError);
		});

		it("async fn that resolves before timeout returns normally", async () => {
			const result = withTimeout(5000, () => Promise.resolve("fast"));
			await expect(result).resolves.toBe("fast");
		});
	});

	// ── withDeadline ──────────────────────────────────────────────

	describe("withDeadline", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("returns sync value before deadline", () => {
			const deadline = new Date(Date.now() + 10_000);
			const result = withDeadline(deadline, () => "ok");
			expect(result).toBe("ok");
		});

		it("cancel() triggers abort immediately", () => {
			const deadline = new Date(Date.now() + 10_000);
			let signal: AbortSignal | undefined;
			withDeadline(deadline, (cancel) => {
				signal = getSignal();
				cancel();
				expect(signal?.aborted).toBe(true);
			});
		});

		it("cancel() sets ContextCanceledError as signal.reason", () => {
			const deadline = new Date(Date.now() + 10_000);
			let signal: AbortSignal | undefined;
			withDeadline(deadline, (cancel) => {
				signal = getSignal();
				cancel();
			});
			expect(signal?.reason).toBeInstanceOf(ContextCanceledError);
		});

		it("deadline expiry sets DeadlineExceededError as signal.reason", () => {
			const deadline = new Date(Date.now() + 100);
			let signal: AbortSignal | undefined;
			withDeadline(deadline, () => {
				signal = getSignal();
				vi.advanceTimersByTime(200);
			});
			expect(signal?.aborted).toBe(true);
			expect(signal?.reason).toBeInstanceOf(DeadlineExceededError);
		});

		it("treats past deadline as immediate (ms = 0)", () => {
			const past = new Date(Date.now() - 1000);
			const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
			withDeadline(past, () => "ok");
			const call = setTimeoutSpy.mock.calls.find((c) => typeof c[0] === "function");
			expect(call?.[1]).toBe(0);
			setTimeoutSpy.mockRestore();
		});

		it("rejects with DeadlineExceededError when deadline fires during async fn", async () => {
			const deadline = new Date(Date.now() + 100);
			const result = withDeadline(deadline, () => {
				return new Promise((resolve) => setTimeout(resolve, 10_000));
			});
			vi.advanceTimersByTime(200);
			await expect(result).rejects.toBeInstanceOf(DeadlineExceededError);
		});

		it("async fn that resolves before deadline returns normally", async () => {
			const deadline = new Date(Date.now() + 10_000);
			const result = withDeadline(deadline, () => Promise.resolve("fast"));
			await expect(result).resolves.toBe("fast");
		});
	});

	// ── withAbortSignal ──────────────────────────────────────────

	describe("withAbortSignal", () => {
		it("propagates external signal into context", () => {
			const ac = new AbortController();
			let signal: AbortSignal | undefined;
			withAbortSignal(ac.signal, () => {
				signal = getSignal();
			});
			expect(signal).toBeInstanceOf(AbortSignal);
			expect(signal?.aborted).toBe(false);
		});

		it("external abort reflects in getSignal()", () => {
			const ac = new AbortController();
			let signal: AbortSignal | undefined;
			withAbortSignal(ac.signal, () => {
				signal = getSignal();
			});
			ac.abort();
			expect(signal?.aborted).toBe(true);
		});

		it("isCanceled() reflects external abort", () => {
			const ac = new AbortController();
			ac.abort();
			withAbortSignal(ac.signal, () => {
				expect(isCanceled()).toBe(true);
			});
		});

		it("returns sync value from callback", () => {
			const ac = new AbortController();
			const result = withAbortSignal(ac.signal, () => 42);
			expect(result).toBe(42);
		});

		it("returns async value from callback", async () => {
			const ac = new AbortController();
			const result = withAbortSignal(ac.signal, () => Promise.resolve("async"));
			await expect(result).resolves.toBe("async");
		});

		it("derives with parent signal — parent abort cascades", () => {
			const parent = new AbortController();
			const child = new AbortController();
			let innerSignal: AbortSignal | undefined;
			withAbortSignal(parent.signal, () => {
				withAbortSignal(child.signal, () => {
					innerSignal = getSignal();
				});
			});
			expect(innerSignal?.aborted).toBe(false);
			parent.abort();
			expect(innerSignal?.aborted).toBe(true);
		});

		it("child abort does not cascade to parent", () => {
			const parent = new AbortController();
			const child = new AbortController();
			let parentSignal: AbortSignal | undefined;
			withAbortSignal(parent.signal, () => {
				parentSignal = getSignal();
				withAbortSignal(child.signal, () => {
					// noop
				});
			});
			child.abort();
			expect(parentSignal?.aborted).toBe(false);
		});

		it("derives with withCancel parent signal", () => {
			const ac = new AbortController();
			let innerSignal: AbortSignal | undefined;
			let parentCancelFn: (() => void) | undefined;
			withCancel((cancel) => {
				parentCancelFn = cancel;
				withAbortSignal(ac.signal, () => {
					innerSignal = getSignal();
				});
			});
			expect(innerSignal?.aborted).toBe(false);
			parentCancelFn!();
			expect(innerSignal?.aborted).toBe(true);
		});

		it("signal is undefined outside withAbortSignal scope", () => {
			const ac = new AbortController();
			withAbortSignal(ac.signal, () => {
				expect(getSignal()).toBeInstanceOf(AbortSignal);
			});
			expect(getSignal()).toBeUndefined();
		});
	});

	// ── withoutCancel ────────────────────────────────────────────

	describe("withoutCancel", () => {
		it("getSignal() returns undefined inside withoutCancel", () => {
			withCancel(() => {
				expect(getSignal()).toBeInstanceOf(AbortSignal);
				withoutCancel(() => {
					expect(getSignal()).toBeUndefined();
				});
			});
		});

		it("isCanceled() returns false inside withoutCancel", () => {
			withCancel((cancel) => {
				cancel();
				expect(isCanceled()).toBe(true);
				withoutCancel(() => {
					expect(isCanceled()).toBe(false);
				});
			});
		});

		it("parent cancel does not affect withoutCancel scope", () => {
			let innerSignal: AbortSignal | undefined;
			withCancel((cancel) => {
				withoutCancel(() => {
					// Re-establish a new signal inside detached scope
					withCancel(() => {
						innerSignal = getSignal();
					});
				});
				cancel();
			});
			// Inner signal was created inside withoutCancel, detached from parent
			expect(innerSignal?.aborted).toBe(false);
		});

		it("preserves context values (only strips signal)", () => {
			const key = Symbol("keep-me");
			withValue(key, "hello", () => {
				withCancel(() => {
					withoutCancel(() => {
						expect(getValue(key)).toBe("hello");
						expect(getSignal()).toBeUndefined();
					});
				});
			});
		});

		it("returns sync value from callback", () => {
			const result = withCancel(() => {
				return withoutCancel(() => 42);
			});
			expect(result).toBe(42);
		});

		it("returns async value from callback", async () => {
			const result = withCancel(() => {
				return withoutCancel(() => Promise.resolve("async"));
			});
			await expect(result).resolves.toBe("async");
		});

		it("works with withTimeout parent", () => {
			withTimeout(100, () => {
				expect(getSignal()).toBeInstanceOf(AbortSignal);
				withoutCancel(() => {
					expect(getSignal()).toBeUndefined();
				});
			});
		});

		it("works with withAbortSignal parent", () => {
			const ac = new AbortController();
			withAbortSignal(ac.signal, () => {
				expect(getSignal()).toBeInstanceOf(AbortSignal);
				withoutCancel(() => {
					expect(getSignal()).toBeUndefined();
				});
			});
		});
	});

	// ── Nesting ───────────────────────────────────────────────────

	describe("nesting", () => {
		it("child inherits parent signal — parent cancel aborts child", () => {
			let childSignal: AbortSignal | undefined;
			let parentCancelFn: (() => void) | undefined;
			withCancel((parentCancel) => {
				parentCancelFn = parentCancel;
				withCancel(() => {
					childSignal = getSignal();
				});
			});
			// Cancel parent after scopes exited — child signal was derived
			// via AbortSignal.any so it should reflect parent abort
			parentCancelFn!();
			expect(childSignal?.aborted).toBe(true);
		});

		it("child cancel does not abort parent", () => {
			let parentSignal: AbortSignal | undefined;
			withCancel(() => {
				parentSignal = getSignal();
				withCancel((childCancel) => {
					childCancel();
				});
				expect(parentSignal?.aborted).toBe(false);
			});
		});

		it("withValue inside withCancel preserves signal", () => {
			const key = Symbol("k");
			withCancel(() => {
				withValue(key, "v", () => {
					expect(getValue(key)).toBe("v");
					expect(getSignal()).toBeInstanceOf(AbortSignal);
				});
			});
		});
	});
});
