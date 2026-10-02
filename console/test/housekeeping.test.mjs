import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { housekeepingSnapshot } from '../../housekeeping/command.mjs';
import { createModernSession } from '../modern/session.mjs';
import { lineText } from '../lib/frame.mjs';

const bin = fileURLToPath(new URL('../../bin/org.mjs', import.meta.url));
const app = fileURLToPath(new URL('../app.mjs', import.meta.url));
const render = (s, cols = 100, rows = 40) => s.frame(cols, rows).lines.map(lineText).join('\n');
function fixture(t) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'console-housekeeping-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const cwd = path.join(scratch, 'project'); fs.mkdirSync(cwd);
  const env = { ...process.env, ORG_DIR: path.join(cwd, '.org'), ORG_ACTOR: 'housekeeping-console-test', HERDR_BIN_PATH: '/usr/bin/false', HERDR_ENV: '1' };
  const git = args => execFileSync('git', args, { cwd, env, stdio: 'pipe', timeout: 10000 });
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.test']);
  fs.writeFileSync(path.join(cwd, 'README.md'), 'Fixture\n'); fs.writeFileSync(path.join(cwd, '.gitignore'), '.org/\n'); git(['add', '.']); git(['commit', '-m', 'Fixture']);
  const cli = (args, directory = cwd) => spawnSync(process.execPath, [bin, ...args], { cwd: directory, env, encoding: 'utf8', timeout: 10000 });
  const org = (args, directory = cwd) => { const r = cli(args, directory); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  org(['init']);
  const snapshot = () => JSON.parse(org(['housekeeping', '--json']));
  const doc = snapshot(), state = doc.stateDir, configFile = doc.target;
  fs.mkdirSync(state, { recursive: true });
  const logFile = path.join(state, 'actions.jsonl');
  const at = '2026-10-02T06:00:00.000Z';
  const entries = [
    { at, action: 'scan', close: 1, keep: 1, cleanup: true, dryRun: false },
    { at, action: 'closed', label: 'Finished worker', tab_id: 'tab-done', why: 'report recorded; lane promoted' },
    { at, action: 'keep', label: 'Busy worker', tab_id: 'tab-working', why: 'agent is working', dryRun: false },
    { at, action: 'resumed', run: 'R-7', pane: 'pane-resume', why: 'interrupted open run with wheel junk' },
    { at, action: 'resume-failed', run: 'R-8', error: 'Herdr unavailable' },
    { at: '2026-10-02T06:01:00.000Z', action: 'scan', close: 8, keep: 2, dryRun: true },
  ];
  fs.writeFileSync(logFile, entries.map(e => JSON.stringify(e) + '\n').join(''));
  const lock = path.join(state, 'lock');
  const owner = pid => {
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid, cwd: fs.realpathSync(cwd), org: fs.realpathSync(env.ORG_DIR), config: configFile, script: bin, record_cli: [fs.realpathSync(process.execPath), bin] }));
  };
  const session = createModernSession({ config: { projects: [{ name: 'Housekeeping fixture', cwd, org: env.ORG_DIR }] }, env,
    deps: { herdrList: async () => [], herdrAgents: async () => ({ ok: true, agents: [] }), herdrRead: async () => ({ ok: true, text: '' }), brainQueue: async () => ({ rows: [], off: true }) } });
  t.after(() => session.stop());
  return { cwd, scratch, env, git, cli, org, snapshot, session, state, logFile, lock, owner, configFile, at };
}

test('housekeeping CLI reads without writes, validates tracked overrides, pauses, resets and targets canonical Git identity', { timeout: 30000 }, t => {
  const f = fixture(t);
  assert.equal(fs.existsSync(f.configFile), false);
  const events = fs.readFileSync(path.join(f.env.ORG_DIR, 'events.jsonl'), 'utf8');
  assert.equal(f.snapshot().lastScan.at, f.at, 'preview never replaces live last run');
  assert.equal(f.snapshot().process, 'stopped');
  const lane = path.join(f.scratch, 'lane'); f.git(['worktree', 'add', '-b', 'lane/fixture', lane]);
  const doc = JSON.parse(f.org(['housekeeping', 'set', '--resume=false', '--tick-seconds=5', '--cleanup-seconds=20', '--json'], lane));
  assert.equal(doc.target, f.configFile); assert.equal(doc.config.resume, false);
  assert.equal(fs.existsSync(path.join(lane, '.housekeeping.json')), false);
  const before = fs.readFileSync(f.configFile, 'utf8');
  for (const args of [['--enabled=maybe'], ['--tick-seconds=0'], ['--cleanup-seconds=NaN'], ['--resume=false', '--unset=resume'], ['--unset=unknown']]) {
    assert.notEqual(f.cli(['housekeeping', 'set', ...args]).status, 0);
    assert.equal(fs.readFileSync(f.configFile, 'utf8'), before);
  }
  assert.notEqual(f.cli(['housekeeping', 'pause', '--expect=stale']).status, 0);
  f.org(['housekeeping', 'pause', `--expect=${doc.revision}`]);
  assert.equal(f.snapshot().config.enabled, false);
  f.org(['housekeeping', 'set', '--unset=resume', '--unset=tick_seconds']);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile, 'utf8')), { enabled: false, cleanup_seconds: 20 });
  f.git(['add', '.housekeeping.json']); f.git(['commit', '-m', 'Track housekeeping overrides']);
  assert.equal(f.git(['status', '--porcelain']).toString(), '');
  assert.equal(fs.readFileSync(path.join(f.env.ORG_DIR, 'events.jsonl'), 'utf8'), events, 'config edits never invent record events');
});

