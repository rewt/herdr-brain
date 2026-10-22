import test from './helpers/bounded-test.mjs';
import { spawnChild, waitForExit } from './helpers/child.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { findOrgDir, initOrg, loadEvents } from '../lib/store.mjs';
import { loadDiscoveredRoutes, resolveLaunchRoute } from '../lanes/routes.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { projectFleet, readFleet, checkFleetRecord } from '../lib/fleet.mjs';
import { gitProject } from '../lib/project.mjs';
import { discoverArchive } from '../lib/archive.mjs';
import { configFixture } from './helpers/config-home-fixture.mjs';

const root = new URL('../', import.meta.url).pathname;
const client = path.join(root, 'discovery/client.mjs');
function fixture(t) {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'ft-'));
  const fleetHome = path.join(scratch, 'fleet'), consoleFile = path.join(scratch, 'console.json');
  const env = { ...process.env, HERDR_MONITOR_FLEET: fleetHome, HERDR_ORG_CONSOLE_CONFIG: consoleFile, ORG_DIR: '' };
  const before = { ...process.env };
  const entries = [];
  Object.assign(process.env, env);
  t.after(() => { for (const entry of entries) entry.close(); for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]; Object.assign(process.env, before); fs.rmSync(scratch, { recursive: true, force: true }); });
  const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  function repo(name) {
    const cwd = path.join(scratch, name); fs.mkdirSync(cwd, { recursive: true });
    git(cwd, ['init', '-q', '-b', 'main']); git(cwd, ['config', 'user.name', 'Fleet test']); git(cwd, ['config', 'user.email', 'fleet@example.invalid']);
    fs.writeFileSync(path.join(cwd, 'README.md'), 'fixture\n'); git(cwd, ['add', '.']); git(cwd, ['commit', '-qm', 'Seed']);
    return cwd;
  }
  const run = (cwd, args) => spawnSync(process.execPath, [client, 'fleet', ...args], { cwd, env, encoding: 'utf8' });
  const join = (cwd, args = []) => { const r = run(cwd, ['join', ...args]); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const read = () => JSON.parse(fs.readFileSync(path.join(fleetHome, 'fleet.json'), 'utf8'));
  return { scratch, fleetHome, consoleFile, env, git, repo, run, join, read, keep: entry => entries.push(entry) };
}

test('a generated home key cannot replace an unrelated legacy fleet mapping', async t => {
  const f = configFixture(t); await f.adopt();
  const binding = f.binding(), name = `${binding.identity}/${binding.project}`;
  const other = path.join(f.scratch, 'legacy'); fs.mkdirSync(other);
  execFileSync('git', ['init', '-qb', 'main', other], { env: f.env });
  const legacy = { identity: path.join(other, '.git'), checkout: other, record: path.join(other, '.org'), worktrees: path.join(f.scratch, 'legacy-lanes'), layers: [] };
  initOrg(legacy.record);
  const file = path.join(f.env.HERDR_MONITOR_FLEET, 'fleet.json'); fs.mkdirSync(path.dirname(file));
  const fleet = { version: 1, session_limit: 6, projects: { [name]: legacy } };
  fs.writeFileSync(file, JSON.stringify(fleet));
  const files = [file, binding.file, binding.identityFile], bytes = files.map(file => fs.readFileSync(file));
  for (const read of [() => readFleet(f.env), () => projectFleet(f.cwd, f.env), () => checkFleetRecord(binding.record, f.env)]) {
    assert.throws(read, error => {
      assert.match(error.message, /fleet key collision/);
      for (const fact of [name, file, legacy.identity, binding.common]) assert.ok(error.message.includes(fact), error.message);
      return true;
    });
    assert.deepEqual(files.map(file => fs.readFileSync(file)), bytes, 'both durable mappings survive the refused union');
  }
  fs.writeFileSync(file, JSON.stringify({ ...fleet, projects: { legacy } }));
  const discovered = readFleet(f.env).projects;
  assert.deepEqual(discovered.legacy, legacy);
  assert.equal(discovered[name].identity, binding.common);
  assert.equal(Object.keys(discovered).length, 2);
});

