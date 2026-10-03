import test from '../../test/helpers/bounded-test.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { configureCliFixture, installRuntime, rememberHousekeepingProcess, createHousekeepingStarter } from './helpers/cli-fixture.mjs';
import { createReceiptTracker } from '../../test/helpers/receipts.mjs';
import { createProcessTracker } from '../../test/helpers/processes.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHousekeeping, interruptedComposer, matchingRun, readConfig } from '../housekeeping.mjs';
import { readInbox } from '../../supervisor/prompt-supervisor.mjs';
import { waitForInboxIdle } from '../../test/helpers/inbox.mjs';

const TEST_ENV = { ...process.env, ORG_ACTOR: 'housekeeping-test-agent' };
const screen = fs.readFileSync(new URL('./fixtures/interrupted.txt', import.meta.url), 'utf8');
function fixture(t, { promoted = true, reported = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'housekeeping-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'project'), lane = path.join(root, 'lane');
  fs.mkdirSync(repo);
  const git = (args, cwd = repo) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: TEST_ENV });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'file'), 'base'); git(['add', '.']); git(['commit', '-m', 'base']);
  git(['worktree', 'add', '-b', 'lane/topic', lane]);
  fs.writeFileSync(path.join(lane, 'file'), 'work'); git(['add', '.'], lane); git(['commit', '-m', 'work'], lane);
  if (promoted) git(['merge', '--ff-only', 'lane/topic']);
  const common = fs.realpathSync(path.join(repo, '.git'));
  const agent = { name: 'lane-worker', agent: 'codex', agent_status: 'idle', pane_id: 'w:p', tab_id: 'w:t',
    workspace_id: 'w', cwd: lane, terminal_id: 'term-a', state_change_seq: 7 };
  const run = { id: 'R-1', item: 'ENG-1', started: { seq: 1 }, workspace: lane, report_path: path.join(lane, 'report.md'),
    meta: { agent: agent.name, pane: agent.pane_id, worker_workspace: 'w', terminal_id: agent.terminal_id, lane: 'topic' },
    report: reported ? { outcome: 'done' } : null, abandoned: null };
  const f = { root, repo, lane, git, common, agent, run,
    items: [{ id: 'ENG-1', status: reported ? 'done' : 'active', blocked_by: [] }], runs: [run], agents: [agent],
    tabs: [{ tab_id: 'w:t', label: 'worker' }], panes: [{ pane_id: 'w:p', tab_id: 'w:t' }],
    ws: [{ workspace_id: 'w', worktree: { checkout_path: lane, repo_root: repo, repo_key: common, is_linked_worktree: true } }],
    actions: [], logs: [], shell: true, text: screen, before: () => {} };
  f.command = (exe, args, options) => {
    if (exe === 'git') return spawnSync(exe, args, options);
    f.before(exe, args);
    const result = (value) => ({ status: 0, stdout: JSON.stringify({ result: value }), stderr: '' });
    if (exe === 'fake-record') return result({ runs: f.runs, items: f.items });
    assert.equal(exe, 'fake-herdr');
    if (args[0] === 'workspace') return result({ workspaces: f.ws });
    if (args[0] === 'tab' && args[1] === 'list') return result({ tabs: f.tabs });
    if (args[0] === 'pane' && args[1] === 'list') return result({ panes: f.panes });
    if (args[0] === 'pane' && args[1] === 'process-info') return result({ process_info: { shell_pid: 1,
      foreground_processes: [{ pid: f.shell ? 1 : 2, name: f.shell ? 'zsh' : 'node' }] } });
    if (args[0] === 'agent' && args[1] === 'list') return result({ agents: f.agents });
    if (args[0] === 'agent' && args[1] === 'read') return { status: 0, stdout: f.text, stderr: '' };
    f.actions.push(args);
    return result({});
  };
  f.runner = (extra = {}) => createHousekeeping({ cwd: repo, org: root, herdr: 'fake-herdr', record: ['fake-record'],
    command: f.command, log: (entry) => f.logs.push(entry), selfTab: null, ...extra });
  return f;
}

