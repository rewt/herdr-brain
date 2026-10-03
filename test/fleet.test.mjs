import test from './helpers/bounded-test.mjs';
import { spawnChild, waitForExit } from './helpers/child.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { findOrgDir, initOrg } from '../lib/store.mjs';
import { loadDiscoveredRoutes } from '../lanes/routes.mjs';
import { loadModernConfig, loadConfig } from '../console/lib/config.mjs';
import { catalog, createIdentityReader } from '../console/modern/model.mjs';
import { createEntry } from '../discovery/runtime.mjs';
import { projectRows } from '../console/modern/project.mjs';
import { createModernSession } from '../console/modern/session.mjs';
import { randomUUID } from 'node:crypto';
import { recover } from '../herdr/entry-transaction.mjs';
import { entryPolicy } from '../discovery/policy.mjs';

const root = new URL('../', import.meta.url).pathname;
const client = path.join(root, 'discovery/client.mjs');
function fixture(t) {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fleet-test-'));
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

test('malformed fleet fails before entry or discovery touches any record', t => {
  const f = fixture(t), cwd = f.repo('app'), record = path.join(f.scratch, '.org'); initOrg(record);
  const before = fs.readFileSync(path.join(record, 'events.jsonl'));
  fs.mkdirSync(f.fleetHome);
  for (const bad of ['{', JSON.stringify({ version: 1, session_limit: 0, projects: {} }), JSON.stringify({ version: 1, session_limit: 6, projects: { app: { checkout: cwd } } })]) {
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
  const env = { ...f.env, HOME: home, ZDOTDIR: home, HERDR_MONITOR_HOME: path.join(home, 'install'), HERDR_MONITOR_ENTRY_BIN: bin, HERDR_MONITOR_CODEX: native, HERDR_MONITOR_CLAUDE: '-' };
  const installer = path.join(root, 'herdr/entry-install.mjs');
  execFileSync(process.execPath, [installer, '--snapshot'], { env });
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
  const automatic = f.run(moved, ['join']);
  assert.notEqual(automatic.status, 0); assert.match(automatic.stderr, /stale.*app.*--replace/s);
  assert.notEqual(f.run(moved, ['join', '--record', record]).status, 0);
  assert.notEqual(f.run(moved, ['join', '--replace', 'missing']).status, 0);
  const recordBackup = `${record}-backup`; fs.renameSync(record, recordBackup);
  assert.notEqual(f.run(moved, ['join', '--replace', 'app']).status, 0, 'replacement requires the existing record');
  assert.equal(fs.existsSync(record), false); fs.renameSync(recordBackup, record);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.existsSync(path.join(moved, '.org')), false);
  const repaired = f.join(moved, ['--replace', 'app', '--record', record]);
  assert.equal(repaired.name, 'app'); assert.equal(repaired.project.checkout, moved);
  assert.notEqual(repaired.project.identity, original.identity);
  for (const key of ['record', 'worktrees', 'temp', 'layers']) assert.deepEqual(repaired.project[key], original[key]);
  assert.equal(Object.keys(f.read().projects).length, 1);
  assert.equal(findOrgDir({ cwd: moved, env: f.env }), record);
  const repairedBytes = fs.readFileSync(file), mtime = fs.statSync(file).mtimeMs;
  f.join(moved, ['--replace', 'app']); f.join(moved);
  assert.deepEqual(fs.readFileSync(file), repairedBytes); assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.deepEqual(fs.readFileSync(path.join(record, 'events.jsonl')), recordBytes);
});
