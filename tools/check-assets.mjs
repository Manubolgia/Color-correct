// Fails if sw.js precaches a file that doesn't exist, or if an app file is missing from the precache
// (it would then be unavailable offline).
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';

const app = new URL('../app/', import.meta.url).pathname;
const sw = readFileSync(join(app, 'sw.js'), 'utf8');
const list = JSON.parse(sw.match(/var ASSETS = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"'));
const walk = (d) => readdirSync(d).flatMap((n) => statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [relative(app, join(d, n))]);
const skip = new Set(['sw.js', 'vendor/MEDIABUNNY-LICENSE.txt']);
const files = walk(app).filter((f) => !skip.has(f) && !f.startsWith('.'));

const missingOnDisk = list.filter((a) => a !== './' && !existsSync(join(app, a)));
const notCached = files.filter((f) => !list.includes(f));
if (missingOnDisk.length || notCached.length) {
  if (missingOnDisk.length) console.error('In sw.js but not on disk:', missingOnDisk);
  if (notCached.length) console.error('On disk but not precached in sw.js:', notCached);
  process.exit(1);
}
console.log('ok:', list.length, 'precached files');
