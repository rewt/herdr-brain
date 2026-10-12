import test from '../../test/helpers/bounded-test.mjs';
import { spawnChild, waitForExit, childProcessEntry } from '../../test/helpers/child.mjs';
import { registerProcess, killProcess, lookupProcess } from '../../test/helpers/processes.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { queueFor, enqueue } from '../promote.mjs';
import { resolveGateProfile } from '../gate-profile.mjs';
import { readInbox } from '../../supervisor/prompt-supervisor.mjs';
import { stopFixtureInbox } from '../../test/helpers/inbox.mjs';
import { waitForFile, waitForChange } from '../../test/helpers/file-wait.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';
import { drain } from '../promote.mjs';

const CLI = fileURLToPath(new URL('../promote.mjs', import.meta.url));
const LANE = fileURLToPath(new URL('../../lanes/lane.mjs', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quietFake = `
if (args[0]==='agent' && args[1]==='get') {console.log(JSON.stringify({result:{agent:{agent:'claude',agent_status:'idle',pane_id:'fake:supervisor'}}}));process.exit(0);}
if (args[0]==='pane' && args[1]==='read') {console.log(process.env.PROMOTE_TEST_COMPOSER && fs.existsSync(process.env.PROMOTE_TEST_COMPOSER) ? fs.readFileSync(process.env.PROMOTE_TEST_COMPOSER,'utf8') : '────────────────────\\n❯ \\n────────────────────');process.exit(0);}
`;
async function until(fn) {
  const end = Date.now() + loadTimeout(30000);
  while (Date.now() < end) { if (fn()) return; await delay(30); }
  assert.fail('timed out waiting for queue evidence');
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'pt-'));
  const repo = path.join(root, 'project'); fs.mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    npm_config_cache: path.join(root, 'cache'), npm_config_update_notifier: 'false' };
  delete env.NODE_TEST_CONTEXT;
  for (const key of Object.keys(env)) if (/^(LANE_|ORG_|HERDR_|GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT))/.test(key)) delete env[key];
  env.ORG_ACTOR = 'promote-test-agent';
  env.HERDR_MONITOR_FLEET = path.join(root, 'fleet');
  env.HERDR_ORG_CONSOLE_CONFIG = path.join(root, 'console.json');
  env.SUPERVISOR_INPUT_CONFIRM_SECONDS = '0.02';
  env.SUPERVISOR_INPUT_POLL_SECONDS = '0.02';
  env.SUPERVISOR_INPUT_WAIT_SECONDS = '2';
  env.PROMOTE_TEST_COMPOSER = path.join(root, 'composer');
  const git = (args, cwd = repo) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Queue test']); git(['config', 'user.email', 'queue@example.invalid']);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: `${process.execPath} --test check.mjs` } }));
  fs.writeFileSync(path.join(repo, 'check.mjs'), "import assert from 'node:assert/strict'; assert.equal(2 + 2, 4);\n");
  fs.writeFileSync(path.join(repo, 'shared'), 'base\n'); git(['add', '.']); git(['commit', '-qm', 'base']);
  const herdr = path.join(root, 'herdr');
  const notices = path.join(root, 'notices.jsonl');
  fs.writeFileSync(herdr, `#!${process.execPath}\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\n${quietFake}\nif (args[0] === 'agent' && args[1] === 'prompt') {\nfs.appendFileSync(${JSON.stringify(notices)}, JSON.stringify(args) + '\\n');\nif (fs.existsSync(${JSON.stringify(path.join(root, 'delivery-fail'))})) process.exit(1);\n}\nprocess.stdout.write(JSON.stringify({result:{workspaces:[],agents:[]}}));\n`);
  fs.chmodSync(herdr, 0o755);
  const queue = queueFor(repo);
  const lane = (topic, content = topic) => {
    const wt = path.join(root, topic); git(['worktree', 'add', '-b', `lane/${topic}`, wt]);
    fs.writeFileSync(path.join(wt, `${topic}.txt`), content); git(['add', '.'], wt); git(['commit', '-qm', topic], wt);
    return wt;
  };
  const processes = new Map();
  const cli = (args, cwd = repo) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', timeout: loadTimeout(10000) });
    const owner = path.join(queue.directory, 'worker.lock/owner.json');
    if (result.status === 0 && fs.existsSync(owner)) {
      const pid = JSON.parse(fs.readFileSync(owner, 'utf8')).pid;
      if (!processes.has(pid)) {
        const entry = registerProcess(pid);
        assert.ok(entry.command.includes(CLI) && entry.command.includes(repo), 'acknowledged worker command belongs to this fixture');
        processes.set(pid, entry);
      }
    }
    return result;
  };
  const launch = (args) => {
    const r = cli([...args, '--herdr', herdr, '--delivery-attempts', '2', '--retry-seconds', '0']);
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  const results = () => queue.load().results;
  const messages = () => fs.existsSync(notices) ? fs.readFileSync(notices, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  let cleanupProcesses = async () => {};
  let foreignInboxes = [];
  t.after(async () => {
    try {
      await cleanupProcesses();
      await until(() => !fs.existsSync(path.join(queue.directory, 'worker.lock')));
      // A record-backed notice has a different owner from the Git inbox. Stop
      // every actual destination after senders finish and before removing files.
      const data = queue.load();
      const jobs = [...data.results, ...data.pending, ...(data.current ? [data.current] : [])];
      const inboxes = new Set([path.join(repo, '.git/supervisor/inbox.log'),
        // Child fixtures strip ambient ORG_DIR. Resolve cleanup only from
        // their recorded destination or the fixture's own Git inbox.
        ...jobs.map(job => job.inbox ?? path.join(job.org ?? path.join(repo, '.git'), 'supervisor/inbox.log'))]);
      const ownedInboxes = [...inboxes].filter(file => {
        const relative = path.relative(root, file);
        return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
      });
      foreignInboxes = [...inboxes].filter(file => !ownedInboxes.includes(file));
      for (const file of ownedInboxes) await stopFixtureInbox(file, {
        script: fileURLToPath(new URL('../../supervisor/prompt-supervisor.mjs', import.meta.url)),
      });
    } finally {
      for (const entry of processes.values()) killProcess(entry);
    }
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(foreignInboxes.length, 0, 'fixture inbox stays inside its owned root');
  });
  return { root, repo, env, git, lane, cli, launch, queue, results, messages, herdr, ownedProcess: (pid) => processes.get(pid), onCleanup: (fn) => { cleanupProcesses = fn; } };
}

test('fixture cleanup ignores an ambient record inbox owner', (t) => {
  const f = fixture(t);
  const foreign = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'pt-foreign-'));
  const prior = process.env.ORG_DIR;
  process.env.ORG_DIR = foreign;
  const inbox = path.join(foreign, 'supervisor/inbox.log');
  fs.mkdirSync(inbox + '.owner.lock', { recursive: true });
  const owner = JSON.stringify({ pid: process.pid, argv: ['outside-this-fixture'] });
  fs.writeFileSync(inbox + '.owner.lock/owner.json', owner);
  // Registered after fixture cleanup: the ambient owner remains present while
  // that hook resolves the queued job's destination. No process is signaled.
  t.after(() => {
    try { assert.equal(fs.readFileSync(inbox + '.owner.lock/owner.json', 'utf8'), owner); }
    finally {
      if (prior === undefined) delete process.env.ORG_DIR; else process.env.ORG_DIR = prior;
      fs.rmSync(foreign, { recursive: true, force: true });
    }
  });
  enqueue(f.queue, ['not-started'], { to: 'supervisor-herdr', attempts: 1, retry: 0, herdr: f.herdr, laneCLI: LANE, org: null });
  assert.equal(f.queue.load().pending.length, 1);
});

