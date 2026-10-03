import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitProject } from '../../lib/project.mjs';
import { coldStart, renderColdStart, receiptDirectory } from '../context.mjs';
import { configureCliFixture } from '../../housekeeping/test/helpers/cli-fixture.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const deadPid = 2147483647;
const exec = (file, args, cwd, env = {}, input) => spawnSync(file, args, { cwd, env: { ...process.env, ORG_ACTOR: 'entry-test', ...env }, input, encoding: 'utf8', timeout: 15000 });
const good = r => { assert.equal(r.status, 0, r.stderr || r.error?.message); return r.stdout.trim(); };
function fixture(t) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-entry-')));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const repo = path.join(scratch, 'repo'); fs.mkdirSync(repo);
  const git = args => good(exec('git', args, repo));
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Entry test']); git(['config', 'user.email', 'entry@example.invalid']);
  fs.writeFileSync(path.join(repo, 'seed'), 'seed'); git(['add', '.']); git(['commit', '-qm', 'seed']);
  const org = path.join(scratch, 'record');
  const record = args => good(exec(process.execPath, [path.join(root, 'bin/org.mjs'), ...args], repo, { ORG_DIR: org }));
  record(['init', org]);
  const project = { ...gitProject(repo), org };
  const binding = { MONITOR_SESSION_ROLE: 'supervisor', MONITOR_ENTRY_BYPASS: '0', MONITOR_SUPERVISOR_REPO: repo,
    MONITOR_SUPERVISOR_IDENTITY: project.identity, MONITOR_SUPERVISOR_ORG: org, MONITOR_SUPERVISOR_AGENT: 'supervisor-test', ORG_DIR: org };
  const start = (name, pid = deadPid) => {
    const item = record(['add', name]).split('\n')[0];
    const id = record(['start', item, '--workspace', repo, '--report', path.join(scratch, `${item}.md`)]).match(/R-\d+/)[0];
    record(['set', id, `agent=worker-${id}`, `watcher_pid=${pid}`]); return id;
  };
  return { root: scratch, repo, org, project, binding, record, git, start };
}
const load = () => import('../entry.mjs');
function fakeCommands(f) {
  const calls = [];
  let watching = new Set();
  const command = (file, args) => {
    calls.push(args);
    if (args[0].endsWith('supervisor.mjs')) return { status: 0, stdout: 'Supervisor cold start\n', stderr: '' };
    if (args[0].endsWith('housekeeping.mjs')) {
      const state = path.join(f.org, 'housekeeping', createHash('sha256').update(f.project.identity).digest('hex'));
      fs.mkdirSync(path.join(state, 'lock'), { recursive: true });
      fs.writeFileSync(path.join(state, 'lock/owner.json'), JSON.stringify({ pid: process.pid, cwd: f.repo, org: f.org,
        config: path.join(f.repo, '.housekeeping.json'), script: args[0], record_cli: [process.execPath, path.join(root, 'bin/org.mjs')] }));
      return { status: 0, stdout: '{"action":"started"}\n', stderr: '' };
    }
    if (args[0].endsWith('watch.mjs')) { watching.add(args[1]); return { status: 0, stdout: JSON.stringify({ run: args[1], pid: process.pid, log: path.join(f.root, 'watch.log') }), stderr: '' }; }
    const r = exec(file, args, f.repo, { ORG_DIR: f.org }); return r;
  };
  return { calls, command, watching };
}

test('entry CLI is non-blocking and prints the cold start with paused housekeeping', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{"enabled":false}');
  const r = exec(process.execPath, [path.join(root, 'supervisor/supervisor.mjs'), 'entry', '--repo', f.repo, '--org', f.org, '--role', 'supervisor'], f.repo);
  good(r); assert.match(r.stdout, /Supervisor cold start/); assert.match(r.stdout, /housekeeping.*disabled/i);
});

