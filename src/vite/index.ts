/**
 * Vite/Rollup plugin utilities.
 *
 * ```ts
 * import { stubNodeBuiltins } from "@tigorhutasuhut/telemetry-js/vite";
 * ```
 */

import type { Plugin } from "vite";

const STUB_PREFIX = "\0stub:";

/**
 * Vite/Rollup plugin that stubs `node:*` built-in packages with empty modules.
 *
 * Useful when building for browser or edge runtimes (e.g. Cloudflare Workers)
 * where Node.js built-ins are unavailable — prevents build errors caused by
 * transitive dependencies that import `node:*` packages.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from "vite";
 * import { stubNodeBuiltins } from "@tigorhutasuhut/telemetry-js/vite";
 *
 * export default defineConfig({
 *   plugins: [stubNodeBuiltins()],
 * });
 * ```
 */
export function stubNodeBuiltins(): Plugin {
	return {
		name: "stub-node-builtins",
		enforce: "pre",

		resolveId(id) {
			if (id.startsWith("node:")) {
				return STUB_PREFIX + id;
			}
		},

		load(id) {
			if (!id.startsWith(STUB_PREFIX)) return;

			const original = id.slice(STUB_PREFIX.length);

			this.warn(`Stubbing Node.js built-in: ${original}`);

			// `syntheticNamedExports` lets Rollup satisfy any named import
			// (e.g. `import { performance } from "node:perf_hooks"`) by looking
			// it up on the default export, which resolves to `undefined` rather
			// than throwing "X is not exported by __vite-browser-external".
			return {
				code: [
					"// Stubbed by @tigorhutasuhut/telemetry-js/vite",
					`// Original: ${original}`,
					"export default {};",
				].join("\n"),
				syntheticNamedExports: true,
			};
		},
	};
}
