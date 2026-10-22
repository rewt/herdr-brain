import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { configFixture } from '../../test/helpers/config-home-fixture.mjs';
import { loadDiscoveredRoutes, mergeRoutesConfig, resolveLaunchRoute } from '../routes.mjs';
import { setConfig } from '../../lib/config-command.mjs';
import { readConfigJSON } from '../../lib/config-home.mjs';
import { writeFakeHerdr } from './lane-fixture.mjs';

function nativeFixture(f) {
  const linked = path.join(f.scratch, 'linked'), bin = path.join(f.scratch, 'bin');
  f.git('worktree', 'add', '-qb', 'lane/launch-prefix', linked);
  fs.mkdirSync(bin);
  f.env.PATH = `${bin}:${f.env.PATH}`;
  const fake = writeFakeHerdr({ root: f.scratch, repo: f.cwd, bin, env: f.env }, { lanePath: linked, branch: 'lane/launch-prefix', initiallyOpened: true });
  const log = path.join(f.scratch, 'prefix.jsonl'), script = path.join(f.scratch, 'identity-launch.mjs');
  fs.writeFileSync(script, `
    import { appendFileSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    const args = process.argv.slice(2);
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
    const result = spawnSync(args[1], args.slice(2), { stdio: 'inherit' });
    process.exit(result.status ?? 1);
  `);
  const prefix = [process.execPath, script, 'literal $(unchanged)'];
  const cli = (file, args) => spawnSync(process.execPath, [path.join(f.bundle, file), ...args], { cwd: linked, env: f.env, encoding: 'utf8' });
  const dispatch = extra => cli('lanes/lane.mjs', ['dispatch', 'launch-prefix', '--route', 'engineer', '--memory-checked', '--json', ...extra]);
  return { linked, fake, log, prefix, cli, dispatch };
}

for (const mode of ['legacy', 'home', 'standalone']) for (const launch of [false, true]) {
  test(`${mode} lane dispatch and discovered routes agree ${launch ? 'with' : 'without'} an identity launcher`, async t => {
    const f = configFixture(t, { custom: true, routing: mode === 'standalone' });
    const native = nativeFixture(f);
    const file = path.join(f.ownerRoot, '.lane.json');
    const defaults = readConfigJSON(file);
    if (launch) defaults.launch = native.prefix;
    fs.writeFileSync(file, JSON.stringify(defaults));
    if (mode !== 'legacy') {
      await f.adopt();
      assert.deepEqual(f.binding().defaults.launch, launch ? native.prefix : undefined);
    }
    const discovered = resolveLaunchRoute(loadDiscoveredRoutes({ cwd: native.linked }).config, { route: 'engineer' });
    assert.deepEqual(discovered.launch, launch ? native.prefix : undefined);
    const result = native.dispatch([]);
    assert.equal(result.status, 0, result.stderr);
    const starts = native.fake.calls().filter(args => args[0] === 'agent' && args[1] === 'start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0][starts[0].indexOf('--model') + 1], discovered.model);
    assert.equal(fs.existsSync(native.log), launch);
    if (launch) {
      const calls = fs.readFileSync(native.log, 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepEqual(calls, [{ args: ['literal $(unchanged)', 'herdr', ...starts[0]], cwd: native.linked }]);
    }
  });
}

test('admitted route snapshots keep their launcher and metadata after identity and project defaults change', async t => {
  const f = configFixture(t, { custom: true, routing: true }); await f.adopt();
  const native = nativeFixture(f);
  setConfig('launch', JSON.stringify(native.prefix), { cwd: f.cwd, scope: 'identity' });
  setConfig('routes.engineer.model', 'captured-model', { cwd: f.cwd });
  const file = path.join(f.scratch, 'admitted.routes.json');
  const bytes = JSON.stringify(mergeRoutesConfig([loadDiscoveredRoutes({ cwd: f.cwd }).config]));
  fs.writeFileSync(file, bytes);
  setConfig('launch', undefined, { cwd: f.cwd, scope: 'identity', unset: true });
  setConfig('routes.engineer.model', 'current-model', { cwd: f.cwd });
  assert.equal(loadDiscoveredRoutes({ cwd: f.cwd }).config.launch, undefined);
  const added = native.cli('bin/org.mjs', ['add', 'Resume admitted routing', '--role', 'engineer']);
  assert.equal(added.status, 0, added.stderr);
  const item = added.stdout.match(/ENG-\d+/)[0];
  const started = native.cli('bin/org.mjs', ['start', item, '--route', 'engineer', '--route-config', file]);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /captured-model/);
  const result = native.dispatch(['--route-config', file]);
  assert.equal(result.status, 0, result.stderr);
  const starts = native.fake.calls().filter(args => args[0] === 'agent' && args[1] === 'start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0][starts[0].indexOf('--model') + 1], 'captured-model');
  const call = JSON.parse(fs.readFileSync(native.log, 'utf8').trim());
  assert.deepEqual(call.args, ['literal $(unchanged)', 'herdr', ...starts[0]]);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});
