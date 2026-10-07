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
import { sessionEnvironment, sessionHookArguments } from '../session-hooks.mjs';
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
  for (const key of Object.keys(inherited)) if (/^MONITOR_(SESSION_ROLE|ENTRY_BYPASS|SUPERVISOR_)|^HERDR_(PANE_ID|AGENT_NAME)$/.test(key)) delete inherited[key];
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
  const binding = { MONITOR_SESSION_ROLE: 'supervisor', MONITOR_ENTRY_BYPASS: '0', MONITOR_SUPERVISOR_REPO: repo,
    MONITOR_SUPERVISOR_IDENTITY: project.identity, MONITOR_SUPERVISOR_ORG: org, MONITOR_SUPERVISOR_AGENT: 'supervisor-test', ORG_DIR: org };
  const start = (name, pid = deadPid) => {
    const item = record(['add', name]).split('\n')[0];
    const id = record(['start', item, '--workspace', repo, '--report', path.join(scratch, `${item}.md`)]).match(/R-\d+/)[0];
    record(['set', id, `agent=worker-${id}`, `watcher_pid=${pid}`, ...(pid === deadPid ? [] : [`watcher_identity=${ownerIdentity(pid)}`])]); return id;
  };
  return { root: scratch, repo, org, project, binding, record, git, start };
}
const load = () => import('../entry.mjs');
function codexLaunchHook(context) {
  const args = sessionHookArguments('codex', context, root);
  assert.equal(args.length, 2);
  assert.equal(args[0], '-c');
  assert.match(args[1], /^hooks\.SessionStart=/);
  const command = args[1].match(/command=("(?:[^"\\]|\\.)*")/);
  assert.ok(command, 'launch hook must supply a command');
  return { config: args[1], command: JSON.parse(command[1]) };
}

test('repository does not track a Codex project hook that can interrupt unattended workers', () => {
  assert.equal(good(exec('git', ['ls-files', '--', '.codex/hooks.json'], root)), '',
    'Codex project hooks require interactive trust before an unattended worker receives its task');
  assert.equal(fs.existsSync(path.join(root, '.codex/hooks.json')), false);
});

test('durable supervisor pane binding survives native restore, clear and compact without adapter env', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{"enabled":false}');
  fs.symlinkSync(path.join(root, 'supervisor'), path.join(f.repo, 'supervisor'), 'dir');
  sessionEnvironment({ role: 'supervisor', canonical: f.repo, identity: f.project.identity, org: f.org }, root,
    { HERDR_PANE_ID: 'wHD:pR', HERDR_AGENT_NAME: 'project-supervisor' });
  const hook = path.join(root, 'supervisor/session-start.mjs');
  for (const source of ['resume', 'clear', 'compact']) {
    for (const kind of ['claude', 'codex']) {
      const command = kind === 'codex' ? codexLaunchHook({ role: 'supervisor', canonical: root }).command
        : JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'))).hooks.SessionStart
          .flatMap(g => g.hooks).find(h => h.command.includes('session-start.mjs')).command;
      const r = exec('/bin/sh', ['-c', command], f.repo, { HERDR_PANE_ID: 'wHD:pR', CLAUDE_PROJECT_DIR: f.repo },
        JSON.stringify({ cwd: f.repo, hook_event_name: 'SessionStart', source, session_id: `new-${source}` }));
      good(r); assert.match(r.stdout, /Supervisor cold start/, `${kind} ${source}`);
    }
  }
  const lane = path.join(f.root, 'lane'); f.git(['worktree', 'add', '-qb', 'lane/restore', lane]);
  for (const [cwd, env] of [[f.repo, { HERDR_PANE_ID: 'wHD:pOther' }], [lane, { HERDR_PANE_ID: 'wHD:pR' }],
    [f.repo, { HERDR_PANE_ID: 'wHD:pR', MONITOR_SESSION_ROLE: 'worker' }],
    [f.repo, { HERDR_PANE_ID: 'wHD:pR', MONITOR_ENTRY_BYPASS: '1' }]]) {
    const r = exec(process.execPath, [hook], cwd, env, JSON.stringify({ cwd, hook_event_name: 'SessionStart', source: 'resume' }));
    good(r); assert.doesNotMatch(r.stdout, /Supervisor cold start/);
  }
  sessionEnvironment({ role: 'worker', canonical: f.repo, identity: f.project.identity, org: f.org }, root, { HERDR_PANE_ID: 'wHD:pR' });
  const revoked = exec(process.execPath, [hook], f.repo, { HERDR_PANE_ID: 'wHD:pR' },
    JSON.stringify({ cwd: f.repo, hook_event_name: 'SessionStart', source: 'resume' }));
  good(revoked); assert.doesNotMatch(revoked.stdout, /Supervisor cold start/);
});

