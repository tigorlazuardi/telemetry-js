import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
  type TextMapGetter,
  type TextMapSetter,
} from "@opentelemetry/api";
import type { SDKConfig, SDKResult } from "../../types.js";
import { initSDK } from "../../sdk.js";

// Minimal CF types to avoid @cloudflare/workers-types dependency
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  /** For compatibility with Wrangler 4.x. */
  props: unknown;
}

/** Minimal context for {@link traceHandler} — only `waitUntil` is required. */
export interface MinimalExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface ScheduledController {
  scheduledTime: number;
  cron: string;
  noRetry(): void;
}

interface MessageBatch<T = unknown> {
  readonly queue: string;
  readonly messages: readonly Message<T>[];
  ackAll(): void;
  retryAll(options?: MessageRetryOptions): void;
}

interface Message<T = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: T;
  readonly attempts: number;
  ack(): void;
  retry(options?: MessageRetryOptions): void;
}

interface MessageRetryOptions {
  delaySeconds?: number;
}

type FetchHandler<Env = unknown> = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

type ScheduledHandler<Env = unknown> = (
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
) => void | Promise<void>;

type QueueHandler<Env = unknown, T = unknown> = (
  batch: MessageBatch<T>,
  env: Env,
  ctx: ExecutionContext,
) => void | Promise<void>;

interface ExportedHandler<Env = unknown> {
  fetch?: FetchHandler<Env>;
  scheduled?: ScheduledHandler<Env>;
  queue?: QueueHandler<Env>;
}

/**
 * Options for {@link instrument}. Extends {@link SDKConfig} (minus `runtime`).
 */
export interface InstrumentOptions extends Omit<SDKConfig, "runtime"> { }

let sdkResult: SDKResult | null = null;

export function ensureSDK(config: Omit<SDKConfig, "runtime">): SDKResult {
  if (!sdkResult) {
    sdkResult = initSDK({ ...config, runtime: "cloudflare-worker" });
  }
  return sdkResult;
}

function flush(): Promise<void> {
  if (!sdkResult) return Promise.resolve();
  return sdkResult.forceFlush();
}

/**
 * Options for {@link traceHandler}.
 */
export interface TraceHandlerOptions<T = Response> extends InstrumentOptions {
  /** Execution context — only `waitUntil` is required. Pass `undefined` during SSG/prerender. */
  context: MinimalExecutionContext | undefined;
  /** Environment variable map forwarded to the SDK. */
  env: Record<string, string | undefined>;
  /** The incoming `Request` to trace. */
  request: Request;
  /** The handler to call inside the traced span. */
  handler: () => T | Promise<T>;
  /** Optional callback invoked via `ctx.waitUntil` after the span ends. */
  onFlush?: () => void;
}

const headerGetter: TextMapGetter<Headers> = {
  keys(carrier) {
    return [...carrier.keys()];
  },
  get(carrier, key) {
    return carrier.get(key) ?? undefined;
  },
};

const headerSetter: TextMapSetter<Headers> = {
  set(carrier, key, value) {
    carrier.set(key, value);
  },
};

/**
 * Trace a single fetch-style request.
 *
 * Creates a `SERVER` span, propagates incoming W3C trace context
 * (`traceparent`/`tracestate`) from `request` headers, and injects
 * trace context into the response headers.
 *
 * Use this directly in frameworks (e.g. SvelteKit hooks) that provide
 * `Request` + `ExecutionContext` but not the full `ExportedHandler` pattern.
 *
 * @example
 * ```ts
 * import { traceHandler } from "@tigorhutasuhut/telemetry-js";
 *
 * export async function handle({ event, resolve }) {
 *   return traceHandler({
 *     serviceName: "my-sveltekit-app",
 *     context: event.platform?.ctx,
 *     env: event.platform?.env ?? {},
 *     request: event.request,
 *     handler: () => resolve(event),
 *   });
 * }
 * ```
 */
