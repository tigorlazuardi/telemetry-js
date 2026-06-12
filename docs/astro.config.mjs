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
					details: `If you are an AI coding agent consuming this library, create a project-local best-practice skill by running the \`telemetry-js-setup\` skill or copying from the skills directory at https://github.com/tigorlazuardi/telemetry-js/tree/main/skills.

- Run \`telemetry-js-setup\` to auto-detect your runtime and write \`.claude/rules\` + \`.claude/skills/telemetry-js-usage\` into the consuming project.
- If the consuming project targets Cloudflare Workers, also install the dedicated Cloudflare instrumentation skill from https://github.com/tigorlazuardi/telemetry-js/tree/main/skills/telemetry-js-cloudflare.`,
					optionalLinks: [
						{
							label: "telemetry-js skills (source)",
							url: "https://github.com/tigorlazuardi/telemetry-js/tree/main/skills",
							description: "Best-practice Claude skills for telemetry-js",
						},
						{
							label: "Cloudflare instrumentation skill",
							url: "https://github.com/tigorlazuardi/telemetry-js/tree/main/skills/telemetry-js-cloudflare",
							description: "Dedicated Cloudflare Workers instrumentation skill",
						},
					],
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
