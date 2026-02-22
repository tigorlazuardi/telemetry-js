import { context, trace, type SpanContext } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { LogAttributes, LogLevel, LogOptions, Logger } from "./types.js";

const SEVERITY: Record<LogLevel, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

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
  serviceName: string,
  level: LogLevel,
  message: string,
  attrs?: LogAttributes,
  opts?: LogOptions,
): void {
  try {
    const logger = logs.getLogger(serviceName);
    const spanCtx = resolveSpanContext(opts);
    logger.emit({
      severityNumber: SEVERITY[level],
      severityText: level.toUpperCase(),
      body: message,
      attributes: attrs as Record<string, string | number | boolean>,
      timestamp: opts?.timestamp ? [Math.floor(opts.timestamp / 1000), (opts.timestamp % 1000) * 1_000_000] : undefined,
      ...(spanCtx ? { context: trace.setSpanContext(context.active(), spanCtx) } : {}),
    });
  } catch {
    // Never throw from logger
  }
}

/** Format a log record as a JSON string for stderr output. */
function formatJson(
  level: LogLevel,
  message: string,
  serviceName: string,
  attrs?: LogAttributes,
  opts?: LogOptions,
): string {
  const spanCtx = resolveSpanContext(opts);
  const record: Record<string, unknown> = {
    level,
    time: opts?.timestamp ?? Date.now(),
    msg: message,
    service: serviceName,
  };
  if (spanCtx) {
    record.traceId = spanCtx.traceId;
    record.spanId = spanCtx.spanId;
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined) record[k] = v;
    }
  }
  return JSON.stringify(record);
}

/** Try to load pino. Returns the pino factory or undefined. */
function tryLoadPino(): unknown {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
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

// ANSI color codes for TTY pretty-printing
const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m",  // green
  warn: "\x1b[33m",  // yellow
  error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";

/** Pretty-print a log line for TTY stderr output (Node without pino). */
function formatPretty(
  level: LogLevel,
  message: string,
  serviceName: string,
  attrs?: LogAttributes,
  opts?: LogOptions,
): string {
  const spanCtx = resolveSpanContext(opts);
  const ts = new Date(opts?.timestamp ?? Date.now()).toISOString();
  const color = COLORS[level];
  let line = `${color}${level.toUpperCase().padEnd(5)}${RESET} ${ts} [${serviceName}] ${message}`;
  if (spanCtx) {
    line += ` traceId=${spanCtx.traceId} spanId=${spanCtx.spanId}`;
  }
  if (attrs) {
    const pairs = Object.entries(attrs)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    if (pairs) line += ` ${pairs}`;
  }
  return line;
}

type StderrWriter = (level: LogLevel, message: string, attrs?: LogAttributes, opts?: LogOptions) => void;

/** Build a stderr writer backed by pino. */
function createPinoWriter(
  pinoFactory: (...args: unknown[]) => unknown,
  serviceName: string,
): StderrWriter {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let pinoLogger: any;
    if (isTTY()) {
      pinoLogger = pinoFactory(
        { name: serviceName, level: "debug" },
        // pino transport for pretty-printing to stderr
        (pinoFactory as unknown as { destination: (fd: number) => unknown }).destination?.(2)
          ?? process.stderr,
      );
    } else {
      pinoLogger = pinoFactory({ name: serviceName, level: "debug" }, process.stderr);
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
function createBuiltinNodeWriter(serviceName: string): StderrWriter {
  return (level, message, attrs, opts) => {
    try {
      const line = isTTY()
        ? formatPretty(level, message, serviceName, attrs, opts)
        : formatJson(level, message, serviceName, attrs, opts);
      process.stderr.write(line + "\n");
    } catch {
      // Never throw
    }
  };
}

/** Build a stderr writer using console (Cloudflare Workers). */
function createConsoleWriter(serviceName: string): StderrWriter {
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
 * Create a structured {@link Logger} for the given service.
 *
 * Dual output:
 * 1. **Stderr** — pino (Node + pino installed), built-in formatter (Node without pino),
 *    or `console[level]` (Cloudflare Workers).
 * 2. **OTLP** — emits via the global `LoggerProvider` if one is registered.
 *
 * Every method is wrapped in try-catch — **never throws**.
 */
export function createLogger(serviceName: string): Logger {
  let stderrWriter: StderrWriter;

  if (isNode()) {
    const pino = tryLoadPino();
    if (typeof pino === "function") {
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
    debug: (msg, attrs, opts) => { try { log("debug", msg, attrs, opts); } catch { /* */ } },
    info: (msg, attrs, opts) => { try { log("info", msg, attrs, opts); } catch { /* */ } },
    warn: (msg, attrs, opts) => { try { log("warn", msg, attrs, opts); } catch { /* */ } },
    error: (msg, attrs, opts) => { try { log("error", msg, attrs, opts); } catch { /* */ } },
  };
}