test('status distinguishes running, stale and malformed owners and isolates repositories sharing a record', { timeout: 30000 }, t => {
  const f = fixture(t); f.owner(process.pid);
  assert.equal(f.snapshot().process, 'running');
  const deadPid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { env: f.env, encoding: 'utf8', timeout: 10000 }));
  f.owner(deadPid); assert.equal(f.snapshot().process, 'stale lock');
  fs.writeFileSync(path.join(f.lock, 'owner.json'), '{}');
  assert.equal(f.snapshot().process, 'unknown'); assert.equal(f.snapshot().editable, false);
  assert.notEqual(f.cli(['housekeeping', 'pause']).status, 0);
  f.owner(process.pid);
  const ownerFile = path.join(f.lock, 'owner.json'), own = JSON.parse(fs.readFileSync(ownerFile));
  own.config = path.join(f.scratch, 'other-config'); fs.writeFileSync(ownerFile, JSON.stringify(own));
  assert.equal(f.snapshot().process, 'unknown'); assert.equal(f.snapshot().editable, false);
  const other = path.join(f.scratch, 'another', 'project'); fs.mkdirSync(other, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', other], { env: f.env, stdio: 'pipe', timeout: 10000 });
  const doc = housekeepingSnapshot({ cwd: other, org: f.env.ORG_DIR });
  assert.notEqual(doc.stateDir, f.state); assert.equal(doc.actions.length, 0); assert.equal(doc.process, 'stopped');
});

test('unreadable activity, invalid config, symlinks, hardlinks and concurrent writers remain explicit and leave targets intact', { timeout: 30000 }, t => {
  const f = fixture(t);
  fs.appendFileSync(f.logFile, 'not json\n{"action":"scan"');
  const doc = f.snapshot(); assert.equal(doc.lastScan.at, f.at); assert.match(doc.warnings.join(' '), /unreadable/);
  fs.writeFileSync(f.configFile, '{"resume":"bad"}');
  assert.match(f.snapshot().configError, /resume/); assert.equal(f.snapshot().config, null);
  assert.notEqual(f.cli(['housekeeping', 'pause']).status, 0);
  fs.rmSync(f.configFile);
  const external = path.join(f.scratch, 'external.json'); fs.writeFileSync(external, '{}');
  fs.symlinkSync(external, f.configFile);
  assert.notEqual(f.cli(['housekeeping', 'pause']).status, 0); assert.equal(fs.readFileSync(external, 'utf8'), '{}');
  fs.rmSync(f.configFile); fs.linkSync(external, f.configFile);
  assert.notEqual(f.cli(['housekeeping', 'pause']).status, 0); assert.equal(fs.readFileSync(external, 'utf8'), '{}');
  fs.rmSync(f.configFile); fs.mkdirSync(f.configFile + '.lock');
  assert.notEqual(f.cli(['housekeeping', 'pause']).status, 0); assert.equal(fs.existsSync(f.configFile), false);
});

