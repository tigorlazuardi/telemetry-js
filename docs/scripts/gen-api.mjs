import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsRoot = join(__dirname, '..');

const BUCKETS = [
  { name: 'node',        entries: ['../src/node/index.ts'] },
  { name: 'bun',         entries: ['../src/bun/index.ts'] },
  { name: 'cloudflare',  entries: ['../src/cloudflare/index.ts'] },
  { name: 'browser',     entries: ['../src/browser/index.ts', '../src/browser/fetch/index.ts', '../src/browser/react/index.ts', '../src/browser/sdk/index.ts'] },
  { name: 'shared',      entries: ['../src/error/index.ts', '../src/db/index.ts', '../src/context/index.ts', '../src/vite/index.ts'] },
];

const typedoc = join(docsRoot, 'node_modules', '.bin', 'typedoc');

for (const bucket of BUCKETS) {
  console.log(`Generating API: ${bucket.name}...`);
  const args = [
    '--options', './typedoc.base.json',
    '--out', `./src/content/docs/api/${bucket.name}`,
    ...bucket.entries,
  ];
  const result = spawnSync(typedoc, args, { cwd: docsRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('API generation complete.');