test('interruption requires the current banner and an exclusively wheel-junk composer', () => {
  assert.equal(interruptedComposer(screen), true);
  assert.equal(interruptedComposer(screen.replace('<65;12;9M<64;12;9M', '\x1b[<65;12;9M')), true);
  for (const value of [screen.replace('■ Conversation interrupted', 'Finished'),
    screen.replace('› <65;12;9M<64;12;9M', '› continue'),
    screen.replace('<65;12;9M', 'stop <65;12;9M'),
    screen.replace('\n›', '\n• Finished and wrote the report.\n›'),
    screen.replace('<65;12;9M<64;12;9M', '<0;12;9M'),
    screen.replace('› <65;12;9M<64;12;9M', '› Ask Codex to do anything')]) assert.equal(interruptedComposer(value), false);
});

test('recorded promoted workers close through the shared tidy planner', (t) => {
  const f = fixture(t); const plan = f.runner().tick();
  assert.equal(plan.close.length, 1); assert.deepEqual(f.actions, [['tab', 'close', 'w:t']]);
  assert.match(f.logs.find((x) => x.action === 'closed').why, /R-1/);
});

test('abandoned promoted workers may close', (t) => {
  const f = fixture(t); f.run.report = null; f.run.abandoned = { seq: 4 };
  f.runner().tick(); assert.equal(f.actions.length, 1);
});

test('CLI-closed unmerged work is authorized by its Git archive, never a session done marker', (t) => {
  const f = fixture(t, { promoted: false });
  f.git(['worktree', 'remove', f.lane]); f.git(['tag', 'archive/lane/topic', 'lane/topic']); f.git(['branch', '-D', 'lane/topic']);
  f.runner().tick(); assert.deepEqual(f.actions, [['tab', 'close', 'w:t']]);
});

for (const variant of ['open', 'unpromoted', 'dirty', 'blocked', 'working', 'unknown', 'unnamed', 'unrecorded',
  'replaced', 'waiting', 'report-blocked', 'report-needs-human', 'new-open-run', 'declined', 'wrong-repo', 'mixed-pane', 'running-shell', 'session-done', 'review-file']) {
  test(`preserves ${variant} workers/tabs`, (t) => {
    const f = fixture(t, { promoted: !['unpromoted', 'session-done', 'review-file'].includes(variant) });
    if (variant === 'session-done') {
      fs.mkdirSync(path.join(f.repo, '.lane/sessions.json.d'), { recursive: true });
      fs.writeFileSync(path.join(f.repo, '.lane/sessions.json.d/display.done.json'), JSON.stringify({ name: f.agent.name, done: true }));
    }
    if (variant === 'review-file') {
      fs.mkdirSync(path.join(f.lane, 'docs/reviews/topic'), { recursive: true });
      fs.writeFileSync(path.join(f.lane, 'docs/reviews/topic/latest.md'), '**PASS**');
    }
    if (variant === 'open') { f.run.report = null; f.text = 'finished\n› Ask Codex'; }
    if (variant === 'dirty') fs.writeFileSync(path.join(f.lane, 'file'), 'dirty');
    if (['blocked', 'working', 'unknown'].includes(variant)) f.agent.agent_status = variant;
    if (variant === 'unnamed') delete f.agent.name;
    if (variant === 'unrecorded') f.runs = [];
    if (variant === 'replaced') f.agent.terminal_id = 'term-new';
    if (variant === 'waiting') { f.items[0].blocked_by = ['HUM-1']; f.items.push({ id: 'HUM-1', status: 'ready' }); }
    if (variant === 'declined') { f.items[0].blocked_by = ['HUM-1']; f.items.push({ id: 'HUM-1', status: 'done', closed: {}, meta: { answer: 'no' } }); }
    if (variant.startsWith('report-')) f.run.report.outcome = variant === 'report-blocked' ? 'blocked' : 'needs_human';
    if (variant === 'new-open-run') f.runs.push({ ...f.run, id: 'R-2', report: null, started: { seq: 2 }, meta: { ...f.run.meta, agent: 'new-worker' } });
    if (variant === 'wrong-repo') f.ws[0].worktree.repo_key = f.root;
    if (variant === 'mixed-pane') { f.agents.push({ ...f.agent, name: 'operator', pane_id: 'w:q' }); f.panes.push({ pane_id: 'w:q', tab_id: 'w:t' }); }
    if (variant === 'running-shell') { f.shell = false; f.panes.push({ pane_id: 'w:q', tab_id: 'w:t' }); }
    f.runner().tick(); assert.deepEqual(f.actions, []);
    if (variant !== 'wrong-repo') assert.ok(f.logs.some(entry => entry.action === 'keep' && entry.why && entry.dryRun === false), 'live kept tabs record reasons');
  });
}

