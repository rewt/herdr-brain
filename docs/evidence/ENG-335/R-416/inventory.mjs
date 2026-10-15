import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const files = execFileSync('rg', ['--files'], { encoding: 'utf8' }).trim().split('\n').sort();
const tests = files.filter(file => file.endsWith('.test.mjs'));
const changed = execFileSync('git', ['diff', '--name-only', 'main...HEAD'], { encoding: 'utf8' }).trim().split('\n');
const production = file => file.endsWith('.mjs') && !file.endsWith('.test.mjs') && !/^(?:test|docs)\/|\/(?:test|tests)\//.test(file);
const modules = new Set([
  ...changed.filter(production),
  ...files.filter(file => /^(?:promote|housekeeping|verify)\/[^/]+\.mjs$/.test(file)),
  'lib/retire-runtime.mjs',
]);
const inventory = new Set(files), graph = new Map();
const byBasename = new Map();
for (const file of files) {
  const name = path.posix.basename(file);
  if (!byBasename.has(name)) byBasename.set(name, []);
  byBasename.get(name).push(file);
}
for (const file of files.filter(file => /\.(?:mjs|js|cjs|sh)$/.test(file))) {
  const edges = new Set(), text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/['"`]([^'"`\n]+\.(?:mjs|js|cjs|sh))['"`]/g)) {
    const literal = match[1];
    for (const target of [path.posix.normalize(path.posix.join(path.posix.dirname(file), literal)), literal]) {
      if (inventory.has(target)) edges.add(target);
    }
    if (!literal.includes('/')) for (const target of byBasename.get(literal) ?? []) edges.add(target);
  }
  graph.set(file, edges);
}
const references = new Map(tests.map(file => [file, [...(graph.get(file) ?? [])].filter(edge => modules.has(edge))]));
const helper = file => /(?:^|\/)(?:test|tests)\//.test(file) && !file.endsWith('.test.mjs');
const helperChain = (file, seen = new Set()) => {
  if (seen.has(file)) return null;
  seen.add(file);
  for (const edge of graph.get(file) ?? []) {
    if (modules.has(edge)) return [file, edge];
    if (helper(edge)) { const chain = helperChain(edge, seen); if (chain) return [file, ...chain]; }
  }
  return null;
};
const chains = new Map(tests.map(file => [file, helperChain(file)]));
const referenced = tests.filter(file => chains.get(file) || changed.includes(file));
const acceptance = tests.filter(file => file.startsWith('acceptance/test/') && !referenced.includes(file));
const selected = [...referenced, ...acceptance];
const lane = 'lanes/test/lane.test.mjs';
if (!selected.includes(lane)) throw Error('lane coverage is missing');
const remaining = referenced.filter(file => file !== lane), batches = [[lane]];
for (let index = 0; index < remaining.length; index += 4) batches.push(remaining.slice(index, index + 4));
for (let index = 0; index < acceptance.length; index += 4) batches.push(acceptance.slice(index, index + 4));
const data = {
  run: 'R-416', main: execFileSync('git', ['rev-parse', 'main'], { encoding: 'utf8' }).trim(),
  source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  start: '99666f45', method: 'Grep every .test.mjs file for literal import/path references to all requested or changed modules, resolving root and relative paths and conservative basename joins. Follow test-helper references as well and include lane-changed tests. Add the complete offline acceptance suite after its focus fixture update. No file or time-budget exclusions.',
  modules: [...modules].sort(),
  tests: selected.map(file => ({ file, references: references.get(file), chain: chains.get(file), changed: changed.includes(file), ...(acceptance.includes(file) ? { reason: 'complete offline acceptance suite after fixture update' } : {}) })),
  batches,
};
fs.writeFileSync('/private/tmp/R-416-coverage.json', JSON.stringify(data, null, 2) + '\n');
const broadMatches = tests.map(file => ({ file, modules: data.modules.filter(module =>
  fs.readFileSync(file, 'utf8').includes(path.posix.basename(module))) })).filter(row => row.modules.length);
const omitted = broadMatches.filter(row => !selected.includes(row.file));
if (omitted.length) throw Error(`direct module references omitted: ${JSON.stringify(omitted)}`);
fs.writeFileSync('/private/tmp/R-416-broad-scan.json', JSON.stringify({ source: data.source,
  test_files_scanned: tests.length, matched_files: broadMatches.length, selected_files: selected.length,
  omitted, matches: broadMatches }, null, 2) + '\n');
fs.writeFileSync('/private/tmp/R-416-module-names.txt', [...new Set(data.modules.flatMap(module => [module, path.posix.basename(module)]))].join('\n') + '\n');
fs.writeFileSync('/private/tmp/R-416-reference-grep.txt', execFileSync('rg', ['-n', '-F', '-f',
  '/private/tmp/R-416-module-names.txt', '-g', '*.test.mjs', '.'], { encoding: 'utf8' }));
console.log(JSON.stringify({ modules: data.modules.length, test_files: selected.length, batches: batches.length, files: selected }, null, 2));
