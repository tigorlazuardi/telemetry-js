import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/cloudflare.ts", "src/node.ts", "src/browser.ts"],
	format: ["esm", "cjs"],
	dts: true,
	clean: true,
	splitting: false,
	sourcemap: true,
});