test('latest open fix round defeats an older reported run using the same worker name', (t) => {
  const f = fixture(t); const later = { ...f.run, id: 'R-2', report: null, started: { seq: 2 } };
  f.runs.push(later); assert.equal(matchingRun(f.agent, f.runs), later);
  f.text = 'finished\n› Ask Codex'; f.runner().tick(); assert.deepEqual(f.actions, []);
});

test('unknown finished sessions stay; exited watcher shell tabs use tidy-tabs', (t) => {
  const f = fixture(t); f.ws[0].worktree.is_linked_worktree = false;
  f.ws[0].worktree.checkout_path = f.repo;
  f.tabs[0].label = 'watch R-99'; f.agents = [];
  f.runner().tick(); assert.deepEqual(f.actions, [['tab', 'close', 'w:t']]);
  f.actions = []; f.tabs[0].label = 'executive'; f.agents = [{ ...f.agent, name: 'exec-1' }];
  f.runner().tick(); assert.deepEqual(f.actions, []);
});

test('never closes or resumes its own tab', (t) => {
  const f = fixture(t); f.runner({ selfTab: 'w:t' }).tick(); assert.deepEqual(f.actions, []);
  f.run.report = null; f.runner({ selfTab: 'w:t' }).tick(); assert.deepEqual(f.actions, []);
});

test('an interrupted open worker resumes once, and durable attempts survive a new runner', (t) => {
  const f = fixture(t, { reported: false }); const seen = new Set(), attempts = [];
  f.runner().tick({ seen, remember: (key) => attempts.push(key) });
  assert.equal(attempts.length, 1);
  assert.deepEqual(f.actions.map((a) => a.slice(0, 2)), [['agent', 'send-keys'], ['agent', 'prompt']]);
  f.runner().tick({ seen: new Set(attempts) }); assert.equal(f.actions.length, 2);
});

test('failed prompt is logged and never replayed at the same state sequence', (t) => {
  const f = fixture(t, { reported: false }); const seen = new Set();
  const original = f.command;
  f.command = (exe, args, opts) => args[1] === 'prompt' ? { status: 1, stderr: 'offline', stdout: '' } : original(exe, args, opts);
  f.runner().tick({ seen }); f.runner().tick({ seen });
  assert.equal(f.actions.length, 1); assert.equal(f.logs.some((e) => e.action === 'resume-failed'), true);
});

test('unrecorded disk report, human words, other harness and absent identity prevent resume', (t) => {
  const f = fixture(t, { reported: false });
  fs.writeFileSync(f.run.report_path, 'not yet ingested'); f.runner().tick(); assert.deepEqual(f.actions, []);
  fs.unlinkSync(f.run.report_path);
  f.text = screen.replace('<65;', 'stop <65;'); f.runner().tick(); assert.deepEqual(f.actions, []);
  f.text = screen; f.agent.agent = 'claude'; f.runner().tick(); assert.deepEqual(f.actions, []);
  f.agent.agent = 'codex'; delete f.run.meta.terminal_id; f.runner().tick(); assert.deepEqual(f.actions, []);
});

