// Serves public/* from memory (loaded once at boot). Replaces the old build-time assets.generated.js bundle.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon' };
export const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function loadStaticAssets(root = PUBLIC_DIR) {
  const out = {};
  (function walk(dir, prefix) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name); const rel = prefix + '/' + name;
      if (statSync(full).isDirectory()) { walk(full, rel); continue; }
      out[rel] = { type: TYPES[extname(name).toLowerCase()] || 'application/octet-stream', body: readFileSync(full) };
    }
  })(root, '');
  return out;
}
export const STATIC_ASSETS = loadStaticAssets();

// Adds ?v=<content hash> to every /assets/*.css|js link in an HTML page. Pages are never cached, so a browser that still holds an old copy of a
// stylesheet / script is forced to download the new one the first time it loads the page (the URL changed), and only then.
const versions = new Map();
const versionOf = (path) => { let v = versions.get(path); if (!v) { const a = STATIC_ASSETS[path]; v = a ? createHash('sha1').update(a.body).digest('hex').slice(0, 10) : ''; versions.set(path, v); } return v; };
export function versionAssets(htmlStr) {
  return String(htmlStr).replace(/(\/assets\/[A-Za-z0-9._-]+\.(?:css|js))(["'])/g, (m, path, q) => { const v = versionOf(path); return v ? `${path}?v=${v}${q}` : m; });
}