test('claude adapter reuses the project SessionStart entry exactly once', t => {
  const f = fixture(t), directory = path.join(f.repo, '.claude');
  fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{"enabled":false}');
  fs.mkdirSync(directory);
  const project = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json')));
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(project));
  const context = { role: 'supervisor', canonical: f.repo, identity: f.project.identity, org: f.org };
  assert.deepEqual(sessionHookArguments('claude', context, root), [], 'project hook must not gain a second adapter hook');
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    const hooks = project.hooks.SessionStart.filter(g => !g.matcher || new RegExp(g.matcher).test(source))
      .flatMap(g => g.hooks).filter(h => h.command.includes('session-start.mjs'));
    assert.equal(hooks.length, 1);
    const r = exec('/bin/sh', ['-c', hooks[0].command], root,
      { ...f.binding, CLAUDE_PROJECT_DIR: root, MONITOR_SUPERVISOR_ENTRY: path.join(root, 'supervisor/session-start.mjs') },
      JSON.stringify({ cwd: f.repo, hook_event_name: 'SessionStart', source, session_id: 'single-entry' }));
    // Paused housekeeping keeps this integration test entirely foreground.
    good(r); assert.equal((r.stdout.match(/Supervisor cold start/g) ?? []).length, 1);
    assert.doesNotMatch(r.stdout, /session may continue/);
  }
});