test('console renders activity at all widths and reviews actual CLI pause and overrides, including cancellation and stale edits', { timeout: 45000 }, async t => {
  const f = fixture(t), s = f.session;
  await s.refresh(); await s.key('H');
  for (const cols of [80, 100, 140]) {
    const text = render(s, cols, 48);
    for (const pattern of [/Schedule: stopped/, /Last live scan/, /Finished worker/, /lane promoted/, /Busy worker/, /agent is working/, /resumed/, /R-7/, /resume-failed/, /Herdr unavailable/, /preview/]) assert.match(text, pattern);
    assert.equal(text.split('\n').length, 48); assert.doesNotMatch(text, /NaN/);
    assert.ok(s.ui.frame.hits.flat().some(h => h.id === 'housekeeping-pause'));
  }
  await s.activate('housekeeping-pause'); assert.match(render(s), /Review housekeeping change/);
  assert.equal(fs.existsSync(f.configFile), false);
  await s.activate('view:goals'); await s.key('H'); assert.equal(s.ui.view, 'housekeeping', 'review owns navigation');
  await s.activate('housekeeping-cancel'); assert.equal(fs.existsSync(f.configFile), false);
  await s.activate('housekeeping-pause'); await s.key('', { return: true });
  assert.equal(f.snapshot().config.enabled, false);
  await s.activate('housekeeping-edit'); await s.key('u', { ctrl: true }); await s.key('true');
  await s.key('', { tab: true }); await s.key('false'); await s.key('', { tab: true }); await s.key('5');
  await s.key('', { return: true }); assert.match(render(s), /tick_seconds: 60 → 5/);
  assert.equal(f.snapshot().config.tick_seconds, 60);
  await s.key('', { return: true });
  assert.equal(f.snapshot().config.tick_seconds, 5); assert.equal(f.snapshot().config.resume, false);
  assert.equal(f.snapshot().process, 'stopped', 'enabling never starts a timer');
  await s.activate('housekeeping-edit'); await s.key('', { tab: true }); await s.key('u', { ctrl: true });
  await s.key('', { return: true }); assert.match(render(s), /resume: false → true \(default\)/);
  f.org(['housekeeping', 'set', '--cleanup-seconds=45']); const before = fs.readFileSync(f.configFile, 'utf8');
  await s.key('', { return: true }); assert.match(s.ui.message, /changed since you opened/); assert.ok(s.ui.housekeepingEdit);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), before);
  await s.key('', { escape: true }); await s.refresh(); await s.activate('housekeeping-edit');
  await s.key('', { tab: true }); await s.key('u', { ctrl: true }); await s.key('q'); await s.key('', { return: true });
  assert.match(s.ui.message, /resume must be true\|false/); assert.equal(s.ui.housekeepingEdit.confirm, false);
  await s.activate('housekeeping-cancel');
});

test('housekeeping --print renders fixture and stays read only even when pause or override saves are confirmed', { timeout: 30000 }, t => {
  const f = fixture(t), config = path.join(f.scratch, 'console.json');
  fs.writeFileSync(config, JSON.stringify({ projects: [{ name: 'Housekeeping fixture', cwd: f.cwd, org: f.env.ORG_DIR }] }));
  const events = fs.readFileSync(path.join(f.env.ORG_DIR, 'events.jsonl'), 'utf8'), logs = fs.readFileSync(f.logFile, 'utf8');
  for (const keys of ['H', 'Hj\\n\\n', 'H\\nfalse\\n\\n']) {
    const output = execFileSync(process.execPath, [app, '--modern', '--config', config, '--print', '100x40', '--keys', keys],
      { cwd: f.cwd, env: f.env, encoding: 'utf8', timeout: 10000 });
    if (keys === 'H') { assert.match(output, /Housekeeping/); assert.match(output, /Finished worker/); }
    else assert.match(output, /--print does not change housekeeping/);
    assert.equal(fs.existsSync(f.configFile), false);
    assert.equal(fs.readFileSync(path.join(f.env.ORG_DIR, 'events.jsonl'), 'utf8'), events);
    assert.equal(fs.readFileSync(f.logFile, 'utf8'), logs);
  }
});