test('busy supervisor does not hold completed queue accounting by default', async (t) => {
  const f = fixture(t);
  delete f.env.SUPERVISOR_INPUT_WAIT_SECONDS;
  f.onCleanup(async () => {
    fs.writeFileSync(f.env.PROMOTE_TEST_COMPOSER, fs.readFileSync(new URL('../../supervisor/test/fixtures/claude-empty.ansi', import.meta.url)));
  });
  fs.writeFileSync(f.env.PROMOTE_TEST_COMPOSER, fs.readFileSync(new URL('../../supervisor/test/fixtures/claude-typed.ansi', import.meta.url)));
  const workspace = f.lane('first');
  const target = f.git(['rev-parse', 'HEAD'], workspace);
  const launched = f.launch(['first']);
  await until(() => f.results().length === 1 && f.queue.load().current === null);
  const result = f.results()[0];
  assert.equal(result.outcome, 'promoted', result.reason);
  assert.equal(f.git(['rev-parse', 'main']), target);
  assert.equal(fs.existsSync(workspace), false);
  assert.equal(result.delivered, false);
  assert.equal(result.queued, true);
  assert.equal(f.messages().length, 0, 'busy input receives no prompt');
  const id = 'promote:' + launched.jobs[0].id;
  assert.equal(readInbox(result.inbox).filter(entry => entry.id === id).length, 1, 'one durable notice owns delivery');
  // Span several former short owner windows while input remains genuinely busy.
  await delay((Number(f.env.SUPERVISOR_INPUT_CONFIRM_SECONDS) + 1) * 2200);
  const events = fs.readFileSync(result.inbox, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(entry => entry.id === id && entry.type === 'capped').length, 0, 'zero caller wait preserves the owner window without repeated cap journal entries');
  fs.writeFileSync(f.env.PROMOTE_TEST_COMPOSER, fs.readFileSync(new URL('../../supervisor/test/fixtures/claude-empty.ansi', import.meta.url)));
  await until(() => readInbox(result.inbox).find(entry => entry.id === id)?.state === 'sent');
  assert.equal(f.messages().length, 1, 'retained owner delivers exactly once after input clears');
  assert.equal(f.results().length, 1, 'delivery does not replay promotion accounting');
  assert.equal(f.git(['rev-parse', 'main']), target);
});

test('idle supervisor receives a default queued promotion notice without a false alert', async (t) => {
  const f = fixture(t);
  delete f.env.SUPERVISOR_INPUT_WAIT_SECONDS;
  const calls = path.join(f.root, 'herdr-calls.jsonl');
  const script = fs.readFileSync(f.herdr, 'utf8');
  fs.writeFileSync(f.herdr, script.replace('const args = process.argv.slice(2);',
    'const args = process.argv.slice(2); fs.appendFileSync(' + JSON.stringify(calls) + ', JSON.stringify(args) + "\\n");'));
  f.lane('idle-notice');
  f.launch(['idle-notice']);
  await until(() => f.results().length === 1 && f.queue.load().current === null);
  const result = f.results()[0];
  await until(() => readInbox(result.inbox).find(entry => entry.id === result.delivery_id)?.state === 'sent');
  const observed = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(observed.filter(args => args[0] === 'notification' && args[1] === 'show').length, 0, 'idle input receives no false undelivered alert');
  assert.equal(f.messages().length, 1);
});

test('queued promotion waits before validation under low-memory pressure and proceeds when cleared', async t => {
  const f = fixture(t), workspace = f.lane('memory-wait'), before = f.git(['rev-parse', 'main']);
  const file = path.join(f.root, 'memory.json');
  const healthy = { available: 8 * 1024 ** 3, swap_used: 0 };
  fs.writeFileSync(file, JSON.stringify({ ...healthy, available: 128 * 1024 ** 2 }));
  f.env.TEST_MEMORY_FILE = file;
  f.onCleanup(async () => { fs.writeFileSync(file, JSON.stringify(healthy)); });
  const launched = f.launch(['memory-wait']);
  const batch = f.queue.load().current;
  assert.equal(batch.jobs[0].id, launched.jobs[0].id);
  const log = path.join(f.queue.directory, 'batches', batch.id, 'train.log');
  await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('waiting; memory pressure'));
  assert.match(fs.readFileSync(log, 'utf8'), /available memory 128 MiB/);
  assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /validating in/);
  assert.equal(f.git(['rev-parse', 'main']), before); assert.ok(fs.existsSync(workspace));
  assert.equal(fs.existsSync(path.join(f.repo, '.git/lane-promote.lock')), false, 'memory waits leave the promotion lock available');
  assert.equal(f.results().length, 0);
  fs.writeFileSync(file, JSON.stringify(healthy));
  await until(() => f.results().length === 1);
  assert.equal(f.results()[0].outcome, 'promoted', f.results()[0].reason);
  assert.match(fs.readFileSync(log, 'utf8'), /cleared; proceeding/);
  assert.equal(fs.existsSync(workspace), false);
});

