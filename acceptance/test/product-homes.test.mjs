import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harnessEnvironment } from '../run.mjs';
import { scratchProductHomes, assertScratchHomes, scratchFixtureCommand, enterScratchHomes } from '../environment.mjs';
import { fleetPath } from '../../lib/fleet.mjs';

const source = path.resolve(import.meta.dirname, '../..');
function fixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync('/tmp/ah-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'scratch'), realHome = path.join(parent, 'operator');
  fs.mkdirSync(root); fs.mkdirSync(realHome);
  const input = { ...process.env, ...scratchProductHomes(realHome, realHome), HOME: realHome };
  return { root, realHome, input };
}

test('entry case environment bootstraps only the scratch fleet despite inherited operator homes', t => {
  const { root, realHome, input } = fixture(t), env = harnessEnvironment(input, root);
  assert.equal(fleetPath(env), path.join(root, 'f/fleet.json'));
  for (const key of Object.keys(scratchProductHomes(root))) assert.ok(env[key].startsWith(root + path.sep), key);
  const repo = path.join(root, 'entry-project'); fs.mkdirSync(repo); fs.mkdirSync(env.HOME);
  const run = (file, args) => {
    const result = spawnSync(file, args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.error?.message); return result.stdout;
  };
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid']]) run('git', args);
  fs.writeFileSync(path.join(repo, 'seed'), 'pristine'); run('git', ['add', '.']); run('git', ['commit', '-qm', 'Seed']);
  run(process.execPath, [path.join(source, 'discovery/adapters/codex.mjs'), '--repo', repo, '--binary', '/usr/bin/true', '--role', 'supervisor', '--policy-only']);
  const fleet = JSON.parse(fs.readFileSync(fleetPath(env), 'utf8'));
  assert.equal(fleet.projects['entry-project'].checkout, repo);
  assert.ok(fleet.projects['entry-project'].worktrees.startsWith(root + path.sep));
  assert.deepEqual(fs.readdirSync(realHome), [], 'simulated operator home is untouched');
});

test('case guard refuses real-home fleet resolution and symlink redirects before product execution', t => {
  const { root, realHome, input } = fixture(t), env = harnessEnvironment(input, root);
  const guard = selected => assertScratchHomes(selected, [root], { realHome, fleetFile: fleetPath(selected) });
  assert.equal(guard(env), env);
  assert.throws(() => guard({ ...env, HERDR_MONITOR_FLEET: path.join(realHome, '.herdr-monitor') }), /real home/);
  assert.throws(() => assertScratchHomes(env, [root], { realHome, fleetFile: path.join(realHome, '.herdr-monitor/fleet.json') }), /real home/);
  assert.throws(() => guard({ ...env, HERDR_MONITOR_FLEET: '' }), /explicit scratch fleet/);
  fs.symlinkSync(realHome, path.join(root, 'alias'));
  assert.throws(() => guard({ ...env, HERDR_MONITOR_FLEET: path.join(root, 'alias/fleet') }), /real home/);
  for (const key of Object.keys(scratchProductHomes(root))) {
    assert.throws(() => guard({ ...env, [key]: path.join(realHome, 'escaped') }), /real home/, key);
  }
  assert.deepEqual(fs.readdirSync(realHome), []);
});

test('delegated scratch cases restore product homes after their fixture scrubs machine variables', t => {
  const { root, input } = fixture(t), home = path.join(root, 'home');
  const execute = scratchFixtureCommand((file, args, options) => {
    assert.equal(fleetPath(options.env), path.join(root, 'f/fleet.json'));
    for (const key of Object.keys(scratchProductHomes(root))) assert.ok(options.env[key].startsWith(root + path.sep), key);
    assert.equal(options.env.ORG_ACTOR, 'scratch-worker');
    return { status: 0 };
  });
  assert.equal(execute('node', [], { env: { ...input, HOME: home, ORG_ACTOR: 'scratch-worker', HERDR_MONITOR_FLEET: undefined } }).status, 0);
});

test('in-process cases use the real fleetPath under scratch homes and restore the caller after failure', t => {
  const { root, realHome, input } = fixture(t), env = harnessEnvironment(input, root);
  const before = Object.fromEntries(Object.keys(scratchProductHomes(root)).map(key => [key, process.env[key]]));
  assert.throws(() => {
    const restore = enterScratchHomes(env, [root], { realHome, fleetFile: fleetPath(env) });
    try {
      assert.equal(fleetPath(), path.join(root, 'f/fleet.json'));
      assert.equal(process.env.HOME, env.HOME);
      throw Error('injected case failure');
    } finally { restore(); }
  }, /injected case failure/);
  for (const [key, value] of Object.entries(before)) assert.equal(process.env[key], value, key);
});
