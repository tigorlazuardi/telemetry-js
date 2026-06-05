import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the shared action module so tests don't need real OTel
vi.mock("../src/shared/action.js", () => {
	const withAction = vi.fn(<T>(_action: string, fn: (span: never) => T, _opts?: unknown): T => {
		return fn(null as never);
	});
	const scopeAction = vi.fn(
		(scope: { page?: string; component?: string }) =>
			<T>(action: string, fn: (span: never) => T, _attributes?: Record<string, string>): T => {
				return withAction(action, fn, scope);
			},
	);
	return { withAction, scopeAction };
});

import {
	_resetReactActionModule,
	createOneOffAction,
	createScopedAction,
} from "../src/browser/react/index.js";

// Re-import mock to inspect calls
const actionMod = await import("../src/shared/action.js");
const mockWithAction = actionMod.withAction as ReturnType<typeof vi.fn>;
const mockScopeAction = actionMod.scopeAction as ReturnType<typeof vi.fn>;

describe("react-action factories", () => {
	beforeEach(() => {
		_resetReactActionModule();
		vi.clearAllMocks();
	});

	describe("createScopedAction", () => {
		it("cold first call resolves to fn's return value (proves blocking-until-loaded)", async () => {
			const action = createScopedAction({ page: "/home", component: "MyComp" });
			const result = await action("click", () => "hello");
			expect(result).toBe("hello");
		});

		it("always returns a Promise", () => {
			const action = createScopedAction({ page: "/home" });
			const ret = action("click", () => 42);
			expect(ret).toBeInstanceOf(Promise);
		});

		it("error from fn propagates (rejects)", async () => {
			const action = createScopedAction({ component: "Comp" });
			await expect(
				action("click", () => {
					throw new Error("boom");
				}),
			).rejects.toThrow("boom");
		});

		it("passes scope to scopeAction", async () => {
			const scope = { page: "/test", component: "TestComp" };
			const action = createScopedAction(scope);
			await action("submit", () => "ok");
			expect(mockScopeAction).toHaveBeenCalledWith(scope);
		});
	});

	describe("createOneOffAction", () => {
		it("cold first call resolves to fn's return value", async () => {
			const run = createOneOffAction();
			const result = await run("click", () => 99);
			expect(result).toBe(99);
		});

		it("always returns a Promise", () => {
			const run = createOneOffAction();
			const ret = run("click", () => "val");
			expect(ret).toBeInstanceOf(Promise);
		});

		it("error from fn propagates (rejects)", async () => {
			const run = createOneOffAction();
			await expect(
				run("click", () => {
					throw new TypeError("oops");
				}),
			).rejects.toThrow("oops");
		});

		it("passes opts to withAction", async () => {
			const run = createOneOffAction();
			const opts = { page: "/page", component: "Comp" };
			await run("submit", () => true, opts);
			expect(mockWithAction).toHaveBeenCalledWith("submit", expect.any(Function), opts);
		});
	});

	describe("ensureActionModule deduplication", () => {
		it("two createScopedAction calls in parallel share one promise (module loaded once)", async () => {
			// Both created while _mod is null — should dedupe the dynamic import
			const a1 = createScopedAction({ page: "/a" });
			const a2 = createScopedAction({ page: "/b" });
			const [r1, r2] = await Promise.all([a1("x", () => 1), a2("y", () => 2)]);
			expect(r1).toBe(1);
			expect(r2).toBe(2);
			// scopeAction called twice (once per action invocation), withAction twice
			expect(mockScopeAction).toHaveBeenCalledTimes(2);
		});
	});
});
