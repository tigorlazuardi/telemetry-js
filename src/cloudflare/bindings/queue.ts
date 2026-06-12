import { SpanKind } from "@opentelemetry/api";
import { traceBinding } from "./trace-binding.js";
import type { MessageSendRequest, Queue } from "./types.js";

/**
 * Wrap a `Queue` producer binding with OpenTelemetry tracing and metrics.
 *
 * Returns a transparent `Proxy<T>` so the wrapped value is assignment-compatible
 * with the original binding type. Every call to `send` or `sendBatch` opens a
 * child span (when inside a traced request) and records a
 * `cloudflare.binding.operation.duration` histogram data point.
 *
 * Spans use {@link SpanKind.PRODUCER} to reflect the messaging semantics.
 * The consumer side (queue handler) is already handled by `instrument().queue`
 * in `instrument.ts` — this wrapper covers only the producer (`env.MY_QUEUE`).
 *
 * For `sendBatch`, the `messages` iterable is materialised into an array before
 * calling the real method. This is necessary to count the messages without
 * draining a one-shot generator, and arrays are safe to pass to `sendBatch`.
 *
 * @param q    - The original `Queue` producer binding to instrument.
 * @param name - Human-readable name for this binding (e.g. `"JOBS"`).
 *   Used in span names (`QUEUE JOBS send`) and metric labels.
 * @returns A `Proxy<T>` with identical type; non-wrapped properties pass through unchanged.
 *
 * @example
 * ```ts
 * import { instrumentQueue } from "@tigorhutasuhut/telemetry-js/cloudflare";
 *
 * export default {
 *   async fetch(request, env, ctx) {
 *     const queue = instrumentQueue(env.JOBS, "JOBS");
 *     await queue.send({ taskId: "123" });          // → span "QUEUE JOBS send"
 *     await queue.sendBatch([{ body: { taskId: "456" } }]); // → span "QUEUE JOBS sendBatch"
 *     return new Response("ok");
 *   },
 * };
 * ```
 */
export function instrumentQueue<T extends Queue>(q: T, name: string): T {
	return new Proxy(q, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);

			if (typeof prop !== "string") {
				return value;
			}

			if (prop === "send") {
				if (typeof value !== "function") return value;
				const bound = (value as (...a: unknown[]) => unknown).bind(target);

				return (message: unknown, opts?: unknown) =>
					traceBinding(
						{
							bindingType: "queue",
							bindingName: name,
							operation: "send",
							spanKind: SpanKind.PRODUCER,
							attributes: {
								"messaging.system": "cloudflare-queues",
								"messaging.destination.name": name,
								"messaging.operation": "send",
							},
						},
						() => bound(message, opts) as Promise<void>,
					);
			}

			if (prop === "sendBatch") {
				if (typeof value !== "function") return value;
				const bound = (value as (...a: unknown[]) => unknown).bind(target);

				return (messages: Iterable<MessageSendRequest>, opts?: unknown) => {
					// Materialise the iterable into an array so we can:
					// 1. Count messages for messaging.batch.message_count span attr.
					// 2. Pass the array to the real sendBatch (arrays are safe to re-iterate;
					//    a one-shot generator would be drained before the real call otherwise).
					const arr = [...messages];
					return traceBinding(
						{
							bindingType: "queue",
							bindingName: name,
							operation: "sendBatch",
							spanKind: SpanKind.PRODUCER,
							attributes: {
								"messaging.system": "cloudflare-queues",
								"messaging.destination.name": name,
								"messaging.operation": "sendBatch",
								"messaging.batch.message_count": arr.length,
							},
						},
						() => bound(arr, opts) as Promise<void>,
					);
				};
			}

			return value;
		},
	});
}
