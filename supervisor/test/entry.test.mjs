import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownerAlive, ownerIdentity } from '../../lib/process-owner.mjs';
import { lookupProcess } from '../../lib/processes.mjs';
import { housekeepingSnapshot } from '../../housekeeping/command.mjs';
import { gitProject } from '../../lib/project.mjs';
import { joinFleet } from '../../lib/fleet.mjs';
import { coldStart, renderColdStart, receiptDirectory } from '../context.mjs';
import { configureCliFixture } from '../../housekeeping/test/helpers/cli-fixture.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const linuxBoot = '12345678-1234-4234-8234-123456789abc';
const linuxOwner = birth => pid => pid === deadPid ? { ok: true, value: null } : lookupProcess(pid, { platform: 'linux', identityOnly: true, readFile: file => {
  if (file === '/proc/sys/kernel/random/boot_id') return `${linuxBoot}\n`;
  if (file === `/proc/${pid}/stat`) return `${pid} (watcher) S ${[1, pid, ...Array(16).fill(0), birth].join(' ')}\n`;
  throw Error(`unexpected Linux identity read: ${file}`);
} });
const deadPid = 2147483647;
const exec = (file, args, cwd, env = {}, input) => {
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) if (/^MONITOR_(SESSION_ROLE|SUPERVISOR_)|^HERDR_(PANE_ID|AGENT_NAME)$/.test(key)) delete inherited[key];
  return spawnSync(file, args, { cwd, env: { ...inherited, ORG_ACTOR: 'entry-test', ...env }, input, encoding: 'utf8', timeout: 15000 });
};
const good = r => { assert.equal(r.status, 0, r.stderr || r.error?.message); return r.stdout.trim(); };
function fixture(t) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-entry-')));
  fixtureFleet(t, scratch);
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const repo = path.join(scratch, 'repo'); fs.mkdirSync(repo);
  const git = args => good(exec('git', args, repo));
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Entry test']); git(['config', 'user.email', 'entry@example.invalid']);
  fs.writeFileSync(path.join(repo, 'seed'), 'seed'); git(['add', '.']); git(['commit', '-qm', 'seed']);
  const org = path.join(scratch, 'record');
  const record = args => good(exec(process.execPath, [path.join(root, 'bin/org.mjs'), ...args], repo, { ORG_DIR: org }));
  record(['init', org]);
  const project = { ...gitProject(repo), org };
  const binding = { MONITOR_SESSION_ROLE: 'supervisor', MONITOR_SUPERVISOR_REPO: repo,
    MONITOR_SUPERVISOR_IDENTITY: project.identity, MONITOR_SUPERVISOR_ORG: org, MONITOR_SUPERVISOR_AGENT: 'supervisor-test', ORG_DIR: org };
  const start = (name, pid = deadPid) => {
    const item = record(['add', name]).split('\n')[0];
    const id = record(['start', item, '--workspace', repo, '--report', path.join(scratch, `${item}.md`)]).match(/R-\d+/)[0];
    record(['set', id, `agent=worker-${id}`, `watcher_pid=${pid}`, ...(pid === deadPid ? [] : [`watcher_identity=${ownerIdentity(pid)}`])]); return id;
  };
  return { root: scratch, repo, org, project, binding, record, git, start };
}
const load = () => import('../entry.mjs');
test('repository does not track a Codex project hook that can interrupt unattended workers', () => {
  assert.equal(fs.existsSync(path.join(root, '.codex/hooks.json')), false);
});





test('re-armed watcher uses its recorded dispatch recipient before the supervisor fallback', async t => {
  const f = fixture(t), run = f.start('receipt recipient'), fallback = f.start('fallback recipient');
  fs.mkdirSync(path.join(f.org, 'dispatch'));
  const journal = path.join(f.org, 'dispatch', 'request-token.json');
  fs.writeFileSync(journal, JSON.stringify({ run, org: f.org, repo: f.repo, common: f.project.identity, workspace: f.repo, to: 'supervisor-another-project' }));
  f.record(['set', run, `dispatch_journal=${journal}`]);
  const fake = fakeCommands(f), { enterSupervisor } = await load();
  enterSupervisor({ cwd: f.repo, org: f.org, role: 'supervisor', to: 'supervisor-fallback', command: fake.command, output: () => {} });
  const recipient = id => { const args = fake.calls.find(a => a[0].endsWith('watch.mjs') && a[1] === id); return args[args.indexOf('--to') + 1]; };
  assert.equal(recipient(run), 'supervisor-another-project');
  assert.equal(recipient(fallback), 'supervisor-fallback');
  const absent = f.start('missing dispatch receipt');
  f.record(['set', absent, `dispatch_journal=${path.join(f.org, 'dispatch', 'gone.json')}`]);
  enterSupervisor({ cwd: f.repo, org: f.org, role: 'supervisor', to: 'supervisor-fallback', command: fake.command, output: () => {} });
  assert.equal(recipient(absent), 'supervisor-fallback');
});