test('codex supervisor adapter injects SessionStart without a project hook', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{"enabled":false}');
  const context = { role: 'supervisor', canonical: root };
  const hook = codexLaunchHook(context);
  assert.deepEqual(sessionHookArguments('codex', { ...context, role: 'worker' }, root), []);
  const matcher = JSON.parse(hook.config.match(/matcher=("(?:[^"\\]|\\.)*")/)[1]);
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    assert.ok(new RegExp(matcher).test(source));
    const r = exec('/bin/sh', ['-c', hook.command], f.repo, f.binding,
      JSON.stringify({ cwd: f.repo, hook_event_name: 'SessionStart', source, session_id: 'adapter-entry' }));
    good(r); assert.equal((r.stdout.match(/Supervisor cold start/g) ?? []).length, 1);
    assert.doesNotMatch(r.stdout, /session may continue/);
  }
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

test('adapter exports its known supervisor agent identity', t => {
  const f = fixture(t), context = { role: 'supervisor', canonical: f.repo, identity: f.project.identity, org: f.org };
  assert.equal(sessionEnvironment({ ...context, agent: 'supervisor-project' }, root, {}).MONITOR_SUPERVISOR_AGENT, 'supervisor-project');
  assert.equal(sessionEnvironment(context, root, { HERDR_AGENT_NAME: 'supervisor-project' }).MONITOR_SUPERVISOR_AGENT, 'supervisor-project');
  assert.equal(sessionEnvironment({ ...context, role: 'worker' }, root, { MONITOR_SUPERVISOR_AGENT: 'inherited' }).MONITOR_SUPERVISOR_AGENT, '');
});

test('project chat adapter and durable restore retain ops separately from the chat name', t => {
  const f = fixture(t), context = {role: 'supervisor', canonical: f.repo, identity: f.project.identity, org: f.org};
  const env = sessionEnvironment(context, root, {HERDR_PANE_ID: 'control:pChat', HERDR_AGENT_NAME: 'chat-project', MONITOR_SUPERVISOR_AGENT: 'ops-project'});
  assert.equal(env.HERDR_AGENT_NAME, 'chat-project'); assert.equal(env.MONITOR_SUPERVISOR_AGENT, 'ops-project');
  const receipt = JSON.parse(fs.readFileSync(path.join(f.repo, '.lane/supervisor/panes', `${createHash('sha256').update('control:pChat').digest('hex')}.json`)));
  assert.equal(receipt.to, 'ops-project');
  fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{"enabled":false}');
  const restored = exec(process.execPath, [path.join(root, 'supervisor/session-start.mjs')], f.repo,
    {HERDR_PANE_ID: 'control:pChat'}, JSON.stringify({cwd: f.repo, hook_event_name: 'SessionStart', source: 'resume'}));
  good(restored); assert.match(restored.stdout, /Supervisor cold start/); assert.doesNotMatch(restored.stdout, /session may continue/);
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

for (const source of ['startup', 'resume', 'clear', 'compact']) test(`Claude project hook delivers supervisor entry on ${source}`, t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{"enabled":false}');
  const config = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json')));
  const hook = config.hooks.SessionStart.flatMap(g => !g.matcher || new RegExp(g.matcher).test(source) ? g.hooks : []).find(h => h.command.includes('session-start'));
  assert.ok(hook, `no supervisor hook for ${source}`);
  const input = JSON.stringify({ hook_event_name: 'SessionStart', cwd: f.repo, source, session_id: 'test' });
  const env = { ...f.binding, CLAUDE_PROJECT_DIR: root, MONITOR_SUPERVISOR_ENTRY: path.join(root, 'supervisor/session-start.mjs') };
  // Project hook command is evaluated from this repository, payload still binds the actual session checkout.
  const r = exec('/bin/sh', ['-c', hook.command], root, env, input); good(r); assert.match(r.stdout, /Supervisor cold start/);
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

test('adapters use short fleet temp and bind both roles with native supervisor hooks', t => {
  for (const kind of ['claude', 'codex']) for (const role of ['supervisor', 'worker']) {
    const f = fixture(t), receipt = path.join(f.root, 'native.json'), fake = path.join(f.root, 'native');
    const temporary = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'se-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    joinFleet({ cwd: f.repo, temp: temporary });
    fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{"enabled":false}');
    fs.writeFileSync(fake, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({args:process.argv.slice(2),temp:process.env.TMPDIR,role:process.env.MONITOR_SESSION_ROLE,bypass:process.env.MONITOR_ENTRY_BYPASS,repo:process.env.MONITOR_SUPERVISOR_REPO,identity:process.env.MONITOR_SUPERVISOR_IDENTITY,org:process.env.MONITOR_SUPERVISOR_ORG,entry:process.env.MONITOR_SUPERVISOR_ENTRY}));\n`, { mode: 0o755 });
    const r = exec(process.execPath, [path.join(root, `discovery/adapters/${kind}.mjs`), '--repo', f.repo, '--role', role,
      '--binary', fake, '--validator', fake, '--runtime-dir', path.join(f.root, 'runtime'), '--worktree-root', path.join(f.root, 'worktrees'), '--', '--model', 'opaque-model'], f.repo, { ...f.binding, HERDR_PANE_ID: 'wTest:pSupervisor' });
    good(r); const native = JSON.parse(fs.readFileSync(receipt)); assert.equal(native.role, role); assert.ok(native.args.includes('opaque-model'));
    assert.equal(path.dirname(native.temp), temporary);
    assert.ok(Buffer.byteLength(native.temp) <= 60);
    assert.equal(native.bypass, role === 'supervisor' ? '0' : '1');
    if (role === 'supervisor') {
      assert.equal(native.repo, f.repo); assert.equal(native.identity, f.project.identity); assert.equal(native.org, path.join(f.repo, '.org'));
      assert.equal(native.entry, path.join(root, 'supervisor/session-start.mjs'));
      const hook = kind === 'claude' ? JSON.parse(native.args[native.args.indexOf('--settings') + 1]).hooks.SessionStart[0] : native.args.find(a => a.startsWith('hooks.SessionStart='));
      assert.match(JSON.stringify(hook), /startup.*resume.*clear.*compact/); assert.match(JSON.stringify(hook), /session-start.mjs/);
      const resumed = exec(process.execPath, [path.join(root, 'supervisor/session-start.mjs')], f.repo, { HERDR_PANE_ID: 'wTest:pSupervisor' },
        JSON.stringify({ cwd: f.repo, hook_event_name: 'SessionStart', source: 'resume' }));
      good(resumed); assert.match(resumed.stdout, /Supervisor cold start/);
    } else {
      assert.equal(native.repo, ''); assert.equal(native.identity, ''); assert.equal(native.entry, '');
      assert.ok(!native.args.some(a => a.includes('hooks.SessionStart='))); assert.ok(!native.args.includes('--settings'));
    }
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

for (const [kind, args] of [['claude', ['--resume', 'session']], ['claude', ['--continue']], ['codex', ['resume', 'session']]])
test(`${kind} interactive ${args[0]} through automatic adapter preserves supervisor entry and worker guards`, t => {
  const f = fixture(t), native = path.join(f.root, 'resume.cjs'), hook = path.join(root, 'supervisor/session-start.mjs');
  const tty = path.join(f.root, 'tty.cjs');
  fs.writeFileSync(tty, 'process.stdin.isTTY=true;process.stdout.isTTY=true;');
  fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{"enabled":false}');
  sessionEnvironment({ role: 'supervisor', canonical: f.repo, identity: f.project.identity, org: f.org }, root,
    { ...f.binding, HERDR_PANE_ID: 'w:pSupervisor' });
  fs.writeFileSync(native, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');
const r=spawnSync(process.execPath,[${JSON.stringify(hook)}],{env:process.env,
input:JSON.stringify({cwd:process.cwd(),hook_event_name:'SessionStart',source:'resume'}),encoding:'utf8'});
process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status);\n`, { mode: 0o755 });
  const adapter = [path.join(root, `discovery/adapters/${kind}.mjs`), '--auto-entry', '--repo', f.repo, '--binary', native, '--', ...args];
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8');
  for (const extra of [{}, f.binding, { MONITOR_SESSION_ROLE: 'worker' }, { MONITOR_ENTRY_BYPASS: '1' }]) {
    const r = exec(process.execPath, ['--require', tty, ...adapter], f.repo, { HERDR_PANE_ID: 'w:pSupervisor', ...extra });
    good(r);
    assert.equal(/Supervisor cold start/.test(r.stdout), extra.MONITOR_SESSION_ROLE !== 'worker' && extra.MONITOR_ENTRY_BYPASS !== '1', JSON.stringify(extra));
  }
  for (const headless of [false, true]) {
    const launch = headless ? [...adapter, ...(kind === 'claude' ? ['--print'] : ['exec'])] : adapter;
    const r = exec(process.execPath, [...(headless ? ['--require', tty] : []), ...launch], f.repo,
      { ...f.binding, HERDR_PANE_ID: 'w:pSupervisor' });
    good(r); assert.doesNotMatch(r.stdout, /Supervisor cold start/);
  }
  assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(f.org, 'housekeeping')));
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

for (const kind of ['claude', 'codex']) test(`${kind} nested headless launch cannot inherit supervisor recognition`, t => {
  const f = fixture(t), native = path.join(f.root, 'headless.cjs');
  fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{"enabled":false}');
  sessionEnvironment({ role: 'supervisor', canonical: f.repo, identity: f.project.identity, org: f.org }, root,
    { ...f.binding, HERDR_PANE_ID: 'w:pSupervisor' });
  fs.writeFileSync(native, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');
const r=spawnSync(process.execPath,[${JSON.stringify(path.join(root, 'supervisor/session-start.mjs'))}],{
  env:process.env,input:JSON.stringify({cwd:process.cwd(),hook_event_name:'SessionStart',source:'startup'}),encoding:'utf8'});
process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status);\n`, { mode: 0o755 });
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8');
  const r = exec(process.execPath, [path.join(root, `discovery/adapters/${kind}.mjs`), '--auto-entry', '--repo', f.repo,
    '--binary', native, '--', ...(kind === 'codex' ? ['exec', 'task'] : ['--print', 'task'])], f.repo,
    { ...f.binding, HERDR_PANE_ID: 'w:pSupervisor' });
  good(r); assert.equal(r.stdout, '');
  assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(f.org, 'housekeeping')));
  const resumed = exec(process.execPath, [path.join(root, 'supervisor/session-start.mjs')], f.repo,
    { HERDR_PANE_ID: 'w:pSupervisor' }, JSON.stringify({ cwd: f.repo, hook_event_name: 'SessionStart', source: 'resume' }));
  good(resumed); assert.match(resumed.stdout, /Supervisor cold start/, 'interactive receipt remains usable');
});