test('a legacy mapping rechecks its record against an invalid home ownership claim', async t => {
  const f = configFixture(t); await f.adopt();
  const binding = f.binding(), raw = JSON.parse(fs.readFileSync(binding.file, 'utf8'));
  const cwd = path.join(f.scratch, 'legacy-project');
  execFileSync('git', ['clone', '-q', f.cwd, cwd], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const record = path.join(cwd, '.org'); initOrg(record);
  const project = { identity: path.join(cwd, '.git'), checkout: cwd, record, worktrees: path.join(f.scratch, 'legacy-lanes'), layers: [] };
  const file = path.join(f.env.HERDR_MONITOR_FLEET, 'fleet.json'); fs.mkdirSync(path.dirname(file));
  const write = selected => fs.writeFileSync(file, JSON.stringify({ version: 1, session_limit: 6, projects: { legacy: { ...project, record: selected } } }));
  const env = { ...f.env, ORG_DIR: undefined };
  fs.writeFileSync(binding.file, JSON.stringify({ ...raw, adoption: { ...raw.adoption, scope_file: 'relative' } }));
  write(record);
  assert.equal(projectFleet(cwd, env).project.record, record);
  assert.equal(findOrgDir({ cwd, env }), record);
  const alias = path.join(f.scratch, 'shared-record'); fs.symlinkSync(binding.record, alias, 'dir');
  const before = fs.readFileSync(path.join(binding.record, 'events.jsonl'));
  write(alias);
  const error = `${binding.file}: invalid config-home-project/v1 binding`;
  assert.throws(() => projectFleet(cwd, env), { message: error });
  assert.throws(() => findOrgDir({ cwd, env }), { message: error });
  const run = spawnSync(process.execPath, [path.join(f.bundle, 'bin/org.mjs'), 'snapshot'], { cwd, env, encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr); assert.ok(run.stderr.includes(error), run.stderr);
  assert.deepEqual(fs.readFileSync(path.join(binding.record, 'events.jsonl')), before);
  write(record);
  assert.equal(findOrgDir({ cwd, env }), record);
});


test('concurrent joins publish one complete fleet with both projects', async t => {
  const f = fixture(t), a = f.repo('a'), b = f.repo('b');
  const jobs = [a, b].map(cwd => waitForExit(spawnChild(t, process.execPath,
    [client, 'fleet', 'join'],
    { cwd, env: f.env })));
  const results = await Promise.all(jobs);
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  const fleet = f.read(); assert.deepEqual(Object.keys(fleet.projects).sort(), ['a', 'b']);
  assert.notEqual(fleet.projects.a.record, fleet.projects.b.record);
  for (const p of Object.values(fleet.projects)) {
    assert.ok(fs.existsSync(path.join(p.record, 'events.jsonl')));
    assert.ok(path.isAbsolute(p.worktrees));
  }
});

test('join is a byte and mtime no-op from a linked checkout; session limit changes only through join', t => {
  const f = fixture(t), cwd = f.repo('app'); f.join(cwd);
  assert.equal(f.git(cwd, ['status', '--porcelain']), '', 'joining keeps runtime state out of Git');
  const file = path.join(f.fleetHome, 'fleet.json'), bytes = fs.readFileSync(file), mtime = fs.statSync(file).mtimeMs;
  const lane = path.join(f.scratch, 'linked'); f.git(cwd, ['worktree', 'add', '-qb', 'lane/test', lane]);
  f.join(lane); assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.equal(findOrgDir({ cwd: lane, env: f.env }), f.read().projects.app.record);
  f.join(cwd, ['--session-limit', '1']); assert.equal(f.read().session_limit, 1);
  const record = spawnSync(process.execPath, [path.join(root, 'bin/org.mjs'), 'add', 'Work proceeds'], { cwd: lane, env: { ...f.env, ORG_ACTOR: 'fleet-test' }, encoding: 'utf8' });
  assert.equal(record.status, 0, record.stderr);
  assert.notEqual(f.run(cwd, ['join', '--session-limit', '0']).status, 0);
});

test('record discovery uses its explicit Git environment with and without a fleet', t => {
  const f = fixture(t), cwd = f.repo('explicit-env'); f.join(cwd);
  const lane = path.join(f.scratch, 'lane'); f.git(cwd, ['worktree', 'add', '-qb', 'lane/env', lane]);
  const safe = Object.fromEntries(Object.entries(f.env).filter(([key]) => !key.startsWith('GIT_')));
  process.env.GIT_DIR = path.join(f.scratch, 'foreign.git');
  process.env.GIT_CONFIG_COUNT = 'invalid';
  const expected = f.read().projects['explicit-env'].record;
  assert.equal(projectFleet(lane, safe).project.record, expected);
  assert.equal(findOrgDir({ cwd: lane, env: safe }), expected);
  assert.equal(findOrgDir({ cwd: lane, env: { ...safe, HERDR_MONITOR_FLEET: path.join(f.scratch, 'no-fleet') } }), expected);
});

test('moved checkout remains stale in fleet instead of being guessed by name', t => {
  const f = fixture(t), cwd = f.repo('app'); f.join(cwd);
  const bytes = fs.readFileSync(path.join(f.fleetHome, 'fleet.json'));
  fs.renameSync(cwd, path.join(f.scratch, 'moved'));
  const r = f.run(f.scratch, ['show']); assert.equal(r.status, 0, r.stderr);
  const view = JSON.parse(r.stdout); assert.equal(view.projects.app.stale, true);
  assert.deepEqual(fs.readFileSync(path.join(f.fleetHome, 'fleet.json')), bytes);
});

for (const change of ['moved', 're-cloned']) test(`a ${change} default-record checkout joins automatically without claiming the stale same-name entry`, t => {
  const f = fixture(t), cwd = f.repo('app'), original = f.join(cwd).project;
  const recordFile = path.join(cwd, '.org/events.jsonl');
  execFileSync(process.execPath, [path.join(root, 'bin/org.mjs'), 'add', 'Original work'], { cwd, env: { ...f.env, ORG_ACTOR: 'fleet-test' } });
  const recordBytes = fs.readFileSync(recordFile);
  const parent = path.join(f.scratch, 'relocated'); fs.mkdirSync(parent);
  const entered = path.join(parent, 'app');
  if (change === 'moved') fs.renameSync(cwd, entered);
  else {
    const backup = path.join(f.scratch, 'original'); fs.renameSync(cwd, backup);
    f.git(f.scratch, ['clone', '-q', backup, entered]);
    f.git(entered, ['config', 'user.name', 'Fleet test']); f.git(entered, ['config', 'user.email', 'fleet@example.invalid']);
  }
  const file = path.join(f.fleetHome, 'fleet.json'), before = fs.readFileSync(file);
  assert.equal(JSON.parse(f.run(f.scratch, ['show']).stdout).projects.app.stale, true);
  assert.deepEqual(fs.readFileSync(file), before, 'viewing a moved project never repairs it');
  const joined = f.join(entered);
  assert.notEqual(joined.name, 'app'); assert.equal(joined.project.checkout, entered);
  assert.equal(joined.project.identity, fs.realpathSync(path.join(entered, '.git')));
  assert.equal(joined.project.record, path.join(entered, '.org'));
  assert.notEqual(joined.project.worktrees, original.worktrees);
  assert.deepEqual(f.read().projects.app, original, 'a name match never transfers the old mapping');
  assert.equal(Object.keys(f.read().projects).length, 2);
  assert.equal(findOrgDir({ cwd: entered, env: f.env }), joined.project.record);
  assert.deepEqual(fs.readFileSync(path.join(joined.project.record, 'events.jsonl')), change === 'moved' ? recordBytes : Buffer.alloc(0));
  const shown = JSON.parse(f.run(f.scratch, ['show']).stdout).projects;
  assert.equal(shown.app.stale, true); assert.equal(shown[joined.name].stale, false);
  const bytes = fs.readFileSync(file), mtime = fs.statSync(file).mtimeMs;
  f.join(entered); assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.equal(projectFleet(entered, f.env).project.record, joined.project.record);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('explicit replacement remaps the default checkout record by its relative path', t => {
  const f = fixture(t), cwd = f.repo('app'), record = path.join(cwd, '.org');
  const original = f.join(cwd).project, recordBytes = fs.readFileSync(path.join(record, 'events.jsonl'));
  const moved = path.join(f.scratch, 'moved'); fs.renameSync(cwd, moved);
  const mappedRecord = path.join(moved, '.org'), backup = path.join(f.scratch, 'record-backup');
  fs.renameSync(mappedRecord, backup);
  const file = path.join(f.fleetHome, 'fleet.json'), before = fs.readFileSync(file);
  const missing = f.run(moved, ['join', '--replace', 'app']);
  assert.notEqual(missing.status, 0); assert.match(missing.stderr, /record.*missing/);
  assert.equal(fs.existsSync(mappedRecord), false); assert.deepEqual(fs.readFileSync(file), before);
  fs.renameSync(backup, mappedRecord);
  const repaired = f.join(moved, ['--replace', 'app']);
  assert.equal(repaired.name, 'app'); assert.equal(repaired.project.checkout, moved);
  assert.equal(repaired.project.record, mappedRecord);
  for (const key of ['worktrees', 'temp', 'layers']) assert.deepEqual(repaired.project[key], original[key]);
  assert.equal(Object.keys(f.read().projects).length, 1);
  assert.equal(findOrgDir({ cwd: moved, env: f.env }), mappedRecord);
  assert.deepEqual(fs.readFileSync(path.join(mappedRecord, 'events.jsonl')), recordBytes);
  const bytes = fs.readFileSync(file), mtime = fs.statSync(file).mtimeMs;
  f.join(moved, ['--replace', 'app']); f.join(moved);
  assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(fs.statSync(file).mtimeMs, mtime);
});

test('a re-clone in place can explicitly replace a missing native record', t => {
  const f = fixture(t), cwd = f.repo('app');
  const original = f.join(cwd).project;
  const backup = path.join(f.scratch, 'backup'); fs.renameSync(cwd, backup);
  f.git(f.scratch, ['clone', '-q', backup, cwd]);
  const record = path.join(cwd, 'restored-record'); fs.cpSync(path.join(backup, '.org'), record, { recursive: true });
  const file = path.join(f.fleetHome, 'fleet.json'), before = fs.readFileSync(file), recordBytes = fs.readFileSync(path.join(record, 'events.jsonl'));
  assert.notEqual(f.run(cwd, ['join', '--replace', 'app']).status, 0, 'missing records are never invented during replacement');
  const other = f.repo('other'), ownedRecord = f.join(other).project.record;
  const withOther = fs.readFileSync(file);
  assert.notEqual(f.run(cwd, ['join', '--replace', 'app', '--record', ownedRecord]).status, 0, 'replacement cannot take another project record');
  assert.deepEqual(fs.readFileSync(file), withOther);
  const repaired = f.join(cwd, ['--replace', 'app', '--record', record]);
  assert.equal(repaired.name, 'app'); assert.equal(repaired.project.checkout, cwd);
  assert.equal(repaired.project.identity, original.identity, 'Git common-directory identity is a canonical path');
  assert.equal(repaired.project.record, record);
  assert.equal(findOrgDir({ cwd, env: f.env }), record);
  assert.deepEqual(fs.readFileSync(path.join(record, 'events.jsonl')), recordBytes);
  assert.equal(fs.existsSync(path.join(cwd, '.org')), false);
  assert.notDeepEqual(fs.readFileSync(file), before);
});




test('explicit adoption maps paths and settings; record ownership cannot be duplicated', t => {
  const f = fixture(t), cwd = f.repo('app'), other = f.repo('other'), record = path.join(f.scratch, 'old-record'); initOrg(record);
  const layer = path.join(f.scratch, '.lane.json'); fs.writeFileSync(layer, JSON.stringify({ routes: { engineer: { kind: 'opaque', model: 'owned' } } }));
  const worktrees = path.join(f.scratch, 'old-lanes'), temp = path.join(f.scratch, 'old-temp');
  f.join(cwd, ['--record', record, '--worktrees', worktrees, '--temp', temp, '--layer', layer]);
  assert.equal(loadDiscoveredRoutes({ cwd, env: f.env }).config.routes.engineer.model, 'owned');
  const p = f.read().projects.app; assert.equal(p.worktrees, worktrees); assert.equal(p.temp, undefined); assert.equal(p.identity, fs.realpathSync(path.join(cwd, '.git')));
  assert.notEqual(f.run(other, ['join', '--record', record]).status, 0);
  assert.equal(Object.keys(f.read().projects).length, 1);
});

test('without a fleet file legacy ancestor discovery and console configuration are unchanged', t => {
  const f = fixture(t), cwd = f.repo('app'), record = path.join(f.scratch, '.org'); initOrg(record);
  const layer = path.join(f.scratch, '.lane.json'); fs.writeFileSync(layer, JSON.stringify({ routes: { engineer: { model: 'legacy' } } }));
  const legacyConfig = JSON.stringify({ projects: [{ name: 'legacy', cwd, org: record }] });
  fs.writeFileSync(f.consoleFile, legacyConfig);
  assert.equal(findOrgDir({ cwd, env: f.env }), record);
  assert.deepEqual(loadDiscoveredRoutes({ cwd, env: f.env }).files, [layer]);
  assert.equal(fs.readFileSync(f.consoleFile, 'utf8'), legacyConfig);
  assert.equal(fs.existsSync(f.fleetHome), false);
});

for (const moved of [false, true]) test(`a ${moved ? 'moved' : 'unmoved'} existing project keeps its layout when another project creates the fleet`, t => {
  const f = fixture(t);
  let cwd = f.repo('existing/app');
  const parent = path.dirname(cwd), record = path.join(parent, '.org'), layer = path.join(parent, '.lane.json');
  initOrg(record);
  fs.writeFileSync(layer, JSON.stringify({ worktree_root: moved ? 'worktrees' : undefined, always_args: { codex: ['-p', 'trusted-project'] }, routes: { engineer: { kind: 'codex', model: 'project-model' } } }));
  fs.writeFileSync(path.join(cwd, '.lane.json'), JSON.stringify({ routes: { reviewer: { kind: 'claude', model: 'project-review' } } }));
  if (moved) {
    cwd = path.join(parent, "moved app's checkout");
    fs.renameSync(path.join(parent, 'app'), cwd);
  }
  const expectedRecord = findOrgDir({ cwd, env: f.env });
  const expectedRoutes = loadDiscoveredRoutes({ cwd, env: f.env });
  const laneConfig = () => spawnSync(process.execPath, [path.join(root, 'lanes/lane.mjs'), 'config'], { cwd, env: f.env, encoding: 'utf8' });
  const beforeConfig = laneConfig(); assert.equal(beforeConfig.status, 0, beforeConfig.stderr);
  const recordBytes = fs.readFileSync(path.join(record, 'events.jsonl'));
  f.join(f.repo('other'));
  const fleetFile = path.join(f.fleetHome, 'fleet.json'), fleetBytes = fs.readFileSync(fleetFile);
  assert.equal(findOrgDir({ cwd, env: f.env }), expectedRecord);
  assert.deepEqual(loadDiscoveredRoutes({ cwd, env: f.env }), expectedRoutes);
  const afterConfig = laneConfig(); assert.equal(afterConfig.status, 0, afterConfig.stderr);
  assert.equal(afterConfig.stdout, beforeConfig.stdout);
  assert.match(afterConfig.stderr, /monitor fleet join --record/u);
  assert.ok(afterConfig.stderr.includes(record)); assert.ok(afterConfig.stderr.includes(layer));
  const bareJoin = f.run(cwd, ['join']); assert.notEqual(bareJoin.status, 0); assert.match(bareJoin.stderr, /explicit adoption/u);
  assert.deepEqual(fs.readFileSync(fleetFile), fleetBytes, 'reads do not register the existing project');
  assert.deepEqual(fs.readFileSync(path.join(record, 'events.jsonl')), recordBytes);
  assert.equal(fs.existsSync(path.join(cwd, '.org')), false);
  const quoted = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = afterConfig.stderr.trim().split(' with ').at(-1);
  const joined = spawnSync('/bin/sh', ['-c', command.replace(/^monitor/, '"$FLEET_TEST_NODE" "$FLEET_TEST_CLIENT"')], {
    cwd, env: { ...f.env, FLEET_TEST_NODE: process.execPath, FLEET_TEST_CLIENT: client }, encoding: 'utf8',
  });
  assert.equal(joined.status, 0, joined.stderr);
  const mapping = JSON.parse(joined.stdout).project;
  assert.equal(mapping.record, record); assert.deepEqual(mapping.layers, [layer]);
  assert.equal(mapping.worktrees, path.join(parent, moved ? 'worktrees' : '.worktrees', path.basename(cwd)));
  assert.deepEqual(loadDiscoveredRoutes({ cwd, env: f.env }), expectedRoutes);
  const linked = path.join(f.scratch, 'linked'); f.git(cwd, ['worktree', 'add', '-qb', 'lane/existing', linked]);
  assert.equal(findOrgDir({ cwd: linked, env: f.env }), record);
  assert.deepEqual(loadDiscoveredRoutes({ cwd: linked, env: f.env }).files, expectedRoutes.files);
  assert.ok(afterConfig.stderr.includes(quoted(mapping.worktrees)));
});




for (const moved of [false, true]) test(`explicit external ORG_DIR preserves the ${moved ? 'moved' : 'unmoved'} unjoined layout until adoption`, t => {
  const f = fixture(t);
  let cwd = f.repo('existing/app');
  const record = path.join(f.scratch, 'records', 'external'), parent = path.dirname(cwd), layer = path.join(parent, '.lane.json'); initOrg(record);
  fs.writeFileSync(layer, JSON.stringify({ worktree_root: 'existing-worktrees', always_args: { codex: ['-p', 'trusted-project'] }, routes: { engineer: { model: 'existing-route' } } }));
  if (moved) { const destination = path.join(parent, "moved app's checkout"); fs.renameSync(cwd, destination); cwd = destination; }
  f.env.ORG_DIR = record; process.env.ORG_DIR = record;
  const routes = loadDiscoveredRoutes({ cwd, env: f.env });
  const laneConfig = () => spawnSync(process.execPath, [path.join(root, 'lanes/lane.mjs'), 'config'], { cwd, env: f.env, encoding: 'utf8' });
  const beforeConfig = laneConfig(); assert.equal(beforeConfig.status, 0, beforeConfig.stderr);
  const recordBytes = fs.readFileSync(path.join(record, 'events.jsonl'));
  const other = f.repo('other'), joinedOther = f.join(other);
  assert.equal(joinedOther.project.record, path.join(other, '.org'), 'entry must not adopt an inherited ORG_DIR');
  const fleetFile = path.join(f.fleetHome, 'fleet.json'), fleetBytes = fs.readFileSync(fleetFile);
  assert.equal(findOrgDir({ cwd, env: f.env }), record);
  assert.deepEqual(loadDiscoveredRoutes({ cwd, env: f.env }), routes);
  const afterConfig = laneConfig(); assert.equal(afterConfig.status, 0, afterConfig.stderr); assert.equal(afterConfig.stdout, beforeConfig.stdout);
  assert.match(afterConfig.stderr, /monitor fleet join --record/u); assert.ok(afterConfig.stderr.includes(record)); assert.ok(afterConfig.stderr.includes(layer));
  const bareJoin = f.run(cwd, ['join']); assert.notEqual(bareJoin.status, 0); assert.match(bareJoin.stderr, /explicit adoption/u);
  assert.deepEqual(fs.readFileSync(fleetFile), fleetBytes); assert.deepEqual(fs.readFileSync(path.join(record, 'events.jsonl')), recordBytes);
  assert.equal(fs.existsSync(path.join(cwd, '.org')), false);
  const command = afterConfig.stderr.trim().split(' with ').at(-1);
  const adopted = spawnSync('/bin/sh', ['-c', command.replace(/^monitor/, '"$FLEET_TEST_NODE" "$FLEET_TEST_CLIENT"')], {
    cwd, env: { ...f.env, FLEET_TEST_NODE: process.execPath, FLEET_TEST_CLIENT: client }, encoding: 'utf8',
  });
  assert.equal(adopted.status, 0, adopted.stderr);
  const mapping = JSON.parse(adopted.stdout).project;
  assert.equal(mapping.record, record); assert.deepEqual(mapping.layers, [layer]); assert.equal(mapping.worktrees, path.join(parent, 'existing-worktrees', path.basename(cwd)));
  assert.deepEqual(loadDiscoveredRoutes({ cwd, env: f.env }), routes);
});

for (const alias of [false, true]) test(`a neighbor with its own record cannot inherit another project's mapped parent layer${alias ? ' through an alias' : ''}`, t => {
  const f = fixture(t), owner = f.repo('shared/owner'), neighbor = f.repo('shared/neighbor');
  const layer = path.join(path.dirname(owner), '.lane.json'), record = path.join(neighbor, '.org'); initOrg(record);
  const selectedLayer = alias ? path.join(f.scratch, 'owned-layer.json') : layer;
  fs.writeFileSync(selectedLayer, JSON.stringify({ worktree_root: 'private-worktrees', validate: 'private-validator',
    always_args: { codex: ['-p', 'private-memory'] }, archive: { dirs: ['private-archive'] }, routes: { engineer: { model: 'private-route' } } }));
  if (alias) fs.symlinkSync(selectedLayer, layer);
  f.join(owner, ['--layer', layer]);
  const before = fs.readFileSync(path.join(record, 'events.jsonl'));
  assert.equal(findOrgDir({ cwd: neighbor, env: f.env }), record);
  assert.equal(projectFleet(neighbor, f.env).legacy, null);
  const routes = loadDiscoveredRoutes({ cwd: neighbor, env: f.env }); assert.deepEqual(routes.files, []); assert.equal(routes.suggested, true);
  assert.deepEqual(discoverArchive({ cwd: neighbor, env: f.env }).dirs, []);
  const config = spawnSync(process.execPath, [path.join(root, 'lanes/lane.mjs'), 'config'], { cwd: neighbor, env: f.env, encoding: 'utf8' });
  assert.equal(config.status, 0, config.stderr); assert.doesNotMatch(config.stdout, /private-route|private-memory|private-validator|private-worktrees/u);
  // Entry also joins independently, without adopting the parent's settings or worktrees.
  const automatic = f.repo('shared/automatic'); initOrg(path.join(automatic, '.org'));
  const automaticProject = f.join(automatic).project;
  assert.deepEqual(f.read().projects.automatic.layers, []); assert.notEqual(automaticProject.worktrees, path.join(path.dirname(layer), 'private-worktrees', 'automatic'));
  // Explicit --layer adoption is the way to share a mapped layer while keeping a distinct record.
  f.join(neighbor, ['--record', record, '--layer', layer]);
  assert.deepEqual(loadDiscoveredRoutes({ cwd: neighbor, env: f.env }).files, [selectedLayer]);
  assert.equal(loadDiscoveredRoutes({ cwd: neighbor, env: f.env }).config.routes.engineer.model, 'private-route');
  assert.deepEqual(discoverArchive({ cwd: neighbor, env: f.env }).dirs, [path.join(path.dirname(selectedLayer), 'private-archive')]);
  assert.equal(findOrgDir({ cwd: neighbor, env: f.env }), record); assert.deepEqual(fs.readFileSync(path.join(record, 'events.jsonl')), before);
});

test('legacy record discovery keeps its symlink path and does not depend on valid parent settings', t => {
  const f = fixture(t), cwd = f.repo('legacy/app'), record = path.join(f.scratch, 'external'); initOrg(record);
  const alias = path.join(path.dirname(cwd), '.org'), layer = path.join(path.dirname(cwd), '.lane.json');
  fs.symlinkSync(record, alias); fs.writeFileSync(layer, '{');
  assert.equal(findOrgDir({ cwd, env: f.env }), alias);
  assert.throws(() => loadDiscoveredRoutes({ cwd, env: f.env }), /route config/u);
  f.join(f.repo('other'));
  assert.equal(findOrgDir({ cwd, env: f.env }), alias);
  assert.throws(() => loadDiscoveredRoutes({ cwd, env: f.env }), /route config/u);
});

test('fleet-present unjoined discovery terminates outside GIT_WORK_TREE and ignores outside records', t => {
  const f = fixture(t), cwd = f.repo('unjoined'), outside = path.join(f.scratch, 'outside');
  fs.mkdirSync(outside); fs.mkdirSync(f.fleetHome);
  fs.writeFileSync(path.join(f.fleetHome, 'fleet.json'), JSON.stringify({ version: 1, session_limit: 6, projects: {} }));
  const record = path.join(cwd, '.org'); initOrg(record);
  const code = `import {findOrgDir} from ${JSON.stringify(path.join(root, 'lib/store.mjs'))}; console.log(JSON.stringify(findOrgDir()));`;
  const probe = () => spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: outside, env: { ...f.env, GIT_DIR: path.join(cwd, '.git'), GIT_WORK_TREE: cwd }, encoding: 'utf8', timeout: 2000,
  });
  for (const outsideRecord of [false, true]) {
    if (outsideRecord) initOrg(path.join(outside, '.org'));
    const result = probe();
    assert.equal(result.error, undefined, 'discovery must terminate at the filesystem root');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), record, 'only the selected checkout record may be used');
  }
  const nested = path.join(cwd, 'nested'); fs.mkdirSync(nested);
  assert.equal(findOrgDir({ cwd: nested, env: f.env }), record);
});


