import { context, type SpanContext, trace } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { LogAttributes, Logger, LogLevel, LogOptions } from "./types.js";

type JsonObject = Record<string, unknown>;
type JsonHighlighter = (json: string) => string;

const ANSI = {
	reset: "\u001B[0m",
	dim: "\u001B[2m",
	gray: "\u001B[90m",
	cyan: "\u001B[36m",
	green: "\u001B[32m",
	yellow: "\u001B[33m",
	red: "\u001B[31m",
} as const;

let _jsonHighlighter: JsonHighlighter | null | undefined;
let _jsonHighlighterPromise: Promise<JsonHighlighter | null> | undefined;

const SEVERITY: Record<LogLevel, SeverityNumber> = {
	debug: SeverityNumber.DEBUG,
	info: SeverityNumber.INFO,
	warn: SeverityNumber.WARN,
	error: SeverityNumber.ERROR,
};

/* ------------------------------------------------------------------ */
/*  Logger context (AsyncLocalStorage or module-level fallback)       */
/* ------------------------------------------------------------------ */

/** Minimal interface matching the AsyncLocalStorage API we need. */
export interface LoggerStorage<T> {
	getStore(): T | undefined;
	run<R>(store: T, fn: () => R): R;
}

let _loggerStorage: LoggerStorage<Logger> | null = null;

/**
 * Provide an {@link AsyncLocalStorage} (or compatible) instance for
 * logger context propagation. Called by runtime adapters during setup.
 *
 * In browsers (where `AsyncLocalStorage` is unavailable) this is never
 * called, and the logger falls back to a module-level variable.
 */
export function setLoggerStorage(storage: LoggerStorage<Logger>): void {
	_loggerStorage = storage;
}

/** Fallback context-scoped logger for runtimes without AsyncLocalStorage. */
let _contextLogger: Logger | undefined;

/** Default logger used when no context-scoped logger exists. */
let _defaultLogger: Logger | undefined;

/**
 * Return the logger stored in the current {@link AsyncLocalStorage} context.
 * Falls back to the default logger set via {@link setDefaultLogger},
 * or a freshly created logger if no default has been set.
 *
 * This is the **recommended** way to obtain a logger in application code —
 * it lets frameworks inject a pre-configured logger via {@link runWithLogger}
 * without threading it through every function signature.
 */
export function getLogger(): Logger {
	return _loggerStorage?.getStore() ?? _contextLogger ?? _defaultLogger ?? createLogger();
}

/**
 * Execute {@link fn} with {@link logger} bound to the
 * current async context so that every nested {@link getLogger}
 * call returns it.
 *
 * Uses `AsyncLocalStorage` on Node.js / Cloudflare Workers.
 * In browsers (where `AsyncLocalStorage` is unavailable) the logger
 * is stored in a module-level variable for the duration of {@link fn}.
 */
export function runWithLogger<T>(logger: Logger, fn: () => T): T {
	if (_loggerStorage) {
		return _loggerStorage.run(logger, fn);
	}
	// Fallback for browsers: simple module-level swap
	const prev = _contextLogger;
	_contextLogger = logger;
	try {
		return fn();
	} finally {
		_contextLogger = prev;
	}
}

/**
 * Set the default logger returned by {@link getLogger} when no
 * context-scoped logger is present. Typically called once during
 * SDK initialisation.
 */
export function setDefaultLogger(logger: Logger): void {
	_defaultLogger = logger;
}

/** Resolve span context from options, or from the currently active span. */
function resolveSpanContext(opts?: LogOptions): SpanContext | undefined {
	if (opts?.spanContext) return opts.spanContext;
	const span = trace.getSpan(context.active());
	if (span) {
		const ctx = span.spanContext();
		if (ctx.traceId && ctx.traceId !== "00000000000000000000000000000000") {
			return ctx;
		}
	}
	return undefined;
}

/** Emit a log record to the global OTLP LoggerProvider (no-op if none registered). */
function emitOtlp(
	serviceName: string | undefined,
	level: LogLevel,
	message: string,
	attrs?: LogAttributes,
	opts?: LogOptions,
): void {
	try {
		const logger = logs.getLogger(serviceName ?? "");
		const spanCtx = resolveSpanContext(opts);
		const otlpAttrs: Record<string, string | number | boolean> = {};
		if (attrs) {
			for (const [key, value] of Object.entries(attrs)) {
				const normalized = normalizeOtlpAttributeValue(value);
				if (normalized !== undefined) otlpAttrs[key] = normalized;
			}
		}
		logger.emit({
			severityNumber: SEVERITY[level],
			severityText: level.toUpperCase(),
			body: message,
			attributes: otlpAttrs,
			timestamp: opts?.timestamp
				? [Math.floor(opts.timestamp / 1000), (opts.timestamp % 1000) * 1_000_000]
				: undefined,
			...(spanCtx ? { context: trace.setSpanContext(context.active(), spanCtx) } : {}),
		});
	} catch {
		// Never throw from logger
	}
}

