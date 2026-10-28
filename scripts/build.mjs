// `npm run build` (Render build step). Nothing needs compiling any more — assets are served straight from public/ —
// so this verifies the deploy is complete and every source file parses, failing the build early rather than at boot.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = join(import.meta.dirname, '..');
const need = ['public/index.html', 'public/assets/style.css', 'public/assets/app.js', 'db/migrations/0001_initial.sql', 'src/server.js'];
const missing = need.filter((f) => !existsSync(join(root, f)));
if (missing.length) { console.error('Missing required files:', missing.join(', ')); process.exit(1); }

let checked = 0;
(function walk(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!p.endsWith('.js')) continue;
    const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
    if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
    checked++;
  }
})(join(root, 'src'));
console.log(`Build OK — ${checked} source files parsed, assets and migrations present.`);
