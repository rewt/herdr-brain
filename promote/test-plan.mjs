// Project-owned planners add test evidence without replacing the declared gate.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
export const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const validFiles = files => Array.isArray(files) && files.length <= 512 && new Set(files).size === files.length &&
  files.every(f => typeof f === 'string' && /^[\w./-]+\.test\.mjs$/.test(f) && !f.split('/').includes('..') && !path.isAbsolute(f));
export function promotionTestPlan({ cwd, plannerRoot = cwd, planner, changed, required = [], baseCommand = '', env = process.env }) {
  if (!planner) return null;
  if (!validFiles(required)) throw Error('invalid required test files');
  if (typeof planner !== 'string' || !planner || path.isAbsolute(planner) || planner.split(/[\\/]/).includes('..')) throw Error('promotion_tests must be a project-relative planner');
  const file = path.join(plannerRoot, planner);
  if (!fs.statSync(file).isFile()) throw Error('promotion test planner must be a regular file');
  const r = spawnSync(process.execPath, [file, '--plan', JSON.stringify(changed), JSON.stringify(baseCommand), JSON.stringify(required)], { cwd, env, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
  if (r.error || r.status !== 0) throw Error(r.stderr || r.error?.message || 'promotion test planning failed');
  if (!r.stdout.trim()) throw Error(`promotion test planner produced no output${r.stderr.trim() ? ': ' + r.stderr.trim() : ''}`);
  const plan = JSON.parse(r.stdout);
  if (!plan || Object.keys(plan).some(key => !['files', 'covered', 'graph', 'selected', 'deferred', 'budget'].includes(key))) throw Error('invalid promotion test plan fields');
  if (plan.covered !== undefined && !validFiles(plan.covered)) throw Error('invalid promotion test coverage');
  if (!validFiles(plan.files)) throw Error('invalid promotion test plan');
  const validRows = rows => Array.isArray(rows) && validFiles(rows.map(row => row?.file)) &&
    rows.every(row => typeof row.reason === 'string' && Number.isFinite(row.estimated_ms) && row.estimated_ms > 0 && ['measured', 'fallback'].includes(row.estimate));
  if (plan.selected !== undefined && (!validRows(plan.selected) || plan.selected.length !== plan.files.length || plan.selected.some(row => !plan.files.includes(row.file)))) throw Error('invalid selected test details');
  if (plan.deferred !== undefined && (!validRows(plan.deferred) || plan.deferred.some(row => row.destination !== 'release-candidate' || [...plan.files, ...(plan.covered ?? [])].includes(row.file)))) throw Error('invalid deferred test details');
  if (plan.budget !== undefined && (!plan.budget || ['time_ms', 'max_files', 'unknown_file_ms'].some(key => !Number.isSafeInteger(plan.budget[key]) || plan.budget[key] < 1) || !Number.isFinite(plan.budget.estimated_ms) || plan.budget.estimated_ms < 0)) throw Error('invalid promotion test budget');
  return { schema: 'promotion-tests/v1', planner, changed: [...new Set(changed)].sort(), required: [...required].sort(), ...plan,
    command: plan.files.length ? `${quote(process.execPath)} ${quote(planner)} --run ${quote(JSON.stringify(plan.files))}` : null };
}
export function changedPaths(cwd, base, head) {
  const r = spawnSync('git', ['-C', cwd, 'diff', '--name-only', '-z', '--no-renames', base, head], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw Error(r.stderr || 'cannot select changed test paths');
  return r.stdout.split('\0').filter(Boolean);
}
export function plannedCommand(command, plan) {
  if (!plan?.command) return command;
  return `export MONITOR_PROMOTION_TEST_FILES=${quote(JSON.stringify(plan.files))}; ( ${command} ) && ${plan.command}`;
}
