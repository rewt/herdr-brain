import test from './helpers/bounded-test.mjs';
import { spawnChild, waitForExit } from './helpers/child.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { findOrgDir, initOrg } from '../lib/store.mjs';
import { loadDiscoveredRoutes } from '../lanes/routes.mjs';
import { ConfigError, EXAMPLE, loadModernConfig, loadConfig } from '../console/lib/config.mjs';
import { catalog, createIdentityReader } from '../console/modern/model.mjs';
import { createEntry } from '../discovery/runtime.mjs';
import { projectRows } from '../console/modern/project.mjs';
import { createModernSession } from '../console/modern/session.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { recover } from '../herdr/entry-transaction.mjs';
import { entryPolicy } from '../discovery/policy.mjs';
import { projectFleet } from '../lib/fleet.mjs';

const root = new URL('../', import.meta.url).pathname;
const client = path.join(root, 'discovery/client.mjs');
function fixture(t) {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'ft-'));
  const fleetHome = path.join(scratch, 'fleet'), consoleFile = path.join(scratch, 'console.json');
  const env = { ...process.env, HERDR_MONITOR_FLEET: fleetHome, HERDR_ORG_CONSOLE_CONFIG: consoleFile, ORG_DIR: '', MONITOR_REQUEST_DIR: '' };
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

test('first entry maps an existing record in place; a neighbouring repository gets its own record and routes', t => {
  const f = fixture(t), a = f.repo('herdr-brain'), b = f.repo('neighbour');
  const record = path.join(f.scratch, '.org'), parent = path.join(f.scratch, '.lane.json');
  initOrg(record); fs.writeFileSync(parent, JSON.stringify({ routes: { engineer: { kind: 'opaque', model: 'private-route' } } }));
  fs.writeFileSync(f.consoleFile, JSON.stringify({ projects: [{ name: 'herdr-brain', cwd: a, org: record }] }));
  const before = fs.readFileSync(path.join(record, 'events.jsonl'));
  const first = createEntry({ cwd: a, role: 'supervisor', runtimeDir: path.join(f.scratch, 'runtime-a') });
  f.keep(first);
  assert.equal(first.context().org, record);
  assert.equal(f.read().projects['herdr-brain'].record, record);
  assert.equal(f.read().session_limit, 6);
  assert.deepEqual(f.read().projects['herdr-brain'].layers, [parent]);
  assert.equal(findOrgDir({ cwd: b, env: f.env }), null);
  assert.equal(loadDiscoveredRoutes({ cwd: b, env: f.env }).suggested, true);
  const laneConfig = spawnSync(process.execPath, [path.join(root, 'lanes/lane.mjs'), 'config'], { cwd: b, env: f.env, encoding: 'utf8' });
  assert.equal(laneConfig.status, 0, laneConfig.stderr); assert.doesNotMatch(laneConfig.stdout, /private-route/);
  const second = createEntry({ cwd: b, role: 'supervisor', runtimeDir: path.join(f.scratch, 'runtime-b') });
  f.keep(second);
  assert.notEqual(second.context().org, record);
  assert.equal(second.context().org, f.read().projects.neighbour.record);
  assert.ok(fs.existsSync(path.join(second.context().org, 'events.jsonl')));
  assert.deepEqual(fs.readFileSync(path.join(record, 'events.jsonl')), before);
  assert.match(entryPolicy(second.context(), root), /fleet.*6.*advisory/i);
});