function safeJsonStringify(value: unknown, space?: number): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(
		value,
		(_key, currentValue) => {
			if (currentValue instanceof Error) {
				const maybeJson = currentValue as Error & { toJSON?: () => unknown };
				const json = typeof maybeJson.toJSON === "function" ? maybeJson.toJSON() : undefined;
				if (json !== undefined) return json;
				return {
					...currentValue,
					name: currentValue.name,
					message: currentValue.message,
					stack: currentValue.stack,
				};
			}

			if (typeof currentValue === "bigint") return currentValue.toString();

			if (currentValue && typeof currentValue === "object") {
				if (seen.has(currentValue)) return "[Circular]";
				seen.add(currentValue);
			}

			return currentValue;
		},
		space,
	);
}

function normalizeOtlpAttributeValue(value: unknown): string | number | boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (value === null) return "null";
	return safeJsonStringify(value);
}

function loadJsonHighlighter(): Promise<JsonHighlighter | null> {
	if (_jsonHighlighterPromise) return _jsonHighlighterPromise;

	const specifier = "cli-highlight";
	_jsonHighlighterPromise = import(/* @vite-ignore */ specifier)
		.then((mod) => {
			const highlight = (mod as { highlight?: unknown }).highlight;
			if (typeof highlight === "function") {
				_jsonHighlighter = (json) =>
					(highlight as (code: string, options?: Record<string, unknown>) => string)(json, {
						language: "json",
						ignoreIllegals: true,
					});
				return _jsonHighlighter;
			}

			_jsonHighlighter = null;
			return _jsonHighlighter;
		})
		.catch(() => {
			// Optional dependency absent or unavailable in current runtime.
			_jsonHighlighter = null;
			return _jsonHighlighter;
		})
		.finally(() => {
			_jsonHighlighterPromise = undefined;
		});

	return _jsonHighlighterPromise;
}

/**
 * Lazily load optional JSON syntax highlighting for TTY pretty output.
 *
 * This is intentionally Node-only and best-effort so Cloudflare/Wrangler
 * runtimes never depend on Node-specific or optional colorizing packages.
 * The first TTY log may render without colors while the highlighter loads.
 */
function tryLoadJsonHighlighter(): JsonHighlighter | null {
	if (_jsonHighlighter !== undefined) return _jsonHighlighter;
	if (!isNode() || !isTTY()) {
		_jsonHighlighter = null;
		return _jsonHighlighter;
	}

	void loadJsonHighlighter();
	return null;
}

function collectLogFields(spanCtx: SpanContext | undefined, attrs?: LogAttributes): JsonObject {
	const fields: JsonObject = {};
	if (spanCtx) {
		fields.traceId = spanCtx.traceId;
		fields.spanId = spanCtx.spanId;
	}
	if (attrs) {
		for (const [key, value] of Object.entries(attrs)) {
			if (value !== undefined) fields[key] = value;
		}
	}
	return fields;
}

function formatPrettyDetails(fields: JsonObject): string | undefined {
	const details = safeJsonStringify(fields, 2);
	if (details === "{}") return undefined;

	const highlightJson = tryLoadJsonHighlighter();
	if (!highlightJson) return details;

	try {
		return highlightJson(details);
	} catch {
		return details;
	}
}

/** Format a log record as a JSON string for stderr output. */
function formatJson(
	level: LogLevel,
	message: string,
	serviceName: string | undefined,
	attrs?: LogAttributes,
	opts?: LogOptions,
): string {
	const spanCtx = resolveSpanContext(opts);
	const record: Record<string, unknown> = {
		level,
		time: opts?.timestamp ?? Date.now(),
		msg: message,
		...(serviceName ? { service: serviceName } : {}),
	};
	Object.assign(record, collectLogFields(spanCtx, attrs));
	return safeJsonStringify(record);
}

/** Try to load pino. Returns the pino factory or undefined. */
function tryLoadPino(): unknown {
	try {
		return require("pino");
	} catch {
		return undefined;
	}
}

/** Check if we're running in Node.js. */
function isNode(): boolean {
	return typeof process !== "undefined" && !!process.versions?.node;
}

/** Check if stderr is a TTY (Node only). */
function isTTY(): boolean {
	try {
		return typeof process !== "undefined" && !!process.stderr?.isTTY;
	} catch {
		return false;
	}
}