test('unconfigured project: detached worker promotes two lanes in FIFO order using default npm gate', async (t) => {
  const f = fixture(t); const first = f.lane('first'), second = f.lane('second');
  const launched = f.launch(['first', 'second']); assert.ok(launched.worker.ready);
  await waitForChange([f.queue.file], () => f.results().length === 2, { timeoutMs: 30000 });
  assert.deepEqual(f.results().map((r) => [r.topic, r.outcome, r.delivered]), [['first', 'promoted', true], ['second', 'promoted', true]]);
  assert.equal(fs.existsSync(first), false); assert.equal(fs.existsSync(second), false);
  assert.equal(f.git(['rev-list', '--merges', 'main']), '');
  assert.equal(f.git(['remote']), '');
  assert.deepEqual(f.messages().map((args) => args[2]), ['supervisor-herdr', 'supervisor-herdr']);
  assert.match(f.messages()[0][3], /lane=first outcome=promoted/); assert.match(f.messages()[1][3], /lane=second outcome=promoted/);
  assert.ok(f.results()[1].batch, 'both lanes belong to a durable train');
  assert.equal(f.results()[0].batch, f.results()[1].batch);
  assert.equal(f.git(['status', '--porcelain']), '');
  assert.equal(fs.existsSync(path.join(f.repo, '.promote.json')), false);
});

test('promotion notice queues during typing and delivers after clearing without repeating promotion', async (t) => {
  const f = fixture(t); f.lane('first');
  const inbox = path.join(f.repo, '.git/supervisor/inbox.log');
  fs.writeFileSync(f.env.PROMOTE_TEST_COMPOSER, fs.readFileSync(new URL('../../supervisor/test/fixtures/claude-typed.ansi', import.meta.url)));
  f.launch(['first']);
  await until(() => fs.existsSync(inbox) && readInbox(inbox).length === 1);
  assert.deepEqual(f.messages(), []); assert.equal(f.queue.load().current.phase, 'completed');
  fs.writeFileSync(f.env.PROMOTE_TEST_COMPOSER, fs.readFileSync(new URL('../../supervisor/test/fixtures/claude-empty.ansi', import.meta.url)));
  await waitForChange([f.queue.file], () => f.results().length === 1, { timeoutMs: 30000 });
  assert.equal(f.results()[0].outcome, 'promoted'); assert.equal(f.results()[0].delivered, true);
  assert.equal(f.messages().length, 1); assert.equal(readInbox(inbox)[0].state, 'sent');
});

test('queue refuses a lane changed while pending behind another job before validation or integration', { timeout: 20000 }, (t) => {
  const f = fixture(t); f.lane('first'); const wt = f.lane('second');
  const opts = { to: 'supervisor-herdr', attempts: 1, retry: 0, herdr: f.herdr, laneCLI: LANE, org: null };
  enqueue(f.queue, ['first'], opts);
  const expected = f.git(['rev-parse', 'lane/second']);
  enqueue(f.queue, ['second'], { ...opts, expectedHead: expected });
  fs.writeFileSync(path.join(wt, 'second.txt'), 'unreviewed work'); f.git(['add', '.'], wt); f.git(['commit', '-qm', 'New work while queued'], wt);
  const actual = f.git(['rev-parse', 'lane/second']);
  const r = f.cli(['--drain']); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n').map((line) => JSON.parse(line).outcome),
    ['promoted', 'refused'], 'wait diagnostics leave every JSON receipt intact');
  const [first, second] = f.results();
  assert.equal(first.outcome, 'promoted'); assert.equal(second.outcome, 'refused');
  assert.equal(second.expectedHead, expected);
  assert.match(second.reason, new RegExp(`expected ${expected}, found ${actual}`));
  assert.match(f.messages()[1][3], /outcome=refused .*lane tip differs from expected head/);
  assert.equal(second.gate, undefined, 'changed lane was excluded before the batch gate');
  assert.equal(f.git(['rev-parse', 'main']), first.tip);
  assert.equal(f.git(['rev-parse', 'lane/second']), actual); assert.ok(fs.existsSync(wt));
});

test('expected head survives CLI enqueue and succeeds exactly; a changed binding cannot reuse a pending job', { timeout: 20000 }, async (t) => {
  const f = fixture(t); f.lane('first'); const expected = f.git(['rev-parse', 'lane/first']);
  const opts = { to: 'supervisor-herdr', attempts: 1, retry: 0, herdr: f.herdr, laneCLI: LANE, org: null, expectedHead: expected };
  const [job] = enqueue(f.queue, ['first'], opts);
  assert.equal(enqueue(f.queue, ['first'], opts)[0].id, job.id);
  assert.throws(() => enqueue(f.queue, ['first'], { ...opts, expectedHead: '0'.repeat(40) }), /different head or run binding/);
  assert.throws(() => enqueue(f.queue, ['first'], { ...opts, expectedHead: undefined }), /different head or run binding/);
  assert.throws(() => enqueue(f.queue, ['first', 'second'], opts), /requires one lane/);
  assert.equal(f.cli(['first', '--expected-head', 'HEAD']).status, 1);
  const request = f.launch(['first', '--expected-head', expected]); assert.equal(request.jobs[0].id, job.id);
  await waitForChange([f.queue.file], () => f.results().length === 1, { timeoutMs: 30000 });
  assert.equal(f.results()[0].expectedHead, expected); assert.equal(f.results()[0].tip, expected);
  assert.equal(f.results()[0].outcome, 'promoted'); assert.equal(f.git(['rev-parse', 'main']), expected);
});

