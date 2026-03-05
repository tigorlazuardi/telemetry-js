import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		cloudflare: "src/cloudflare/index.ts",
		node: "src/node/index.ts",
		browser: "src/browser/index.ts",
		"browser-fetch": "src/browser/fetch/index.ts",
	},
	format: ["esm", "cjs"],
	dts: true,
	clean: true,
	splitting: false,
	sourcemap: true,
	// Keep all dependencies external so consumer bundlers (Vite, esbuild, etc.)
	// resolve them from node_modules. This prevents Node-only modules like
	// `async_hooks` from being inlined into the browser bundle.
	external: [/^@opentelemetry\//, /^node:/, "pino", "perf_hooks", "async_hooks"],
});
