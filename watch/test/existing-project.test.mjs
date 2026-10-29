import { recipientAgent } from '../../test/helpers/recipient-agent.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from '../../test/helpers/bounded-test.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { waitForInboxIdle, stopFixtureInbox } from '../../test/helpers/inbox.mjs';
import { readInbox } from '../../supervisor/prompt-supervisor.mjs';
import { noticeLock, ownerPid } from '../../supervisor/notice-lock.mjs';
import { gitProject } from '../../lib/project.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';

const monitor = path.resolve(import.meta.dirname, '../..');
const arm = path.join(monitor, 'supervisor/arm-watch.sh');
const cli = path.join(monitor, 'bin/org.mjs');

async function waitForNotice(inbox, predicate) {
  const deadline = Date.now() + loadTimeout(10000);
  do {
    const entry = readInbox(inbox)[0];
    if (entry && predicate(entry)) return entry;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.fail(`notice did not reach the expected state: ${JSON.stringify(readInbox(inbox))}`);
}

function fixture(t, outcome = 'done', { autopilot = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bch-notices-')));
  const repo = path.join(root, 'bastian/bch-cloak'), org = path.join(root, 'bastian/.org');
  const lane = path.join(root, 'worktrees/lane-notices'), bin = path.join(root, 'bin');
  const calls = path.join(root, 'calls.jsonl'), actions = path.join(root, 'actions.jsonl');
  const inbox = path.join(org, 'supervisor/inbox.log');
  const env = { ...process.env, ORG_DIR: org, ORG_ACTOR: 'existing-project-test',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    MONITOR_SUPERVISOR_AGENT: 'wrong-inherited-supervisor',
    SUPERVISOR_INPUT_CONFIRM_SECONDS: '0.01', SUPERVISOR_INPUT_POLL_SECONDS: '0.01',
    SUPERVISOR_INPUT_WAIT_SECONDS: String(loadTimeout(10000) / 1000) };
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(bin);
  const runCommand = (file, args, cwd = repo) => {
    const r = spawnSync(file, args, { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim();
  };
  const record = args => runCommand(process.execPath, [cli, ...args]);
  runCommand('git', ['init', '-q', '-b', 'main']);
  runCommand('git', ['config', 'user.name', 'Offline notice test']);
  runCommand('git', ['config', 'user.email', 'offline@example.invalid']);
  fs.writeFileSync(path.join(repo, 'work.txt'), 'base');
  runCommand('git', ['add', 'work.txt']); runCommand('git', ['commit', '-qm', 'Base']);
  runCommand('git', ['worktree', 'add', '-qb', 'lane/notices', lane]);
  // ENG-381 requires an explicit opt-in and a nonempty, mapped candidate diff.
  // An unconfigured project must retain the ordinary supervisor delivery path.
  if (autopilot) fs.writeFileSync(path.join(repo, '.supervisor.json'), JSON.stringify({ autopilot: { enabled: true, cohort: 'clean-pass' } }));
  fs.writeFileSync(path.join(lane, 'README.md'), 'Offline worker result.\n');
  runCommand('git', ['add', 'README.md'], lane);
  runCommand('git', ['commit', '-qm', 'Document offline worker result'], lane);
  record(['init']);
  const config = JSON.parse(fs.readFileSync(path.join(org, 'config.json')));
  config.approvals.categories.tooling = 'auto';
  fs.writeFileSync(path.join(org, 'config.json'), JSON.stringify(config));
  const item = record(['add', 'Offline worker', '--role', 'engineer']).split(' ')[0];
  const run = record(['start', item, '--workspace', lane, '--meta', 'agent=worker']).match(/R-\d+/)[0];
  record(['claim', run, '--controller', 'brain']);
  const report = JSON.parse(record(['show', run, '--json'])).report_path;
  fs.writeFileSync(report, `---\nrun: ${run}\noutcome: ${outcome}\nsummary: Offline worker finished.\nheadline: Offline worker finished\nblockers: ${outcome === 'done' ? '[]' : '["Operator judgment needed"]'}\nproposals: []\n---\n`);
  const herdr = path.join(bin, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}
import fs from 'node:fs';
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a)+'\\n');
if(a[0]==='agent' && a[1]==='get') console.log(JSON.stringify({result:{agent:{...${JSON.stringify(recipientAgent('supervisor-opus', repo, { pane_id: 'scratch:supervisor', terminal_id: 'scratch:supervisor-terminal' }))},name:a[2],agent_status:a[2]==='supervisor-opus'?${JSON.stringify(outcome === 'done' ? 'working' : 'done')}:'done'}}}));
else if(a[0]==='pane' && a[1]==='read') console.log('────────────────────\\n❯ \\n────────────────────');
else if(a[0]==='agent' && a[1]==='prompt') console.log('{}');
else if(a[0]==='notification' && a[1]==='show') console.log('{}');
else process.exit(91);
`, { mode: 0o755 });
  env.PATH = `${bin}:${env.PATH}`;
  // Only the routed settle command is scripted. Watch, report validation,
  // project binding, the journal, policy and record intake are real and offline.
  const preload = path.join(root, 'settle-transport.mjs');
  fs.writeFileSync(preload, `import cp from 'node:child_process';
import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const native = cp.spawnSync;
cp.spawnSync = (file,args,options) => {
  if(args?.[0]===${JSON.stringify(path.join(monitor, 'supervisor/supervisor.mjs'))}) {
    fs.appendFileSync(${JSON.stringify(actions)},JSON.stringify({args,cwd:options.cwd,org:options.env.ORG_DIR})+'\\n');
    const intake=native(process.execPath,[${JSON.stringify(cli)},'ingest',${JSON.stringify(report)}],options);
    if(intake.status!==0) return intake;
    return {status:0,stdout:JSON.stringify({result:'fix_round',review:{verdict:'NEEDS-WORK'},review_policy:{cap:2,round:1}}),stderr:''};
  }
  return native(file,args,options);
}; syncBuiltinESMExports();
`);
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${preload}`;
  t.after(async () => { await stopFixtureInbox(inbox, { script: path.join(monitor, 'supervisor/prompt-supervisor.mjs') }); fs.rmSync(root, { recursive: true, force: true }); });
  const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const args = [arm, run, '--org', org, '--cwd', lane, '--to', 'supervisor-opus'];
  return { root, repo, lane, org, inbox, env, args, run, item, record, calls: () => rows(calls), actions: () => rows(actions) };
}

test('an existing project autopilots a done notice with a busy supervisor from a foreign caller and detached arm', async t => {
  const f = fixture(t);
  const child = spawnChild(t, process.execPath, [path.join(monitor, 'watch/watch.mjs'), ...f.args.slice(1)], { cwd: monitor, env: f.env });
  const finished = await waitForExit(child);
  assert.equal(finished.code, 0, finished.stderr);
  let entries = readInbox(f.inbox);
  assert.equal(entries.length, 1); assert.equal(entries[0].state, 'handled');
  assert.equal(entries[0].to, 'supervisor-opus');
  assert.deepEqual(entries[0].project, { repo: f.repo, identity: gitProject(f.repo).identity, org: f.org });
  assert.match(entries[0].autopilot.receipt, new RegExp(`${f.org}/supervisor/`));
  assert.equal(f.actions().length, 1);
  const action = f.actions()[0];
  assert.deepEqual(action.args.slice(1, 3), ['handle', f.run]);
  assert.equal(action.cwd, f.repo); assert.equal(action.org, f.org);
  assert.equal(action.args[action.args.indexOf('--to') + 1], 'supervisor-opus');
  assert.equal(JSON.parse(f.record(['show', f.run, '--json'])).report.outcome, 'done');
  assert.equal(f.calls().some(a => a[1] === 'prompt'), false);

  const log = path.join(f.root, 'watch.log');
  const detached = spawnSync('/bin/sh', [...f.args, '--detach', '--log', log], { cwd: monitor, env: f.env, encoding: 'utf8' });
  assert.equal(detached.status, 0, detached.stderr);
  assert.equal(JSON.parse(detached.stdout).run, f.run);
  // Filesystem events are optional under a native worker sandbox. This is a
  // detached startup/deduplication check of the already-ingested report.
  const confirmed = new RegExp(`${f.run} final notice confirmed from its ingested report`);
  const deadline = Date.now() + 5000;
  while (!confirmed.test(fs.readFileSync(log, 'utf8')) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(fs.readFileSync(log, 'utf8'), confirmed);
  await waitForInboxIdle(f.inbox);
  entries = readInbox(f.inbox);
  assert.equal(entries.length, 1); assert.equal(f.actions().length, 1);
  assert.equal(fs.existsSync(path.join(f.repo, '.lane/supervisor/outbox')), false);
});

test('an existing project exception reaches its named supervisor through its own record inbox', async t => {
  const f = fixture(t, 'blocked');
  const child = spawnChild(t, process.execPath, [path.join(monitor, 'watch/watch.mjs'), ...f.args.slice(1)], { cwd: monitor, env: f.env });
  const finished = await waitForExit(child);
  assert.equal(finished.code, 0, finished.stderr);
  await waitForInboxIdle(f.inbox);
  const [entry] = readInbox(f.inbox);
  assert.equal(entry.state, 'sent'); assert.equal(entry.autopilot.disposition, 'wake');
  assert.equal(entry.project.org, f.org); assert.equal(entry.project.repo, f.repo);
  const prompts = f.calls().filter(a => a[1] === 'prompt');
  assert.equal(prompts.length, 1); assert.equal(prompts[0][2], 'supervisor-opus');
  assert.match(prompts[0][3], /outcome=blocked/); assert.equal(f.actions().length, 0);
});

test('an opted-in existing project retains a done notice until the live drainer releases the inbox lock', async t => {
  const f = fixture(t), lock = `${f.inbox}.drain.lock`, release = noticeLock(lock);
  try {
    const child = spawnChild(t, process.execPath, [path.join(monitor, 'watch/watch.mjs'), ...f.args.slice(1)], { cwd: monitor, env: f.env });
    // Observe actual drain-lock contention before checking that policy and
    // input remain serialized behind the live owner.
    const pending = await waitForNotice(f.inbox, entry => entry.owner_pid && entry.notified &&
      entry.error === `locked: ${lock}; owner is live or unidentified`);
    assert.equal(pending.state, 'pending'); assert.equal(pending.autopilot, undefined);
    assert.equal(f.actions().length, 0);
    assert.equal(f.calls().some(a => a[1] === 'prompt'), false);
    assert.equal(ownerPid(lock), process.pid, 'policy must leave the live drain owner intact');
    release();
    const finished = await waitForExit(child);
    assert.equal(finished.code, 0, finished.stderr);
    assert.equal(readInbox(f.inbox)[0].state, 'handled');
    assert.equal(f.actions().length, 1);
    assert.equal(f.calls().some(a => a[1] === 'prompt'), false);
  } finally { release(); }
});

test('an unconfigured existing project retains its done notice for a busy supervisor without automatic intake', async t => {
  const f = fixture(t, 'done', { autopilot: false });
  const child = spawnChild(t, process.execPath, [path.join(monitor, 'watch/watch.mjs'), ...f.args.slice(1)], {
    cwd: monitor, env: { ...f.env, SUPERVISOR_INPUT_WAIT_SECONDS: '0' },
  });
  const finished = await waitForExit(child);
  assert.equal(finished.code, 1, finished.stderr);
  assert.match(finished.stderr, /could not deliver to supervisor-opus/);
  // A zero-wait caller hands policy to the acknowledged background owner.
  const entry = await waitForNotice(f.inbox, entry => entry.autopilot);
  assert.equal(entry.state, 'pending'); assert.equal(entry.to, 'supervisor-opus');
  assert.equal(entry.autopilot.disposition, 'wake');
  assert.equal(entry.autopilot.summary, entry.message);
  assert.equal(JSON.parse(fs.readFileSync(entry.autopilot.receipt)).exception, 'AUTOPILOT_DISABLED');
  assert.equal(f.actions().length, 0);
  assert.equal(f.calls().some(a => a[1] === 'prompt'), false);
  assert.equal(JSON.parse(f.record(['show', f.run, '--json'])).report, null);
});

test('arming discovers the caller record and adapter recipient and dry-runs detached settings', t => {
  const f = fixture(t);
  const env = { ...f.env, MONITOR_SUPERVISOR_AGENT: 'supervisor-opus' };
  delete env.ORG_DIR;
  const r = spawnSync('/bin/sh', [arm, f.run, '--dry-run', '--detach', '--log', path.join(f.root, 'unused.log')], { cwd: f.repo, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /supervisor supervisor-opus/);
  assert.match(r.stdout, /\[dry-run\].*report=valid/);
  assert.equal(fs.existsSync(f.inbox), false);
  assert.equal(fs.existsSync(path.join(f.root, 'unused.log')), false);
});
