// Fails if a service worker precaches a file that doesn't exist, or if a file an app needs is missing
// from its precache (it would then be unavailable offline). Two apps: UW Color (app/) and UW Reels
// (app/reels/, which also uses the shared engine in app/js and app/vendor).
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative, dirname, resolve } from 'path';

const root = new URL('../app/', import.meta.url).pathname;
const walk = (d) => readdirSync(d).flatMap((n) => statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]);

// Files a page pulls in: <link>/<script>/<img> in HTML, imports and workers in JS, the manifest's icons.
function references(file) {
  const src = readFileSync(file, 'utf8'), out = [], add = (u) => { if (u && !/^(https?:|data:|#|mailto:)/.test(u)) out.push(resolve(dirname(file), u.split(/[?#]/)[0])); };
  if (file.endsWith('.html')) for (const m of src.matchAll(/\b(?:href|src)="([^"]+)"/g)) add(m[1]);
  if (file.endsWith('.js')) {
    for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*'([^']+)'/g)) add(m[1]);
    for (const m of src.matchAll(/import\('([^']+)'\)/g)) add(m[1]);
    for (const m of src.matchAll(/new URL\('([^']+)', import\.meta\.url\)/g)) add(m[1]);
    for (const m of src.matchAll(/new Worker\('([^']+)'/g)) add(m[1]);
  }
  if (file.endsWith('.webmanifest')) for (const i of JSON.parse(src).icons || []) add(i.src);
  return out.filter((p) => !p.endsWith('/'));
}
function reachable(entry) {
  const seen = new Set(), todo = [entry];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f) || !existsSync(f) || statSync(f).isDirectory()) continue;
    seen.add(f);
    todo.push(...references(f));
  }
  return seen;
}

let bad = false;
for (const app of [{ dir: root, own: (f) => !f.startsWith(join(root, 'reels') + '/') }, { dir: join(root, 'reels'), own: () => true }]) {
  const sw = readFileSync(join(app.dir, 'sw.js'), 'utf8');
  const list = JSON.parse(sw.match(/var ASSETS = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"'));
  const cached = new Set(list.filter((a) => a !== './').map((a) => resolve(app.dir, a)));
  const skip = (f) => f.endsWith('/sw.js') || f.endsWith('LICENSE.txt') || /\/\./.test(f);
  // everything the app's pages reach, plus every file in its own folder
  const needed = new Set([...reachable(join(app.dir, 'index.html')), ...walk(app.dir).filter((f) => app.own(f) && !(app.dir === root && f.startsWith(join(root, 'reels'))))].filter((f) => !skip(f)));
  const missingOnDisk = [...cached].filter((f) => !existsSync(f));
  const notCached = [...needed].filter((f) => !cached.has(f));
  const name = relative(root, app.dir) || 'app';
  if (missingOnDisk.length) { bad = true; console.error(name + ': in sw.js but not on disk:', missingOnDisk.map((f) => relative(app.dir, f))); }
  if (notCached.length) { bad = true; console.error(name + ': needed but not precached in sw.js:', notCached.map((f) => relative(app.dir, f))); }
  if (!missingOnDisk.length && !notCached.length) console.log('ok:', name, list.length, 'precached files');
}
if (bad) process.exit(1);
