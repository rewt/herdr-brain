import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configFixture } from './helpers/config-home-fixture.mjs';
import { readConfigJSON } from '../lib/config-home.mjs';
import { setConfig } from '../lib/config-command.mjs';
import { ROUTE_PRESET } from '../lanes/preset.mjs';

const lane = fileURLToPath(new URL('../lanes/lane.mjs', import.meta.url));
function effectiveRoot(f) {
  const output = execFileSync(process.execPath, [lane, 'config'], { cwd: f.cwd, env: f.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const row = output.split('\n').find(line => line.startsWith('worktree_root\t'));
  assert.ok(row, output);
  return JSON.parse(row.split('\t')[1]);
}
function parentWithoutRoot(f) {
  const file = path.join(f.ownerRoot, '.lane.json'), config = readConfigJSON(file);
  delete config.worktree_root;
  fs.writeFileSync(file, JSON.stringify(config));
}
function fleetEntry(f, worktrees) {
  fs.mkdirSync(f.env.HERDR_MONITOR_FLEET);
  fs.writeFileSync(path.join(f.env.HERDR_MONITOR_FLEET, 'fleet.json'), JSON.stringify({ version: 1, session_limit: 6,
    projects: { project: { identity: path.join(f.cwd, '.git'), checkout: f.cwd, record: f.env.ORG_DIR, worktrees,
      layers: [path.join(f.ownerRoot, '.lane.json')] } } }));
}

for (const fleet of [false, true]) test(`HUM-171: adopt preserves the project worktree_root with a parent lacking it, ${fleet ? 'with a stale legacy fleet entry' : 'without a fleet'}`, async t => {
  const f = configFixture(t, { custom: true });
  parentWithoutRoot(f);
  const base = path.join(f.scratch, 'worktrees', 'alex'), expected = path.join(base, 'project');
  const file = path.join(f.cwd, '.lane.json');
  fs.writeFileSync(file, JSON.stringify({ ...readConfigJSON(file), worktree_root: base }));
  if (fleet) fleetEntry(f, path.join(f.ownerRoot, '.worktrees/project'));
  const before = fs.readFileSync(file);
  assert.equal(effectiveRoot(f), expected, 'the lane open resolver uses the project setting');
  const captured = await f.capture();
  assert.equal(captured.scope.migration.sources.lane.path, file);
  assert.equal(captured.scope.migration.worktrees, expected);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(path.join(f.cwd, '.brain')), false, 'inspection never adopts the project');
});

for (const fleet of [false, true]) test(`adopt preserves Brain's parent-derived root with no worktree_root keys, ${fleet ? 'with' : 'without'} a fleet`, async t => {
  const f = configFixture(t, { custom: true });
  parentWithoutRoot(f);
  const expected = path.join(f.ownerRoot, '.worktrees/project');
  if (fleet) fleetEntry(f, expected);
  assert.equal(effectiveRoot(f), expected);
  assert.equal((await f.capture()).scope.migration.worktrees, expected);
});

test('adopt preserves a configured parent worktree root over a stale fleet mapping', async t => {
  const f = configFixture(t);
  fleetEntry(f, path.join(f.scratch, 'stale/project'));
  const expected = path.join(f.ownerRoot, 'parent-lanes/project');
  assert.equal(effectiveRoot(f), expected);
  assert.equal((await f.capture()).scope.migration.worktrees, expected);
});

test('adopt preserves LANE_WORKTREE_ROOT as the final per-project directory', async t => {
  const f = configFixture(t);
  f.env.LANE_WORKTREE_ROOT = '../selected-lanes';
  const expected = path.join(f.ownerRoot, 'selected-lanes');
  assert.equal(effectiveRoot(f), expected);
  assert.equal((await f.capture()).scope.migration.worktrees, expected);
});

for (const configured of [false, true]) test(`adopt preserves an explicit LANE_CONFIG ${configured ? 'worktree_root' : 'home fallback'}`, async t => {
  const f = configFixture(t), selected = path.join(f.scratch, 'selected.json');
  fs.writeFileSync(selected, JSON.stringify({ ...ROUTE_PRESET, ...(configured ? { worktree_root: 'selected-lanes' } : {}) }));
  f.env.LANE_CONFIG = selected;
  const expected = configured ? path.join(f.scratch, 'selected-lanes/project') : path.join(f.home, '.herdr/worktrees/project');
  assert.equal(effectiveRoot(f), expected);
  assert.equal((await f.capture()).scope.migration.worktrees, expected);
});

test('adopt inspect reports the current and migration worktree roots and names a later root change', async t => {
  const f = configFixture(t);
  const original = effectiveRoot(f), captured = await f.capture();
  assert.deepEqual(captured.worktrees, { current: original, migration: original, changed: false });
  await f.adopt();
  const selected = path.join(f.scratch, 'new-lanes');
  setConfig('worktree_root', JSON.stringify(selected), { cwd: f.cwd, env: f.env });
  const current = path.join(selected, 'project'), result = await f.capture();
  assert.equal(effectiveRoot(f), current);
  assert.deepEqual(result.worktrees, { current, migration: original, changed: true });
  assert.ok(result.warnings.some(warning => warning.includes('would change the lane worktree root') && warning.includes(current) && warning.includes(original)), result.warnings.join('\n'));
});