test('dry run reports close/resume plans and persists no attempts or live actions', (t) => {
  const f = fixture(t); f.runner().tick({ dryRun: true }); assert.equal(f.logs.some((e) => e.action === 'would-close'), true);
  f.run.report = null;
  f.runner().tick({ dryRun: true, remember: () => assert.fail('persisted') });
  assert.equal(f.logs.some((e) => e.action === 'would-resume'), true); assert.deepEqual(f.actions, []);
});

test('fresh state or record changes prevent deletion', (t) => {
  const f = fixture(t); let reads = 0;
  f.before = (exe, args) => { if (args[0] === 'agent' && args[1] === 'list' && ++reads === 2) f.agent.agent_status = 'working'; };
  f.runner().tick(); assert.deepEqual(f.actions, []); assert.equal(f.logs.some((e) => e.action === 'skip-close'), true);
});

test('a run completed during the pre-input recheck receives no resume input', (t) => {
  const f = fixture(t, { reported: false }); let reads = 0;
  f.before = (exe) => { if (exe === 'fake-record' && ++reads === 2) f.run.report = { outcome: 'done' }; };
  f.runner().tick(); assert.deepEqual(f.actions, []);
});

test('a record change after clearing composer suppresses the prompt', (t) => {
  const f = fixture(t, { reported: false }); let reads = 0;
  f.before = (exe) => { if (exe === 'fake-record' && ++reads === 3) f.run.report = { outcome: 'done' }; };
  f.runner().tick(); assert.deepEqual(f.actions.map((a) => a[1]), ['send-keys']);
  assert.equal(f.logs.some((e) => e.action === 'skip-resume'), true);
});

test('incomplete or failed reads never authorize any action', (t) => {
  const f = fixture(t); const original = f.command;
  for (const failure of ['herdr', 'record', 'topology']) {
    f.command = (exe, args, opts) => {
      if ((failure === 'herdr' && args[0] === 'agent') || (failure === 'record' && exe === 'fake-record')) return { status: 1, stdout: '', stderr: 'offline' };
      if (failure === 'topology' && args[0] === 'pane' && args[1] === 'list') return { status: 0, stdout: '{"result":{}}' };
      return original(exe, args, opts);
    };
    assert.throws(() => f.runner().tick(), /offline|topology/); assert.deepEqual(f.actions, []);
  }
});

function cliFixture(t) { return configureCliFixture(fixture(t)); }

test('one-shot logs actions, disabled config stops, invalid config refuses, and overlap refuses', (t) => {
  const f = cliFixture(t);
  const run = () => spawnSync(process.execPath, [...f.args, '--once'], { encoding: 'utf8', env: TEST_ENV });
  const first = run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(fs.existsSync(path.join(f.state, 'actions.jsonl')), true);
  fs.writeFileSync(f.config, '{"enabled":false}'); assert.match(run().stdout, /disabled/);
  fs.writeFileSync(f.config, '{"enabled":"yes"}'); assert.equal(run().status, 1);
  assert.throws(() => readConfig(f.config), /enabled/);
  fs.mkdirSync(path.join(f.state, 'lock')); assert.equal(run().status, 1);
});

test('the loop rereads opt-in and shuts down with its lock removed', async (t) => {
  const f = cliFixture(t);
  const child = spawnChild(t, process.execPath, [...f.args, '--loop'], { env: TEST_ENV });
  let output = '', errors = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (output.includes('scan')) fs.writeFileSync(f.config, '{"enabled":false}');
  });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const { code } = await waitForExit(child);
  assert.equal(code, 0, errors); assert.match(output, /disabled/);
  assert.equal(fs.existsSync(path.join(f.state, 'lock')), false);
});