function fakeCommands(f) {
  const calls = [];
  let watching = new Set();
  const command = (file, args) => {
    calls.push(args);
    if (args[0].endsWith('supervisor.mjs')) return { status: 0, stdout: 'Supervisor cold start\n', stderr: '' };
    if (args[0].endsWith('housekeeping.mjs')) {
      const state = path.join(f.org, 'housekeeping', createHash('sha256').update(f.project.identity).digest('hex'));
      fs.mkdirSync(path.join(state, 'lock'), { recursive: true });
      fs.writeFileSync(path.join(state, 'lock/owner.json'), JSON.stringify({ pid: process.pid, identity: ownerIdentity(process.pid), cwd: f.repo, org: f.org,
        config: path.join(f.repo, '.housekeeping.json'), script: args[0], record_cli: [process.execPath, path.join(root, 'bin/org.mjs')] }));
      return { status: 0, stdout: '{"action":"started"}\n', stderr: '' };
    }
    if (args[0].endsWith('watch.mjs')) { watching.add(args[1]); return { status: 0, stdout: JSON.stringify({ run: args[1], pid: process.pid, identity: ownerIdentity(process.pid), log: path.join(f.root, 'watch.log') }), stderr: '' }; }
    const r = exec(file, args, f.repo, { ORG_DIR: f.org }); return r;
  };
  return { calls, command, watching };
}