test('expected head refuses an automatic rebase and post-preparation tip changes', { timeout: 20000 }, (t) => {
  for (const mode of ['rebase', 'prepare']) {
    const f = fixture(t); const wt = f.lane('first'), expected = f.git(['rev-parse', 'lane/first']);
    if (mode === 'rebase') {
      fs.writeFileSync(path.join(f.repo, 'new-base'), 'new base'); f.git(['add', '.']); f.git(['commit', '-qm', 'Advance main']);
    } else {
      const file = path.join(f.root, 'prepare.mjs');
      fs.writeFileSync(file, `import fs from 'node:fs'; import {execFileSync} from 'node:child_process'; fs.writeFileSync('new-work','unreviewed'); execFileSync('git',['add','.']);execFileSync('git',['commit','-qm','Preparation changed head']);\n`);
      const config = path.join(f.root, 'lane.json'); fs.writeFileSync(config, JSON.stringify({ prepare: [{ run: `${process.execPath} ${file}` }] }));
      f.env.LANE_CONFIG = config;
    }
    const base = f.git(['rev-parse', 'main']);
    const r = spawnSync(process.execPath, [LANE, 'promote', 'first', '--expected-head', expected], { cwd: f.repo, env: f.env, encoding: 'utf8', timeout: loadTimeout(10000) });
    assert.equal(r.status, 1, r.stdout); assert.match(r.stderr, mode === 'rebase' ? /requires a rebase/ : /tip differs from expected head/);
    assert.doesNotMatch(r.stdout, /validating in/);
    assert.equal(f.git(['rev-parse', 'main']), base); assert.ok(fs.existsSync(wt));
  }
});

test('a completed refusal awaiting delivery permits a fresh attempt without replaying the refused job', { timeout: 15000 }, (t) => {
  const f = fixture(t); f.lane('first');
  const opts = { to: 'supervisor-herdr', attempts: 1, retry: 0, herdr: f.herdr, laneCLI: LANE, org: null, expectedHead: f.git(['rev-parse', 'lane/first']) };
  const [old] = enqueue(f.queue, ['first'], opts);
  f.queue.transaction((q) => { q.current = { ...q.pending.shift(), phase: 'completed', result: { outcome: 'refused', reason: 'Saved lock contention' } }; });
  const [retry] = enqueue(f.queue, ['first'], opts); assert.notEqual(retry.id, old.id);
  assert.equal(f.cli(['--drain']).status, 0);
  assert.deepEqual(f.results().map((r) => [r.id, r.outcome]), [[old.id, 'refused'], [retry.id, 'promoted']]);
  assert.equal(f.git(['rev-parse', 'main']), opts.expectedHead); assert.equal(f.messages().length, 2);
});

for (const mode of ['dirty', 'red', 'conflict']) test(`${mode} refusal is delivered; lane kept; next queued lane still promotes`, async (t) => {
  const f = fixture(t); const bad = f.lane('bad'), good = f.lane('good');
  if (mode === 'dirty') fs.writeFileSync(path.join(bad, 'dirty'), 'work');
  if (mode === 'red') {
    fs.writeFileSync(path.join(bad, 'check.mjs'), 'process.exit(1);\n'); f.git(['add', '.'], bad); f.git(['commit', '-qm', 'red'], bad);
  }
  if (mode === 'conflict') {
    fs.writeFileSync(path.join(bad, 'shared'), 'lane\n'); f.git(['add', '.'], bad); f.git(['commit', '-qm', 'lane edit'], bad);
    fs.writeFileSync(path.join(f.repo, 'shared'), 'main\n'); f.git(['add', '.']); f.git(['commit', '-qm', 'main edit']);
  }
  const before = f.git(['rev-parse', `lane/bad`]);
  f.launch(['bad', 'good']); await waitForChange([f.queue.file], () => f.results().length === 2, { timeoutMs: 30000 });
  assert.equal(f.results()[0].outcome, 'refused', fs.readFileSync(f.results()[0].log, 'utf8')); assert.equal(f.results()[0].delivered, true);
  assert.match(f.results()[0].reason, mode === 'dirty' ? /not clean/ : mode === 'red' ? /validation failed/ : /does not rebase cleanly/);
  assert.equal(f.git(['rev-parse', 'lane/bad']), before);
  assert.ok(fs.existsSync(bad)); assert.equal(fs.existsSync(good), false);
  assert.equal(f.results()[1].outcome, 'promoted');
  assert.match(f.messages()[0][3], /lane=bad outcome=refused/);
});

test('replay conflict after clean merge-tree preflight names the file in the notice and preserves the lane', async (t) => {
  const f = fixture(t); const bad = f.lane('bad'), good = f.lane('good');
  fs.writeFileSync(path.join(bad, 'shared'), 'lane edit\n');
  f.git(['add', 'shared'], bad); f.git(['commit', '-qm', 'edit shared'], bad);
  fs.writeFileSync(path.join(bad, 'shared'), 'base\n');
  f.git(['add', 'shared'], bad); f.git(['commit', '-qm', 'revert shared'], bad);
  fs.writeFileSync(path.join(f.repo, 'shared'), 'upstream edit\n');
  f.git(['add', 'shared']); f.git(['commit', '-qm', 'upstream edit']);
  const before = f.git(['rev-parse', 'lane/bad']);
  const upstream = f.git(['rev-parse', 'main']);
  const preflight = spawnSync(process.execPath, [LANE, 'rebase-check', 'bad'], {
    cwd: f.repo, env: f.env, encoding: 'utf8',
  });
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.match(preflight.stdout, / clean\n$/);

  f.launch(['bad', 'good']); await waitForChange([f.queue.file], () => f.results().length === 2, { timeoutMs: 30000 });
  const refused = f.results()[0];
  const log = fs.readFileSync(refused.log, 'utf8');
  assert.equal(refused.outcome, 'refused', log);
  assert.equal(refused.delivered, true);
  assert.match(log, /conflicts in: shared/);
  assert.equal(refused.gate, undefined, 'conflicting lane was excluded before the batch gate');
  assert.match(refused.reason, /rebase replay onto main failed; conflicts in: shared; lane kept intact/);
  assert.match(f.messages()[0][3], /lane=bad outcome=refused .*conflicts in: shared; lane kept intact/);
  assert.ok(fs.existsSync(bad));
  assert.equal(f.git(['rev-parse', 'lane/bad']), before);
  assert.equal(f.git(['diff', '--name-only', '--diff-filter=U'], bad), '');
  assert.equal(fs.existsSync(f.git(['rev-parse', '--git-path', 'rebase-merge'], bad)), false);
  assert.equal(f.results()[1].outcome, 'promoted');
  assert.equal(fs.existsSync(good), false);
  assert.equal(f.git(['merge-base', upstream, 'main']), upstream);
  assert.equal(f.git(['show', 'main:shared']), 'upstream edit');
  assert.equal(fs.existsSync(path.join(f.repo, 'bad.txt')), false);
  assert.equal(f.git(['status', '--porcelain']), '');
  assert.equal(f.git(['symbolic-ref', '--short', 'HEAD'], bad), 'lane/bad');
  assert.equal(f.git(['rev-parse', 'HEAD'], bad), before);
  assert.equal(f.git(['status', '--porcelain'], bad), '');
  assert.equal(fs.readFileSync(path.join(bad, 'shared'), 'utf8'), 'base\n');
});

