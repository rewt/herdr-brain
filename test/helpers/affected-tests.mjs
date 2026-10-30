// Shared complete-inventory, transitive selection; never executes product modules.
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from '../../lib/cli-help.mjs';
import { tierFiles } from './tier.mjs';
import { trackedTestInventory } from './test-inventory.mjs';
import { affectedTestPlan } from './affected-graph.mjs';
export { affectedTestPlan } from './affected-graph.mjs';
import { main as runRelease } from './release-suites.mjs';
const durations = JSON.parse(fs.readFileSync(new URL('./test-durations.json', import.meta.url), 'utf8'));
export const DEFAULT_BUDGET_MS = 300000;
export const DEFAULT_MAX_FILES = 10;
export function boundAffectedTests({ candidates, changed, required = [], estimates = durations.files,
  budgetMs = DEFAULT_BUDGET_MS, maxFiles = DEFAULT_MAX_FILES, unknownMs = 60000, consumers = [] }) {
  for (const value of [budgetMs, maxFiles, unknownMs]) if (!Number.isSafeInteger(value) || value < 1) throw Error('invalid affected-test budget');
  const requiredSet = new Set(required), changedSet = new Set(changed);
  const cost = file => estimates[file]?.duration_ms ?? unknownMs;
  const row = (file, reason) => ({ file, reason, estimated_ms: cost(file),
    estimate: estimates[file] ? 'measured' : 'fallback',
    ...(estimates[file]?.measured_at ? { measured_at: estimates[file].measured_at } : {}),
    ...(consumers.some(entry => entry.file === file) ? { consumers: consumers.filter(entry => entry.file === file) } : {}) });
  const selected = [...requiredSet].sort().map(file => row(file, 'bound-required'));
  const deferred = [];
  let total = selected.reduce((sum, entry) => sum + entry.estimated_ms, 0);
  // Prefer changed tests, then cheaper affected consumers. Required evidence is
  // unconditional and consumes the allowance before optional extras.
  const ordered = [...new Set(candidates)].filter(file => !requiredSet.has(file)).sort((a, b) =>
    Number(changedSet.has(b)) - Number(changedSet.has(a)) || cost(a) - cost(b) || a.localeCompare(b));
  for (const file of ordered) {
    const reason = selected.length >= maxFiles ? 'file-cap' : total + cost(file) > budgetMs ? 'time-budget' : null;
    if (reason) deferred.push({ ...row(file, reason), destination: 'release-candidate' });
    else { selected.push(row(file, changedSet.has(file) ? 'changed-test' : consumers.find(entry => entry.file === file)?.reason ?? 'direct-reference')); total += cost(file); }
  }
  return { files: selected.map(entry => entry.file).sort(), selected, deferred,
    budget: { time_ms: budgetMs, max_files: maxFiles, unknown_file_ms: unknownMs, estimated_ms: total,
      required_over_budget: total > budgetMs || selected.length > maxFiles, durations_source: durations.source } };
}
export function affectedTests({ root, changed, files, tests }) {
  return affectedTestPlan({ root, changed, files, tests }).candidates;
}
export function main(argv = process.argv.slice(2)) {
  const [mode, json, commandJson, requiredJson] = argv;
  if (mode === '--promotion') {
    const selected = JSON.parse(process.env.MONITOR_PROMOTION_TEST_FILES ?? 'null');
    if (!Array.isArray(selected) || selected.some(file => typeof file !== 'string' || !/^[\w./-]+\.test\.mjs$/.test(file) || file.split('/').includes('..') || path.isAbsolute(file))) throw Error('promotion requires a bound test-file selection');
    const files = [...new Set(selected)].sort();
    if (files.length) runRelease(files);
    else console.log('Affected-file check: no selected files; no tests executed.');
    return;
  }
  const values = JSON.parse(json);
  if (!Array.isArray(values) || values.some(v => typeof v !== 'string')) throw Error('expected a path array');
  if (mode === '--run') {
    if (values.length) runRelease(values);
  } else if (mode === '--plan') {
    const root = process.cwd();
    const { files, tests } = trackedTestInventory(root);
    const command = commandJson ? JSON.parse(commandJson) : '';
    const promotion = ['npm run test:promotion', 'npm run test:promotion:steps'].includes(command)
      ? [...tierFiles('promotion', root), ...files.filter(file => /^test-slot\/test\/[^/]+\.test\.mjs$/.test(file))] : [];
    const required = requiredJson ? JSON.parse(requiredJson) : [];
    if (!Array.isArray(required) || required.some(file => typeof file !== 'string' || !file.endsWith('.test.mjs') || !files.includes(file))) throw Error('required test file is missing from candidate');
    const analysis = affectedTestPlan({ root, changed: values, files, tests });
    const candidates = analysis.candidates.filter(file => !promotion.includes(file));
    // Reduced gates execute the unique affected union once; estimates remain advisory.
    const reduced = command === 'node test/helpers/affected-tests.mjs --promotion';
    const bound = boundAffectedTests({ candidates, changed: values, consumers: analysis.consumers,
      required: [...new Set([...required.filter(file => !promotion.includes(file)), ...(reduced ? candidates : [])])],
      budgetMs: Number(process.env.MONITOR_PROMOTION_EXTRA_BUDGET_MS ?? DEFAULT_BUDGET_MS),
      maxFiles: Number(process.env.MONITOR_PROMOTION_EXTRA_MAX_FILES ?? DEFAULT_MAX_FILES) });
    // The validator already on main accepts only the legacy fields. Callers
    // opt into the detailed receipt by supplying the required-files argument.
    console.log(JSON.stringify({ covered: promotion.filter(file => files.includes(file)),
      ...(requiredJson !== undefined ? { ...bound, unknown: analysis.unknown } : { files: bound.files }),
      graph: analysis.graph }));
  } else throw Error('expected --plan or --run');
}
if (isMain(import.meta.url)) main();