test('entry twice restarts stopped housekeeping and dead open watchers only once', async t => {
  const f = fixture(t), run = f.start('open'), live = f.start('live', process.pid), reported = f.start('reported');
  const report = path.join(f.root, 'reported.md');
  fs.writeFileSync(report, `---\nrun: ${reported}\noutcome: done\nsummary: Done\nblockers: []\nproposals: []\nartifacts: []\n---\n`);
  f.record(['ingest', report]);
  const fake = fakeCommands(f), { enterSupervisor } = await load();
  const output = []; const options = { cwd: f.repo, org: f.org, role: 'supervisor', to: 'supervisor-test', command: fake.command, output: text => output.push(text) };
  enterSupervisor(options);
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'); const count = fake.calls.length;
  enterSupervisor(options);
  assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), before);
  assert.deepEqual([...fake.watching], [run]); assert.ok(!fake.watching.has(reported)); assert.ok(!fake.watching.has(live));
  assert.equal(fake.calls.filter(a => a[0].endsWith('housekeeping.mjs')).length, 1);
  assert.equal(fake.calls.slice(count).filter(a => !a[0].endsWith('supervisor.mjs')).length, 0);
  assert.ok(output.join('').includes('Supervisor cold start'));
});

for (const override of [{ enabled: false }, { resume: false }]) test(`entry respects ${JSON.stringify(override)}`, async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), JSON.stringify(override));
  const fake = fakeCommands(f); const { enterSupervisor } = await load();
  enterSupervisor({ cwd: f.repo, org: f.org, role: 'supervisor', command: fake.command, output: () => {} });
  assert.equal(fake.calls.filter(a => a[0].endsWith('housekeeping.mjs')).length, 0);
});

test('cold-start brief flags a dead housekeeping process without changing its lock', t => {
  const f = fixture(t), state = path.join(f.org, 'housekeeping', createHash('sha256').update(f.project.identity).digest('hex'));
  const lock = path.join(state, 'lock'); fs.mkdirSync(lock, { recursive: true });
  const owner = JSON.stringify({ pid: deadPid, cwd: f.repo, org: f.org, config: path.join(f.repo, '.housekeeping.json'),
    script: path.join(root, 'housekeeping/housekeeping.mjs'), record_cli: [process.execPath, path.join(root, 'bin/org.mjs')] });
  fs.writeFileSync(path.join(lock, 'owner.json'), owner);
  assert.match(renderColdStart(coldStart({ cwd: f.repo, org: f.org })), /Housekeeping.*stale lock/);
  assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), owner);
});

test('entry reports dead promotion, release and settle owners but preserves all locks and live owners', async t => {
  const f = fixture(t), dirs = [path.join(f.project.identity, 'lane-promote.lock'), path.join(f.project.identity, 'promote/queue.lock'), path.join(receiptDirectory(f.org, f.project.identity), 'R-9.lock')];
  for (const dir of dirs) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: deadPid })); }
  const live = path.join(f.project.identity, 'promote/worker.lock'); fs.mkdirSync(live, { recursive: true }); fs.writeFileSync(path.join(live, 'owner.json'), JSON.stringify({ pid: process.pid }));
  const settle = path.join(f.org, 'settle', `${createHash('sha256').update(f.project.identity).digest('hex').slice(0, 20)}-topic.locks`);
  fs.mkdirSync(settle, { recursive: true }); const contender = path.join(settle, `${deadPid}-owner`); fs.writeFileSync(contender, '');
  const foreign = path.join(f.org, 'settle', 'foreign-topic.locks'); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, `${deadPid}-owner`), '');
  fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{"enabled":false}');
  const output = [], { enterSupervisor } = await load();
  enterSupervisor({ cwd: f.repo, org: f.org, role: 'supervisor', command: fakeCommands(f).command, output: s => output.push(s) });
  const text = output.join(''); for (const file of [...dirs, contender]) { assert.ok(text.includes(file), text); assert.ok(fs.existsSync(file)); }
  assert.ok(!text.includes(live)); assert.ok(!text.includes(foreign));
});

test('failed cold start, housekeeping and watch print reasons and allow later recovery steps', async t => {
  const f = fixture(t), run = f.start('open'), output = [], calls = [];
  const { enterSupervisor } = await load();
  assert.doesNotThrow(() => enterSupervisor({ cwd: f.repo, org: f.org, role: 'supervisor', output: s => output.push(s), command: (file, args) => {
    calls.push(args);
    if (args[0].endsWith('org.mjs')) return exec(file, args, f.repo, { ORG_DIR: f.org });
    return { status: 1, stdout: '', stderr: 'fixture failure' };
  } }));
  assert.ok(calls.some(a => a[0].endsWith('watch.mjs') && a[1] === run));
  assert.match(output.join(''), /brief.*fixture failure/s); assert.match(output.join(''), /housekeeping.*fixture failure/s); assert.match(output.join(''), /watch.*fixture failure/s);
});

