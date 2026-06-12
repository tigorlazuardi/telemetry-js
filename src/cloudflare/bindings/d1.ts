import { traceBinding } from "./trace-binding.js";
import type { D1Database, D1PreparedStatement, D1Result } from "./types.js";

// ── Symbol used to unwrap instrumented prepared statements ────────────────────

const RAW_STMT = Symbol("d1.raw_stmt");

/** @internal Retrieve the raw underlying statement from a wrapped proxy, if any. */
function unwrapStmt(stmt: D1PreparedStatement): D1PreparedStatement {
	const raw = (stmt as unknown as Record<symbol, D1PreparedStatement>)[RAW_STMT];
	return raw ?? stmt;
}

// ── SQL verb extraction ───────────────────────────────────────────────────────

/**
 * Extract the first SQL keyword from a query string.
 *
 * Strips leading whitespace and single-line (`--`) / block (`/* ... *\/`) comments
 * minimally, then uppercases the first word. Falls back to `"QUERY"` if none found.
 *
 * The result is used as the metric `operation` label — it must be bounded (low cardinality).
 */
export function sqlVerb(sql: string): string {
	// Strip leading block comments /* ... */ and line comments --
	let s = sql.trimStart();
	// Remove leading block comments
	while (s.startsWith("/*")) {
		const end = s.indexOf("*/");
		if (end === -1) break;
		s = s.slice(end + 2).trimStart();
	}
	// Remove leading line comments
	while (s.startsWith("--")) {
		const nl = s.indexOf("\n");
		if (nl === -1) {
			s = "";
			break;
		}
		s = s.slice(nl + 1).trimStart();
	}
	const match = /^([A-Za-z]+)/.exec(s);
	return match ? match[1].toUpperCase() : "QUERY";
}

// ── Prepared statement wrapper ────────────────────────────────────────────────

/**
 * Wrap a raw `D1PreparedStatement` so that terminal ops (`first`, `all`, `run`, `raw`)
 * each emit exactly one tracing span, and `bind()` chains correctly carrying the
 * original SQL for the span name and `db.statement` attribute.
 *
 * The raw underlying statement is stored on `RAW_STMT` so that `instrumentD1`'s
 * `batch()` handler can unwrap proxies before passing them to the real D1 API.
 */
function wrapStatement(
	raw: D1PreparedStatement,
	sql: string,
	bindingName: string,
): D1PreparedStatement {
	const TERMINAL_OPS = new Set<string>(["first", "all", "run", "raw"]);

	const proxy = new Proxy(raw, {
		get(target, prop, receiver) {
			// Expose raw statement for batch() unwrapping
			if (prop === RAW_STMT) {
				return target;
			}

			const value = Reflect.get(target, prop, receiver);

			if (typeof prop !== "string") {
				return value;
			}

			// bind() — chainable, no span, carry sql forward
			if (prop === "bind") {
				return (...values: unknown[]) => {
					const bound = (value as (...a: unknown[]) => D1PreparedStatement).apply(target, values);
					return wrapStatement(bound, sql, bindingName);
				};
			}

			// Terminal ops — emit a span
			if (TERMINAL_OPS.has(prop) && typeof value === "function") {
				const method = prop as "first" | "all" | "run" | "raw";
				return (...args: unknown[]) => {
					const verb = sqlVerb(sql);
					return traceBinding(
						{
							bindingType: "d1",
							bindingName,
							operation: verb,
							attributes: {
								"db.system": "cloudflare-d1",
								"db.statement": sql,
								"db.operation": verb,
								"db.cloudflare.method": method,
							},
						},
						() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args),
					);
				};
			}

			// Everything else passes through
			if (typeof value === "function") {
				return (value as (...a: unknown[]) => unknown).bind(target);
			}
			return value;
		},
	});

	return proxy;
}

// ── Database wrapper ──────────────────────────────────────────────────────────

/**
 * Wrap a `D1Database` binding with OpenTelemetry tracing and metrics.
 *
 * Returns a transparent `Proxy<T>` assignment-compatible with the original type.
 *
 * - `prepare(sql)` → wraps the returned statement; no span at prepare (no I/O).
 * - `batch(stmts)` → one span `D1 <name> BATCH`; unwraps any instrumented stmts.
 * - `exec(sql)` → one span `D1 <name> <VERB>`.
 * - `dump()` → passes through untraced (admin/rare).
 *
 * @param db   - The original `D1Database` to instrument.
 * @param name - Binding name used in span names and metric labels (e.g. `"DB"`).
 * @returns A `Proxy<T>` with identical type.
 *
 * @example
 * ```ts
 * import { instrumentD1 } from "@tigorhutasuhut/telemetry-js/cloudflare";
 *
 * export default {
 *   async fetch(request, env, ctx) {
 *     const db = instrumentD1(env.DB, "DB");
 *     const row = await db.prepare("SELECT * FROM users WHERE id = ?").bind(1).first();
 *     return Response.json(row);
 *   },
 * };
 * ```
 */
export function instrumentD1<T extends D1Database>(db: T, name: string): T {
	return new Proxy(db, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);

			if (typeof prop !== "string") {
				return value;
			}

			// prepare — wrap returned statement, no span
			if (prop === "prepare") {
				return (sql: string) => {
					const raw = (value as (s: string) => D1PreparedStatement).call(target, sql);
					return wrapStatement(raw, sql, name);
				};
			}

			// batch — unwrap any instrumented statements, one span
			if (prop === "batch") {
				return (stmts: D1PreparedStatement[]) => {
					const unwrapped = stmts.map(unwrapStmt);
					return traceBinding(
						{
							bindingType: "d1",
							bindingName: name,
							operation: "BATCH",
							attributes: {
								"db.system": "cloudflare-d1",
								"db.operation": "BATCH",
								"db.cloudflare.batch_size": unwrapped.length,
							},
						},
						() =>
							(value as (s: D1PreparedStatement[]) => Promise<D1Result[]>).call(target, unwrapped),
					);
				};
			}

			// exec — one span with SQL verb
			if (prop === "exec") {
				return (sql: string) => {
					const verb = sqlVerb(sql);
					return traceBinding(
						{
							bindingType: "d1",
							bindingName: name,
							operation: verb,
							attributes: {
								"db.system": "cloudflare-d1",
								"db.statement": sql,
								"db.operation": verb,
								"db.cloudflare.method": "exec",
							},
						},
						() => (value as (s: string) => Promise<unknown>).call(target, sql),
					);
				};
			}

			// dump + everything else — pass through
			if (typeof value === "function") {
				return (value as (...a: unknown[]) => unknown).bind(target);
			}
			return value;
		},
	});
}
