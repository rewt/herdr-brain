// Conservative static dependency closure. Dynamic/computed references need an
// explicit import or literal path; this planner never executes product modules.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tierFiles } from './tier.mjs';
import { main as runRelease } from './release-suites.mjs';
export function affectedTests({ root, changed, files, tests }) {
  if (files.length > 10000 || changed.length > 10000) throw Error('affected-test graph exceeds 10000 paths');
  const inventory = new Set([...files, ...changed]), graph = new Map();
  let bytes = 0;
  for (const file of files.filter(f => /\.(?:mjs|js|cjs|sh)$/.test(f))) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    bytes += Buffer.byteLength(text);
    if (bytes > 32 * 1024 * 1024) throw Error('affected-test graph exceeds 32 MiB');
    const edges = new Set();
    // Imports, re-exports, literal dynamic imports/new URL and launched scripts.
    // Root-relative literals cover fixture CLIs; basename literals conservatively
    // cover path.join(HERE, '..', 'lane.mjs') and similar constructed paths.
    for (const match of text.matchAll(/['"`]([^'"`\n]+\.(?:mjs|js|cjs|sh))['"`]/g)) {
      const literal = match[1];
      for (const target of [path.posix.normalize(path.posix.join(path.posix.dirname(file), literal)), literal]) if (inventory.has(target)) edges.add(target);
      if (!literal.includes('/')) for (const target of inventory) if (path.posix.basename(target) === literal) edges.add(target);
    }
    graph.set(file, edges);
  }
  const impacted = new Set(changed);
  let added = true;
  while (added) {
    added = false;
    for (const [file, edges] of graph) if (!impacted.has(file) && [...edges].some(e => impacted.has(e))) { impacted.add(file); added = true; }
  }
  return tests.filter(file => impacted.has(file)).sort();
}
export function main(argv = process.argv.slice(2)) {
  const [mode, json, commandJson] = argv;
  const values = JSON.parse(json);
  if (!Array.isArray(values) || values.some(v => typeof v !== 'string')) throw Error('expected a path array');
  if (mode === '--run') {
    if (values.length) runRelease(['--file-timeout=480000', '--suite-timeout=540000', ...values]);
  } else if (mode === '--plan') {
    const root = process.cwd();
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).split('\0').filter(Boolean);
    const command = commandJson ? JSON.parse(commandJson) : '';
    const promotion = ['npm run test:promotion', 'npm run test:promotion:steps'].includes(command)
      ? [...tierFiles('promotion', root), ...files.filter(file => /^test-slot\/test\/[^/]+\.test\.mjs$/.test(file))] : [];
    const tests = [...new Set([...tierFiles('release', root), ...values.filter(file => file.endsWith('.test.mjs') && files.includes(file))])].filter(file => !promotion.includes(file));
    console.log(JSON.stringify({ covered: promotion.filter(file => files.includes(file)), files: affectedTests({ root, changed: values, files, tests }), graph: { paths: files.length, max_paths: 10000, max_bytes: 32 * 1024 * 1024, max_suite_files: 4 } }));
  } else throw Error('expected --plan or --run');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