for (const source of ['startup', 'resume', 'clear', 'compact']) test(`native hooks deliver the same entry on ${source}`, t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{"enabled":false}');
  for (const config of [JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'))), JSON.parse(fs.readFileSync(path.join(root, '.codex/hooks.json')))]) {
    const hook = config.hooks.SessionStart.flatMap(g => !g.matcher || new RegExp(g.matcher).test(source) ? g.hooks : []).find(h => h.command.includes('session-start'));
    assert.ok(hook, `no supervisor hook for ${source}`);
    const input = JSON.stringify({ hook_event_name: 'SessionStart', cwd: f.repo, source, session_id: 'test' });
    const env = { ...f.binding, CLAUDE_PROJECT_DIR: root, MONITOR_SUPERVISOR_ENTRY: path.join(root, 'supervisor/session-start.mjs') };
    // Project hook command is evaluated from this repository, payload still binds the actual session checkout.
    const r = exec('/bin/sh', ['-c', hook.command], root, env, input); good(r); assert.match(r.stdout, /Supervisor cold start/);
  }
});

for (const variant of ['unmarked', 'worker', 'lane', 'foreign', 'bad-input', 'missing-record', 'worker-bypass']) test(`hook skips or explains ${variant} without blocking startup`, t => {
  const f = fixture(t); let cwd = f.repo, env = { ...f.binding };
  if (variant === 'unmarked') env = { ORG_DIR: f.org, ORG_ACTOR: 'supervisor-test', HERDR_PANE_ID: 'supervisor' };
  if (variant === 'worker') env.MONITOR_SESSION_ROLE = 'worker';
  if (variant === 'worker-bypass') env.MONITOR_ENTRY_BYPASS = '1';
  if (variant === 'foreign') env.MONITOR_SUPERVISOR_IDENTITY = '/some/other/.git';
  if (variant === 'missing-record') env.MONITOR_SUPERVISOR_ORG = path.join(f.root, 'absent');
  if (variant === 'lane') { cwd = path.join(f.root, 'lane'); f.git(['worktree', 'add', '-qb', 'lane/test', cwd]); }
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8');
  const r = exec(process.execPath, [path.join(root, 'supervisor/session-start.mjs')], cwd, env,
    variant === 'bad-input' ? '{' : JSON.stringify({ cwd, hook_event_name: 'SessionStart', source: 'resume' }));
  good(r); assert.doesNotMatch(r.stdout, /Supervisor cold start/);
  assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(f.org, 'housekeeping')));
});

test('housekeeping resume recovers a confirmed dead matching owner and repeated entry adopts the new process', async t => {
  const f = fixture(t); configureCliFixture(f);
  const lock = path.join(f.state, 'lock'); fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: deadPid, cwd: f.repo, org: f.root, config: f.config, script: f.runtime, record_cli: [f.fake] }));
  t.after(async () => {
    if (!fs.existsSync(path.join(lock, 'owner.json'))) return;
    const pid = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'))).pid;
    if (pid !== deadPid) { process.kill(pid, 'SIGTERM'); for (let i = 0; i < 500 && fs.existsSync(lock); i++) await new Promise(r => setTimeout(r, 10)); assert.ok(!fs.existsSync(lock), 'schedule must stop before fixture cleanup'); }
  });
  const resumed = exec(process.execPath, [...f.args, '--start', '--resume'], f.repo); good(resumed); assert.match(resumed.stdout, /started/);
  const before = fs.readFileSync(path.join(lock, 'owner.json'), 'utf8');
  const again = exec(process.execPath, [...f.args, '--start', '--resume'], f.repo); good(again); assert.match(again.stdout, /already-running/);
  assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), before);
});