test('join adopts a legacy console.json mapping without writing its record', t => {
  const f = fixture(t), cwd = f.repo('app'), legacy = f.repo('bch-cloak'), record = path.join(f.scratch, 'legacy-record');
  initOrg(record);
  fs.writeFileSync(f.consoleFile, JSON.stringify({ projects: [
    { name: 'old-app-name', cwd, org: path.join(cwd, '.org'), session_cap: 17 },
    { name: 'bch-cloak', cwd: legacy, org: record, session_cap: 23 },
  ], glyphs: 'plain' }));
  f.join(cwd);
  const recordBytes = fs.readFileSync(path.join(record, 'events.jsonl'));
  assert.equal(fs.existsSync(path.join(legacy, '.org')), false);
  f.join(legacy);
  assert.equal(f.read().projects['bch-cloak'].record, fs.realpathSync(record));
  assert.equal(Object.keys(f.read().projects).length, 2);
  assert.deepEqual(fs.readFileSync(path.join(record, 'events.jsonl')), recordBytes);
  assert.equal(fs.existsSync(path.join(legacy, '.org')), false);
});

test('explicit ORG_DIR isolates unrelated settings without launching Git on record commands', t => {
  const f = fixture(t), cwd = f.repo('app'); f.join(cwd);
  f.join(f.repo('other'));
  const record = f.read().projects.app.record, bin = path.join(f.scratch, 'bin'), marker = path.join(f.scratch, 'git-ran');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\n: > "$GIT_PROBE_MARKER"\nexit 77\n', { mode: 0o755 });
  const env = { ...f.env, ORG_DIR: record, GIT_PROBE_MARKER: marker, PATH: `${bin}${path.delimiter}${f.env.PATH}` };
  const fleet = f.read(), file = path.join(f.fleetHome, 'fleet.json');
  fleet.projects.other.layers = 'damaged'; delete fleet.projects.other.worktrees;
  fs.writeFileSync(file, JSON.stringify(fleet));
  const bytes = fs.readFileSync(file), log = fs.readFileSync(path.join(record, 'events.jsonl'));
  assert.equal(findOrgDir({ cwd, env }), record);
  const result = spawnSync(process.execPath, [path.join(root, 'bin/org.mjs'), 'status', '--json'], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(fs.existsSync(marker), false);
  const initialized = spawnSync(process.execPath, [path.join(root, 'bin/org.mjs'), 'init', record], { cwd, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.throws(() => readFleet(env), /other.worktrees/);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readFileSync(path.join(record, 'events.jsonl')), log);
  fs.writeFileSync(file, '{');
  assert.throws(() => findOrgDir({ cwd, env }), /invalid fleet/);
  assert.equal(fs.existsSync(marker), false);
});

test('a bound project and its linked checkout isolate unrelated malformed settings', t => {
  const f = fixture(t), cwd = f.repo('app'), layer = path.join(f.scratch, 'app-routes.json');
  fs.writeFileSync(layer, JSON.stringify({ archive: { dirs: ['project-archive'] }, routes: { engineer: { kind: 'codex', model: 'project-model' } } }));
  const own = f.join(cwd, ['--layer', layer]).project;
  f.join(f.repo('other'));
  const lane = path.join(f.scratch, 'linked'); f.git(cwd, ['worktree', 'add', '-qb', 'lane/test', lane]);
  const fleet = f.read(), file = path.join(f.fleetHome, 'fleet.json');
  fleet.projects.other.layers = null; fleet.projects.other.worktrees = 42;
  fs.writeFileSync(file, JSON.stringify(fleet));
  const bytes = fs.readFileSync(file);
  for (const entered of [cwd, lane]) {
    assert.equal(findOrgDir({ cwd: entered, env: f.env }), own.record);
    assert.deepEqual(projectFleet(entered, f.env).project, { ...own, name: 'app' });
    assert.deepEqual(loadDiscoveredRoutes({ cwd: entered, env: f.env }).files, [layer]);
    assert.deepEqual(discoverArchive({ cwd: entered, env: f.env }).dirs, [path.join(f.scratch, 'project-archive')]);
    const cli = spawnSync(process.execPath, [path.join(root, 'bin/org.mjs'), 'status', '--json'], { cwd: entered, env: f.env, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
  }
  assert.notEqual(f.run(cwd, ['show']).status, 0, 'fleet-wide inspection still reports unrelated corruption');
  assert.notEqual(f.run(cwd, ['join']).status, 0, 'writers never publish a partially validated fleet');
  assert.deepEqual(fs.readFileSync(file), bytes);
});

for (const field of ['identity', 'checkout']) test(`an unregistered explicit record isolates an unrelated relative ${field}`, t => {
  const f = fixture(t), cwd = f.repo('unregistered'), record = path.join(f.scratch, 'explicit-record');
  initOrg(record); f.join(f.repo('other'));
  const fleet = f.read(), file = path.join(f.fleetHome, 'fleet.json'), env = { ...f.env, ORG_DIR: record };
  fleet.projects.other[field] = 'relative';
  fs.writeFileSync(file, JSON.stringify(fleet));
  const bytes = fs.readFileSync(file), log = fs.readFileSync(path.join(record, 'events.jsonl'));
  assert.equal(findOrgDir({ cwd, env }), record);
  const status = () => spawnSync(process.execPath, [path.join(root, 'bin/org.mjs'), 'status', '--json'], { cwd, env, encoding: 'utf8' });
  const result = status(); assert.equal(result.status, 0, result.stderr);
  assert.throws(() => readFleet(env), new RegExp(`other\\.${field} must be an absolute path`));
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readFileSync(path.join(record, 'events.jsonl')), log);

  // The same malformed entry must refuse as soon as it claims this record.
  fleet.projects.other.record = record;
  fs.writeFileSync(file, JSON.stringify(fleet));
  assert.throws(() => findOrgDir({ cwd, env }), new RegExp(`other\\.${field} must be an absolute path`));
  const refused = status(); assert.notEqual(refused.status, 0); assert.match(refused.stderr, /invalid fleet/);
  fleet.projects.selected = { identity: gitProject(cwd).identity, checkout: cwd, record,
    worktrees: path.join(f.scratch, 'selected-worktrees'), layers: [] };
  fs.writeFileSync(file, JSON.stringify(fleet));
  assert.throws(() => findOrgDir({ cwd, env: f.env }), new RegExp(`other: ${field} must be an absolute path`), 'a malformed overlapping entry still refuses a bound project');
  assert.deepEqual(fs.readFileSync(path.join(record, 'events.jsonl')), log);
});

test('malformed selected project fields refuse explicit and discovered record operations', t => {
  const f = fixture(t), cwd = f.repo('app'), own = f.join(cwd).project;
  const fleet = f.read(), file = path.join(f.fleetHome, 'fleet.json');
  const log = fs.readFileSync(path.join(own.record, 'events.jsonl'));
  for (const key of ['identity', 'checkout', 'record', 'worktrees', 'layers']) {
    const damaged = structuredClone(fleet); damaged.projects.app[key] = null;
    fs.writeFileSync(file, JSON.stringify(damaged));
    assert.throws(() => findOrgDir({ cwd, env: f.env }), /invalid fleet.*app/);
    assert.throws(() => findOrgDir({ cwd, env: { ...f.env, ORG_DIR: own.record } }), /invalid fleet.*app/);
    for (const args of [['status', '--json'], ['init', own.record]]) {
      const cli = spawnSync(process.execPath, [path.join(root, 'bin/org.mjs'), ...args], {
        cwd, env: { ...f.env, ORG_DIR: own.record }, encoding: 'utf8',
      });
      assert.notEqual(cli.status, 0); assert.match(cli.stderr, /invalid fleet.*app/);
    }
    assert.deepEqual(fs.readFileSync(path.join(own.record, 'events.jsonl')), log);
  }
});

test('ambiguous ownership and unidentifiable entries refuse rather than guessing a binding', t => {
  const f = fixture(t), cwd = f.repo('app'), own = f.join(cwd).project;
  f.join(f.repo('other'));
  const fleet = f.read(), file = path.join(f.fleetHome, 'fleet.json');
  const alias = path.join(f.scratch, 'record-alias'); fs.symlinkSync(own.record, alias);
  for (const key of ['identity', 'checkout', 'record']) {
    const damaged = structuredClone(fleet); damaged.projects.other[key] = key === 'record' ? alias : own[key];
    fs.writeFileSync(file, JSON.stringify(damaged));
    for (const env of [f.env, { ...f.env, ORG_DIR: own.record }])
      assert.throws(() => findOrgDir({ cwd, env }), /ambiguous projects.*app.*other/);
  }
  for (const unknown of [null, { identity: own.identity }, { ...fleet.projects.other, identity: 'relative' }, { ...fleet.projects.other, checkout: 'relative' }]) {
    const damaged = structuredClone(fleet); damaged.projects.other = unknown;
    fs.writeFileSync(file, JSON.stringify(damaged));
    for (const env of [f.env, { ...f.env, ORG_DIR: own.record }])
      assert.throws(() => findOrgDir({ cwd, env }), /cannot isolate project "?other/);
  }
});

test('a moved checkout can explicitly replace its stale mapping while retaining its external record', t => {
  const f = fixture(t), cwd = f.repo('app'), record = path.join(f.scratch, 'external-record'); initOrg(record);
  const original = f.join(cwd, ['--record', record]).project, recordBytes = fs.readFileSync(path.join(record, 'events.jsonl'));
  const other = f.repo('other');
  assert.notEqual(f.run(other, ['join', '--replace', 'app']).status, 0, 'a live mapping cannot be replaced');
  const parent = path.join(f.scratch, 'relocated'); fs.mkdirSync(parent);
  const moved = path.join(parent, 'app'); fs.renameSync(cwd, moved);
  const file = path.join(f.fleetHome, 'fleet.json'), before = fs.readFileSync(file);
  const unowned = f.repo('relocated-again/unrelated');
  const automatic = f.join(unowned);
  assert.notEqual(automatic.name, 'app'); assert.equal(automatic.project.record, path.join(unowned, '.org'));
  const afterAutomatic = fs.readFileSync(file);
  assert.notEqual(f.run(moved, ['join', '--record', record]).status, 0, 'automatic adoption cannot take a record already mapped elsewhere');
  assert.notEqual(f.run(moved, ['join', '--replace', 'missing']).status, 0);
  const recordBackup = `${record}-backup`; fs.renameSync(record, recordBackup);
  assert.notEqual(f.run(moved, ['join', '--replace', 'app']).status, 0, 'replacement requires the existing record');
  assert.equal(fs.existsSync(record), false); fs.renameSync(recordBackup, record);
  assert.notDeepEqual(afterAutomatic, before);
  assert.deepEqual(fs.readFileSync(file), afterAutomatic); assert.equal(fs.existsSync(path.join(moved, '.org')), false);
  const repaired = f.join(moved, ['--replace', 'app', '--record', record]);
  assert.equal(repaired.name, 'app'); assert.equal(repaired.project.checkout, moved);
  assert.notEqual(repaired.project.identity, original.identity);
  for (const key of ['record', 'worktrees', 'temp', 'layers']) assert.deepEqual(repaired.project[key], original[key]);
  assert.equal(Object.keys(f.read().projects).length, 2);
  assert.equal(findOrgDir({ cwd: moved, env: f.env }), record);
  const repairedBytes = fs.readFileSync(file), mtime = fs.statSync(file).mtimeMs;
  f.join(moved, ['--replace', 'app']); f.join(moved);
  assert.deepEqual(fs.readFileSync(file), repairedBytes); assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.deepEqual(fs.readFileSync(path.join(record, 'events.jsonl')), recordBytes);
});

for (const change of ['moved', 're-cloned']) test(`fleet repair: join suggests the stale external record for a ${change} checkout`, t => {
  const f = fixture(t), cwd = f.repo("agent's app"), record = path.join(f.scratch, "record's home"); initOrg(record);
  const original = f.join(cwd, ['--record', record]).project;
  const backup = path.join(f.scratch, 'backup'); fs.renameSync(cwd, backup);
  const entered = path.join(f.scratch, 'relocated', "agent's app"); fs.mkdirSync(path.dirname(entered));
  if (change === 'moved') fs.renameSync(backup, entered);
  else f.git(f.scratch, ['clone', '-q', backup, entered]);
  const file = path.join(f.fleetHome, 'fleet.json'), before = fs.readFileSync(file), recordBytes = fs.readFileSync(path.join(record, 'events.jsonl'));
  let message;
  const refused = f.run(entered, ['join']);
  assert.notEqual(refused.status, 0); message = refused.stderr;
  assert.match(message, /stale fleet project/);
  const quoted = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = `monitor fleet join --replace ${quoted("agent's app")} --record ${quoted(record)}`;
  assert.ok(message.includes(command), message);
  assert.ok(message.includes(cwd), 'suggestion identifies the stale checkout');
  assert.equal(JSON.parse(f.run(f.scratch, ['show']).stdout).projects["agent's app"].stale, true);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readFileSync(path.join(record, 'events.jsonl')), recordBytes);
  assert.equal(fs.existsSync(path.join(entered, '.org')), false);
  assert.equal(fs.existsSync(path.join(entered, '.lane')), false);
  // Run exactly the printed command, including its shell quoting.
  const repaired = spawnSync('/bin/sh', ['-c', command.replace(/^monitor/, '"$FLEET_TEST_NODE" "$FLEET_TEST_CLIENT"')], {
    cwd: entered, env: { ...f.env, FLEET_TEST_NODE: process.execPath, FLEET_TEST_CLIENT: client }, encoding: 'utf8',
  });
  assert.equal(repaired.status, 0, repaired.stderr);
  const joined = JSON.parse(repaired.stdout);
  assert.equal(joined.name, "agent's app"); assert.equal(joined.project.checkout, entered);
  for (const key of ['record', 'worktrees', 'temp', 'layers']) assert.deepEqual(joined.project[key], original[key]);
  assert.deepEqual(Object.keys(f.read().projects), ["agent's app"]);
  assert.equal(fs.existsSync(path.join(entered, '.org')), false);
});

test('fleet repair: explicit replacement consolidates an earlier automatic hash entry without deleting its record', t => {
  const f = fixture(t), cwd = f.repo('app'), record = path.join(f.scratch, 'external-record'); initOrg(record);
  const original = f.join(cwd, ['--record', record]).project;
  const entered = path.join(f.scratch, 'relocated/app'); fs.mkdirSync(path.dirname(entered)); fs.renameSync(cwd, entered);
  // Reproduce the fleet left by automatic entry in an older installation.
  const hash = createHash('sha256').update(fs.realpathSync(path.join(entered, '.git'))).digest('hex').slice(0, 16);
  const duplicateName = `app-${hash}`, local = path.join(entered, '.org'); initOrg(local);
  const file = path.join(f.fleetHome, 'fleet.json'), fleet = f.read();
  fleet.projects[duplicateName] = { ...original, identity: fs.realpathSync(path.join(entered, '.git')), checkout: entered, record: local,
    worktrees: path.join(f.fleetHome, 'p', hash, 'worktrees'), temp: path.join(f.fleetHome, 't', hash), layers: [] };
  fs.writeFileSync(file, JSON.stringify(fleet));
  const recordBytes = fs.readFileSync(path.join(record, 'events.jsonl')), localBytes = fs.readFileSync(path.join(local, 'events.jsonl'));
  // A live mapping with work in its record must not be mistaken for a fresh
  // automatic entry, even when its name and paths otherwise match exactly.
  execFileSync(process.execPath, [path.join(root, 'bin/org.mjs'), 'add', 'Keep this work'], {
    cwd: entered, env: { ...f.env, ORG_DIR: local, ORG_ACTOR: 'fleet-test' },
  });
  const before = fs.readFileSync(file), populated = fs.readFileSync(path.join(local, 'events.jsonl'));
  const refused = f.run(entered, ['join', '--replace', 'app', '--record', record]);
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /already belongs/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readFileSync(path.join(local, 'events.jsonl')), populated);
  fs.writeFileSync(path.join(local, 'events.jsonl'), localBytes);
  const repaired = f.join(entered, ['--replace', 'app', '--record', record]);
  assert.equal(repaired.name, 'app'); assert.equal(repaired.project.checkout, entered);
  assert.deepEqual(Object.keys(f.read().projects), ['app']);
  for (const key of ['record', 'worktrees', 'temp', 'layers']) assert.deepEqual(repaired.project[key], original[key]);
  assert.deepEqual(fs.readFileSync(path.join(record, 'events.jsonl')), recordBytes);
  assert.deepEqual(fs.readFileSync(path.join(local, 'events.jsonl')), localBytes);
  assert.equal(findOrgDir({ cwd: entered, env: f.env }), record);
});

test('fleet repair: live same-name external mappings join separately; multiple stale matches only suggest', t => {
  const f = fixture(t), a = f.repo('first/app'), b = f.repo('second/app');
  const records = ['first-record', 'second-record'].map(name => path.join(f.scratch, name));
  for (const record of records) initOrg(record);
  const first = f.join(a, ['--record', records[0]]);
  fs.writeFileSync(f.consoleFile, JSON.stringify({ projects: [{ cwd: b, org: records[1] }] }));
  const second = f.join(b);
  assert.notEqual(second.name, first.name); assert.equal(second.project.record, records[1]);
  fs.renameSync(a, path.join(f.scratch, 'old-first')); fs.renameSync(b, path.join(f.scratch, 'old-second'));
  const entered = f.repo('third/app'), file = path.join(f.fleetHome, 'fleet.json'), before = fs.readFileSync(file);
  const result = f.run(entered, ['join']);
  assert.notEqual(result.status, 0);
  for (const joined of [first, second]) {
    assert.ok(result.stderr.includes(`stale fleet project ${joined.name}:`));
    assert.ok(result.stderr.includes(`monitor fleet join --replace '${joined.name}' --record '${joined.project.record}'`));
  }
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.existsSync(path.join(entered, '.org')), false);
});


test('fleet repair: unknown names and live records remain refused before writes', t => {
  const f = fixture(t), cwd = f.repo('app'), record = path.join(f.scratch, 'external-record'); initOrg(record);
  f.join(cwd, ['--record', record]);
  const other = f.repo('other'), ownedRecord = f.join(other).project.record;
  const entered = path.join(f.scratch, 'relocated/app'); fs.mkdirSync(path.dirname(entered)); fs.renameSync(cwd, entered);
  const file = path.join(f.fleetHome, 'fleet.json'), before = fs.readFileSync(file);
  for (const args of [ ['--replace', 'missing', '--record', record], ['--replace', 'app', '--record', ownedRecord],
    ['--replace', 'other', '--record', record] ]) {
    const result = f.run(entered, ['join', ...args]); assert.notEqual(result.status, 0, result.stdout);
    assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.existsSync(path.join(entered, '.org')), false);
  }
});