for (const target of ['canonical checkout', 'linked preview']) {
test(`no configuration defaults on and project record/main are discovered from a ${target}`, (t) => {
  const f = cliFixture(t);
  fs.mkdirSync(path.join(f.repo, '.org'));
  fs.writeFileSync(path.join(f.repo, '.org/events.jsonl'), '');
  f.git(['branch', '-m', 'main', 'trunk']);
  const args = f.args.filter((arg, i, all) => !['--org', '--config'].includes(arg) && !['--org', '--config'].includes(all[i - 1]));
  if (target === 'linked preview') args[args.indexOf('--cwd') + 1] = f.lane;
  const r = spawnSync(process.execPath, [...args, '--once', ...(target === 'linked preview' ? ['--dry-run'] : [])],
    { encoding: 'utf8', env: { ...TEST_ENV, ORG_DIR: '' } });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /scan/);
  assert.deepEqual(readConfig(path.join(f.root, 'missing')), { enabled: true, tick_seconds: 60, cleanup_seconds: 600 });
});
}

test('no record and no Git project are quiet no-ops', (t) => {
  const f = cliFixture(t);
  const r = spawnSync(process.execPath, [f.runtime, '--once', '--cwd', f.repo], { encoding: 'utf8', env: { ...TEST_ENV, ORG_DIR: '' } });
  assert.equal(r.status, 0); assert.match(r.stdout, /no-record/);
  const outside = spawnSync(process.execPath, [f.runtime, '--once', '--cwd', f.root], { encoding: 'utf8', env: TEST_ENV });
  assert.equal(outside.status, 0); assert.match(outside.stdout, /no-project/);
});
test('an existing housekeeping tick recovers pending notice intent while dry-run starts no delivery', async (t) => {
  const f = cliFixture(t), inbox = path.join(f.root, 'supervisor/inbox.log');
  fs.mkdirSync(path.dirname(inbox));
  const notice = { type: 'notice', at: new Date().toISOString(), id: 'tick-recovery', to: 'supervisor',
    message: 'tick notice', herdr: f.fake, attempts: 1, retrySeconds: 0, title: 'Notice', sound: 'request' };
  fs.writeFileSync(inbox, JSON.stringify(notice) + '\n' + JSON.stringify({ type: 'sending', id: notice.id }) + '\n');
  fs.writeFileSync(f.fake, `#!${process.execPath}\nimport fs from 'node:fs';const a=process.argv.slice(2);
if(a[0]==='agent'&&a[1]==='get') console.log(JSON.stringify({result:{agent:{agent:'claude',agent_status:'idle',pane_id:'fake:supervisor'}}}));
else if(a[0]==='pane'&&a[1]==='read') console.log('────────────────────\\n❯ \\n────────────────────');
else { if(a[0]==='agent'&&a[1]==='prompt') fs.writeFileSync(${JSON.stringify(path.join(f.root, 'notice.txt'))},a[3]);
console.log(JSON.stringify({result:a[0]==='status'?{runs:[],items:[]}:a[0]==='workspace'?{workspaces:[]}:{agents:[]}})); }\n`);
  const env = { ...TEST_ENV, SUPERVISOR_INPUT_CONFIRM_SECONDS: '.02', SUPERVISOR_INPUT_POLL_SECONDS: '.01', SUPERVISOR_INPUT_WAIT_SECONDS: '0' };
  const preview = spawnSync(process.execPath, [...f.args, '--once', '--dry-run'], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(preview.status, 0, preview.stderr); assert.equal(fs.existsSync(`${inbox}.owner.lock`), false);
  assert.equal(readInbox(inbox)[0].state, 'uncertain');
  const tick = spawnSync(process.execPath, [...f.args, '--once'], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(tick.status, 0, tick.stderr); assert.match(tick.stdout, /supervisor-inbox-owned/);
  await waitForInboxIdle(inbox);
  assert.equal(readInbox(inbox)[0].state, 'sent');
  assert.equal(fs.readFileSync(path.join(f.root, 'notice.txt'), 'utf8'), 'tick notice notice-id=tick-recovery');
});

test('housekeeping lock cleanup refuses PID reuse before registration and retains ownership on start retries', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'housekeeping-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = { root, repo: root, runtime: path.join(root, 'housekeeping.mjs'), config: path.join(root, 'config'),
    state: path.join(root, 'state'), fake: path.join(root, 'fake') };
  fs.mkdirSync(path.join(f.state, 'lock'), { recursive: true });
  fs.writeFileSync(path.join(f.state, 'lock/owner.json'), '{"pid":101}');
  const command = [process.execPath, f.runtime, '--cwd', fs.realpathSync(root), '--org', root, '--config', f.config,
    '--state-dir', f.state, '--main', 'main', '--herdr', f.fake, '--org-cli', f.fake, '--loop'].join(' ');
  const suite = { pid: 700, ppid: 1, pgid: 700, state: 'S', identity: 'suite birth', command: 'suite worker' };
  const signals = [], rows = new Map([[700, suite]]);
  const receipts = createReceiptTracker({ suitePid: 700, tracker: createProcessTracker({
    readIdentity: pid => ({ ok: true, value: rows.get(pid) ?? null }),
    sendSignal: pid => signals.push(pid), report: () => {},
  }) });
  for (const replacement of [{ command, pgid: 900 }, { command: 'operator session', pgid: 700 }]) {
    rows.set(101, { ...suite, pid: 101, identity: 'replacement birth', ...replacement });
    rememberHousekeepingProcess(f, receipts); receipts.cleanup();
    assert.deepEqual(signals, []);
  }
  rows.set(101, { ...suite, pid: 101, command, identity: 'fixture birth' });
  rememberHousekeepingProcess(f, receipts);
  const original = receipts.remember(101, command);
  rows.set(101, { ...suite, pid: 101, command, identity: 'reused birth' });
  rememberHousekeepingProcess(f, receipts); receipts.cleanup();
  assert.equal(receipts.remember(101, command), original);
  assert.deepEqual(signals, []);
  rows.set(101, { ...suite, pid: 101, command, identity: 'fixture birth' });
  receipts.cleanup(); assert.deepEqual(signals, [101]);
});