test('an unconfigured Git project can inspect defaults and save a tracked override without creating a record or schedule', { timeout: 30000 }, t => {
  const f = fixture(t);
  fs.rmSync(f.env.ORG_DIR, { recursive: true });
  const r = spawnSync(process.execPath, [bin, 'housekeeping', '--json'], { cwd: f.cwd, env: { ...f.env, ORG_DIR: '' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout); assert.equal(doc.process, 'no record'); assert.equal(doc.stateDir, null);
  assert.equal(fs.existsSync(f.configFile), false); assert.equal(fs.existsSync(f.env.ORG_DIR), false);
  const write = spawnSync(process.execPath, [bin, 'housekeeping', 'set', '--resume=false'], { cwd: f.cwd, env: { ...f.env, ORG_DIR: '' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(write.status, 0, write.stderr); assert.equal(fs.existsSync(f.env.ORG_DIR), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile)), { resume: false });
  const folder = path.join(f.scratch, 'ordinary'); fs.mkdirSync(folder);
  assert.notEqual(f.cli(['housekeeping', 'pause'], folder).status, 0);
  assert.equal(fs.existsSync(path.join(folder, '.housekeeping.json')), false);
});

test('console retains failed housekeeping reads with explicit stale state and prevents editing until recovery', { timeout: 30000 }, async t => {
  const f = fixture(t);
  let fail = false;
  const s = createModernSession({ config: { projects: [{ name: 'Scoped fixture', cwd: f.cwd, org: f.env.ORG_DIR }] }, env: f.env,
    deps: { herdrList: async () => [], herdrAgents: async () => ({ ok: true, agents: [] }), herdrRead: async () => ({ ok: true, text: '' }), brainQueue: async () => ({ rows: [], off: true }),
      orgHousekeeping: async () => { if (fail) throw Error('activity source inaccessible'); return f.snapshot(); } } });
  t.after(() => s.stop());
  await s.refresh(); await s.key('H'); assert.match(render(s), /Finished worker/);
  fail = true; await s.refresh();
  assert.match(render(s), /Last loaded housekeeping/); assert.match(render(s), /Finished worker/);
  await s.activate('housekeeping-pause'); assert.equal(s.ui.housekeepingEdit, null);
  assert.equal(fs.existsSync(f.configFile), false);
  fail = false; await s.refresh(); await s.activate('housekeeping-pause');
  assert.ok(s.ui.housekeepingEdit);
});

test('a discovered Git project without a record opens and edits housekeeping through the real console CLI adapters', { timeout: 30000 }, async t => {
  const f = fixture(t);
  fs.rmSync(f.env.ORG_DIR, { recursive: true });
  const workspace = { workspace_id: 'fresh-workspace', worktree: {
    repo_key: fs.realpathSync(path.join(f.cwd, '.git')), repo_root: f.cwd, checkout_path: f.cwd, is_linked_worktree: false,
  } };
  const s = createModernSession({ config: { projects: [] }, env: { ...f.env, HERDR_WORKSPACE_ID: workspace.workspace_id },
    deps: { herdrList: async kind => kind === 'workspace' ? [workspace] : [], herdrAgents: async () => ({ ok: true, agents: [] }),
      herdrRead: async () => ({ ok: true, text: '' }), brainQueue: async () => ({ rows: [], off: true }) } });
  t.after(() => s.stop());
  await s.refresh(); await s.key('H');
  assert.match(s.project.id, /^discovered:/); assert.equal(s.project.org, null);
  assert.equal(s.ui.errors.housekeeping, undefined);
  assert.match(render(s), /Schedule: no record/); assert.match(render(s), /Enabled · recovery on/);
  assert.equal(fs.existsSync(f.configFile), false);
  await s.activate('housekeeping-pause'); await s.key('', { return: true });
  assert.equal(s.ui.housekeepingEdit, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile, 'utf8')), { enabled: false });
  await s.activate('housekeeping-edit'); await s.key('', { tab: true }); await s.key('false');
  await s.key('', { return: true }); await s.key('', { return: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile, 'utf8')), { enabled: false, resume: false });
  assert.match(render(s), /Paused · recovery off/);
  assert.equal(s.model.housekeeping.stateDir, null); assert.equal(s.project.org, null);
  assert.equal(fs.existsSync(f.env.ORG_DIR), false, 'opening and editing do not initialize a record');
  assert.equal(fs.existsSync(path.join(f.cwd, 'null')), false, 'no literal-null record directory');
});

test('housekeeping close failures show both the actual error and planned reason in console and text CLI renders', { timeout: 30000 }, async t => {
  const f = fixture(t), s = f.session;
  fs.writeFileSync(f.logFile, JSON.stringify({ at: f.at, action: 'close-failed', tab_id: 'tab-failed', label: 'Finished worker',
    why: 'R-9 report recorded; clean lane promoted', error: 'Herdr refused to close tab-failed' }) + '\n');
  await s.refresh(); await s.key('H');
  for (const width of [80, 100, 140]) {
    const frame = s.frame(width, 40), text = frame.lines.map(lineText).join('\n');
    assert.match(text, /close-failed/); assert.match(text, /Error: Herdr refused to close tab-failed/);
    assert.match(text, /Reason: R-9 report recorded; clean lane promoted/);
    const errorLine = frame.lines.find(line => lineText(line).includes('Error: Herdr'));
    assert.ok(errorLine.spans.some(span => span.fg === 'amber'), 'actual failure remains highlighted');
  }
  const cliText = f.org(['housekeeping']);
  assert.match(cliText, /Error: Herdr refused to close tab-failed/);
  assert.match(cliText, /Reason: R-9 report recorded; clean lane promoted/);
  const config = path.join(f.scratch, 'failed-close-console.json');
  fs.writeFileSync(config, JSON.stringify({ projects: [{ name: 'Close failure fixture', cwd: f.cwd, org: f.env.ORG_DIR }] }));
  const output = execFileSync(process.execPath, [app, '--modern', '--config', config, '--print', '100x40', '--keys', 'H'],
    { cwd: f.cwd, env: f.env, encoding: 'utf8', timeout: 10000 });
  assert.match(output, /Error: Herdr refused to close tab-failed/);
  assert.match(output, /Reason: R-9 report recorded; clean lane promoted/);
});
