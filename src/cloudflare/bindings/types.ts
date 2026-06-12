/**
 * Minimal Cloudflare binding type interfaces.
 *
 * Defined locally to avoid a runtime dependency on `@cloudflare/workers-types`.
 * These interfaces cover only the methods instrumented by the binding wrappers.
 */

/** KV value type options. */
export type KVGetType = "text" | "json" | "arrayBuffer" | "stream";

/** Options for KV `get` and `getWithMetadata`. */
export interface KVGetOptions {
	type?: KVGetType;
	cacheTtl?: number;
}

/** Result of `getWithMetadata`. */
export interface KVGetWithMetadataResult<Value, Metadata> {
	value: Value | null;
	metadata: Metadata | null;
}

/** Options for KV `put`. */
export interface KVPutOptions {
	expiration?: number;
	expirationTtl?: number;
	metadata?: unknown;
}

/** Options for KV `delete`. */
export interface KVDeleteOptions {
	prefix?: string;
}

/** Options for KV `list`. */
export interface KVListOptions {
	prefix?: string;
	limit?: number;
	cursor?: string;
}

/** Result of KV `list`. */
export interface KVListResult {
	keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
	list_complete: boolean;
	cursor?: string;
}

// ── D1 types ──────────────────────────────────────────────────────────────────

/** Result returned by D1 statement execution methods. */
export interface D1Result<T = unknown> {
	results: T[];
	success: boolean;
	meta: unknown;
}

/** Result returned by D1 `exec`. */
export interface D1ExecResult {
	count: number;
	duration: number;
}

/**
 * Minimal `D1PreparedStatement` interface covering methods wrapped by {@link instrumentD1}.
 *
 * Consumers may pass a real `D1PreparedStatement` (from `@cloudflare/workers-types`) —
 * structural typing ensures compatibility.
 */
export interface D1PreparedStatement {
	bind(...values: unknown[]): D1PreparedStatement;
	first<T = unknown>(colName?: string): Promise<T | null>;
	all<T = unknown>(): Promise<D1Result<T>>;
	run<T = unknown>(): Promise<D1Result<T>>;
	raw<T = unknown>(options?: { columnNames?: boolean }): Promise<T[]>;
}

/**
 * Minimal `D1Database` interface covering the methods wrapped by {@link instrumentD1}.
 *
 * Consumers may pass a real `D1Database` (from `@cloudflare/workers-types`) —
 * structural typing ensures compatibility.
 */
export interface D1Database {
	prepare(query: string): D1PreparedStatement;
	batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
	exec(query: string): Promise<D1ExecResult>;
	dump(): Promise<ArrayBuffer>;
}

// ── KV types ──────────────────────────────────────────────────────────────────

/**
 * Minimal `KVNamespace` interface covering the methods wrapped by {@link instrumentKV}.
 *
 * Consumers may pass a real `KVNamespace` (from `@cloudflare/workers-types`) —
 * structural typing ensures compatibility.
 */
export interface KVNamespace {
	get(key: string, options?: Partial<KVGetOptions> | KVGetType): Promise<string | null>;
	get<Value = unknown>(key: string, options: { type: "json" } | "json"): Promise<Value | null>;
	get(key: string, options: { type: "arrayBuffer" } | "arrayBuffer"): Promise<ArrayBuffer | null>;
	get(key: string, options: { type: "stream" } | "stream"): Promise<ReadableStream | null>;

	getWithMetadata<Metadata = unknown>(
		key: string,
		options?: Partial<KVGetOptions> | KVGetType,
	): Promise<KVGetWithMetadataResult<string, Metadata>>;
	getWithMetadata<Value = unknown, Metadata = unknown>(
		key: string,
		options: { type: "json" } | "json",
	): Promise<KVGetWithMetadataResult<Value, Metadata>>;
	getWithMetadata<Metadata = unknown>(
		key: string,
		options: { type: "arrayBuffer" } | "arrayBuffer",
	): Promise<KVGetWithMetadataResult<ArrayBuffer, Metadata>>;
	getWithMetadata<Metadata = unknown>(
		key: string,
		options: { type: "stream" } | "stream",
	): Promise<KVGetWithMetadataResult<ReadableStream, Metadata>>;

	put(
		key: string,
		value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
		options?: KVPutOptions,
	): Promise<void>;

	delete(key: string): Promise<void>;

	list(options?: KVListOptions): Promise<KVListResult>;
}
