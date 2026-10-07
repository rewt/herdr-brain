// Project-owned planners add test evidence without replacing the declared gate.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
export const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function promotionTestPlan({ cwd, plannerRoot = cwd, planner, changed, baseCommand = '', env = process.env }) {
  if (!planner) return null;
  if (typeof planner !== 'string' || !planner || path.isAbsolute(planner) || planner.split(/[\\/]/).includes('..')) throw Error('promotion_tests must be a project-relative planner');
  const file = path.join(plannerRoot, planner);
  if (!fs.statSync(file).isFile()) throw Error('promotion test planner must be a regular file');
  const r = spawnSync(process.execPath, [file, '--plan', JSON.stringify(changed), JSON.stringify(baseCommand)], { cwd, env, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
  if (r.error || r.status !== 0) throw Error(r.stderr || r.error?.message || 'promotion test planning failed');
  if (!r.stdout.trim()) throw Error(`promotion test planner produced no output${r.stderr.trim() ? ': ' + r.stderr.trim() : ''}`);
  const plan = JSON.parse(r.stdout);
  if (!plan || Object.keys(plan).some(key => !['files', 'covered', 'graph'].includes(key))) throw Error('invalid promotion test plan fields');
  if (plan.covered !== undefined && (!Array.isArray(plan.covered) || plan.covered.length > 512 || plan.covered.some(f => typeof f !== 'string' || !/^[\w./-]+\.test\.mjs$/.test(f) || f.split('/').includes('..') || path.isAbsolute(f)))) throw Error('invalid promotion test coverage');
  if (!Array.isArray(plan.files) || plan.files.length > 512 || new Set(plan.files).size !== plan.files.length || plan.files.some(f => typeof f !== 'string' || !/^[\w./-]+\.test\.mjs$/.test(f) || f.split('/').includes('..') || path.isAbsolute(f))) throw Error('invalid promotion test plan');
  return { schema: 'promotion-tests/v1', planner, changed: [...new Set(changed)].sort(), ...plan,
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
