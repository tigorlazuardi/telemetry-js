import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";

export default defineConfig({
	site: "https://tigorlazuardi.github.io",
	base: "/telemetry-js",
	integrations: [
		starlight({
			title: "@tigorhutasuhut/telemetry-js",
			description:
				"OpenTelemetry SDK setup abstraction for Node, Bun, Cloudflare Workers, and Browser",
			social: [
				{ icon: "github", label: "GitHub", href: "https://github.com/tigorlazuardi/telemetry-js" },
			],
			plugins: [
				starlightLlmsTxt({
					minify: { whitespace: false },
					customSets: [
						{
							label: "Node usage",
							description: "telemetry-js on Node.js",
							paths: [
								"runtimes/node",
								"api/node/**",
								"api/shared/**",
								"guides/**",
								"getting-started/**",
							],
						},
						{
							label: "Bun usage",
							description: "telemetry-js on Bun",
							paths: [
								"runtimes/bun",
								"api/bun/**",
								"api/shared/**",
								"guides/**",
								"getting-started/**",
							],
						},
						{
							label: "Cloudflare usage",
							description: "telemetry-js on Cloudflare Workers",
							paths: [
								"runtimes/cloudflare",
								"api/cloudflare/**",
								"api/shared/**",
								"guides/**",
								"getting-started/**",
							],
						},
						{
							label: "Browser usage",
							description: "telemetry-js in the browser + React",
							paths: [
								"runtimes/browser",
								"api/browser/**",
								"api/shared/**",
								"guides/**",
								"getting-started/**",
							],
						},
						{
							label: "API reference",
							description: "Full generated API reference",
							paths: ["api/**"],
						},
					],
				}),
			],
			sidebar: [
				{ label: "Getting Started", items: [{ autogenerate: { directory: "getting-started" } }] },
				{ label: "Runtimes", items: [{ autogenerate: { directory: "runtimes" } }] },
				{ label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
				{
					label: "API Reference",
					collapsed: true,
					items: [{ autogenerate: { directory: "api" } }],
				},
			],
		}),
	],
});
