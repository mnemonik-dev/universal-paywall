// Bundles the extension into a loadable, self-contained MV3 build in dist/.
// The MV3 service worker / content script can't resolve bare imports
// (@universal-paywall/agent, viem) at runtime, so we inline everything with esbuild.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
mkdirSync(out, { recursive: true });

await build({ entryPoints: [join(here, 'src/background.js')], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: join(out, 'background.js') });
await build({ entryPoints: [join(here, 'src/content.js')], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', outfile: join(out, 'content.js') });

writeFileSync(join(out, 'manifest.json'), JSON.stringify({
  manifest_version: 3,
  name: 'Universal Paywall',
  version: '0.0.1',
  description: 'Auto-pay x402 paywalls; expose paid fetches to pages and other extensions.',
  background: { service_worker: 'background.js', type: 'module' },
  permissions: ['storage'],
  host_permissions: ['<all_urls>'],
  content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_start' }],
  externally_connectable: { ids: ['*'] },
}, null, 2));

console.log('extension bundled -> dist/ (background.js, content.js, manifest.json)');