test('legacy temp and exclusion settings are inert, and nested peers keep distinct record mappings', t => {
  const f = fixture(t), cwd = f.repo('outer');
  const first = f.join(cwd);
  const file = path.join(f.fleetHome, 'fleet.json');
  const raw = f.read(); raw.excluded_roots = false; raw.projects[first.name].temp = { retired: true };
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(f.join(cwd, ['--temp', 'ignored-temp']).project.record, first.project.record);
  assert.ok(!fs.existsSync(path.join(cwd, 'ignored-temp')));
  const nested = f.repo('outer/nested'), second = f.join(nested);
  assert.notEqual(first.project.identity, second.project.identity);
  assert.notEqual(first.project.record, second.project.record);
  assert.equal(findOrgDir({ cwd: nested, env: f.env }), second.project.record);
  assert.equal(findOrgDir({ cwd, env: f.env }), first.project.record);
});

test("a project's own worktree_root wins over its fleet mapping; without it the fleet mapping applies", t => {
  const f = fixture(t), cwd = f.repo('app'), mapped = path.join(f.scratch, 'mapped-lanes');
  f.join(cwd, ['--worktrees', mapped]);
  const env = { ...f.env }; delete env.LANE_CONFIG; delete env.LANE_WORKTREE_ROOT;
  const row = () => {
    const r = spawnSync(process.execPath, [path.join(root, 'lanes/lane.mjs'), 'config'], { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split('\n').find(line => line.startsWith('worktree_root\t'));
  };
  const fleetRow = `worktree_root\t${JSON.stringify(mapped)}\t${path.join(f.fleetHome, 'fleet.json')}`;
  assert.equal(row(), fleetRow);
  const config = path.join(cwd, '.lane.json');
  fs.writeFileSync(config, JSON.stringify({ worktree_root: '../identity-lanes' }));
  assert.equal(row(), `worktree_root\t${JSON.stringify(path.join(f.scratch, 'identity-lanes', 'app'))}\t${config}`);
  assert.equal(f.read().projects.app.worktrees, mapped, 'reading settings never rewrites the fleet');
  fs.rmSync(config);
  assert.equal(row(), fleetRow);
});
