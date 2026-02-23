import {
  type Span,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  ROOT_CONTEXT,
} from "@opentelemetry/api";

/**
 * Options for {@link withTrace}.
 */
export interface WithTraceOptions {
  /** Override auto-detected span name. */
  name?: string;
  /** Span kind (default: {@link SpanKind.INTERNAL}). */
  kind?: SpanKind;
  /** Initial span attributes. */
  attributes?: Record<string, string>;
  /**
   * Parent context — either an existing {@link Span} or a W3C `traceparent`
   * string (e.g. `"00-<traceId>-<spanId>-01"`).
   *
   * When omitted the current active context is inherited.
   */
  parent?: Span | string;
}

/**
 * Derive a human-readable span name for the given function.
 *
 * Resolution order:
 * 1. `fn.name` (works for named functions / methods)
 * 2. Parse `new Error().stack` for caller file:line
 * 3. Fallback `"anonymous"`
 */
function deriveSpanName(fn: (...args: never[]) => unknown): string {
  if (fn.name) return fn.name;

  const stack = new Error().stack;
  if (stack) {
    const lines = stack.split("\n");
    // Skip Error line, deriveSpanName frame, withTrace frame → caller is at index 3
    const callerLine = lines[3]?.trim();
    if (callerLine) {
      // Match "at <file>:<line>:<col>" or "at <name> (<file>:<line>:<col>)"
      const fileMatch = callerLine.match(/\((.+):(\d+):\d+\)/) ??
        callerLine.match(/at (.+):(\d+):\d+/);
      if (fileMatch) {
        const filePath = fileMatch[1];
        const line = fileMatch[2];
        const fileName = filePath.split("/").pop() ?? filePath;
        return `${fileName}:${line}`;
      }
    }
  }

  return "anonymous";
}

/**
 * Derive a tracer name from the call-site file or fall back to the package name.
 */
function deriveTracerName(): string {
  const stack = new Error().stack;
  if (stack) {
    const lines = stack.split("\n");
    const callerLine = lines[3]?.trim();
    if (callerLine) {
      const fileMatch = callerLine.match(/\((.+):\d+:\d+\)/) ??
        callerLine.match(/at (.+):\d+:\d+/);
      if (fileMatch) {
        const filePath = fileMatch[1];
        return filePath.split("/").pop() ?? "@tigorhutasuhut/telemetry-js";
      }
    }
  }
  return "@tigorhutasuhut/telemetry-js";
}

/**
 * Build the parent context from the `parent` option.
 */
function resolveParentContext(parent?: Span | string) {
  if (!parent) return context.active();

  if (typeof parent === "string") {
    return propagation.extract(ROOT_CONTEXT, { traceparent: parent });
  }

  // parent is a Span
  return trace.setSpan(context.active(), parent);
}

/**
 * Execute `fn` inside a new OpenTelemetry span, returning whatever `fn` returns.
 *
 * The span is automatically named from the function (or caller location) unless
 * overridden via `opts.name`. Errors are recorded on the span and re-thrown.
 *
 * **Cloudflare Workers caveat:** `performance.now()` only advances after I/O
 * in Workers (Spectre mitigation). Spans wrapping **pure CPU work** (no `fetch`,
 * KV, R2, D1, etc.) will report a duration of **0 ms**. Use `withTrace` for
 * operations that involve at least one I/O call.
 *
 * @param fn - The function to trace. Receives the active {@link Span} as its argument.
 * @param opts - Optional tracing configuration.
 * @returns The return value of `fn` (or a `Promise` thereof).
 *
 * @example
 * ```ts
 * import { withTrace } from "@tigorhutasuhut/telemetry-js";
 *
 * // Named function — span name is "fetchUser"
 * const user = await withTrace(async function fetchUser(span) {
 *   span.setAttribute("user.id", id);
 *   return db.users.find(id);
 * });
 *
 * // Explicit name + attributes
 * const result = withTrace(
 *   (span) => compute(span),
 *   { name: "heavy-computation", attributes: { "input.size": "42" } },
 * );
 * ```
 */
export function withTrace<T>(
  fn: (span: Span) => T,
  opts?: WithTraceOptions,
): T;
export function withTrace<T>(
  fn: (span: Span) => Promise<T>,
  opts?: WithTraceOptions,
): Promise<T>;
export function withTrace<T>(
  fn: (span: Span) => T | Promise<T>,
  opts?: WithTraceOptions,
): T | Promise<T> {
  const spanName = opts?.name ?? deriveSpanName(fn);
  const tracerName = deriveTracerName();
  const tracer = trace.getTracer(tracerName);
  const parentCtx = resolveParentContext(opts?.parent);

  return tracer.startActiveSpan(
    spanName,
    {
      kind: opts?.kind ?? SpanKind.INTERNAL,
      ...(opts?.attributes ? { attributes: opts.attributes } : {}),
    },
    parentCtx,
    (span: Span) => {
      let result: T | Promise<T>;
      try {
        result = fn(span);
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.recordException(error as Error);
        span.end();
        throw error;
      }

      if (result instanceof Promise) {
        return result.then(
          (value) => {
            span.end();
            return value;
          },
          (error: unknown) => {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : String(error),
            });
            span.recordException(error as Error);
            span.end();
            throw error;
          },
        ) as T | Promise<T>;
      }

      span.end();
      return result;
    },
  );
}