/** Pretty-print a log line for TTY stderr output (Node without pino). */
function formatPretty(
	level: LogLevel,
	message: string,
	serviceName: string | undefined,
	attrs?: LogAttributes,
	opts?: LogOptions,
): string {
	const spanCtx = resolveSpanContext(opts);
	const ts = new Date(opts?.timestamp ?? Date.now()).toISOString();
	const colorize = (color: string, text: string) => `${color}${text}${ANSI.reset}`;
	const levelLabel = `[${level.toUpperCase()}]`;
	const coloredLevel =
		level === "error"
			? colorize(ANSI.red, levelLabel)
			: level === "warn"
				? colorize(ANSI.yellow, levelLabel)
				: level === "info"
					? colorize(ANSI.green, levelLabel)
					: colorize(ANSI.gray, levelLabel);
	const header = [
		coloredLevel,
		colorize(ANSI.dim, `[${ts}]`),
		...(serviceName ? [colorize(ANSI.cyan, `[${serviceName}]`)] : []),
		message,
	].join(" ");
	const fields = collectLogFields(spanCtx, attrs);
	const details = formatPrettyDetails(fields);
	return details ? `${header}\n${details}` : header;
}

type StderrWriter = (
	level: LogLevel,
	message: string,
	attrs?: LogAttributes,
	opts?: LogOptions,
) => void;

/** Build a stderr writer backed by pino. */
function createPinoWriter(
	pinoFactory: (...args: unknown[]) => unknown,
	serviceName: string | undefined,
): StderrWriter {
	try {
		let pinoLogger: any;
		const pinoOpts: Record<string, unknown> = { level: "debug" };
		if (serviceName) pinoOpts.name = serviceName;
		if (isTTY()) {
			pinoLogger = pinoFactory(
				pinoOpts,
				// pino transport for pretty-printing to stderr
				(pinoFactory as unknown as { destination: (fd: number) => unknown }).destination?.(2) ??
					process.stderr,
			);
		} else {
			pinoLogger = pinoFactory(pinoOpts, process.stderr);
		}

		return (level, message, attrs, opts) => {
			try {
				const spanCtx = resolveSpanContext(opts);
				const extra: Record<string, unknown> = {};
				if (spanCtx) {
					extra.traceId = spanCtx.traceId;
					extra.spanId = spanCtx.spanId;
				}
				if (attrs) {
					for (const [k, v] of Object.entries(attrs)) {
						if (v !== undefined) extra[k] = v;
					}
				}
				pinoLogger[level](extra, message);
			} catch {
				// Never throw
			}
		};
	} catch {
		// Fall back to built-in writer if pino setup fails
		return createBuiltinNodeWriter(serviceName);
	}
}

/** Build a stderr writer using process.stderr.write (Node without pino). */
function createBuiltinNodeWriter(serviceName: string | undefined): StderrWriter {
	return (level, message, attrs, opts) => {
		try {
			const line = isTTY()
				? formatPretty(level, message, serviceName, attrs, opts)
				: formatJson(level, message, serviceName, attrs, opts);
			process.stderr.write(isTTY() ? `${line}\n\n` : `${line}\n`);
		} catch {
			// Never throw
		}
	};
}

/** Build a stderr writer using console (Cloudflare Workers). */
function createConsoleWriter(serviceName: string | undefined): StderrWriter {
	return (level, message, attrs, opts) => {
		try {
			const json = formatJson(level, message, serviceName, attrs, opts);
			console[level](json);
		} catch {
			// Never throw
		}
	};
}

/**
 * Create a structured {@link Logger}.
 *
 * @param serviceName - Optional service name included in log output.
 *   When omitted the OTLP exporter's resource attributes (e.g.
 *   `service.name`) are used instead — this is the recommended approach
 *   so that the service name is configured in a single place.
 *
 * Dual output:
 * 1. **Stderr** — built-in pretty formatter on TTY, pino for non-TTY Node.js when installed,
 *    otherwise the built-in JSON formatter, or `console[level]` (Cloudflare Workers).
 * 2. **OTLP** — emits via the global `LoggerProvider` if one is registered.
 *
 * Every method is wrapped in try-catch — **never throws**.
 */
export function createLogger(serviceName?: string): Logger {
	let stderrWriter: StderrWriter;

	if (isNode()) {
		const pino = tryLoadPino();
		if (!isTTY() && typeof pino === "function") {
			stderrWriter = createPinoWriter(pino as (...args: unknown[]) => unknown, serviceName);
		} else {
			stderrWriter = createBuiltinNodeWriter(serviceName);
		}
	} else {
		stderrWriter = createConsoleWriter(serviceName);
	}

	function log(level: LogLevel, message: string, attrs?: LogAttributes, opts?: LogOptions): void {
		try {
			stderrWriter(level, message, attrs, opts);
		} catch {
			// Never throw
		}
		emitOtlp(serviceName, level, message, attrs, opts);
	}

	return {
		debug: (msg, attrs, opts) => {
			try {
				log("debug", msg, attrs, opts);
			} catch {
				/* */
			}
		},
		info: (msg, attrs, opts) => {
			try {
				log("info", msg, attrs, opts);
			} catch {
				/* */
			}
		},
		warn: (msg, attrs, opts) => {
			try {
				log("warn", msg, attrs, opts);
			} catch {
				/* */
			}
		},
		error: (msg, attrs, opts) => {
			try {
				log("error", msg, attrs, opts);
			} catch {
				/* */
			}
		},
	};
}
