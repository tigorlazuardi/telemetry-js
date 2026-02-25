import type { Resource } from "@opentelemetry/resources";
import { resolve } from "./registry.js";
import { noopSDKResult } from "./noop.js";
import type { SDKConfig, SDKResult } from "./types.js";

/** Module-level reference to the last initialised resource. */
let _globalResource: Resource | null = null;

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
 * import { initSDK } from "@tigorhutasuhut/telemetry-js";
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
    const result = adapter.setup(config);
    _globalResource = result.resource;
    return result;
  } catch {
    return noopSDKResult();
  }
}

/**
 * Return the {@link Resource} created by the most recent {@link initSDK} call,
 * or `null` if the SDK has not been initialised yet.
 */
export function getResource(): Resource | null {
  return _globalResource;
}
