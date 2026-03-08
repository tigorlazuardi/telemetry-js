import { describe, expect, it } from "vitest";
import { AppError } from "../src/error/index.js";

describe("AppError", () => {
	// ── constructor & name ──────────────────────────────────────────

	it("has name 'AppError'", () => {
		const err = new AppError();
		expect(err.name).toBe("AppError");
	});

	it("is instanceof Error", () => {
		expect(new AppError()).toBeInstanceOf(Error);
	});

	it("is instanceof AppError", () => {
		expect(new AppError()).toBeInstanceOf(AppError);
	});

	// ── message ────────────────────────────────────────────────────

	describe("message", () => {
		it("returns explicit message when set via constructor", () => {
			const err = new AppError({ message: "boom" });
			expect(err.message).toBe("boom");
		});

		it("returns cause.message when message is not set and cause is Error", () => {
			const cause = new Error("root cause");
			const err = new AppError({ cause });
			expect(err.message).toBe("root cause");
		});

		it("returns 'Internal Server Error' when message is not set and cause is not Error", () => {
			const err = new AppError({ cause: "string cause" });
			expect(err.message).toBe("Internal Server Error");
		});

		it("returns 'Internal Server Error' when no message and no cause", () => {
			const err = new AppError();
			expect(err.message).toBe("Internal Server Error");
		});

		it("allows setting message via setter", () => {
			const err = new AppError({ cause: new Error("original") });
			expect(err.message).toBe("original");
			err.message = "overridden";
			expect(err.message).toBe("overridden");
		});
	});

	// ── publicMessage ──────────────────────────────────────────────

	describe("publicMessage", () => {
		it("returns explicit publicMessage when set", () => {
			const err = new AppError({ publicMessage: "Not found" });
			expect(err.publicMessage).toBe("Not found");
		});

		it("walks cause chain to find publicMessage", () => {
			const inner = new AppError({ publicMessage: "from inner" });
			const mid = new AppError({ cause: inner });
			const outer = new AppError({ cause: mid });
			expect(outer.publicMessage).toBe("from inner");
		});

		it("falls back to message when no publicMessage in chain", () => {
			const err = new AppError({ message: "detailed error" });
			expect(err.publicMessage).toBe("detailed error");
		});

		it("falls back to message (from cause) when no publicMessage in chain", () => {
			const err = new AppError({ cause: new Error("root") });
			expect(err.publicMessage).toBe("root");
		});

		it("allows setting publicMessage via setter", () => {
			const err = new AppError();
			err.publicMessage = "user-facing";
			expect(err.publicMessage).toBe("user-facing");
		});

		it("prefers own publicMessage over cause chain", () => {
			const inner = new AppError({ publicMessage: "inner msg" });
			const outer = new AppError({ publicMessage: "outer msg", cause: inner });
			expect(outer.publicMessage).toBe("outer msg");
		});
	});

	// ── status ─────────────────────────────────────────────────────

	describe("status", () => {
		it("returns explicit status when set", () => {
			const err = new AppError({ status: 404 });
			expect(err.status).toBe(404);
		});

		it("walks cause chain to find status", () => {
			const inner = new AppError({ status: 403 });
			const mid = new AppError({ cause: inner });
			const outer = new AppError({ cause: mid });
			expect(outer.status).toBe(403);
		});

		it("defaults to 500 when no status in chain", () => {
			const err = new AppError();
			expect(err.status).toBe(500);
		});

		it("defaults to 500 when cause is plain Error", () => {
			const err = new AppError({ cause: new Error("oops") });
			expect(err.status).toBe(500);
		});

		it("allows setting status via setter", () => {
			const err = new AppError();
			err.status = 422;
			expect(err.status).toBe(422);
		});

		it("prefers own status over cause chain", () => {
			const inner = new AppError({ status: 403 });
			const outer = new AppError({ status: 401, cause: inner });
			expect(outer.status).toBe(401);
		});
	});

	// ── fields ─────────────────────────────────────────────────────

	describe("fields", () => {
		it("defaults to undefined", () => {
			const err = new AppError();
			expect(err.fields).toBeUndefined();
		});

		it("stores provided fields", () => {
			const err = new AppError({ fields: { userId: 123 } });
			expect(err.fields).toEqual({ userId: 123 });
		});
	});

	// ── cause ──────────────────────────────────────────────────────

	describe("cause", () => {
		it("stores cause", () => {
			const cause = new Error("root");
			const err = new AppError({ cause });
			expect(err.cause).toBe(cause);
		});

		it("accepts non-Error cause", () => {
			const err = new AppError({ cause: "string cause" });
			expect(err.cause).toBe("string cause");
		});
	});

	// ── AppError.wrap ──────────────────────────────────────────────

	describe("wrap", () => {
		it("always wraps AppError (builds cause chain)", () => {
			const original = new AppError({ message: "existing" });
			const wrapped = AppError.wrap(original);
			expect(wrapped).not.toBe(original);
			expect(wrapped).toBeInstanceOf(AppError);
			expect(wrapped.cause).toBe(original);
			expect(wrapped.message).toBe("existing");
		});

		it("wraps AppError with opts as new AppError", () => {
			const original = new AppError({ message: "existing" });
			const wrapped = AppError.wrap(original, { status: 400 });
			expect(wrapped).not.toBe(original);
			expect(wrapped.cause).toBe(original);
			expect(wrapped.status).toBe(400);
		});

		it("wraps plain Error and preserves stack trace", () => {
			const original = new Error("plain error");
			const wrapped = AppError.wrap(original);
			expect(wrapped).toBeInstanceOf(AppError);
			expect(wrapped.cause).toBe(original);
			expect(wrapped.message).toBe("plain error");
			expect(wrapped.stack).toBe(original.stack);
		});

		it("wraps non-Error value", () => {
			const wrapped = AppError.wrap("string error");
			expect(wrapped).toBeInstanceOf(AppError);
			expect(wrapped.cause).toBe("string error");
			expect(wrapped.message).toBe("Internal Server Error");
		});

		it("wraps null", () => {
			const wrapped = AppError.wrap(null);
			expect(wrapped).toBeInstanceOf(AppError);
			expect(wrapped.cause).toBeNull();
		});

		it("applies opts when wrapping plain Error", () => {
			const original = new Error("plain");
			const wrapped = AppError.wrap(original, {
				status: 422,
				publicMessage: "Validation failed",
				fields: { field: "email" },
			});
			expect(wrapped.status).toBe(422);
			expect(wrapped.publicMessage).toBe("Validation failed");
			expect(wrapped.fields).toEqual({ field: "email" });
			expect(wrapped.cause).toBe(original);
		});
	});

	// ── AppError.fail ──────────────────────────────────────────────

	describe("fail", () => {
		it("creates AppError with message", () => {
			const err = AppError.fail("something broke");
			expect(err).toBeInstanceOf(AppError);
			expect(err.message).toBe("something broke");
		});

		it("creates AppError with message and opts", () => {
			const err = AppError.fail("not found", {
				status: 404,
				publicMessage: "Resource not found",
				fields: { id: "abc" },
			});
			expect(err.message).toBe("not found");
			expect(err.status).toBe(404);
			expect(err.publicMessage).toBe("Resource not found");
			expect(err.fields).toEqual({ id: "abc" });
		});

		it("creates AppError with cause", () => {
			const cause = new Error("root");
			const err = AppError.fail("wrapper", { cause });
			expect(err.message).toBe("wrapper");
			expect(err.cause).toBe(cause);
		});
	});

	// ── AppError.run ───────────────────────────────────────────────

	describe("run", () => {
		it("returns value from synchronous fn", () => {
			const result = AppError.run(() => 42);
			expect(result).toBe(42);
		});

		it("wraps synchronous throw as AppError", () => {
			expect(() =>
				AppError.run(() => {
					throw new Error("sync fail");
				}),
			).toThrow(AppError);

			try {
				AppError.run(() => {
					throw new Error("sync fail");
				});
			} catch (err) {
				expect(err).toBeInstanceOf(AppError);
				expect((err as AppError).message).toBe("sync fail");
			}
		});

		it("wraps synchronous non-Error throw as AppError", () => {
			try {
				AppError.run(() => {
					throw "string error";
				});
			} catch (err) {
				expect(err).toBeInstanceOf(AppError);
				expect((err as AppError).cause).toBe("string error");
			}
		});

		it("wraps existing AppError on sync throw (builds chain)", () => {
			const original = AppError.fail("original");
			try {
				AppError.run(() => {
					throw original;
				});
			} catch (err) {
				expect(err).toBeInstanceOf(AppError);
				expect(err).not.toBe(original);
				expect((err as AppError).cause).toBe(original);
				expect((err as AppError).message).toBe("original");
			}
		});

		it("returns resolved promise from async fn", async () => {
			const result = AppError.run(() => Promise.resolve(42));
			await expect(result).resolves.toBe(42);
		});

		it("wraps rejected promise as AppError", async () => {
			const result = AppError.run(() => Promise.reject(new Error("async fail")));
			await expect(result).rejects.toBeInstanceOf(AppError);

			try {
				await AppError.run(() => Promise.reject(new Error("async fail")));
			} catch (err) {
				expect(err).toBeInstanceOf(AppError);
				expect((err as AppError).message).toBe("async fail");
			}
		});

		it("wraps rejected non-Error promise as AppError", async () => {
			try {
				await AppError.run(() => Promise.reject("string rejection"));
			} catch (err) {
				expect(err).toBeInstanceOf(AppError);
				expect((err as AppError).cause).toBe("string rejection");
			}
		});

		it("wraps existing AppError on async rejection (builds chain)", async () => {
			const original = AppError.fail("original");
			try {
				await AppError.run(() => Promise.reject(original));
			} catch (err) {
				expect(err).toBeInstanceOf(AppError);
				expect(err).not.toBe(original);
				expect((err as AppError).cause).toBe(original);
				expect((err as AppError).message).toBe("original");
			}
		});
	});

	// ── toString ───────────────────────────────────────────────────

	describe("toString", () => {
		it("returns own message", () => {
			const err = AppError.fail("not found");
			expect(err.toString()).toBe("not found");
		});

		it("chains messages with cause", () => {
			const root = new Error("db connection lost");
			const mid = AppError.wrap(root, { message: "query failed" });
			const outer = AppError.wrap(mid, { message: "get user" });
			expect(outer.toString()).toBe("get user: query failed: db connection lost");
		});

		it("skips cause layers without explicit message", () => {
			const root = new Error("timeout");
			const mid = AppError.wrap(root); // no message, falls through
			const outer = AppError.wrap(mid, { message: "service call" });
			expect(outer.toString()).toBe("service call: timeout");
		});

		it("handles deep chain", () => {
			const e1 = AppError.fail("a");
			const e2 = AppError.wrap(e1, { message: "b" });
			const e3 = AppError.wrap(e2, { message: "c" });
			expect(e3.toString()).toBe("c: b: a");
		});

		it("returns 'Internal Server Error' when entire chain has no message", () => {
			const err = new AppError();
			expect(err.toString()).toBe("Internal Server Error");
		});

		it("stops at non-Error cause", () => {
			const err = new AppError({ message: "wrap", cause: "string" });
			expect(err.toString()).toBe("wrap");
		});
	});

	// ── toJSON ─────────────────────────────────────────────────────

	describe("toJSON", () => {
		it("returns structured object without stack", () => {
			const err = AppError.fail("bad input", {
				status: 400,
				publicMessage: "Invalid request",
				fields: { field: "email" },
			});
			const json = err.toJSON();
			expect(json).toEqual({
				name: "AppError",
				message: "bad input",
				publicMessage: "Invalid request",
				status: 400,
				fields: { field: "email" },
			});
			expect(json).not.toHaveProperty("stack");
		});

		it("omits fields when undefined", () => {
			const err = AppError.fail("no fields");
			expect(err.toJSON()).not.toHaveProperty("fields");
		});

		it("includes cause as nested JSON when cause is AppError", () => {
			const inner = AppError.fail("inner", { status: 403 });
			const outer = AppError.wrap(inner, { message: "outer" });
			const json = outer.toJSON();
			expect(json.cause).toEqual({
				name: "AppError",
				message: "inner",
				publicMessage: "inner",
				status: 403,
			});
		});

		it("includes cause as {name, message, stack} when cause is plain Error", () => {
			const original = new TypeError("type mismatch");
			const err = AppError.wrap(original);
			const json = err.toJSON();
			expect((json.cause as Record<string, unknown>).name).toBe("TypeError");
			expect((json.cause as Record<string, unknown>).message).toBe("type mismatch");
			expect((json.cause as Record<string, unknown>).stack).toBe(original.stack);
		});

		it("includes raw cause for non-Error values", () => {
			const err = AppError.wrap("string cause");
			const json = err.toJSON();
			expect(json.cause).toBe("string cause");
		});

		it("omits cause when undefined", () => {
			const err = AppError.fail("no cause");
			expect(err.toJSON()).not.toHaveProperty("cause");
		});

		it("is used by JSON.stringify", () => {
			const err = AppError.fail("test", { status: 422 });
			const parsed = JSON.parse(JSON.stringify(err));
			expect(parsed.name).toBe("AppError");
			expect(parsed.status).toBe(422);
			expect(parsed.message).toBe("test");
		});
	});

	// ── is ────────────────────────────────────────────────────────

	describe("is", () => {
		class CustomError extends Error {
			code = "CUSTOM";
		}

		class OtherError extends Error {
			code = "OTHER";
		}

		it("returns the instance when err itself matches", () => {
			const err = new CustomError("direct");
			const found = AppError.is(err, CustomError);
			expect(found).toBe(err);
		});

		it("finds target in AppError cause chain", () => {
			const root = new CustomError("db conflict");
			const wrapped = AppError.wrap(root, { message: "save failed" });
			const found = AppError.is(wrapped, CustomError);
			expect(found).toBe(root);
			expect(found?.code).toBe("CUSTOM");
		});

		it("finds target deep in cause chain", () => {
			const root = new CustomError("deep");
			const mid = AppError.wrap(root);
			const outer = AppError.wrap(mid, { message: "top" });
			const found = AppError.is(outer, CustomError);
			expect(found).toBe(root);
		});

		it("returns undefined when target not in chain", () => {
			const err = AppError.wrap(new CustomError("x"));
			expect(AppError.is(err, OtherError)).toBeUndefined();
		});

		it("returns undefined for null/undefined", () => {
			expect(AppError.is(null, CustomError)).toBeUndefined();
			expect(AppError.is(undefined, CustomError)).toBeUndefined();
		});

		it("returns undefined for non-Error values", () => {
			expect(AppError.is("string", CustomError)).toBeUndefined();
		});

		it("can find AppError itself in chain", () => {
			const inner = AppError.fail("inner");
			const outer = new Error("outer");
			(outer as Error & { cause?: unknown }).cause = inner;
			const found = AppError.is(outer, AppError);
			expect(found).toBe(inner);
		});

		it("returns first match when multiple exist", () => {
			const first = new CustomError("first");
			const second = new CustomError("second");
			const mid = AppError.wrap(second);
			(first as Error & { cause?: unknown }).cause = mid;
			const found = AppError.is(first, CustomError);
			expect(found).toBe(first);
		});
	});
});