export async function traceHandler<T = Response>(
  opts: TraceHandlerOptions<T>,
): Promise<T> {
  const { context: ctx, env, request, handler, onFlush, ...sdkOpts } = opts;
  ensureSDK({ ...sdkOpts, env });
  const tracer = trace.getTracer(opts.serviceName ?? "unknown");
  const url = new URL(request.url);
  const extractedCtx = propagation.extract(
    context.active(),
    request.headers,
    headerGetter,
  );
  let span: Span | undefined;

  try {
    const result = await tracer.startActiveSpan(
      `${request.method} ${url.pathname}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "http.method": request.method,
          "http.url": request.url,
          "http.target": url.pathname + url.search,
          "http.host": url.host,
        },
      },
      extractedCtx,
      async (s) => {
        span = s;
        const res = await handler();
        if (res instanceof Response) {
          span.setAttribute("http.status_code", res.status);
          if (res.status >= 500) {
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
        }
        return res;
      },
    );

    // Inject trace context into response headers when the result is a Response
    if (result instanceof Response) {
      const newResponse = new Response(result.body, result);
      propagation.inject(context.active(), newResponse.headers, headerSetter);
      return newResponse as T;
    }

    return result;
  } catch (error) {
    span?.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    span?.recordException(error as Error);
    throw error;
  } finally {
    span?.end();
    ctx?.waitUntil(onFlush?.() ?? Promise.resolve());
  }
}

/**
 * Wrap a Cloudflare Worker handler with OpenTelemetry instrumentation.
 *
 * Each incoming `fetch`, `scheduled`, or `queue` event is traced as a span.
 * Spans are flushed via `ctx.waitUntil` so they don't block the response.
 *
 * @param handler - The original Cloudflare Worker `ExportedHandler` to instrument.
 * @param opts - SDK configuration options.
 * @returns A new `ExportedHandler` that traces every event.
 *
 * @example
 * ```ts
 * import { instrument } from "@tigorhutasuhut/telemetry-js";
 *
 * export default instrument({
 *   async fetch(request, env, ctx) {
 *     return new Response("Hello");
 *   },
 * });
 * ```
 */
export function instrument<Env = unknown>(
  handler: ExportedHandler<Env>,
  opts?: InstrumentOptions,
): ExportedHandler<Env> {
  const sdkConfig = opts ?? {};
  const result: ExportedHandler<Env> = {};

  if (handler.fetch) {
    const originalFetch = handler.fetch;
    result.fetch = async (
      request: Request,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<Response> => {
      const ee = sdkConfig.env || env || {}
      return traceHandler({
        ...sdkConfig,
        context: ctx,
        env: ee,
        request,
        serviceName: sdkConfig.serviceName ?? "unknown",
        handler: () => originalFetch(request, env, ctx),
        onFlush: () => flush(),
      });
    };
  }

  if (handler.scheduled) {
    const originalScheduled = handler.scheduled;
    result.scheduled = async (
      controller: ScheduledController,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<void> => {
      ensureSDK(sdkConfig);
      const tracer = trace.getTracer(sdkConfig.serviceName ?? "unknown");
      let span: Span | undefined;

      try {
        await tracer.startActiveSpan(
          `scheduled ${controller.cron}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              "faas.trigger": "timer",
              "faas.cron": controller.cron,
              "faas.time": new Date(
                controller.scheduledTime,
              ).toISOString(),
            },
          },
          async (s) => {
            span = s;
            await originalScheduled(controller, env, ctx);
          },
        );
      } catch (error) {
        span?.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span?.recordException(error as Error);
        throw error;
      } finally {
        span?.end();
        ctx.waitUntil(flush());
      }
    };
  }

  if (handler.queue) {
    const originalQueue = handler.queue;
    result.queue = async (
      batch: MessageBatch,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<void> => {
      ensureSDK(sdkConfig);
      const tracer = trace.getTracer(sdkConfig.serviceName ?? "unknown");
      let span: Span | undefined;

      try {
        await tracer.startActiveSpan(
          `queue ${batch.queue}`,
          {
            kind: SpanKind.CONSUMER,
            attributes: {
              "faas.trigger": "pubsub",
              "messaging.system": "cloudflare",
              "messaging.destination": batch.queue,
              "messaging.batch.message_count": batch.messages.length,
            },
          },
          async (s) => {
            span = s;
            await originalQueue(batch, env, ctx);
          },
        );
      } catch (error) {
        span?.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span?.recordException(error as Error);
        throw error;
      } finally {
        span?.end();
        ctx.waitUntil(flush());
      }
    };
  }

  return result;
}

/**
 * Reset internal SDK state (for testing).
 * @internal
 */
export function _resetInstrumentState(): void {
  sdkResult = null;
}
