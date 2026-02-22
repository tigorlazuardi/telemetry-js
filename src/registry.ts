import type { RuntimeAdapter, RuntimeName } from "./types.js";
import { noopSDKResult } from "./noop.js";
import { nodeAdapter } from "./runtimes/node.js";
import { cloudflareWorkerAdapter } from "./runtimes/cloudflare/worker.js";

const noopAdapter: RuntimeAdapter = {
  name: "noop",
  detect: () => false,
  setup: () => noopSDKResult(),
};

const adapters: RuntimeAdapter[] = [];

/**
 * Register a custom {@link RuntimeAdapter}.
 *
 * Adapters are evaluated in registration order during auto-detection.
 *
 * @param adapter - The adapter to register.
 *
 * @example
 * ```ts
 * import { register } from "@tigor/telemetry-js";
 *
 * register({
 *   name: "deno",
 *   detect: () => "Deno" in globalThis,
 *   setup: (config) => { /* ... *\/ },
 * });
 * ```
 */
export function register(adapter: RuntimeAdapter): void {
  adapters.push(adapter);
}

/**
 * Resolve a {@link RuntimeAdapter} by name or by auto-detection.
 *
 * Returns a noop adapter if no adapter matches (never throws).
 *
 * @param runtimeName - Explicit runtime name. When omitted, each registered adapter's
 *   `detect()` method is called in order and the first match is returned.
 * @returns The matched adapter, or a noop adapter if none matches.
 */
export function resolve(runtimeName?: RuntimeName): RuntimeAdapter {
  if (runtimeName) {
    const adapter = adapters.find((a) => a.name === runtimeName);
    return adapter ?? noopAdapter;
  }

  for (const adapter of adapters) {
    if (adapter.detect()) {
      return adapter;
    }
  }

  return noopAdapter;
}

/**
 * Return a read-only snapshot of all currently registered adapters.
 *
 * @returns An array of registered {@link RuntimeAdapter} instances.
 */
export function getRegisteredAdapters(): readonly RuntimeAdapter[] {
  return adapters;
}

// Pre-register built-in adapters (detection order matters: CF Workers first, then Node)
register(cloudflareWorkerAdapter);
register(nodeAdapter);