test('concurrent first entries publish one complete fleet with both projects', async t => {
  const f = fixture(t), a = f.repo('a'), b = f.repo('b');
  const jobs = [a, b].map(cwd => waitForExit(spawnChild(t, process.execPath,
    [path.join(root, 'discovery/adapters/codex.mjs'), '--repo', cwd, '--role', 'supervisor', '--policy-only', '--runtime-dir', path.join(f.scratch, `runtime-${path.basename(cwd)}`)],
    { cwd, env: f.env })));
  const results = await Promise.all(jobs);
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  const fleet = f.read(); assert.deepEqual(Object.keys(fleet.projects).sort(), ['a', 'b']);
  assert.notEqual(fleet.projects.a.record, fleet.projects.b.record);
  for (const p of Object.values(fleet.projects)) {
    assert.ok(fs.existsSync(path.join(p.record, 'events.jsonl')));
    assert.ok(path.isAbsolute(p.worktrees)); assert.ok(path.isAbsolute(p.temp));
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
  const a = createEntry({ cwd }), b = createEntry({ cwd }); f.keep(a); f.keep(b);
  assert.notEqual(a.context().workspace, b.context().workspace, 'advisory limit never refuses another session');
  assert.equal(a.context().fleet.session_limit, 1);
});

test('moved checkout remains stale in fleet and console instead of being guessed by name', t => {
  const f = fixture(t), cwd = f.repo('app'); f.join(cwd);
  const bytes = fs.readFileSync(path.join(f.fleetHome, 'fleet.json'));
  const initialConfig = loadModernConfig(f.consoleFile);
  fs.renameSync(cwd, path.join(f.scratch, 'moved'));
  const r = f.run(f.scratch, ['show']); assert.equal(r.status, 0, r.stderr);
  const view = JSON.parse(r.stdout); assert.equal(view.projects.app.stale, true);
  const config = loadModernConfig(f.consoleFile); assert.equal(config.projects[0].stale, true);
  const projects = catalog(config.projects, [], createIdentityReader()); assert.equal(projects[0].stale, true);
  assert.equal(projects[0].org, null);
  assert.equal(catalog(initialConfig.projects, [], createIdentityReader())[0].stale, true, 'a running console rechecks stale paths');
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
  assert.notEqual(joined.project.worktrees, original.worktrees); assert.notEqual(joined.project.temp, original.temp);
  assert.deepEqual(f.read().projects.app, original, 'a name match never transfers the old mapping');
  assert.equal(Object.keys(f.read().projects).length, 2);
  assert.equal(findOrgDir({ cwd: entered, env: f.env }), joined.project.record);
  assert.deepEqual(fs.readFileSync(path.join(joined.project.record, 'events.jsonl')), change === 'moved' ? recordBytes : Buffer.alloc(0));
  const config = loadModernConfig(f.consoleFile);
  assert.equal(config.projects.find(p => p.name === 'app').stale, true);
  assert.equal(config.projects.find(p => p.name === 'app').org, null);
  assert.equal(config.projects.find(p => p.name === joined.name).stale, false);
  const bytes = fs.readFileSync(file), mtime = fs.statSync(file).mtimeMs;
  f.join(entered); assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(fs.statSync(file).mtimeMs, mtime);
  const entry = createEntry({ cwd: entered, role: 'supervisor' }); f.keep(entry);
  assert.equal(entry.context().org, joined.project.record);
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

test('an unedited example console configuration is rejected with a fleet present', t => {
  const f = fixture(t), cwd = f.repo('app'); f.join(cwd);
  fs.writeFileSync(f.consoleFile, JSON.stringify(EXAMPLE, null, 2) + '\n');
  const file = path.join(f.fleetHome, 'fleet.json'), fleetBytes = fs.readFileSync(file), configBytes = fs.readFileSync(f.consoleFile);
  for (const load of [loadConfig, loadModernConfig]) {
    assert.throws(() => load(f.consoleFile), error => error instanceof ConfigError && /still the example/.test(error.message) && error.message.includes(f.consoleFile));
  }
  assert.deepEqual(fs.readFileSync(file), fleetBytes); assert.deepEqual(fs.readFileSync(f.consoleFile), configBytes);
});

test('malformed fleet fails before entry or discovery touches any record', t => {
  const f = fixture(t), cwd = f.repo('app'), record = path.join(f.scratch, '.org'); initOrg(record);
  const before = fs.readFileSync(path.join(record, 'events.jsonl'));
  fs.mkdirSync(f.fleetHome);
  for (const bad of ['{', JSON.stringify({ version: 1, session_limit: 0, projects: {} }), JSON.stringify({ version: 1, session_limit: 6, projects: { app: { checkout: cwd } } }),
    ...[null, {}, ['relative/path']].map(excluded_roots => JSON.stringify({ version: 1, session_limit: 6, projects: {}, excluded_roots }))]) {
    fs.writeFileSync(path.join(f.fleetHome, 'fleet.json'), bad);
    assert.throws(() => findOrgDir({ cwd, env: f.env }), /fleet/i);
    assert.throws(() => loadDiscoveredRoutes({ cwd, env: f.env }), /fleet/i);
    assert.throws(() => loadModernConfig(f.consoleFile), /fleet/i);
    assert.throws(() => createEntry({ cwd, role: 'supervisor' }), /fleet/i);
    const r = f.run(cwd, ['join']); assert.notEqual(r.status, 0); assert.match(r.stderr, /fleet/i);
    const mutation = spawnSync(process.execPath, [path.join(root, 'bin/org.mjs'), 'add', 'Must not write'], { cwd, env: { ...f.env, ORG_DIR: record }, encoding: 'utf8' });
    assert.notEqual(mutation.status, 0); assert.match(mutation.stderr, /invalid fleet/);
    const initialization = spawnSync(process.execPath, [path.join(root, 'bin/org.mjs'), 'init', path.join(cwd, '.org')], { cwd, env: f.env, encoding: 'utf8' });
    assert.notEqual(initialization.status, 0); assert.match(initialization.stderr, /invalid fleet/);
    assert.equal(fs.readFileSync(path.join(f.fleetHome, 'fleet.json'), 'utf8'), bad);
    assert.deepEqual(fs.readFileSync(path.join(record, 'events.jsonl')), before);
    assert.equal(fs.existsSync(path.join(cwd, '.org')), false); assert.equal(fs.existsSync(path.join(cwd, '.lane')), false);
  }
});

test('fleet advisory and stale checkout are visible in the project view', t => {
  const f = fixture(t), cwd = f.repo('app'); f.join(cwd);
  const config = loadModernConfig(f.consoleFile), m = { sessions: [], spaces: [], goals: [], categoryFlags: [], decided: [], asked: [], needs: [], tasks: [] };
  const rows = projectRows({ model: m, state: { fleet: config.fleet, errors: {} }, project: { ...config.projects[0], stale: true }, width: 100, height: 32 });
  const text = rows.flat().map(cell => cell.text).join('\n');
  assert.match(text, /Fleet session limit 6.*advisory/); assert.match(text, /Stale checkout/);
});

test('installed monitor command joins without a session and removal restores its bin', t => {
  const f = fixture(t), cwd = f.repo('app'), bin = path.join(f.scratch, 'bin'), native = path.join(f.scratch, 'native');
  fs.writeFileSync(native, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const installer = path.join(root, 'discovery/install.mjs');
  execFileSync(process.execPath, [installer, '--bin', bin, '--codex', native], { env: f.env });
  const output = execFileSync(path.join(bin, 'monitor'), ['fleet', 'join'], { cwd, env: f.env, encoding: 'utf8' });
  assert.equal(JSON.parse(output).name, 'app');
  execFileSync(process.execPath, [installer, '--bin', bin, '--remove'], { env: f.env });
  assert.equal(fs.existsSync(path.join(bin, 'monitor')), false);
});

test('stable machine installation carries monitor and recovery can restore its launcher', t => {
  const f = fixture(t), cwd = f.repo('app'), home = path.join(f.scratch, 'home'), bin = path.join(f.scratch, 'bin'), native = path.join(f.scratch, 'native');
  fs.mkdirSync(home); fs.writeFileSync(native, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // Simulate an inherited account entirely within scratch, never the operator's
  // actual destinations. Its bytes must survive install, recovery and removal.
  const inherited = path.join(f.scratch, 'inherited-account'), originals = new Map();
  for (const [name, file] of [['CODEX_HOME', 'hooks.json'], ['CLAUDE_CONFIG_DIR', 'settings.json']]) {
    const directory = path.join(inherited, name); fs.mkdirSync(directory, { recursive: true });
    f.env[name] = directory;
    const destination = path.join(directory, file), bytes = Buffer.from('{ "theme": "inherited", "hooks": { "Stop": [] } }\r\n');
    fs.writeFileSync(destination, bytes, { mode: 0o640 }); originals.set(destination, bytes);
  }
  const env = { ...f.env, HOME: home, ZDOTDIR: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    HERDR_MONITOR_HOME: path.join(home, 'install'), HERDR_MONITOR_ENTRY_BIN: bin, HERDR_MONITOR_CODEX: native, HERDR_MONITOR_CLAUDE: '-' };
  const installer = path.join(root, 'herdr/entry-install.mjs');
  execFileSync(process.execPath, [installer, '--snapshot'], { env });
  const preserved = () => { for (const [file, bytes] of originals) { assert.deepEqual(fs.readFileSync(file), bytes, file); assert.equal(fs.statSync(file).mode & 0o777, 0o640); } };
  preserved();
  assert.ok(fs.existsSync(path.join(home, '.codex/hooks.json')), 'hook belongs to the scratch account');
  const launcher = path.join(bin, 'monitor'), bytes = fs.readFileSync(launcher);
  const output = execFileSync(launcher, ['fleet', 'join'], { cwd, env, encoding: 'utf8' });
  assert.equal(JSON.parse(output).name, 'app');
  const journal = path.join(bin, '.monitor-recovery.json'), token = randomUUID();
  fs.writeFileSync(launcher, 'changed'); fs.chmodSync(launcher, 0o755);
  fs.writeFileSync(journal, JSON.stringify({ version: 2, token, bin, pid: process.pid, runtime: null, changes: [{
    file: launcher, before: { content: bytes.toString('base64'), mode: 0o755 }, after: { content: Buffer.from('changed').toString('base64'), mode: 0o755 }, started: true, temporary: null,
  }] }));
  recover(journal, bin, path.join(home, 'install/entry/runtimes'));
  assert.deepEqual(fs.readFileSync(launcher), bytes);
  execFileSync(process.execPath, [installer, '--remove'], { env });
  assert.equal(fs.existsSync(launcher), false);
  preserved();
});

test('an already-open console reads new joins and adjusted advisory limits on refresh', async t => {
  const f = fixture(t), cwd = f.repo('app');
  const config = loadModernConfig(f.consoleFile);
  const console = createModernSession({ config, configFile: f.consoleFile, deps: {
    herdrList: async () => [], herdrAgents: async () => ({ ok: true, agents: [] }), brainQueue: async () => ({ rows: [], off: true }),
    orgToday: async () => ({}), orgStatus: async () => ({ items: [], runs: [] }), orgLog: async () => [], orgDesks: async () => ({}), orgHousekeeping: async () => ({}), orgRoutes: async () => ({}), gitSummary: async () => null,
  } });
  t.after(console.stop);
  f.join(cwd, ['--session-limit', '9']); await console.refresh();
  assert.equal(console.ui.projects[0]?.name, 'app'); assert.equal(console.ui.fleet?.session_limit, 9);
});

test('explicit adoption maps paths and settings; record ownership cannot be duplicated', t => {
  const f = fixture(t), cwd = f.repo('app'), other = f.repo('other'), record = path.join(f.scratch, 'old-record'); initOrg(record);
  const layer = path.join(f.scratch, '.lane.json'); fs.writeFileSync(layer, JSON.stringify({ routes: { engineer: { kind: 'opaque', model: 'owned' } } }));
  const worktrees = path.join(f.scratch, 'old-lanes'), temp = path.join(f.scratch, 'old-temp');
  f.join(cwd, ['--record', record, '--worktrees', worktrees, '--temp', temp, '--layer', layer]);
  assert.equal(loadDiscoveredRoutes({ cwd, env: f.env }).config.routes.engineer.model, 'owned');
  const entry = createEntry({ cwd, runtimeDir: path.join(f.scratch, 'runtime') }); f.keep(entry);
  assert.equal(path.dirname(entry.context().workspace), worktrees);
  const p = f.read().projects.app; assert.equal(p.temp, temp); assert.equal(p.identity, fs.realpathSync(path.join(cwd, '.git')));
  assert.notEqual(f.run(other, ['join', '--record', record]).status, 0);
  assert.equal(Object.keys(f.read().projects).length, 1);
  assert.equal(loadConfig(f.consoleFile).fleet.session_limit, 6);
});

test('without a fleet file legacy ancestor discovery and console configuration are unchanged', t => {
  const f = fixture(t), cwd = f.repo('app'), record = path.join(f.scratch, '.org'); initOrg(record);
  const layer = path.join(f.scratch, '.lane.json'); fs.writeFileSync(layer, JSON.stringify({ routes: { engineer: { model: 'legacy' } } }));
  fs.writeFileSync(f.consoleFile, JSON.stringify({ projects: [{ name: 'legacy', cwd, org: record }] }));
  assert.equal(findOrgDir({ cwd, env: f.env }), record);
  assert.deepEqual(loadDiscoveredRoutes({ cwd, env: f.env }).files, [layer]);
  assert.equal(loadConfig(f.consoleFile).projects[0].org, record);
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
  assert.equal(createEntry({ cwd, role: 'supervisor' }), null, 'entry keeps native behavior until the explicit adoption');
  const bareJoin = f.run(cwd, ['join']); assert.notEqual(bareJoin.status, 0); assert.match(bareJoin.stderr, /explicit adoption/u);
  assert.deepEqual(fs.readFileSync(fleetFile), fleetBytes, 'reads and entry do not register the existing project');
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

test('fleet exclusions persist before Git exists, cover descendants and aliases, and include restores entry eligibility', t => {
  const f = fixture(t), directory = path.join(f.scratch, 'excluded'); fs.mkdirSync(directory);
  const alias = path.join(f.scratch, 'alias'); fs.symlinkSync(directory, alias);
  const missing = path.join(alias, 'future');
  let result = f.run(f.scratch, ['exclude', missing]); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.read().excluded_roots, [path.join(directory, 'future')]);
  const cwd = f.repo('excluded/future/app');
  assert.equal(projectFleet(cwd, f.env).excluded, path.join(directory, 'future'));
  assert.equal(createEntry({ cwd }), null);
  result = f.run(cwd, ['join']); assert.notEqual(result.status, 0); assert.match(result.stderr, /excluded/u);
  assert.deepEqual(f.read().projects, {}); assert.equal(fs.existsSync(path.join(cwd, '.org')), false);
  const file = path.join(f.fleetHome, 'fleet.json'), bytes = fs.readFileSync(file), mtime = fs.statSync(file).mtimeMs;
  result = f.run(f.scratch, ['exclude', missing]); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(fs.statSync(file).mtimeMs, mtime);
  // Prefix siblings are eligible; inclusion removes only the named root.
  const sibling = f.repo('excluded/future-sibling/app'); f.join(sibling);
  f.run(f.scratch, ['exclude', directory]); f.run(f.scratch, ['include', missing]);
  assert.equal(createEntry({ cwd }), null, 'an ancestor exclusion still applies');
  result = f.run(f.scratch, ['include', alias]); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.read().excluded_roots, []);
  const entry = createEntry({ cwd, role: 'supervisor' }); f.keep(entry);
  assert.ok(entry.context().fleet); assert.equal(Object.keys(f.read().projects).length, 2);
  const mapping = projectFleet(cwd, f.env).project;
  f.run(f.scratch, ['exclude', cwd]); assert.equal(createEntry({ cwd }), null);
  assert.deepEqual({ ...f.read().projects[mapping.name], name: mapping.name }, mapping, 'exclusion preserves a joined mapping');
  const linked = path.join(f.scratch, 'excluded-linked'); f.git(cwd, ['worktree', 'add', '-qb', 'lane/excluded', linked]);
  assert.equal(projectFleet(linked, f.env).excluded, cwd, 'canonical exclusion applies to linked checkouts');
  f.run(f.scratch, ['include', cwd]); assert.equal(projectFleet(linked, f.env).project.record, mapping.record);
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

test('entry worktree roots are session overrides and never freeze the fleet mapping', t => {
  const f = fixture(t), cwd = f.repo('app'), roots = ['first', 'second'].map(name => path.join(f.scratch, name));
  const first = createEntry({ cwd, worktreeRoot: roots[0] }); f.keep(first);
  assert.equal(path.dirname(first.context().workspace), roots[0]);
  const mapped = f.read().projects.app.worktrees;
  assert.notEqual(mapped, roots[0], 'first entry stores the project default');
  const file = path.join(f.fleetHome, 'fleet.json'), before = fs.readFileSync(file), mtime = fs.statSync(file).mtimeMs;
  const second = createEntry({ cwd, worktreeRoot: roots[1] }); f.keep(second);
  assert.equal(path.dirname(second.context().workspace), roots[1]);
  const unselected = createEntry({ cwd }); f.keep(unselected);
  assert.equal(path.dirname(unselected.context().workspace), mapped);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.statSync(file).mtimeMs, mtime);
});

test('console merges unjoined configured projects with fleet entries across refresh and adoption', async t => {
  const f = fixture(t), cwd = f.repo('app'), legacy = f.repo('bch-cloak'), record = path.join(f.scratch, 'legacy-record');
  initOrg(record);
  fs.writeFileSync(f.consoleFile, JSON.stringify({ projects: [
    { name: 'old-app-name', cwd, org: path.join(cwd, '.org'), session_cap: 17 },
    { name: 'bch-cloak', cwd: legacy, org: record, session_cap: 23 },
  ], glyphs: 'plain' }));
  f.join(cwd);
  const fleetBytes = fs.readFileSync(path.join(f.fleetHome, 'fleet.json')), recordBytes = fs.readFileSync(path.join(record, 'events.jsonl'));
  const config = loadModernConfig(f.consoleFile);
  for (const loaded of [config, loadConfig(f.consoleFile)]) {
    assert.deepEqual(loaded.projects.map(p => p.name), ['app', 'bch-cloak']);
    assert.equal(loaded.projects[0].session_cap, 17);
    assert.equal(loaded.projects[1].org, record); assert.equal(loaded.projects[1].session_cap, 23);
    assert.equal(loaded.glyphs, 'plain');
    const rows = catalog(loaded.projects, [], createIdentityReader());
    assert.equal(rows.length, 2); assert.equal(rows[1].org, record);
  }
  const console = createModernSession({ config, configFile: f.consoleFile, deps: {
    herdrList: async () => [], herdrAgents: async () => ({ ok: true, agents: [] }), brainQueue: async () => ({ rows: [], off: true }),
    orgToday: async () => ({}), orgStatus: async () => ({ items: [], runs: [] }), orgLog: async () => [], orgDesks: async () => ({}), orgHousekeeping: async () => ({}), orgRoutes: async () => ({}), gitSummary: async () => null,
  } });
  t.after(console.stop); await console.refresh();
  assert.deepEqual(console.ui.projects.map(p => p.name), ['app', 'bch-cloak']);
  assert.deepEqual(fs.readFileSync(path.join(f.fleetHome, 'fleet.json')), fleetBytes);
  assert.deepEqual(fs.readFileSync(path.join(record, 'events.jsonl')), recordBytes);
  assert.equal(fs.existsSync(path.join(legacy, '.org')), false);
  f.join(legacy); await console.refresh();
  assert.equal(console.ui.projects.length, 2, 'adoption replaces the configured row rather than duplicating it');
  assert.equal(console.ui.projects.find(p => p.name === 'bch-cloak').org, record);
});

test('explicit ORG_DIR validates the fleet without launching Git on record commands', t => {
  const f = fixture(t), cwd = f.repo('app'); f.join(cwd);
  const record = f.read().projects.app.record, bin = path.join(f.scratch, 'bin'), marker = path.join(f.scratch, 'git-ran');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\n: > "$GIT_PROBE_MARKER"\nexit 77\n', { mode: 0o755 });
  const env = { ...f.env, ORG_DIR: record, GIT_PROBE_MARKER: marker, PATH: `${bin}${path.delimiter}${f.env.PATH}` };
  const result = spawnSync(process.execPath, [path.join(root, 'bin/org.mjs'), 'status', '--json'], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(fs.existsSync(marker), false);
  fs.writeFileSync(path.join(f.fleetHome, 'fleet.json'), '{');
  assert.throws(() => findOrgDir({ cwd, env }), /invalid fleet/);
  assert.equal(fs.existsSync(marker), false);
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

for (const change of ['moved', 're-cloned']) test(`fleet repair: automatic entry suggests the stale external record for a ${change} checkout`, t => {
  const f = fixture(t), cwd = f.repo("agent's app"), record = path.join(f.scratch, "record's home"); initOrg(record);
  const original = f.join(cwd, ['--record', record]).project;
  const backup = path.join(f.scratch, 'backup'); fs.renameSync(cwd, backup);
  const entered = path.join(f.scratch, 'relocated', "agent's app"); fs.mkdirSync(path.dirname(entered));
  if (change === 'moved') fs.renameSync(backup, entered);
  else f.git(f.scratch, ['clone', '-q', backup, entered]);
  const file = path.join(f.fleetHome, 'fleet.json'), before = fs.readFileSync(file), recordBytes = fs.readFileSync(path.join(record, 'events.jsonl'));
  let message;
  assert.throws(() => createEntry({ cwd: entered, role: 'supervisor' }), error => {
    message = error.message; return /stale fleet project/.test(message);
  });
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

test('fleet repair: unknown names, live records, and overlapping roots remain refused before writes', t => {
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
  const nested = f.repo('other/nested');
  const result = f.run(nested, ['join', '--replace', 'app', '--record', record]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /overlap/);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.existsSync(path.join(nested, '.org')), false);
  const ordinaryJoin = f.run(nested, ['join']);
  assert.notEqual(ordinaryJoin.status, 0); assert.match(ordinaryJoin.stderr, /overlap/);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.existsSync(path.join(nested, '.org')), false);
});
