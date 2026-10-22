import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { configFixture } from '../../test/helpers/config-home-fixture.mjs';
import { loadDiscoveredRoutes, mergeRoutesConfig, readRoutesSnapshot, resolveLaunchRoute } from '../routes.mjs';
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

test('fresh explicit files cannot launch through plain, orphaned, adjacent or mismatched snapshot claims', async t => {
  const f = configFixture(t, { custom: true, routing: true }); await f.adopt();
  const native = nativeFixture(f);
  assert.equal(loadDiscoveredRoutes({ cwd: f.cwd }).config.launch, undefined);
  const added = native.cli('bin/org.mjs', ['add', 'Refuse fresh routing', '--role', 'engineer']);
  assert.equal(added.status, 0, added.stderr);
  const item = added.stdout.match(/ENG-\d+/)[0];
  const token = '11111111-1111-4111-8111-111111111111';
  const directory = path.join(f.env.ORG_DIR, 'dispatch'), external = path.join(f.scratch, 'dispatch');
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(external);
  const snapshot = path.join(directory, `${token}.routes.json`), journal = path.join(directory, `${token}.json`);
  const bytes = JSON.stringify({ routes: { engineer: { kind: 'codex' } }, launch: native.prefix });
  const job = { token, repo: f.cwd, org: f.env.ORG_DIR, common: f.git('rev-parse', '--path-format=absolute', '--git-common-dir'),
    item, lane: 'launch-prefix', route: 'engineer', routeConfig: snapshot, stage: 'worker' };
  const files = [path.join(f.scratch, 'routing.json'), path.join(external, `${token}.routes.json`), snapshot];
  for (const file of files) fs.writeFileSync(file, bytes);
  fs.writeFileSync(path.join(external, `${token}.json`), JSON.stringify({ ...job, routeConfig: files[1] }));
  const refused = file => {
    const started = native.cli('bin/org.mjs', ['start', item, '--route', 'engineer', '--route-config', file]);
    assert.notEqual(started.status, 0, started.stdout);
    assert.match(started.stderr, /identity-only settings belong in identity.json/);
    const dispatched = native.dispatch(['--route-config', file]);
    assert.notEqual(dispatched.status, 0, dispatched.stdout);
    assert.match(dispatched.stderr, /identity-only settings belong in identity.json/);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  };
  for (const file of files) refused(file);
  for (const change of [{ common: f.scratch }, { org: f.scratch }, { repo: f.scratch }, { routeConfig: files[0] }, { token: 'different-job' }]) {
    fs.writeFileSync(journal, JSON.stringify({ ...job, ...change }));
    refused(snapshot);
  }
  assert.equal(f.events().some(e => e.type === 'run.started'), false);
  assert.equal(native.fake.calls().some(args => args[0] === 'agent' && args[1] === 'start'), false);
  assert.equal(fs.existsSync(native.log), false);
});

for (const mode of ['legacy', 'home', 'standalone']) for (const launch of [false, true]) {
  test(`${mode} fresh explicit routing uses current identity launch defaults ${launch ? 'when set' : 'when absent'}`, async t => {
    const f = configFixture(t, { custom: true, routing: mode === 'standalone' });
    const native = nativeFixture(f);
    const defaults = readConfigJSON(path.join(f.ownerRoot, '.lane.json'));
    if (launch) defaults.launch = native.prefix;
    fs.writeFileSync(path.join(f.ownerRoot, '.lane.json'), JSON.stringify(defaults));
    if (mode !== 'legacy') await f.adopt();
    const file = path.join(f.scratch, 'fresh.routes.json');
    fs.writeFileSync(file, JSON.stringify({ routes: { engineer: { kind: 'codex', model: 'explicit-project-model' } } }));
    const current = loadDiscoveredRoutes({ cwd: native.linked }).config;
    const selected = readRoutesSnapshot(file, { cwd: native.linked, env: f.env });
    assert.deepEqual(selected.launch, current.launch);
    const result = native.dispatch(['--route-config', file]);
    assert.equal(result.status, 0, result.stderr);
    const starts = native.fake.calls().filter(args => args[0] === 'agent' && args[1] === 'start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0][starts[0].indexOf('--model') + 1], 'explicit-project-model');
    assert.equal(fs.existsSync(native.log), launch);
    if (launch) assert.deepEqual(JSON.parse(fs.readFileSync(native.log, 'utf8').trim()).args, ['literal $(unchanged)', 'herdr', ...starts[0]]);
  });
}

for (const operation of ['dispatch', 'settle']) test(`admitted ${operation} route snapshots keep their launcher and metadata after identity and project defaults change`, async t => {
  const f = configFixture(t, { custom: true, routing: true }); await f.adopt();
  const native = nativeFixture(f);
  setConfig('launch', JSON.stringify(native.prefix), { cwd: f.cwd, scope: 'identity' });
  setConfig('routes.engineer.model', 'captured-model', { cwd: f.cwd });
  const directory = path.join(f.env.ORG_DIR, operation);
  fs.mkdirSync(directory, { recursive: true });
  const token = '22222222-2222-4222-8222-222222222222', id = operation === 'dispatch' ? token : 'R-1';
  const file = path.join(directory, `${id}.routes.json`), journal = path.join(directory, `${id}.json`);
  const bytes = JSON.stringify(mergeRoutesConfig([loadDiscoveredRoutes({ cwd: f.cwd }).config]));
  fs.writeFileSync(file, bytes);
  const job = JSON.stringify({ repo: operation === 'dispatch' ? native.linked : f.cwd, org: f.env.ORG_DIR, common: f.git('rev-parse', '--path-format=absolute', '--git-common-dir'),
    routeConfig: file, stage: operation === 'dispatch' ? 'worker' : 'review',
    ...(operation === 'dispatch' ? { token, route: 'engineer' } : { run: id, reviewRoute: 'engineer', fixRoute: 'engineer' }) });
  fs.writeFileSync(journal, job);
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
  assert.equal(fs.readFileSync(journal, 'utf8'), job);
});
