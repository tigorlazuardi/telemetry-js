import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsRoot = join(__dirname, '..');

const BUCKETS = [
	{ name: 'node', entries: ['../src/node/index.ts'] },
	{ name: 'bun', entries: ['../src/bun/index.ts'] },
	{ name: 'cloudflare', entries: ['../src/cloudflare/index.ts'] },
	{
		name: 'browser',
		entries: [
			'../src/browser/index.ts',
			'../src/browser/fetch/index.ts',
			'../src/browser/react/index.ts',
			'../src/browser/sdk/index.ts',
		],
	},
	{
		name: 'shared',
		entries: [
			'../src/error/index.ts',
			'../src/db/index.ts',
			'../src/context/index.ts',
			'../src/vite/index.ts',
		],
	},
];

const typedoc = join(docsRoot, 'node_modules', '.bin', 'typedoc');

for (const bucket of BUCKETS) {
	console.log(`Generating API: ${bucket.name}...`);
	const args = [
		'--options',
		'./typedoc.base.json',
		'--out',
		`./src/content/docs/api/${bucket.name}`,
		...bucket.entries,
	];
	const result = spawnSync(typedoc, args, { cwd: docsRoot, stdio: 'inherit' });
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

// Post-process: inject `title` frontmatter into TypeDoc-generated files that lack it.
// Starlight content schema requires `title`; TypeDoc doesn't emit frontmatter by default.
function injectTitles(dir) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			injectTitles(full);
			continue;
		}
		if (!entry.endsWith('.md')) continue;
		const content = readFileSync(full, 'utf8');
		if (content.startsWith('---')) continue; // already has frontmatter
		const h1 = content.match(/^#\s+(.+)$/m);
		// Unescape MD backslash escapes (\< \> \` etc.) then sanitize for YAML single-quoted string
		const rawTitle = h1
			? h1[1].replace(/\*+/g, '').replace(/\\(.)/g, '$1').trim()
			: entry.replace(/\.md$/, '');
		const yamlTitle = rawTitle.replace(/'/g, "''"); // single-quote YAML escaping
		writeFileSync(full, `---\ntitle: '${yamlTitle}'\n---\n\n${content}`);
	}
}

const apiOut = join(docsRoot, 'src', 'content', 'docs', 'api');
console.log('Injecting title frontmatter...');
injectTitles(apiOut);

console.log('API generation complete.');
