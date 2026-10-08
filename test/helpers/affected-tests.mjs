// Conservative one-hop static references. Dynamic/computed references need an
// explicit import or literal path; this planner never executes product modules.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isMain } from '../../lib/cli-help.mjs';
import { tierFiles } from './tier.mjs';
import { main as runRelease } from './release-suites.mjs';
const durations = JSON.parse(fs.readFileSync(new URL('./test-durations.json', import.meta.url), 'utf8'));
export const DEFAULT_BUDGET_MS = 300000;
export const DEFAULT_MAX_FILES = 10;
export function boundAffectedTests({ candidates, changed, required = [], estimates = durations.files,
  budgetMs = DEFAULT_BUDGET_MS, maxFiles = DEFAULT_MAX_FILES, unknownMs = 60000 }) {
  for (const value of [budgetMs, maxFiles, unknownMs]) if (!Number.isSafeInteger(value) || value < 1) throw Error('invalid affected-test budget');
  const requiredSet = new Set(required), changedSet = new Set(changed);
  const cost = file => estimates[file]?.duration_ms ?? unknownMs;
  const row = (file, reason) => ({ file, reason, estimated_ms: cost(file),
    estimate: estimates[file] ? 'measured' : 'fallback',
    ...(estimates[file]?.measured_at ? { measured_at: estimates[file].measured_at } : {}) });
  const selected = [...requiredSet].sort().map(file => row(file, 'bound-required'));
  const deferred = [];
  let total = selected.reduce((sum, entry) => sum + entry.estimated_ms, 0);
  // Prefer changed tests, then cheaper direct references. Required evidence is
  // unconditional and consumes the allowance before optional extras.
  const ordered = [...new Set(candidates)].filter(file => !requiredSet.has(file)).sort((a, b) =>
    Number(changedSet.has(b)) - Number(changedSet.has(a)) || cost(a) - cost(b) || a.localeCompare(b));
  for (const file of ordered) {
    const reason = selected.length >= maxFiles ? 'file-cap' : total + cost(file) > budgetMs ? 'time-budget' : null;
    if (reason) deferred.push({ ...row(file, reason), destination: 'release-candidate' });
    else { selected.push(row(file, changedSet.has(file) ? 'changed-test' : 'direct-reference')); total += cost(file); }
  }
  return { files: selected.map(entry => entry.file).sort(), selected, deferred,
    budget: { time_ms: budgetMs, max_files: maxFiles, unknown_file_ms: unknownMs, estimated_ms: total,
      required_over_budget: total > budgetMs || selected.length > maxFiles, durations_source: durations.source } };
}
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
  const changedSet = new Set(changed);
  return tests.filter(file => changedSet.has(file) || [...(graph.get(file) ?? [])].some(edge => changedSet.has(edge))).sort();
}
export function main(argv = process.argv.slice(2)) {
  const [mode, json, commandJson, requiredJson] = argv;
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
    const required = requiredJson ? JSON.parse(requiredJson) : [];
    if (!Array.isArray(required) || required.some(file => typeof file !== 'string' || !file.endsWith('.test.mjs') || !files.includes(file))) throw Error('required test file is missing from candidate');
    const bound = boundAffectedTests({ candidates: affectedTests({ root, changed: values, files, tests }), changed: values,
      required: required.filter(file => !promotion.includes(file)),
      budgetMs: Number(process.env.MONITOR_PROMOTION_EXTRA_BUDGET_MS ?? DEFAULT_BUDGET_MS),
      maxFiles: Number(process.env.MONITOR_PROMOTION_EXTRA_MAX_FILES ?? DEFAULT_MAX_FILES) });
    // The validator already on main accepts only the legacy fields. Callers
    // opt into the detailed receipt by supplying the required-files argument.
    console.log(JSON.stringify({ covered: promotion.filter(file => files.includes(file)),
      ...(requiredJson !== undefined ? bound : { files: bound.files }),
      graph: { paths: files.length, max_paths: 10000, max_bytes: 32 * 1024 * 1024, max_suite_files: 4, hops: 1 } }));
  } else throw Error('expected --plan or --run');
}
if (isMain(import.meta.url)) main();