for (const runtimeKind of ['canonical checkout', 'installed copy']) {
  test(`${runtimeKind} startup assertion failure stops a real schedule before removing a symlinked fixture`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'housekeeping-start-failure-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const actual = path.join(root, 'actual'), alias = path.join(root, 'alias');
    fs.mkdirSync(actual); fs.symlinkSync(actual, alias, 'dir');
    const evidence = path.join(root, 'teardown.json');
    const file = path.join(root, 'startup-failure.test.mjs');
    const helper = new URL('./helpers/cli-fixture.mjs', import.meta.url).href;
    const boundedTest = new URL('../../test/helpers/bounded-test.mjs', import.meta.url).href;
    fs.writeFileSync(file, `import test from ${JSON.stringify(boundedTest)};
import { configureCliFixture, installRuntime, createHousekeepingStarter } from ${JSON.stringify(helper)};
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
test('injected housekeeping startup assertion failure', t => {
  let f, pid;
  const start = createHousekeepingStarter(t, () => f);
  const fixtureRoot = fs.mkdtempSync(path.join(${JSON.stringify(alias)}, 'fixture-'));
  t.after(() => {
    let alive = false;
    try { process.kill(pid, 0); alive = true; }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    const directoryExists = fs.existsSync(fixtureRoot);
    fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ pid, alive, directoryExists, fixtureRoot,
      herdr: f.args[f.args.indexOf('--herdr') + 1], expectedHerdr: f.fake, realRoot: fs.realpathSync(fixtureRoot) }));
    try { assert.equal(alive, false, 'schedule survived until fixture directory removal'); }
    finally { fs.rmSync(fixtureRoot, { recursive: true, force: true }); }
  });
  const repo = path.join(fixtureRoot, 'project'); fs.mkdirSync(repo);
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'],
    ['config', 'user.email', 'test@example.invalid'], ['commit', '--allow-empty', '-m', 'base']]) {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  f = configureCliFixture({ root: fixtureRoot, repo });
  ${runtimeKind === 'installed copy' ? "f.runtime = installRuntime(path.join(f.root, 'plugin')); f.args[0] = f.runtime;" : ''}
  const result = start();
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /started/);
  pid = JSON.parse(fs.readFileSync(path.join(f.state, 'lock/owner.json'), 'utf8')).pid;
  assert.fail('injected failure after real housekeeping startup');
});`);
    const child = spawnChild(t, process.execPath, [fileURLToPath(new URL('../../test/helpers/run.mjs', import.meta.url)), file]);
    const result = await waitForExit(child);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /injected failure after real housekeeping startup/);
    assert.doesNotMatch(result.stdout + result.stderr, /survived until fixture directory removal|Surviving fixture|not the expected fixture|hookFailed/);
    const observed = JSON.parse(fs.readFileSync(evidence, 'utf8'));
    assert.equal(observed.alive, false);
    assert.equal(observed.directoryExists, true);
    assert.notEqual(observed.fixtureRoot, observed.realRoot, 'regression must use a symlinked root');
    assert.equal(observed.herdr, observed.expectedHerdr);
    assert.equal(fs.existsSync(observed.fixtureRoot), false);
  });
}

