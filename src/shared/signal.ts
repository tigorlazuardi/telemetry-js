/**
 * Shared {@link AbortSignal} context key used by both `./context` and
 * `withTrace` to propagate cancellation signals through the OTel context.
 */

import { createContextKey } from "@opentelemetry/api";

export const SIGNAL_KEY = createContextKey("telemetry-js:signal");