test('capped promotion notices retain an owner and replay with visible IDs after lost acknowledgements', async (t) => {
  const f = fixture(t); f.lane('first'); f.lane('second'); fs.writeFileSync(path.join(f.root, 'delivery-fail'), '1');
  f.launch(['first', 'second']); await waitForChange([f.queue.file], () => f.results().length === 2, { timeoutMs: 30000 });
  assert.ok(f.results().every((r) => r.outcome === 'promoted' && r.delivered === false && r.delivery_error));
  const inbox = path.join(f.repo, '.git/supervisor/inbox.log');
  assert.ok(fs.existsSync(`${inbox}.owner.lock`));
  fs.unlinkSync(path.join(f.root, 'delivery-fail'));
  await until(() => readInbox(inbox).every((entry) => entry.state === 'sent'));
  const texts = f.messages().map((args) => args[3]);
  assert.ok(texts.length >= 3);
  assert.ok(texts.slice(0, -1).every((text) => text.includes(`notice-id=${f.results()[0].delivery_id}`)));
  assert.ok(texts.at(-1).includes(`notice-id=${f.results()[1].delivery_id}`));
});

test('project override selects supervisor and duplicate pending lanes do not repeat', async (t) => {
  const f = fixture(t); f.lane('first');
  fs.writeFileSync(path.join(f.repo, '.promote.json'), JSON.stringify({ to: 'project-supervisor' }));
  f.git(['add', '.']); f.git(['commit', '-qm', 'promotion target']);
  const opts = { to: 'project-supervisor', attempts: 1, retry: 0, herdr: f.herdr, laneCLI: LANE, org: null };
  const jobs = enqueue(f.queue, ['first', 'first'], opts);
  assert.equal(jobs[0].id, jobs[1].id); assert.equal(jobs[1].duplicate, true);
  const r = f.cli(['--drain']); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.results().length, 1); assert.equal(f.messages()[0][2], 'project-supervisor');
});

test('a drain owner this caller may not signal still counts as running', async (t) => {
  const f = fixture(t), lock = path.join(f.queue.directory, 'worker.lock');
  fs.mkdirSync(lock, { recursive: true });
  const owner = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), argv: [process.execPath, CLI] });
  fs.writeFileSync(path.join(lock, 'owner.json'), owner);
  f.lane('waiting');
  enqueue(f.queue, ['waiting'], { to: 'supervisor-herdr', attempts: 1, retry: 0, herdr: f.herdr, laneCLI: LANE, org: null });
  const kill = process.kill, send = process.send, sent = [];
  process.kill = (pid, signal) => {
    if (signal === 0) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    return kill.call(process, pid, signal);
  };
  process.send = message => { sent.push(message); return true; };
  try { await drain(f.queue); } finally { process.kill = kill; process.send = send; }
  assert.deepEqual(sent, [{ ready: true, already_running: true }]);
  assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), owner, 'the live owner keeps its lock');
  const queued = f.queue.load();
  assert.equal(queued.current, null); assert.deepEqual(queued.pending.map(j => j.topic), ['waiting'], 'the job waits for the live drain');
  fs.rmSync(lock, { recursive: true });
});

test('two concurrent enqueue commands share one drain; direct promote is excluded during its gate', async (t) => {
  const f = fixture(t); f.lane('first'); f.lane('second');
  const marker = path.join(f.root, 'gate');
  const command = `${process.execPath} -e 'require("fs").writeFileSync(${JSON.stringify(marker)}, "ready"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1800)'`;
  f.launch(['first', '--validate', command]);
  await waitForFile(marker, () => true, { timeoutMs: 30000 });
  const direct = spawnSync(process.execPath, [LANE, 'promote', 'second'], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.notEqual(direct.status, 0); assert.match(direct.stderr, /lane-promote.lock/);
  f.launch(['second']); await waitForChange([f.queue.file], () => f.results().length === 2, { timeoutMs: 30000 });
  assert.deepEqual(f.results().map((r) => r.topic), ['first', 'second']);
  assert.ok(f.results().every((r) => r.outcome === 'promoted'));
});

test('enqueue during the empty-worker handoff always starts a new drain', async (t) => {
  const f = fixture(t); f.lane('first'); f.lane('second');
  f.launch(['first']); await waitForChange([f.queue.file], () => f.results().length === 1, { timeoutMs: 30000 });
  f.launch(['second']); await waitForChange([f.queue.file], () => f.results().length === 2, { timeoutMs: 30000 });
  assert.ok(f.results().every((r) => r.outcome === 'promoted'));
});

test('interrupted attempt emits a notice without retrying a gate or deleting its lane', async (t) => {
  const f = fixture(t); const wt = f.lane('first');
  const opts = { to: 'supervisor-herdr', attempts: 1, retry: 0, herdr: f.herdr, laneCLI: LANE, org: null };
  enqueue(f.queue, ['first'], opts);
  f.queue.transaction((data) => { data.current = { ...data.pending.shift(), phase: 'promoting' }; });
  const before = f.git(['rev-parse', 'main']);
  const r = f.cli(['--drain']); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.results()[0].outcome, 'interrupted'); assert.equal(f.git(['rev-parse', 'main']), before);
  assert.ok(fs.existsSync(wt)); assert.match(f.messages()[0][3], /outcome=interrupted/);
});

