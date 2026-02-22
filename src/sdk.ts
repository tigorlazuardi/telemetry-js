import { resolve } from "./registry.js";
import { noopSDKResult } from "./noop.js";
import type { SDKConfig, SDKResult } from "./types.js";

/**
 * Initialise the OpenTelemetry SDK for the detected (or explicitly specified) runtime.
 *
 * Never throws — returns a noop result on failure.
 *
 * @param config - SDK configuration options.
 * @returns An {@link SDKResult} with the active providers and lifecycle helpers.
 *
 * @example
 * ```ts
 * import { initSDK } from "@tigor/telemetry-js";
 *
 * const sdk = initSDK({
 *   serviceName: "my-api",
 *   exporterEndpoint: "https://otel.example.com",
 * });
 * ```
 */
export function initSDK(config: SDKConfig): SDKResult {
  try {
    const adapter = resolve(config.runtime);
    return adapter.setup(config);
  } catch {
    return noopSDKResult();
  }
}