for (const runtimeKind of ['canonical checkout', 'installed copy']) {
test(`${runtimeKind} start stays idempotent after a lane is removed`, async (t) => {
  let f;
  const start = createHousekeepingStarter(t, () => f);
  f = cliFixture(t);
  if (runtimeKind === 'installed copy') { f.runtime = installRuntime(path.join(f.root, 'plugin')); f.args[0] = f.runtime; }
  const first = start(); assert.equal(first.status, 0, first.stderr); assert.match(first.stdout, /started/);
  const lock = path.join(f.state, 'lock');
  const pid = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).pid;
  const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
  assert.equal(owner.script, f.runtime);
  assert.deepEqual(owner.record_cli, [f.fake]);
  f.git(['worktree', 'remove', f.lane]);
  assert.equal(fs.existsSync(owner.script), true);
  assert.equal(owner.record_cli.every((file) => fs.existsSync(file)), true);
  const again = start(); assert.equal(again.status, 0, again.stderr); assert.match(again.stdout, /already-running/);
  fs.writeFileSync(f.config, '{"enabled":false}');
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const check = () => {
      if (!fs.existsSync(lock)) return resolve();
      if (Date.now() > deadline) return reject(new Error('detached schedule did not stop'));
      setTimeout(check, 50);
    }; check();
  });
  assert.match(fs.readFileSync(path.join(f.state, 'actions.jsonl'), 'utf8'), /disabled/);
});
}

test('dry-run start leaves no timer process', (t) => {
  const f = cliFixture(t);
  const r = spawnSync(process.execPath, [...f.args, '--start', '--dry-run'], { encoding: 'utf8', env: TEST_ENV });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /would-start/);
  assert.equal(fs.existsSync(path.join(f.state, 'lock')), false);
});

