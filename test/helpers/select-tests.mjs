// Computed static dependency graph for shadow selection. Never imports or runs
// candidate code. Literal dynamic imports/URLs add conservative extra edges.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isMain } from '../../lib/cli-help.mjs';

const sourceFile = file => /\.[cm]?js$/.test(file);
const testFile = file => file.endsWith('.test.mjs');
const safePath = file => typeof file === 'string' && file.length > 0 && !path.isAbsolute(file) &&
  !/[\\\x00-\x1f\x7f]/u.test(file) && file.split('/').every(part => part && part !== '.' && part !== '..');
const full = reason => ({ pick: 'full', reason });
export function selectTests({ root, changed, files }) {
  if (!Array.isArray(changed) || changed.some(row => !safePath(row?.path) || !['A', 'M'].includes(row.status))) return full('unknown, deleted or renamed path');
  if (!Array.isArray(files) || files.length > 10000 || files.some(file => !safePath(file))) return full('unknown or oversized source inventory');
  const known = new Set(files), tests = files.filter(testFile).sort();
  for (const { path: file } of changed) {
    if (!known.has(file)) return full(`unknown path: ${file}`);
    if (!sourceFile(file) || /(?:^|\/)(?:[^/]*config[^/]*|package[^/]*|[^/]*lock[^/]*\.json)$/.test(file)) return full(`package, config or non-module path: ${file}`);
    if (/(?:^|\/)(?:helpers?|fixtures?)(?:\/|[.-])/.test(file) ||
        /(?:^|\/)(?:test|tests)\//.test(file) && !testFile(file)) return full(`test helper: ${file}`);
  }
  const reverse = new Map();
  let bytes = 0;
  for (const file of files.filter(sourceFile)) {
    const absolute = path.join(root, file);
    // Reject links (including linked parent directories) instead of following
    // candidate paths out of the tree during this read-only scan.
    if (!fs.lstatSync(absolute).isFile() || fs.realpathSync(absolute) !== absolute) return full(`non-regular source: ${file}`);
    bytes += fs.statSync(absolute).size;
    if (bytes > 32 * 1024 * 1024) return full('source graph exceeds 32 MiB');
    const source = fs.readFileSync(absolute, 'utf8');
    const references = /(?:\b(?:import|export)\s*(?:[^;'"`]*?\bfrom\s*)?|\b(?:import|require)\s*\(\s*|\bnew\s+URL\s*\(\s*)(['"])([^'"\r\n]+)\1/g;
    for (const match of source.matchAll(references)) {
      const specifier = match[2];
      if (!specifier.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      // Node ESM uses exact names; CommonJS can omit extensions or use index.
      const resolved = [target, `${target}.mjs`, `${target}.js`, `${target}.cjs`, `${target}/index.js`].find(name => known.has(name));
      if (!resolved) continue;
      const consumers = reverse.get(resolved) ?? new Set();
      consumers.add(file); reverse.set(resolved, consumers);
    }
  }
  const picked = new Set();
  for (const { path: file } of changed) {
    const seen = new Set(), pending = [file];
    let mapped = false;
    while (pending.length) {
      const current = pending.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      if (testFile(current)) { picked.add(current); mapped = true; }
      pending.push(...(reverse.get(current) ?? []));
    }
    if (!mapped) return full(`unmapped module: ${file}`);
  }
  // No cap or budget: this is the complete static pick, never a command.
  return { pick: tests.filter(file => picked.has(file)), reason: 'tests importing changed modules transitively (static graph)' };
}
export function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--select') throw Error('expected --select with a JSON request on stdin');
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (request.schema !== 'promotion-selector/v1' || !path.isAbsolute(request.root)) throw Error('invalid selector request');
  const root = fs.realpathSync(request.root);
  const r = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw Error('cannot inventory selector candidate');
  console.log(JSON.stringify(selectTests({ root, changed: request.changed, files: r.stdout.split('\0').filter(Boolean) })));
}
if (isMain(import.meta.url)) main();