test('stale worker lock refuses startup while keeping the queued request', async (t) => {
  const f = fixture(t); f.lane('first');
  const lock = path.join(f.queue.directory, 'worker.lock'); fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
  const r = f.cli(['first', '--herdr', f.herdr]);
  assert.notEqual(r.status, 0); assert.equal(f.queue.load().pending.length, 1);
  fs.rmSync(lock, { recursive: true });
});

test('green gate that modifies its worktree is refused before fast-forward', (t) => {
  const f = fixture(t); const wt = f.lane('first'); const before = f.git(['rev-parse', 'main']);
  const env = { ...f.env, LANE_VALIDATE: `${process.execPath} -e 'require("fs").writeFileSync("first.txt", "changed")'` };
  const r = spawnSync(process.execPath, [LANE, 'promote', 'first'], { cwd: wt, env, encoding: 'utf8' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /validated lane worktree is not clean/);
  assert.equal(f.git(['rev-parse', 'main']), before);
});

test('recorded completed outcome resumes delivery without repeating promotion', (t) => {
  const f = fixture(t); const wt = f.lane('first');
  enqueue(f.queue, ['first'], { to: 'supervisor-herdr', attempts: 1, retry: 0, herdr: f.herdr, laneCLI: LANE, org: null });
  f.queue.transaction((data) => { data.current = { ...data.pending.shift(), phase: 'completed', result: { outcome: 'refused', reason: 'saved refusal' } }; });
  const before = f.git(['rev-parse', 'main']);
  const r = f.cli(['--drain']); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.git(['rev-parse', 'main']), before); assert.ok(fs.existsSync(wt));
  assert.equal(f.results()[0].reason, 'saved refusal'); assert.match(f.messages()[0][3], /saved refusal/);
});

