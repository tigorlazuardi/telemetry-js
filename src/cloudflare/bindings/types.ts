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

// ── R2 types ──────────────────────────────────────────────────────────────────

/**
 * Minimal R2 object metadata interface (no body).
 * Structural alias for `R2Object` from `@cloudflare/workers-types`.
 */
export interface R2Object {
	key: string;
	version: string;
	size: number;
	etag: string;
	httpEtag: string;
	uploaded: Date;
	checksums: unknown;
	httpMetadata?: unknown;
	customMetadata?: Record<string, string>;
	range?: unknown;
	writeHttpMetadata?: (headers: Headers) => void;
}

/**
 * Minimal R2 object body interface — extends R2Object with a readable stream.
 *
 * The `body` stream MUST NOT be consumed by the instrumentation layer; it is
 * returned untouched to the caller so streaming semantics are preserved.
 */
export interface R2ObjectBody extends R2Object {
	body: ReadableStream;
	bodyUsed: boolean;
	arrayBuffer(): Promise<ArrayBuffer>;
	text(): Promise<string>;
	json<T = unknown>(): Promise<T>;
	blob(): Promise<Blob>;
}

/** Result of `R2Bucket.list`. */
export interface R2Objects {
	objects: R2Object[];
	truncated: boolean;
	cursor?: string;
	delimitedPrefixes: string[];
}

/** Minimal multipart upload handle — only used synchronously; no tracing needed. */
export interface R2MultipartUpload {
	key: string;
	uploadId: string;
	uploadPart(partNumber: number, value: unknown): Promise<unknown>;
	abort(): Promise<void>;
	complete(uploadedParts: unknown[]): Promise<R2Object>;
}

/**
 * Minimal `R2Bucket` interface covering the methods wrapped by {@link instrumentR2}.
 *
 * Consumers may pass a real `R2Bucket` (from `@cloudflare/workers-types`) —
 * structural typing ensures compatibility.
 */
export interface R2Bucket {
	get(key: string, options?: unknown): Promise<R2ObjectBody | null>;
	put(key: string, value: unknown, options?: unknown): Promise<R2Object>;
	head(key: string): Promise<R2Object | null>;
	delete(keys: string | string[]): Promise<void>;
	list(options?: unknown): Promise<R2Objects>;
	createMultipartUpload(key: string, options?: unknown): Promise<R2MultipartUpload>;
	resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
}

// ── Queue types ───────────────────────────────────────────────────────────────

/**
 * Minimal message send request for `Queue.sendBatch`.
 *
 * Structural alias for `MessageSendRequest` from `@cloudflare/workers-types`.
 */
export interface MessageSendRequest<Body = unknown> {
	body: Body;
	options?: unknown;
}

/**
 * Minimal `Queue` producer interface covering the methods wrapped by {@link instrumentQueue}.
 *
 * This covers only the **producer** side (`env.MY_QUEUE`). The consumer side is
 * handled separately by `instrument().queue` in `instrument.ts`.
 *
 * Consumers may pass a real `Queue` (from `@cloudflare/workers-types`) —
 * structural typing ensures compatibility.
 */
export interface Queue<Body = unknown> {
	send(message: Body, options?: unknown): Promise<void>;
	sendBatch(messages: Iterable<MessageSendRequest<Body>>, options?: unknown): Promise<void>;
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