test('entry CLI is non-blocking and prints the cold start with paused housekeeping', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{"enabled":false}');
  const r = exec(process.execPath, [path.join(root, 'supervisor/supervisor.mjs'), 'entry', '--repo', f.repo, '--org', f.org, '--role', 'supervisor'], f.repo);
  good(r); assert.match(r.stdout, /Supervisor cold start/); assert.match(r.stdout, /housekeeping.*disabled/i);
  assert.ok(r.stdout.includes(`Read the supervisor protocol: ${path.join(root, 'supervisor/PROTOCOL.md')}`));
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
  const owner = { pid: variant === 'live' ? process.pid : deadPid, identity: ownerIdentity(process.pid), cwd: f.repo, org: f.root, config: f.config, script: f.runtime, record_cli: [f.fake] };
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

for (const variant of ['reused', 'unreadable', 'legacy-live', 'changed-during-entry']) test(`watch recovery handles ${variant} identity without blocking entry`, async t => {
  const f = fixture(t), run = f.start('identity recovery', process.pid), fake = fakeCommands(f), output = [];
  const actual = ownerIdentity(process.pid);
  if (variant === 'reused') f.record(['set', run, 'watcher_identity=old-boot']);
  if (variant === 'legacy-live') f.record(['set', run, 'watcher_identity=']);
  let calls = 0;
  const readProcess = pid => {
    if (variant === 'unreadable') return { ok: false, error: 'fixture permission denied' };
    return { ok: true, value: { pid, identity: variant === 'changed-during-entry' && ++calls === 1 ? 'replacement' : actual, state: 'S' } };
  };
  const { enterSupervisor } = await load();
  assert.doesNotThrow(() => enterSupervisor({ cwd: f.repo, org: f.org, role: 'supervisor', readProcess,
    command: fake.command, output: s => output.push(s) }));
  assert.equal(fake.watching.has(run), variant === 'reused');
  if (variant === 'reused') {
    assert.match(output.join(''), /re-armed/);
    assert.equal(JSON.parse(f.record(['show', run, '--json'])).meta.watcher_identity, actual);
  }
  if (variant === 'unreadable') assert.match(output.join(''), /identity unavailable.*permission denied.*session may continue/);
  if (variant === 'legacy-live') assert.match(output.join(''), /start-time identity is missing.*session may continue/);
});

test('empty supervisor environment and null dispatch recipient use the supervisor fallback', async t => {
  const f = fixture(t), run = f.start('null recipient'), journal = path.join(f.root, 'receipt.json');
  fs.writeFileSync(journal, JSON.stringify({ run, to: null }));
  f.record(['set', run, `dispatch_journal=${journal}`]);
  const fake = fakeCommands(f), { enterSupervisor } = await load();
  enterSupervisor({ cwd: f.repo, org: f.org, role: 'supervisor', to: '', command: fake.command, output: () => {} });
  const args = fake.calls.find(a => a[0].endsWith('watch.mjs'));
  assert.equal(args[args.indexOf('--to') + 1], 'supervisor-herdr');
});

for (const variant of ['reused', 'unreadable', 'legacy-live']) test(`housekeeping snapshot reports ${variant} birth without changing the lock`, t => {
  const f = fixture(t), state = path.join(f.org, 'housekeeping', createHash('sha256').update(f.project.identity).digest('hex'));
  const lock = path.join(state, 'lock'); fs.mkdirSync(lock, { recursive: true });
  const owner = { pid: process.pid, identity: 'old-boot', cwd: f.repo, org: f.org, config: path.join(f.repo, '.housekeeping.json'),
    script: path.join(root, 'housekeeping/housekeeping.mjs'), record_cli: [process.execPath, path.join(root, 'bin/org.mjs')] };
  if (variant === 'legacy-live') delete owner.identity;
  const bytes = JSON.stringify(owner), file = path.join(lock, 'owner.json'); fs.writeFileSync(file, bytes);
  const readProcess = pid => variant === 'unreadable' ? { ok: false, error: 'fixture denied' }
    : { ok: true, value: { pid, identity: 'new-boot', state: 'S' } };
  const snapshot = housekeepingSnapshot({ cwd: f.repo, org: f.org, readProcess });
  assert.equal(snapshot.process, variant === 'reused' ? 'stale lock' : 'unknown');
  if (variant !== 'reused') assert.match(snapshot.warnings.join(''), /identity/);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

test('housekeeping resume replaces a reused PID without signaling the replacement process', async t => {
  let f, lock;
  t.after(async () => {
    const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json')));
    if (owner.pid === process.pid) return;
    process.kill(owner.pid, 'SIGTERM');
    for (let i = 0; i < 500 && fs.existsSync(lock); i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(!fs.existsSync(lock), 'fixture schedule must stop before removal');
  });
  f = fixture(t); configureCliFixture(f);
  lock = path.join(f.state, 'lock'); fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, identity: 'prior-boot',
    cwd: f.repo, org: f.root, config: f.config, script: f.runtime, record_cli: [f.fake] }));
  const r = exec(process.execPath, [...f.args, '--start', '--resume'], f.repo);
  good(r); assert.match(r.stdout, /recovered-dead-owner/);
  const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json')));
  assert.notEqual(owner.pid, process.pid); assert.equal(owner.identity, ownerIdentity(owner.pid));
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});


test('Linux watcher recovery round-trips textual identities through record set and compares changed ticks', async t => {
  const f = fixture(t), run = f.start('Linux watcher'), fake = fakeCommands(f), output = [];
  fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{"enabled":false}');
  let readProcess = linuxOwner('12345');
  const command = (file, args, options) => args[0].endsWith('watch.mjs')
    ? { status: 0, stdout: JSON.stringify({ run, pid: process.pid, identity: ownerIdentity(process.pid, readProcess), log: path.join(f.root, 'watch.log') }) }
    : fake.command(file, args, options);
  const { enterSupervisor } = await load();
  const enter = () => enterSupervisor({ cwd: f.repo, org: f.org, role: 'supervisor', readProcess, command, output: s => output.push(s) });
  enter();
  const stored = () => JSON.parse(f.record(['show', run, '--json'])).meta.watcher_identity;
  assert.equal(typeof stored(), 'string');
  assert.equal(stored(), ownerIdentity(process.pid, readProcess));
  assert.equal(ownerAlive({ pid: process.pid, identity: stored() }, readProcess), true);
  enter(); assert.equal(output.filter(s => /re-armed/.test(s)).length, 1);
  readProcess = linuxOwner('12346');
  assert.equal(ownerAlive({ pid: process.pid, identity: stored() }, readProcess), false);
  enter(); assert.equal(output.filter(s => /re-armed/.test(s)).length, 2);
  assert.equal(stored(), ownerIdentity(process.pid, readProcess));
  assert.equal(typeof stored(), 'string');
});