for (const kind of ['claude', 'codex']) for (const role of ['supervisor', 'worker']) test(`${kind} adapter binds ${role} and supplies native hooks only to supervisors`, t => {
  const f = fixture(t), receipt = path.join(f.root, 'native.json'), fake = path.join(f.root, 'native');
  fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{"enabled":false}');
  fs.writeFileSync(fake, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({args:process.argv.slice(2),role:process.env.MONITOR_SESSION_ROLE,bypass:process.env.MONITOR_ENTRY_BYPASS,repo:process.env.MONITOR_SUPERVISOR_REPO,identity:process.env.MONITOR_SUPERVISOR_IDENTITY,org:process.env.MONITOR_SUPERVISOR_ORG,entry:process.env.MONITOR_SUPERVISOR_ENTRY}));\n`, { mode: 0o755 });
  const r = exec(process.execPath, [path.join(root, `discovery/adapters/${kind}.mjs`), '--repo', f.repo, '--role', role,
    '--binary', fake, '--validator', fake, '--runtime-dir', path.join(f.root, 'runtime'), '--worktree-root', path.join(f.root, 'worktrees'), '--', '--model', 'opaque-model'], f.repo, { ...f.binding });
  good(r); const native = JSON.parse(fs.readFileSync(receipt)); assert.equal(native.role, role); assert.ok(native.args.includes('opaque-model'));
  assert.equal(native.bypass, role === 'supervisor' ? '0' : '1');
  if (role === 'supervisor') {
    assert.equal(native.repo, f.repo); assert.equal(native.identity, f.project.identity); assert.equal(native.org, path.join(f.repo, '.org'));
    assert.equal(native.entry, path.join(root, 'supervisor/session-start.mjs'));
    const hook = kind === 'claude' ? JSON.parse(native.args[native.args.indexOf('--settings') + 1]).hooks.SessionStart[0] : native.args.find(a => a.startsWith('hooks.SessionStart='));
    assert.match(JSON.stringify(hook), /startup.*resume.*clear.*compact/); assert.match(JSON.stringify(hook), /session-start.mjs/);
  } else {
    assert.equal(native.repo, ''); assert.equal(native.identity, ''); assert.equal(native.entry, '');
    assert.ok(!native.args.some(a => a.includes('hooks.SessionStart='))); assert.ok(!native.args.includes('--settings'));
  }
});

for (const variant of ['STOP', 'invalid-config', 'invalid-pid', 'reported-during-entry']) test(`entry safely handles ${variant}`, async t => {
  const f = fixture(t), run = f.start('open'), output = [], fake = fakeCommands(f), { enterSupervisor } = await load();
  if (variant === 'STOP') { fs.mkdirSync(path.join(f.repo, '.lane/supervisor'), { recursive: true }); fs.writeFileSync(path.join(f.repo, '.lane/supervisor/STOP'), ''); }
  if (variant === 'invalid-config') fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{');
  if (variant === 'invalid-pid') f.record(['set', run, 'watcher_pid=not-a-pid']);
  const command = (file, args, options) => {
    if (variant === 'reported-during-entry' && args[0].endsWith('housekeeping.mjs')) {
      const report = path.join(f.root, 'during.md'); fs.writeFileSync(report, `---\nrun: ${run}\noutcome: done\nsummary: Finished during entry\nblockers: []\nproposals: []\nartifacts: []\n---\n`); f.record(['ingest', report]);
    }
    return fake.command(file, args, options);
  };
  enterSupervisor({ cwd: f.repo, org: f.org, role: 'supervisor', command, output: s => output.push(s) });
  assert.ok(output.length);
  if (variant === 'invalid-config') { assert.equal(fake.calls.filter(a => a[0].endsWith('housekeeping.mjs')).length, 0); assert.ok(fake.watching.has(run), 'independent watch recovery still runs'); }
  else assert.equal(fake.watching.size, 0);
  if (variant === 'STOP') assert.equal(fake.calls.filter(a => !a[0].endsWith('supervisor.mjs')).length, 0);
});

for (const variant of ['live', 'invalid', 'foreign', 'missing-runtime', 'resume-disabled']) test(`housekeeping resume preserves a ${variant} owner`, t => {
  const f = fixture(t); configureCliFixture(f); const lock = path.join(f.state, 'lock'); fs.mkdirSync(lock, { recursive: true });
  const owner = { pid: variant === 'live' ? process.pid : deadPid, cwd: f.repo, org: f.root, config: f.config, script: f.runtime, record_cli: [f.fake] };
  if (variant === 'invalid') owner.pid = 0;
  if (variant === 'foreign') owner.cwd = '/other/project';
  if (variant === 'missing-runtime') owner.script = path.join(f.root, 'missing-runtime');
  if (variant === 'resume-disabled') fs.writeFileSync(f.config, '{"resume":false}');
  const before = JSON.stringify(owner); fs.writeFileSync(path.join(lock, 'owner.json'), before);
  const r = exec(process.execPath, [...f.args, '--start', '--resume'], f.repo);
  if (['live', 'resume-disabled'].includes(variant)) good(r); else assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(f.state, 'schedule.log')));
});