for (const failVelocity of [false, true]) test(failVelocity
  ? 'recovery: a failed velocity note still closes the finished tab and promoted lane'
  : 'queued cleanup closes the recorded finished tab and preserves operator and other lane tabs', async (t) => {
  const f = fixture(t); const wt = f.lane('first'); const other = f.lane('other');
  const orgCLI = fileURLToPath(new URL('../../bin/org.mjs', import.meta.url));
  const org = path.join(f.repo, '.org');
  fs.appendFileSync(path.join(f.repo, '.git/info/exclude'), '.org/\n');
  const record = (args) => {
    const r = spawnSync(process.execPath, [orgCLI, ...args], { cwd: f.repo, env: { ...f.env, ORG_DIR: org }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  record(['init', org]);
  const item = record(['add', 'Finished first lane', '--role', 'engineer']).split(/\s/)[0];
  const report = path.join(f.root, 'report.md');
  const run = record(['start', item, '--harness', 'codex', '--model', 'offline', '--effort', 'high', '--workspace', wt, '--report', report]).split(/\s/)[0];
  record(['set', run, 'agent=worker', 'pane=w:p1', 'worker_workspace=w', 'terminal_id=terminal-first', 'lane=first']);
  fs.writeFileSync(report, `---\nrun: ${run}\noutcome: done\nsummary: Finished.\nheadline: Finished lane\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`);
  record(['ingest', report]);
  const calls = path.join(f.root, 'cleanup-calls');
  const topology = {
    workspaces: [
      { workspace_id: 'w', worktree: { checkout_path: wt, repo_root: f.repo, repo_key: f.queue.project.identity, is_linked_worktree: true } },
      { workspace_id: 'other', worktree: { checkout_path: other, repo_root: f.repo, repo_key: f.queue.project.identity, is_linked_worktree: true } },
    ],
    tabs: [{ tab_id: 'w:worker', label: 'worker' }, { tab_id: 'w:operator', label: 'operator' }],
    panes: [{ pane_id: 'w:p1', tab_id: 'w:worker' }, { pane_id: 'w:p2', tab_id: 'w:operator' }],
    agents: [
      { name: 'worker', agent: 'codex', agent_status: 'idle', pane_id: 'w:p1', tab_id: 'w:worker', workspace_id: 'w', cwd: wt, terminal_id: 'terminal-first' },
      { name: null, agent_status: 'idle', pane_id: 'w:p2', tab_id: 'w:operator', workspace_id: 'w', cwd: wt },
    ],
  };
  fs.writeFileSync(f.herdr, `#!${process.execPath}\nimport fs from 'node:fs'; const a=process.argv.slice(2); const d=${JSON.stringify(topology)}; fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n'); let r={};
if(a[0]==='workspace'&&a[1]==='list')r={workspaces:d.workspaces};
if(a[0]==='tab'&&a[1]==='list')r={tabs:d.tabs};
if(a[0]==='pane'&&a[1]==='list')r={panes:d.panes};
if(a[0]==='pane'&&a[1]==='process-info')r={process_info:{shell_pid:1,foreground_processes:[{pid:1,name:'zsh'}]}};
if(a[0]==='agent'&&a[1]==='list')r={agents:d.agents};
console.log(JSON.stringify({result:r}));\n`);
  const failureMarker = path.join(f.root, 'velocity-failed');
  if (failVelocity) {
    const preload = path.join(f.root, 'fail-velocity.cjs');
    fs.writeFileSync(preload, `const fs=require('fs'),cp=require('child_process'),original=cp.spawnSync;
cp.spawnSync=function(cmd,args,options){
 if(cmd===process.execPath&&args[0]===${JSON.stringify(orgCLI)}&&args[1]==='note'&&args[3]?.startsWith('Promotion: report-to-main ')){
  fs.writeFileSync(${JSON.stringify(failureMarker)},'failed');return {status:1,stdout:'',stderr:'injected velocity note failure'};
 }return original.call(this,cmd,args,options);
};require('module').syncBuiltinESMExports();`);
    f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(preload)}`;
  }
  f.launch(['first', '--org', org, '--expected-head', f.git(['rev-parse', 'HEAD'], wt), '--if-current-run', run]);
  await waitForChange([f.queue.file], () => f.results().length === 1, { timeoutMs: 30000 });
  assert.equal(f.results()[0].outcome, 'promoted', f.results()[0].reason);
  if (failVelocity) {
    assert.equal(fs.existsSync(failureMarker), true, 'the velocity note actually failed');
    assert.deepEqual(f.results()[0].warnings, ['velocity record: injected velocity note failure']);
  } else {
    assert.deepEqual(f.results()[0].warnings, []);
    assert.equal(JSON.parse(record(['show', run, '--json'])).notes.filter(n => n.text.startsWith('Promotion: report-to-main ')).length, 1);
  }
  const actions = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(actions.filter((a) => a[0] === 'tab' && a[1] === 'close'), [['tab', 'close', 'w:worker']]);
  assert.ok(!actions.some((a) => a[0] === 'worktree' || a[0] === 'workspace' && a[1] !== 'list'));
  assert.ok(!actions.some((a) => ['pane','tab'].includes(a[0]) && a[1] === 'list' && a.at(-1) === 'other'));
  assert.equal(fs.existsSync(wt), false); assert.equal(fs.existsSync(other), true);
  const inbox = path.join(org, 'supervisor/inbox.log');
  assert.equal(f.results()[0].inbox, inbox);
  assert.equal(readInbox(inbox)[0].state, 'pending', 'the unreadable fake supervisor retains delivery intent');
  const pid = JSON.parse(fs.readFileSync(`${inbox}.owner.lock/owner.json`, 'utf8')).pid;
  const owner = registerProcess(pid);
  t.after(() => {
    const current = lookupProcess(pid);
    assert.ok(current.ok, current.error);
    assert.ok(!current.value || /^Z/.test(current.value.state) || current.value.identity !== owner.identity,
      'record inbox producer must exit before its fixture is removed');
    assert.equal(fs.existsSync(f.root), false);
  });
});

function blockCleanup(f) {
  const org = path.join(f.root, 'cleanup-record');
  const orgCLI = fileURLToPath(new URL('../../bin/org.mjs', import.meta.url));
  const initialized = spawnSync(process.execPath, [orgCLI, 'init', org], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const marker = path.join(f.root, 'cleanup-pid');
  const release = path.join(f.root, 'cleanup-release');
  fs.writeFileSync(f.herdr, `#!${process.execPath}\nimport fs from 'node:fs'; const args=process.argv.slice(2);
${quietFake}
if (args[0]==='workspace' && args[1]==='list') {
  fs.writeFileSync(${JSON.stringify(marker + ".tmp")}, String(process.pid));
  fs.renameSync(${JSON.stringify(marker + ".tmp")}, ${JSON.stringify(marker)});
  while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
}
if (args[0]==='agent' && args[1]==='prompt') fs.appendFileSync(${JSON.stringify(path.join(f.root, 'notices.jsonl'))},JSON.stringify(args)+'\\n');
console.log(JSON.stringify({result:{workspaces:[],agents:[]}}));\n`);
  return { marker, release, org };
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function killCreated(entry) {
  if (!entry) return;
  const result = killProcess({ ...entry, group: false });
  assert.equal(result.ok, true, `identity lookup failed for ${entry.pid}; no signal sent`);
  await until(() => !alive(entry.pid));
}

test('crash during batch cleanup resumes without repeating the gate or trusting saved freshness', async (t) => {
  const f = fixture(t); const wt = f.lane('first'); const blocked = blockCleanup(f);
  const gates = path.join(f.root, 'gates');
  const validate = `${process.execPath} -e 'require("fs").appendFileSync(${JSON.stringify(gates)}, "gate\\n")'`;
  const request = f.launch(['first', '--org', blocked.org, '--validate', validate]);
  let blockedEntry;
  const stop = async () => {
    fs.writeFileSync(blocked.release, 'release');
    await killCreated(f.ownedProcess(request.worker.pid));
    await killCreated(blockedEntry);
    fs.rmSync(path.join(f.queue.directory, 'worker.lock'), { recursive: true, force: true });
  };
  f.onCleanup(stop);
  await waitForFile(blocked.marker, text => /^[1-9]\d*$/.test(text), { timeoutMs: 30000 });
  blockedEntry = registerProcess(Number(fs.readFileSync(blocked.marker, 'utf8')), false);
  assert.ok(blockedEntry.command.includes(f.herdr), 'birth command belongs to the created cleanup fixture');
  const saved = f.queue.load().current;
  // This is the actual checkpoint written after the real lane CLI fast-forward.
  await killCreated(f.ownedProcess(request.worker.pid));
  await killCreated(blockedEntry);
  fs.rmSync(path.join(f.queue.directory, 'worker.lock'), { recursive: true });
  fs.writeFileSync(blocked.release, 'release');
  assert.equal(saved.phase, 'batch-delivering');
  assert.equal(Object.hasOwn(saved, 'fresh'), false, 'freshness must never be durable');
  assert.equal(f.git(['rev-parse', 'main']), f.git(['rev-parse', 'lane/first']));
  // Also recover a checkpoint produced by the older worker that leaked this flag.
  f.queue.transaction((data) => { data.current.fresh = true; });
  const r = f.cli(['--drain']); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.results()[0].outcome, 'promoted');
  assert.match(f.messages()[0][3], /outcome=promoted/);
  assert.equal(fs.readFileSync(gates, 'utf8'), 'gate\n');
  assert.equal(fs.existsSync(wt), false);
  assert.equal(f.git(['rev-parse', 'main']), saved.results[0].result.tip);
  assert.equal(Object.hasOwn(f.results()[0], 'fresh'), false);
  f.onCleanup(async () => {});
});

test('direct gate overlapping queued cleanup prevents queue and direct close from deleting its lane', async (t) => {
  const f = fixture(t); const wt = f.lane('first'); const blocked = blockCleanup(f);
  const request = f.launch(['first', '--org', blocked.org]);
  const ready = path.join(f.root, 'direct-gate-pid'); const release = path.join(f.root, 'direct-gate-release');
  const script = path.join(f.root, 'direct-gate.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(ready + ".tmp")},String(process.pid));fs.renameSync(${JSON.stringify(ready + ".tmp")},${JSON.stringify(ready)});
while(!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);\n`);
  let direct, blockedEntry, gateEntry;
  f.onCleanup(async () => {
    fs.writeFileSync(blocked.release, 'release'); fs.writeFileSync(release, 'release');
    await killCreated(f.ownedProcess(request.worker.pid));
    await killCreated(childProcessEntry(direct));
    for (const entry of [blockedEntry, gateEntry]) await killCreated(entry);
    fs.rmSync(path.join(f.queue.directory, 'worker.lock'), { recursive: true, force: true });
  });
  await waitForFile(blocked.marker, text => /^[1-9]\d*$/.test(text), { timeoutMs: 30000 });
  blockedEntry = registerProcess(Number(fs.readFileSync(blocked.marker, 'utf8')), false);
  assert.ok(blockedEntry.command.includes(f.herdr));
  const tip = f.git(['rev-parse', 'lane/first']);
  direct = spawnChild(t, process.execPath, [LANE, 'promote', 'first'], { cwd: f.repo,
    env: { ...f.env, LANE_VALIDATE: `${process.execPath} ${script}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; direct.stdout.on('data', (v) => { output += v; }); direct.stderr.on('data', (v) => { output += v; });
  const exited = waitForExit(direct);
  await waitForFile(ready, text => /^[1-9]\d*$/.test(text), { timeoutMs: 30000 });
  gateEntry = registerProcess(Number(fs.readFileSync(ready, 'utf8')), false);
  assert.ok(gateEntry.command.includes(script));
  fs.writeFileSync(blocked.release, 'release');
  await waitForChange([f.queue.file], () => f.results().length === 1, { timeoutMs: 30000 });
  assert.equal(direct.exitCode, null, 'the direct gate is still in progress');
  assert.equal(f.results()[0].outcome, 'promoted'); assert.equal(f.results()[0].delivered, true);
  assert.match(f.results()[0].reason, /lane close:.*lane-promote.lock/);
  assert.match(f.messages()[0][3], /lane close:.*lane-promote.lock/);
  assert.ok(fs.existsSync(wt)); assert.equal(f.git(['rev-parse', 'lane/first']), tip);
  // All close callers must respect a live gate, even outside queue orchestration.
  const close = spawnSync(process.execPath, [LANE, 'close', 'first', '--git-only'], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.notEqual(close.status, 0); assert.match(close.stderr, /lane-promote.lock/);
  fs.writeFileSync(release, 'release'); assert.equal((await exited).code, 0, output);
  await until(() => !fs.existsSync(path.join(f.queue.directory, 'worker.lock')));
  f.onCleanup(async () => {});
});

test('conditional close rechecks the promoted tip and base before any removal', (t) => {
  const f = fixture(t); const wt = f.lane('first'); const original = f.git(['rev-parse', 'lane/first']);
  f.git(['merge', '--ff-only', 'lane/first']);
  fs.writeFileSync(path.join(wt, 'first.txt'), 'new work'); f.git(['add', '.'], wt); f.git(['commit', '-qm', 'new lane work'], wt);
  const close = (tip) => spawnSync(process.execPath, [LANE, 'close', 'first', '--git-only', '--expected-tip', tip], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  const changed = close(original); assert.notEqual(changed.status, 0); assert.match(changed.stderr, /tip changed/);
  assert.ok(fs.existsSync(wt));
  const unmerged = close(f.git(['rev-parse', 'lane/first']));
  assert.notEqual(unmerged.status, 0); assert.match(unmerged.stderr, /not contained/);
  assert.ok(fs.existsSync(wt)); assert.equal(f.git(['tag', '--list', 'archive/lane/first']), '');
  f.git(['merge', '--ff-only', 'lane/first']);
  const safe = close(f.git(['rev-parse', 'lane/first'])); assert.equal(safe.status, 0, safe.stderr);
  assert.equal(fs.existsSync(wt), false);
});

test('only the committed gate profile reaches the host adapter, and it cannot set NODE_OPTIONS', async (t) => {
  const f = fixture(t); f.lane('first');
  const config = path.join(f.repo, '.promote.json');
  fs.writeFileSync(config, JSON.stringify({ gate: { wait_seconds: 5 } }));
  f.git(['add', '.']); f.git(['commit', '-qm', 'committed gate profile']);
  const marker = path.join(f.root, 'host-import-ran'), injected = path.join(f.root, 'inject.mjs');
  fs.writeFileSync(injected, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  const edited = JSON.stringify({ gate: { wait_seconds: 5, env: { NODE_OPTIONS: `--import=${injected}` } } });
  fs.writeFileSync(config, edited);
  assert.doesNotMatch(resolveGateProfile(f.repo).env.NODE_OPTIONS ?? '', /inject\.mjs/, 'the working-tree edit is not the profile');
  enqueue(f.queue, ['first'], { to: 'supervisor-herdr', attempts: 1, retry: 0, herdr: f.herdr, laneCLI: LANE, org: null });
  const r = f.cli(['--drain']); assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(marker), false, 'no host child loaded the uncommitted NODE_OPTIONS');
  assert.equal(f.results()[0].outcome, 'refused'); assert.match(f.results()[0].reason, /not clean/);
  f.git(['add', '.']); f.git(['commit', '-qm', 'committed NODE_OPTIONS']);
  assert.throws(() => resolveGateProfile(f.repo), /NODE_OPTIONS are host-owned/);
  f.git(['rm', '-q', '.promote.json']); f.git(['commit', '-qm', 'no profile']);
  fs.writeFileSync(config, JSON.stringify({ gate: { wait_seconds: 5 } }));
  assert.equal(resolveGateProfile(f.repo), null, 'an untracked profile is not a profile');
});

test('an unborn canonical branch has no gate profile, whatever its working tree holds', (t) => {
  const repo = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'pt-unborn-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['-C', repo, 'init', '-q', '-b', 'main']).status, 0);
  fs.writeFileSync(path.join(repo, '.promote.json'), JSON.stringify({ gate: { env: { NODE_OPTIONS: '--import=x' } } }));
  assert.equal(resolveGateProfile(repo), null);
});