test('old interruption with forty blank rows and a final reply is rejected within a bounded subprocess', () => {
  const fixtureURL = new URL('./fixtures/old-interruption.txt', import.meta.url);
  const moduleURL = new URL('../housekeeping.mjs', import.meta.url);
  const script = `import fs from 'node:fs'; import { interruptedComposer } from ${JSON.stringify(moduleURL.href)}; console.log(interruptedComposer(fs.readFileSync(${JSON.stringify(fileURLToPath(fixtureURL))}, 'utf8')));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', env: TEST_ENV, timeout: 2000 });
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), 'false');
  const feedback = screen.replace('\n›', '\nSomething went wrong? Hit /feedback to report the issue.\n\n›');
  assert.equal(interruptedComposer(feedback), true);
});

for (const mode of ['--once', '--start', '--loop']) {
  test(`lane code cannot ${mode} live housekeeping even with the canonical target`, (t) => {
    const f = cliFixture(t);
    const args = [...f.args]; args[0] = installRuntime(f.lane);
    const r = spawnSync(process.execPath, [...args, mode], { encoding: 'utf8', env: TEST_ENV, timeout: 2000 });
    assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /code from a linked worktree/);
    assert.equal(fs.existsSync(f.state), false);
  });
  test(`canonical code cannot ${mode} live housekeeping from a linked target`, (t) => {
    const f = cliFixture(t);
    f.args[f.args.indexOf('--cwd') + 1] = f.lane;
    const r = spawnSync(process.execPath, [...f.args, mode], { encoding: 'utf8', env: TEST_ENV, timeout: 2000 });
    assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /canonical project checkout/);
    assert.equal(fs.existsSync(f.state), false);
  });
}

test('a record CLI override in a lane cannot pin a live schedule to removable code', (t) => {
  const f = cliFixture(t);
  const fake = path.join(f.lane, 'record.mjs'); fs.copyFileSync(f.fake, fake); fs.chmodSync(fake, 0o755);
  f.args[f.args.indexOf('--org-cli') + 1] = fake;
  const r = spawnSync(process.execPath, [...f.args, '--start'], { encoding: 'utf8', env: TEST_ENV, timeout: 2000 });
  assert.equal(r.status, 1); assert.match(r.stderr, /code from a linked worktree/);
  assert.equal(fs.existsSync(f.state), false);
});

test('linked code remains usable for isolated dry-run previews', (t) => {
  const f = cliFixture(t); f.args[0] = installRuntime(f.lane);
  f.args[f.args.indexOf('--cwd') + 1] = f.lane;
  const r = spawnSync(process.execPath, [...f.args, '--once', '--dry-run'], { encoding: 'utf8', env: TEST_ENV });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /scan/);
  assert.equal(fs.existsSync(path.join(f.state, 'lock')), false);
});

for (const variant of ['different-script', 'different-record', 'missing-script', 'missing-record', 'legacy']) {
  test(`an existing ${variant} owner never reports already-running or alters the old lock`, (t) => {
    const f = cliFixture(t), lock = path.join(f.state, 'lock');
    fs.mkdirSync(lock, { recursive: true });
    const owner = { pid: process.pid, cwd: fs.realpathSync(f.repo), org: f.root, config: f.config,
      script: f.runtime, record_cli: [f.fake] };
    if (variant === 'different-script') owner.script = installRuntime(path.join(f.root, 'other-plugin'));
    if (variant === 'different-record') owner.record_cli = [fs.realpathSync(process.execPath)];
    if (variant === 'missing-script') owner.script = path.join(f.root, 'removed-lane/housekeeping.mjs');
    if (variant === 'missing-record') owner.record_cli = [path.join(f.root, 'removed-lane/org.mjs')];
    if (variant === 'legacy') { delete owner.script; delete owner.record_cli; }
    const original = JSON.stringify(owner);
    fs.writeFileSync(path.join(lock, 'owner.json'), original);
    const r = spawnSync(process.execPath, [...f.args, '--start'], { encoding: 'utf8', env: TEST_ENV, timeout: 2000 });
    assert.equal(r.status, 1); assert.doesNotMatch(r.stdout, /already-running/);
    assert.match(r.stderr, /different runtime|stale housekeeping runtime path|no runtime identity/);
    assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), original);
    assert.equal(fs.existsSync(path.join(f.state, 'schedule.log')), false);
  });
}


test('promotion cleanup inspects and closes only the requested lane workspace', (t) => {
  const f = fixture(t);
  f.ws.push({ workspace_id: 'other', worktree: { checkout_path: f.repo, repo_root: f.repo,
    repo_key: f.common, is_linked_worktree: false } });
  const original = f.command;
  f.command = (exe, args, options) => {
    if (['tab', 'pane'].includes(args[0]) && args[1] === 'list') assert.equal(args.at(-1), 'w');
    return original(exe, args, options);
  };
  f.runner().tick({ workspacePath: f.lane, resume: false });
  assert.deepEqual(f.actions, [['tab', 'close', 'w:t']]);
  f.actions = [];
  f.runner().tick({ workspacePath: f.root, resume: false });
  assert.deepEqual(f.actions, []);
});
