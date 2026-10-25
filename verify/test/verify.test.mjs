import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { queueFor, submit, admit, drain, recover, status, deliver, writeReceipt, jobDigest, initStore, probeStore } from '../verify.mjs';
import { parseExpectations, evaluate, sha256 } from '../expectations.mjs';
import { initOrg, transact, loadEvents } from '../../lib/store.mjs';
import { enqueueSupervisor, readInbox as snapshot } from '../../supervisor/prompt-supervisor.mjs';
import { acquireTestSlot } from '../../test-slot/test-slot.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { stopFixtureInbox } from '../../test/helpers/inbox.mjs';
import { lookupProcess } from '../../lib/processes.mjs';
import { productFiles } from '../../lib/product-files.mjs';
import { acquireLock } from '../../lanes/promotion-lock.mjs';
import { stopGateGroup } from '../../test-slot/watchdog.mjs';
import { registerProcess, killProcess } from '../../test/helpers/processes.mjs';

const CLI = fileURLToPath(new URL('../verify.mjs', import.meta.url));
const inboxCLI = fileURLToPath(new URL('../../supervisor/prompt-supervisor.mjs', import.meta.url));
const node = code => [process.execPath, '-e', code];
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const references = (queue, ids) => {
  const inspected = status(queue).jobs;
  return ids.map(id => `${id}=${inspected.find(job => job.id === id).spec_sha256}`);
};
const admitJobs = (queue, ids) => admit(queue, references(queue, ids));
async function until(fn, message, completion, detail = () => '') {
  let ended = false, failure;
  const terminal = completion?.then(() => { ended = true; }, error => { ended = true; failure = error; });
  while (!fn()) {
    if (ended) {
      if (failure) throw failure;
      throw Error(`${message}; execution ended before readiness${detail()}`);
    }
    const poll = new Promise(resolve => setTimeout(resolve, 25));
    await (terminal ? Promise.race([poll, terminal]) : poll);
  }
}
function fixture(t, { defaultState = false, proving = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'))), repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const before = { ...process.env };
  if (proving) {
    const preload = fileURLToPath(new URL('../../test-slot/test/helpers/proving-preload.mjs', import.meta.url));
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}`;
  }
  // Trusted fixtures must also be outside system temp. They belong to this
  // test's temporary project, never the source checkout's live verify store.
  const storeParent = fileURLToPath(new URL('../../.lane/verify-fixtures/', import.meta.url));
  fs.mkdirSync(storeParent, { recursive: true });
  const storeRoot = fs.mkdtempSync(path.join(storeParent, 'store-'));
  process.env.XDG_STATE_HOME = storeRoot;
  delete process.env.VERIFY_UNTRUSTED_ROOTS;
  process.env.MONITOR_TEST_SLOT_PATH = process.env.MONITOR_TEST_SLOT_COMPAT_PATH = path.join(root, 'slot');
  process.env.HERDR_MONITOR_FLEET = path.join(root, 'fleet');
  process.env.ORG_ACTOR = 'fixture-submitter';
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-qb', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'verify@example.invalid');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.org/\ncache/\n');
  fs.writeFileSync(path.join(repo, 'version'), 'one');
  git('add', '.'); git('commit', '-qm', 'one'); const sha1 = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'version'), 'two'); git('commit', '-qam', 'two'); const sha2 = git('rev-parse', 'HEAD');
  const org = path.join(repo, '.org'); initOrg(org);
  transact(org, () => ({ add: [{ type: 'item.added', id: 'ENG-1', title: 'Fixture' }] }), { actor: 'fixture' });
  const fake = path.join(root, 'herdr.cjs');
  fs.writeFileSync(fake, `#!${process.execPath}\nconsole.log(JSON.stringify({result:{agent:{agent:'codex',agent_status:'working',pane_id:'fixture'}}}));\n`, { mode: 0o755 });
  const queue = queueFor(repo, defaultState ? undefined : path.join(storeRoot, 'state'));
  const add = (opt = {}, argv = node("console.log('ok')"), prepare = null) => submit(queue, { org, item: 'ENG-1', sha: sha1, to: 'ops-fixture', herdr: fake, ...opt }, argv, prepare);
  const notify = async (to, text, opt) => enqueueSupervisor(to, text, opt);
  const run = async (...jobs) => { const token = admitJobs(queue, jobs.map(job => job.job)); await drain(queue, token, { notify }); };
  const cli = async args => {
    if (args[0] === 'admit') {
      const jobs = status(queue).jobs;
      args = args.map(arg => jobs.some(job => job.id === arg) ? references(queue, [arg])[0] : arg);
    }
    const result = await waitForExit(spawnChild(t, process.execPath, [CLI, ...args, '--repo', repo, '--state-dir', queue.directory], { env: process.env }));
    assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout);
  };
  t.after(async () => {
    await stopFixtureInbox(path.join(org, 'supervisor/inbox.log'), { script: inboxCLI });
    for (const desk of Object.keys(queue.load().desks)) git('worktree', 'remove', '--force', desk);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(storeRoot, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  });
  return { root, storeRoot, repo, org, queue, sha1, sha2, git, add, run, cli, notify, fake };
}

test('submit exits while the slot is busy; no job runs without explicit admission', async t => {
  const f = fixture(t), holder = await acquireTestSlot('fixture busy', { lockPath: process.env.MONITOR_TEST_SLOT_PATH, waitSeconds: 0 });
  t.after(() => holder.release());
  const marker = path.join(f.root, 'ran');
  // Use the public CLI, including --, without appending options to command argv.
  const result = await waitForExit(spawnChild(t, process.execPath, [CLI, 'submit', '--repo', f.repo, '--state-dir', f.queue.directory,
    '--org', f.org, '--item', 'ENG-1', '--sha', f.sha1, '--herdr', f.fake, '--', ...node(`require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`)]));
  assert.equal(result.code, 0, result.stderr);
  const job = JSON.parse(result.stdout);
  assert.equal(status(f.queue).jobs[0].state, 'pending-admission');
  assert.equal(fs.existsSync(job.receipt), false); assert.equal(fs.existsSync(marker), false);
  assert.equal(f.queue.load().runner, null);
  assert.equal(fs.existsSync(f.queue.directory), false, 'submit never writes the trusted store');
  assert.equal(f.queue.inbox.load().jobs.length, 1);
  holder.release(); await f.run(job);
  assert.equal(read(job.receipt).outcome, 'pass'); assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
});

test('the default trusted store is outside Git and uses canonical identity from a linked checkout', async t => {
  const f = fixture(t, { defaultState: true }), lane = path.join(f.root, 'lane');
  f.git('worktree', 'add', '--detach', lane, f.sha1);
  try {
    assert.equal(queueFor(lane).directory, f.queue.directory);
    assert.equal(f.queue.directory, path.join(f.storeRoot, 'herdr-monitor/verify', sha256(f.git('rev-parse', '--path-format=absolute', '--git-common-dir'))));
    const job = f.add(); await f.run(job);
    assert.equal(read(job.receipt).outcome, 'pass');
    assert.equal(read(job.receipt).desk, path.join(f.queue.directory, 'desks/default'));
  } finally { f.git('worktree', 'remove', '--force', lane); }
});

test('trusted store paths refuse Git, every worktree, records, desks and symlink aliases', t => {
  const f = fixture(t), lane = path.join(f.root, 'linked');
  f.git('worktree', 'add', '--detach', lane, f.sha1);
  try {
    for (const root of [f.repo, path.join(f.repo, '.git'), lane, f.org]) {
      assert.throws(() => queueFor(f.repo, path.join(root, 'trusted')), /trusted store must be outside/);
    }
    const alias = path.join(f.storeRoot, 'git-alias'); fs.symlinkSync(path.join(f.repo, '.git'), alias);
    assert.throws(() => queueFor(f.repo, path.join(alias, 'trusted')), /trusted store must be outside/);
    assert.throws(() => f.add({ desk: f.storeRoot }), /trusted store must be outside|desk cannot contain/);
    const externalOrg = path.join(f.storeRoot, 'record'); initOrg(externalOrg);
    transact(externalOrg, () => ({ add: [{ type: 'item.added', id: 'ENG-1', title: 'External' }] }), { actor: 'fixture' });
    const insideRecord = queueFor(f.repo, path.join(externalOrg, 'trusted'));
    assert.throws(() => submit(insideRecord, { org: externalOrg, item: 'ENG-1', sha: f.sha1 }, node('')), /trusted store must be outside/);
    assert.equal(fs.existsSync(insideRecord.directory), false);
    const job = f.add();
    f.queue.inbox.transaction(data => { data.jobs[0].desk = f.storeRoot; });
    assert.throws(() => admitJobs(f.queue, [job.job]), /trusted store must be outside/);
    assert.equal(fs.existsSync(f.queue.directory), false);
  } finally { f.git('worktree', 'remove', '--force', lane); }
});

test('trusted stores refuse all system temp roots, including configured TMPDIR and default XDG placement', t => {
  const f = fixture(t);
  for (const root of ['/tmp', '/private/tmp', os.tmpdir()]) assert.throws(() => queueFor(f.repo, path.join(root, 'verify-refused')), /system temp/);
  process.env.TMPDIR = path.join(f.storeRoot, 'native-temp');
  assert.throws(() => queueFor(f.repo, path.join(process.env.TMPDIR, 'trusted')), /system temp/);
  process.env.XDG_STATE_HOME = '/private/tmp';
  assert.throws(() => queueFor(f.repo), /system temp/);
  delete process.env.XDG_STATE_HOME;
  assert.equal(queueFor(f.repo).directory, path.join(os.homedir(), '.local/state/herdr-monitor/verify', sha256(f.queue.project.identity)));
});

test('repeatable CLI and colon-separated environment roots refuse stores after resolving aliases', async t => {
  const f = fixture(t), other = path.join(f.storeRoot, 'other-root');
  const result = await waitForExit(spawnChild(t, process.execPath, [CLI, 'status', '--repo', f.repo, '--state-dir', f.queue.directory,
    '--untrusted-root', other, '--untrusted-root', f.storeRoot]));
  assert.equal(result.code, 1); assert.match(result.stderr, /untrusted roots/);
  process.env.VERIFY_UNTRUSTED_ROOTS = [other, f.storeRoot].join(path.delimiter);
  assert.throws(() => queueFor(f.repo, f.queue.directory), /untrusted roots/);
  delete process.env.VERIFY_UNTRUSTED_ROOTS;
  const alias = path.join(f.root, 'untrusted-alias'); fs.symlinkSync(f.storeRoot, alias);
  assert.throws(() => queueFor(f.repo, f.queue.directory, { untrustedRoots: [alias] }), /untrusted roots/);
  assert.equal(queueFor(f.repo, f.queue.directory, { untrustedRoots: [other] }).directory, f.queue.directory);
});

test('probe-store reports an absent store with a nonzero exit and trusted-side init instructions', async t => {
  const f = fixture(t);
  const result = await waitForExit(spawnChild(t, process.execPath, [CLI, 'probe-store', '--repo', f.repo, '--state-dir', f.queue.directory]));
  assert.equal(result.code, 1);
  const absent = JSON.parse(result.stdout);
  assert.equal(absent.state, 'absent'); assert.equal(absent.writable, null); assert.equal(absent.code, 'ENOENT');
  assert.match(absent.error, /ENOENT.*verify init.*trusted side/);
  assert.equal(fs.existsSync(f.queue.directory), false);
});

test('probe-store fires an exclusive write, removes it, and reports protected in a read-only store', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.queue.directory, { mode: 0o700 });
  assert.deepEqual(await f.cli(['probe-store']), { state: 'writable', writable: true, code: null, error: null });
  assert.deepEqual(fs.readdirSync(f.queue.directory), []);
  fs.chmodSync(f.queue.directory, 0o500);
  try {
    const refused = await f.cli(['probe-store']);
    assert.equal(refused.state, 'protected'); assert.ok(['EACCES', 'EPERM'].includes(refused.code));
    assert.equal(refused.writable, false); assert.match(refused.error, /EACCES|EPERM/);
    assert.equal(fs.statSync(f.queue.directory).mode & 0o777, 0o500);
    assert.deepEqual(fs.readdirSync(f.queue.directory), []);
  } finally { fs.chmodSync(f.queue.directory, 0o700); }
});

test('probe-store reports unknown for a non-directory store and exits nonzero', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.queue.directory, 'not a directory');
  try {
    const result = await waitForExit(spawnChild(t, process.execPath, [CLI, 'probe-store', '--repo', f.repo, '--state-dir', f.queue.directory]));
    assert.equal(result.code, 1);
    const unknown = JSON.parse(result.stdout);
    assert.equal(unknown.state, 'unknown'); assert.equal(unknown.writable, null); assert.equal(unknown.code, 'ENOTDIR');
    assert.match(unknown.error, /ENOTDIR/);
    assert.equal(fs.readFileSync(f.queue.directory, 'utf8'), 'not a directory');
  } finally { fs.unlinkSync(f.queue.directory); }
});

test('probe-store reports EPERM as protected and a cleanup failure as unknown', t => {
  const f = fixture(t);
  initStore(f.queue);
  const open = fs.openSync;
  const denied = t.mock.method(fs, 'openSync', (file, ...args) => {
    if (String(file).startsWith(path.join(f.queue.directory, '.probe-'))) throw Object.assign(Error('denied'), { code: 'EPERM' });
    return open(file, ...args);
  });
  assert.deepEqual(probeStore(f.queue), { state: 'protected', writable: false, code: 'EPERM', error: 'EPERM: denied' });
  denied.mock.restore();
  const unlink = fs.unlinkSync;
  const cleanup = t.mock.method(fs, 'unlinkSync', (file, ...args) => {
    if (String(file).startsWith(path.join(f.queue.directory, '.probe-'))) throw Object.assign(Error('cleanup failed'), { code: 'ENOENT' });
    return unlink(file, ...args);
  });
  assert.deepEqual(probeStore(f.queue), { state: 'unknown', writable: null, code: 'ENOENT', error: 'ENOENT: cleanup failed' });
  cleanup.mock.restore();
});

for (const defaultState of [false, true]) test(`init creates a private ${defaultState ? 'default' : 'selected'} store, prints its path and is idempotent`, async t => {
  const f = fixture(t, { defaultState });
  const args = [CLI, 'init', '--repo', f.repo, ...(defaultState ? [] : ['--state-dir', f.queue.directory])];
  for (let i = 0; i < 2; i++) {
    const result = await waitForExit(spawnChild(t, process.execPath, args));
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout.trim(), f.queue.directory);
    const stat = fs.statSync(f.queue.directory);
    assert.equal(stat.mode & 0o7777, 0o700); assert.equal(stat.uid, process.getuid());
    if (!i) fs.writeFileSync(path.join(f.queue.directory, 'retained'), 'keep');
  }
  assert.deepEqual(fs.readdirSync(f.queue.directory), ['retained']);
  assert.equal(fs.readFileSync(path.join(f.queue.directory, 'retained'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(f.queue.inbox.directory), false);
});

test('init creates mode 0700 even with a restrictive umask', t => {
  const f = fixture(t), previous = process.umask(0o777);
  try { assert.equal(initStore(f.queue), f.queue.directory); }
  finally { process.umask(previous); }
  assert.equal(fs.statSync(f.queue.directory).mode & 0o7777, 0o700);
});

test('init refuses existing stores with a different mode or owner without repairing them', t => {
  const f = fixture(t);
  initStore(f.queue);
  for (const mode of [0o755, 0o750, 0o770, 0o500, 0o1700]) {
    fs.chmodSync(f.queue.directory, mode);
    assert.throws(() => initStore(f.queue), /mode 0700/);
    assert.equal(fs.statSync(f.queue.directory).mode & 0o7777, mode);
  }
  fs.chmodSync(f.queue.directory, 0o700);
  const stat = fs.statSync;
  const owner = t.mock.method(fs, 'statSync', (file, ...args) => {
    const result = stat(file, ...args);
    return file === f.queue.directory ? Object.assign(result, { uid: process.getuid() + 1 }) : result;
  });
  assert.throws(() => initStore(f.queue), /different owner/);
  owner.mock.restore();
  assert.equal(fs.statSync(f.queue.directory).mode & 0o7777, 0o700);
  assert.deepEqual(fs.readdirSync(f.queue.directory), []);
});

test('init applies admission location guards before creating a store', async t => {
  const f = fixture(t), lane = path.join(f.root, 'linked'), alias = path.join(f.storeRoot, 'git-alias');
  f.git('worktree', 'add', '--detach', lane, f.sha1);
  fs.symlinkSync(path.join(f.repo, '.git'), alias);
  try {
    for (const root of [f.repo, path.join(f.repo, '.git'), lane, f.org, alias, '/tmp', '/private/tmp', os.tmpdir()]) {
      const directory = path.join(root, 'init-refused');
      const result = await waitForExit(spawnChild(t, process.execPath, [CLI, 'init', '--repo', f.repo, '--state-dir', directory]));
      assert.equal(result.code, 1); assert.match(result.stderr, /trusted store must be outside/);
      assert.equal(fs.existsSync(directory), false);
    }
    const job = f.add();
    f.queue.inbox.transaction(data => { data.jobs.find(row => row.id === job.job).desk = f.storeRoot; });
    assert.throws(() => initStore(f.queue), /trusted store must be outside/);
    assert.equal(fs.existsSync(f.queue.directory), false);
  } finally { f.git('worktree', 'remove', '--force', lane); }
});

test('init applies repeatable CLI roots and environment roots before creating a store', async t => {
  const f = fixture(t);
  for (const opt of [ ['--untrusted-root', path.join(f.storeRoot, 'other'), '--untrusted-root', f.storeRoot], [] ]) {
    if (!opt.length) process.env.VERIFY_UNTRUSTED_ROOTS = [path.join(f.storeRoot, 'other'), f.storeRoot].join(path.delimiter);
    const result = await waitForExit(spawnChild(t, process.execPath, [CLI, 'init', '--repo', f.repo, '--state-dir', f.queue.directory, ...opt]));
    assert.equal(result.code, 1); assert.match(result.stderr, /untrusted roots/);
    assert.equal(fs.existsSync(f.queue.directory), false);
  }
});

test('one detached admitted worker returns before grant, drains FIFO and records holders plus one note and notice', async t => {
  const f = fixture(t, { proving: true }), order = path.join(f.root, 'order');
  const holder = await acquireTestSlot('fixture holder', { lockPath: process.env.MONITOR_TEST_SLOT_PATH, waitSeconds: 0 });
  t.after(() => holder.release());
  const a = f.add({}, node(`require('fs').appendFileSync(${JSON.stringify(order)},'A')`));
  const b = f.add({}, node(`require('fs').appendFileSync(${JSON.stringify(order)},'B')`));
  const admitted = await f.cli(['admit', b.job, a.job]);
  assert.deepEqual(admitted.admitted, { [a.job]: a.spec_sha256, [b.job]: b.spec_sha256 });
  assert.equal(fs.existsSync(a.receipt), false); assert.equal(fs.existsSync(b.receipt), false);
  assert.throws(() => admitJobs(f.queue, [a.job]), /admission is active/);
  await until(() => fs.existsSync(path.join(f.queue.directory, 'jobs', a.job, 'execution.log')) && fs.readFileSync(path.join(f.queue.directory, 'jobs', a.job, 'execution.log'), 'utf8').includes('TEST_SLOT_WAIT'), 'worker did not wait for slot');
  holder.release();
  await until(() => f.queue.load().runner === null, 'detached worker did not finish');
  assert.equal(fs.readFileSync(order, 'utf8'), 'AB');
  const receipt = read(a.receipt);
  assert.equal(receipt.schema, 'verify-receipt/v1'); assert.equal(receipt.sha, f.sha1);
  assert.equal(receipt.admitted_spec_sha256, jobDigest(f.queue.load().jobs[0]));
  assert.equal(receipt.tree, f.git('rev-parse', `${f.sha1}^{tree}`));
  assert.match(receipt.environment_fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(receipt.slot_waits.some(wait => wait.holder.includes('fixture holder')));
  for (const field of ['submitted_at', 'admitted_at', 'slot_wait_started_at', 'granted_at', 'started_at', 'finished_at']) assert.ok(receipt[field], field);
  assert.ok(receipt.granted_at <= receipt.started_at); assert.equal(receipt.slot_execution.attempts, 1);
  for (const log of receipt.logs) { assert.equal(fs.statSync(log.path).mode & 0o777, 0o600); assert.equal(sha256(fs.readFileSync(log.path)), log.sha256); }
  assert.equal(fs.statSync(f.queue.directory).mode & 0o777, 0o700);
  const notes = loadEvents(f.org).events.filter(event => event.type === 'note.added');
  assert.equal(notes.length, 2); assert.ok(notes.every(note => note.decision === false && note.by === 'fixture-submitter'));
  assert.match(notes[0].text, new RegExp(sha256(fs.readFileSync(a.receipt))));
  assert.equal(snapshot(path.join(f.org, 'supervisor/inbox.log')).length, 2);
  const saved = f.queue.load().jobs[0];
  await deliver(f.queue, saved, saved, f.notify);
  assert.equal(loadEvents(f.org).events.filter(event => event.type === 'note.added').length, 2);
  assert.equal(snapshot(path.join(f.org, 'supervisor/inbox.log')).length, 2);
});

test('FIFO preserves submission order when an older pending job enters a later admission batch', async t => {
  const f = fixture(t), order = path.join(f.root, 'order');
  const a = f.add({}, node(`require('fs').appendFileSync(${JSON.stringify(order)},'A')`));
  const b = f.add({}, node(`require('fs').appendFileSync(${JSON.stringify(order)},'B')`));
  admitJobs(f.queue, [b.job]); await recover(f.queue, { notify: f.notify });
  await f.run(b, a); assert.equal(fs.readFileSync(order, 'utf8'), 'AB');
});

test('admit refuses bare IDs through the API and CLI before creating trusted state', async t => {
  const f = fixture(t), job = f.add();
  assert.throws(() => admit(f.queue, [job.job]), /JOB=SPEC_SHA256.*bare IDs refuse/);
  const result = await waitForExit(spawnChild(t, process.execPath, [CLI, 'admit', job.job, '--repo', f.repo, '--state-dir', f.queue.directory]));
  assert.equal(result.code, 1); assert.match(result.stderr, /JOB=SPEC_SHA256/);
  assert.equal(fs.existsSync(f.queue.directory), false);
});

test('a never-admitted inbox edit refuses the previously inspected digest and accepts the newly inspected digest', async t => {
  const f = fixture(t), job = f.add(), inspected = references(f.queue, [job.job]);
  const changed = node("console.log('changed after inspection')");
  f.queue.inbox.transaction(data => { data.jobs[0].argv = changed; });
  assert.throws(() => admit(f.queue, inspected), /inbox spec digest differs/);
  assert.equal(fs.existsSync(f.queue.directory), false);
  const current = status(f.queue, { id: job.job }).jobs[0];
  assert.deepEqual(current.argv, changed); assert.equal(current.spec_sha256, jobDigest(f.queue.inbox.load().jobs[0]));
  await f.run(job); assert.deepEqual(read(job.receipt).argv, changed);
});

test('pending status shows current inbox content; stale consent refuses and admitted specs never change', async t => {
  const f = fixture(t), marker = path.join(f.root, 'changed-command'), job = f.add();
  admitJobs(f.queue, [job.job]); await recover(f.queue, { notify: f.notify });
  const displayed = (await f.cli(['status', job.job])).jobs[0];
  assert.equal(displayed.state, 'pending-admission'); assert.equal(displayed.spec_sha256, job.spec_sha256);
  const saved = f.queue.load(), changed = node(`require('fs').writeFileSync(${JSON.stringify(marker)},'changed')`);
  f.queue.inbox.transaction(data => { data.jobs[0].argv = changed; });
  const current = (await f.cli(['status', job.job])).jobs[0];
  assert.deepEqual(current.argv, changed); assert.notEqual(current.spec_sha256, displayed.spec_sha256);
  assert.equal(current.spec_sha256, jobDigest(f.queue.inbox.load().jobs[0]));
  const result = await waitForExit(spawnChild(t, process.execPath, [CLI, 'admit', `${job.job}=${displayed.spec_sha256}`, '--repo', f.repo, '--state-dir', f.queue.directory]));
  assert.equal(result.code, 1); assert.match(result.stderr, /inbox spec digest differs/);
  assert.throws(() => admit(f.queue, [`${job.job}=${current.spec_sha256}`]), /admitted spec is immutable.*new job/);
  assert.deepEqual(f.queue.load(), saved); assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(job.receipt), false);
  const retry = f.add({}, changed); await f.run(retry);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'changed'); assert.deepEqual(read(retry.receipt).argv, changed);
});

test('completed status keeps the admitted spec and group after inbox edits', async t => {
  const f = fixture(t), argv = node("console.log('admitted')"), job = f.add({ group: 'admitted-group' }, argv);
  await f.run(job);
  const retirementHint = read(path.join(f.org, 'retirement/request.json'));
  assert.equal(retirementHint.key, `verify:${job.job}`);
  assert.equal(retirementHint.source, `verify job ${job.job} completion`);
  f.queue.inbox.transaction(data => { Object.assign(data.jobs[0], { argv: node("console.log('edited')"), group: 'edited-group' }); });
  const current = (await f.cli(['status', job.job])).jobs[0];
  assert.equal(current.state, 'pass'); assert.deepEqual(current.argv, argv);
  assert.equal(current.spec_sha256, job.spec_sha256); assert.equal(current.group, 'admitted-group');
  assert.deepEqual((await f.cli(['status', '--group', 'admitted-group'])).jobs.map(row => row.id), [job.job]);
  assert.deepEqual((await f.cli(['status', '--group', 'edited-group'])).jobs, []);
});

test('detached admission refuses edited specs even with forged queue digests; recorded spec files cannot change execution', async t => {
  const f = fixture(t, { proving: true }), marker = path.join(f.root, 'must-not-run'), order = path.join(f.root, 'order');
  const holder = await acquireTestSlot('admission mutation fixture', { lockPath: process.env.MONITOR_TEST_SLOT_PATH, waitSeconds: 0 });
  t.after(() => holder.release());
  const a = f.add({}, node(`require('fs').appendFileSync(${JSON.stringify(order)},'A')`)), b = f.add();
  await f.cli(['admit', a.job, b.job]);
  const directory = path.join(f.queue.directory, 'jobs', a.job), log = path.join(directory, 'execution.log');
  await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('TEST_SLOT_WAIT'), 'worker did not wait before mutation');
  const spec = read(path.join(directory, 'spec.json'));
  const malicious = node(`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`);
  fs.writeFileSync(path.join(directory, 'spec.json'), JSON.stringify({ ...spec, argv: malicious }));
  f.queue.transaction(data => {
    const edited = data.jobs.find(job => job.id === b.job);
    edited.argv = malicious;
    edited.prepare = malicious;
    edited.admission.spec_sha256 = data.runner.jobs[b.job] = jobDigest(edited);
  });
  holder.release();
  await until(() => !fs.existsSync(path.join(f.queue.directory, 'worker.lock')), 'refused worker did not stop');
  assert.match(f.queue.load().runner.error, /admitted spec digest differs/);
  assert.equal(read(a.receipt).outcome, 'pass');
  assert.equal(fs.readFileSync(order, 'utf8'), 'A');
  assert.equal(fs.existsSync(b.receipt), false); assert.equal(fs.existsSync(marker), false);
  assert.equal(status(f.queue, { id: b.job }).jobs[0].state, 'pending-admission');
  await f.cli(['recover']);
  assert.equal(f.queue.load().runner, null);
});

test('a detached worker ignores jobs injected with its active token and forged allowlist entries', async t => {
  const f = fixture(t, { proving: true }), marker = path.join(f.root, 'injected'), order = path.join(f.root, 'order');
  const holder = await acquireTestSlot('injection fixture', { lockPath: process.env.MONITOR_TEST_SLOT_PATH, waitSeconds: 0 });
  t.after(() => holder.release());
  const a = f.add({}, node(`require('fs').appendFileSync(${JSON.stringify(order)},'A')`));
  const b = f.add({}, node(`require('fs').appendFileSync(${JSON.stringify(order)},'B')`));
  await f.cli(['admit', a.job, b.job]);
  const log = path.join(f.queue.directory, 'jobs', a.job, 'execution.log');
  await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('TEST_SLOT_WAIT'), 'worker did not wait before injection');
  f.queue.transaction(data => {
    const injected = { ...data.jobs[1], id: 'injected-job', argv: node(`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`) };
    injected.admission = { ...injected.admission, spec_sha256: jobDigest(injected) };
    data.runner.jobs[injected.id] = injected.admission.spec_sha256;
    data.jobs.push(injected);
  });
  holder.release();
  await until(() => f.queue.load().runner === null, 'worker did not finish after injection');
  assert.equal(fs.readFileSync(order, 'utf8'), 'AB');
  assert.equal(fs.existsSync(marker), false);
  const injected = status(f.queue, { id: 'injected-job' }).jobs[0];
  assert.equal(injected.state, 'pending-admission'); assert.equal(fs.existsSync(injected.receipt), false);
});

test('admission snapshots only submission fields; drain and recover never read the writable inbox', async t => {
  const f = fixture(t, { proving: true }), order = path.join(f.root, 'order'), injected = path.join(f.root, 'injected');
  const a = f.add({}, node(`require('fs').appendFileSync(${JSON.stringify(order)},'A')`));
  const b = f.add({}, node(`require('fs').appendFileSync(${JSON.stringify(order)},'B')`));
  f.queue.inbox.transaction(data => Object.assign(data.jobs[0], { admission: { token: 'forged' }, started_at: 'forged', completed_at: 'forged', receipt_sha256: '0'.repeat(64), outcome: 'pass' }));
  const holder = await acquireTestSlot('untrusted inbox fixture', { lockPath: process.env.MONITOR_TEST_SLOT_PATH, waitSeconds: 0 });
  t.after(() => holder.release());
  await f.cli(['admit', b.job, a.job, '--untrusted-root', path.join(f.storeRoot, 'unused-worker-root')]);
  const log = path.join(f.queue.directory, 'jobs', a.job, 'execution.log');
  await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('TEST_SLOT_WAIT'), 'worker did not wait for inbox edit');
  const argv = read(path.join(f.queue.directory, 'worker.lock/owner.json')).argv;
  assert.ok(argv.includes('--untrusted-root')); assert.ok(argv.includes(path.join(f.storeRoot, 'unused-worker-root')));
  assert.equal(f.queue.load().jobs[0].completed_at, undefined);
  assert.equal(f.queue.load().jobs[0].receipt_sha256, undefined);
  assert.notEqual(f.queue.load().jobs[0].admission.token, 'forged');
  const trusted = fs.readFileSync(path.join(f.queue.directory, 'queue.json'));
  f.queue.inbox.transaction(data => {
    data.jobs[1].argv = node(`require('fs').writeFileSync(${JSON.stringify(injected)},'bad')`);
    data.jobs.push({ ...data.jobs[1], id: 'injected', admission: f.queue.load().jobs[1].admission });
  });
  const planted = path.join(f.queue.inbox.directory, 'jobs', b.job, 'receipt.json');
  fs.mkdirSync(path.dirname(planted), { recursive: true }); writeReceipt(planted, { schema: 'verify-receipt/v1', job: b.job, outcome: 'pass' });
  assert.deepEqual(fs.readFileSync(path.join(f.queue.directory, 'queue.json')), trusted, 'inbox edits cannot alter trusted rows');
  fs.writeFileSync(path.join(f.queue.inbox.directory, 'inbox.json'), 'invalid JSON');
  holder.release(); await until(() => f.queue.load().runner === null, 'worker read the corrupted inbox');
  assert.equal(fs.readFileSync(order, 'utf8'), 'AB'); assert.equal(fs.existsSync(injected), false);
  assert.deepEqual((await f.cli(['recover'])).delivered, [a.job, b.job]);
  assert.equal(loadEvents(f.org).events.filter(event => event.type === 'note.added').length, 2);
  assert.equal(snapshot(path.join(f.org, 'supervisor/inbox.log')).length, 2);
});

function plantReceipt(f, submitted) {
  const job = f.queue.load().jobs.find(job => job.id === submitted.job) ?? f.queue.inbox.load().jobs.find(job => job.id === submitted.job);
  fs.mkdirSync(path.dirname(submitted.receipt), { recursive: true });
  writeReceipt(submitted.receipt, { schema: 'verify-receipt/v1', job: job.id, admitted_spec_sha256: jobDigest(job),
    admitted_at: job.admission?.admitted_at ?? 'forged', admitted_by: job.admission?.admitted_by ?? 'forged', outcome: 'pass' });
  return fs.readFileSync(submitted.receipt);
}
function assertUndelivered(f, job) {
  assert.equal(loadEvents(f.org).events.some(event => event.type === 'note.added' && event.text.includes(`job=${job.job} `)), false);
  assert.equal(snapshot(path.join(f.org, 'supervisor/inbox.log')).some(notice => JSON.stringify(notice).includes(`job=${job.job} `)), false);
  assert.equal(f.queue.load().jobs.find(row => row.id === job.job)?.completed_at, undefined);
  assert.equal(f.queue.load().jobs.find(row => row.id === job.job)?.receipt_sha256, undefined);
}

test('a forged pass receipt for a never-admitted pending job is unverified and never delivered', async t => {
  const f = fixture(t), marker = path.join(f.root, 'never-ran');
  const job = f.add({}, node(`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`));
  const bytes = plantReceipt(f, job), recovered = await f.cli(['recover']);
  assert.deepEqual(recovered.delivered, []); assert.deepEqual(recovered.unverified.map(row => row.job), [job.job]);
  assert.match(recovered.unverified[0].error, /no admitted trusted job/);
  assertUndelivered(f, job); assert.equal(status(f.queue, { id: job.job }).jobs[0].state, 'pending-admission');
  assert.deepEqual(fs.readFileSync(job.receipt), bytes); assert.equal(fs.existsSync(marker), false);
  assert.throws(() => admitJobs(f.queue, [job.job]), /already has a receipt/);
});

test('a forged pass receipt for an admitted queued job halts the worker with runner.error', async t => {
  const f = fixture(t, { proving: true }), marker = path.join(f.root, 'never-ran');
  const holder = await acquireTestSlot('queued forgery fixture', { lockPath: process.env.MONITOR_TEST_SLOT_PATH, waitSeconds: 0 });
  t.after(() => holder.release());
  const a = f.add(), b = f.add({}, node(`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`));
  await f.cli(['admit', a.job, b.job]);
  const log = path.join(f.queue.directory, 'jobs', a.job, 'execution.log');
  await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('TEST_SLOT_WAIT'), 'worker did not wait before forgery');
  const bytes = plantReceipt(f, b);
  holder.release(); await until(() => !fs.existsSync(path.join(f.queue.directory, 'worker.lock')), 'worker did not refuse queued receipt');
  assert.match(f.queue.load().runner.error, /receipt already exists.*this worker did not write it/);
  assert.equal(f.queue.load().jobs[1].started_at, undefined); assertUndelivered(f, b);
  const recovered = await f.cli(['recover']);
  assert.deepEqual(recovered.delivered, [a.job]); assert.deepEqual(recovered.unverified.map(row => row.job), [b.job]);
  assert.deepEqual(recovered.pending_admission, [b.job]); assertUndelivered(f, b);
  assert.equal(fs.existsSync(marker), false); assert.deepEqual(fs.readFileSync(b.receipt), bytes);
});

test('a forged pass receipt during execution fails exclusive publication and recovery requires a new retry job', async t => {
  const f = fixture(t), started = path.join(f.root, 'started'), finish = path.join(f.root, 'finish');
  const job = f.add({}, node(`const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},'1');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)}))clearInterval(timer)},25);`));
  const running = drain(f.queue, admitJobs(f.queue, [job.job]), { notify: f.notify });
  const rejected = assert.rejects(running, { code: 'EEXIST' });
  let bytes;
  try {
    await until(() => fs.existsSync(started), 'command did not start before forgery');
    bytes = plantReceipt(f, job);
  } finally { fs.writeFileSync(finish, 'done'); }
  await rejected;
  assert.match(f.queue.load().runner.error, /EEXIST/); assertUndelivered(f, job);
  const recovered = await f.cli(['recover']);
  assert.deepEqual(recovered.delivered, []); assert.deepEqual(recovered.unverified.map(row => row.job), [job.job]);
  assert.deepEqual(recovered.needs_retry, [job.job]); assertUndelivered(f, job);
  assert.equal(status(f.queue, { id: job.job }).jobs[0].state, 'needs-retry');
  assert.deepEqual(fs.readFileSync(job.receipt), bytes); assert.equal(fs.readFileSync(started, 'utf8'), '1');
});

for (const changed of ['receipt bytes', 'admission', 'started job']) test(`recovery refuses a runner receipt after its ${changed} no longer matches publication`, async t => {
  const f = fixture(t), job = f.add();
  await assert.rejects(drain(f.queue, admitJobs(f.queue, [job.job]), { notify: async () => { throw Error('delivery unavailable'); } }), /delivery unavailable/);
  const before = loadEvents(f.org).events;
  assert.equal(f.queue.load().jobs[0].receipt_sha256, sha256(fs.readFileSync(job.receipt)));
  if (changed === 'receipt bytes') fs.appendFileSync(job.receipt, ' ');
  else f.queue.transaction(data => {
    if (changed === 'admission') data.jobs[0].admission.admitted_by = 'other';
    else delete data.jobs[0].started_at;
  });
  const recovered = await f.cli(['recover']);
  assert.deepEqual(recovered.delivered, []); assert.deepEqual(recovered.unverified.map(row => row.job), [job.job]);
  assert.deepEqual(loadEvents(f.org).events, before); assert.equal(snapshot(path.join(f.org, 'supervisor/inbox.log')).length, 0);
  assert.equal(f.queue.load().jobs[0].completed_at, undefined);
});

test('every admitted immutable field is bound before a worker can create its execution directory', async t => {
  const f = fixture(t), a = f.add(), original = f.queue.inbox.load().jobs[0];
  const changes = { repo: f.root, identity: f.root, org: f.root, item: 'ENG-2', submitter: 'other', submitted_at: 'other',
    sha: f.sha2, tree: '0'.repeat(40), group: 'other', desk: f.root, desk_name: 'other', argv: node('process.exit(1)'),
    prepare: node('process.exit(1)'), expectations: [], timeout_seconds: 1, idle_timeout_seconds: 1,
    wait_seconds: 1, label: 'other', to: 'other', herdr: '/other' };
  for (const [field, value] of Object.entries(changes)) {
    const admission = admitJobs(f.queue, [a.job]);
    f.queue.transaction(data => { data.jobs[0][field] = value; });
    await assert.rejects(drain(f.queue, admission, { notify: f.notify }), /admitted spec digest differs/, field);
    assert.equal(fs.existsSync(path.join(f.queue.directory, 'jobs', a.job)), false, field);
    f.queue.transaction(data => { data.jobs[0][field] = original[field]; });
    await recover(f.queue, { notify: f.notify });
  }
});

for (const boundary of ['record', 'notice']) test(`${boundary} delivery failure preserves its receipt, returns unstarted jobs and recovers without execution`, async t => {
  const f = fixture(t), count = path.join(f.root, 'executions'), events = path.join(f.org, 'events.jsonl'), saved = path.join(f.org, 'saved-events');
  const script = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(count)},'1');` +
    (boundary === 'record' ? `fs.renameSync(${JSON.stringify(events)},${JSON.stringify(saved)});` : '');
  const a = f.add({}, node(script)), b = f.add(), c = f.add();
  const admission = admitJobs(f.queue, [a.job, b.job, c.job]);
  await assert.rejects(drain(f.queue, admission, { notify: async (...args) => { await f.notify(...args); throw Error('lost notice acknowledgement'); } }),
    boundary === 'record' ? /ENOENT/ : /lost notice acknowledgement/);
  assert.ok(f.queue.load().runner.error);
  assert.equal(fs.existsSync(path.join(f.queue.directory, 'worker.lock')), false);
  for (const job of [b, c]) assert.equal(status(f.queue, { id: job.job }).jobs[0].state, 'pending-admission');
  const bytes = fs.readFileSync(a.receipt);
  assert.equal(f.queue.load().jobs[0].receipt_sha256, sha256(bytes), 'publication is recorded before delivery');
  if (boundary === 'record') fs.renameSync(saved, events);
  await assert.rejects(recover(f.queue, { notify: async () => { throw Error('still unavailable'); } }), /still unavailable/);
  assert.match(f.queue.load().runner.error, /still unavailable/);
  const recovered = await f.cli(['recover']);
  assert.deepEqual(recovered.delivered, [a.job]);
  assert.deepEqual(recovered.pending_admission, [b.job, c.job]);
  assert.deepEqual(recovered.needs_retry, []);
  assert.equal(f.queue.load().runner, null); assert.match(f.queue.load().last_runner.error, /still unavailable/);
  await f.cli(['recover']);
  assert.equal(fs.readFileSync(count, 'utf8'), '1'); assert.deepEqual(fs.readFileSync(a.receipt), bytes);
  assert.equal(loadEvents(f.org).events.filter(event => event.type === 'note.added').length, 1);
  assert.equal(snapshot(path.join(f.org, 'supervisor/inbox.log')).length, 1);
  assert.throws(() => admitJobs(f.queue, [a.job]), /already has a receipt/);
  await f.run(b, c);
});

test('recovery refuses an existing worker lock and marks an interrupted job for a new retry job', async t => {
  const f = fixture(t), marker = path.join(f.root, 'must-not-replay');
  const a = f.add({}, node(`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`)), b = f.add(), c = f.add();
  const admission = admitJobs(f.queue, [a.job, b.job, c.job]);
  f.queue.transaction(data => { data.jobs[0].started_at = new Date().toISOString(); });
  const release = acquireLock(path.join(f.queue.directory, 'worker.lock'));
  try {
    const before = f.queue.load();
    await assert.rejects(recover(f.queue, { notify: f.notify }), /locked:/);
    assert.deepEqual(f.queue.load(), before);
  } finally { release(); }
  await assert.rejects(drain(f.queue, admission, { notify: f.notify }), /interrupted job/);
  assert.match(f.queue.load().runner.error, /interrupted job/);
  const recovered = await f.cli(['recover']);
  assert.deepEqual(recovered.needs_retry, [a.job]);
  assert.deepEqual(recovered.pending_admission, [b.job, c.job]);
  assert.equal(status(f.queue, { id: a.job }).jobs[0].state, 'needs-retry');
  assert.throws(() => admitJobs(f.queue, [a.job]), /retry as a new job/);
  assert.equal(fs.existsSync(a.receipt), false); assert.equal(fs.existsSync(marker), false);
  const retry = f.add(); await f.run(retry, b, c);
  assert.equal(read(retry.receipt).outcome, 'pass');
});

test('a log hashing error is recoverable bookkeeping but an executed job never replays without a receipt', async t => {
  const f = fixture(t), count = path.join(f.root, 'executions');
  const a = f.add(), b = f.add();
  const log = path.join(f.queue.directory, 'jobs', a.job, 'execution.log');
  f.queue.inbox.transaction(data => { data.jobs[0].argv = node(`const fs=require('fs');fs.appendFileSync(${JSON.stringify(count)},'1');fs.unlinkSync(${JSON.stringify(log)});fs.mkdirSync(${JSON.stringify(log)});`); });
  await assert.rejects(f.run(a, b), /EISDIR/);
  assert.match(f.queue.load().runner.error, /EISDIR/);
  assert.equal(status(f.queue, { id: b.job }).jobs[0].state, 'pending-admission');
  const recovered = await f.cli(['recover']);
  assert.deepEqual(recovered.needs_retry, [a.job]);
  assert.equal(f.queue.load().runner, null); assert.equal(fs.readFileSync(count, 'utf8'), '1');
  assert.throws(() => admitJobs(f.queue, [a.job]), /retry as a new job/);
  assert.equal(fs.existsSync(a.receipt), false);
});

test('a desk edited during a busy slot wait is refused at grant and its edits are preserved', async t => {
  const f = fixture(t, { proving: true }), holder = await acquireTestSlot('busy grant fixture', { lockPath: process.env.MONITOR_TEST_SLOT_PATH, waitSeconds: 0 });
  t.after(() => holder.release());
  const marker = path.join(f.root, 'must-not-run'), job = f.add({}, node(`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`));
  await f.cli(['admit', job.job]);
  const log = path.join(f.queue.directory, 'jobs', job.job, 'execution.log');
  await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('TEST_SLOT_WAIT'), 'job did not reach slot wait');
  const desk = f.queue.load().jobs[0].desk; fs.writeFileSync(path.join(desk, 'version'), 'edited during wait');
  holder.release(); await until(() => f.queue.load().runner === null, 'refused worker did not finish');
  assert.match(read(job.receipt).error, /desk is dirty at slot grant/);
  assert.equal(fs.readFileSync(path.join(desk, 'version'), 'utf8'), 'edited during wait');
  assert.equal(fs.existsSync(marker), false);
});

test('prepare and command share the slot; receipts bind prior SHA with and without prepare and preserve ignored caches', async t => {
  const f = fixture(t, { proving: true }), slot = process.env.MONITOR_TEST_SLOT_PATH;
  const prepare = node(`const fs=require('fs');if(JSON.parse(fs.readFileSync(${JSON.stringify(slot)})).token!==process.env.MONITOR_TEST_SLOT_TOKEN)throw Error('no slot');fs.mkdirSync('cache',{recursive:true});fs.writeFileSync('cache/token',process.env.MONITOR_TEST_SLOT_TOKEN);`);
  const a = f.add({}, node("const fs=require('fs');if(fs.readFileSync('cache/token','utf8')!==process.env.MONITOR_TEST_SLOT_TOKEN)throw Error('different slot');console.log(fs.readFileSync('version','utf8'));"), prepare);
  await f.run(a);
  const first = read(a.receipt);
  assert.equal(first.outcome, 'pass', first.error); assert.equal(first.desk_previous_sha, f.sha1);
  assert.deepEqual(first.prepare.argv, prepare); assert.equal(first.prepare.exit, 0); assert.ok(first.prepare.duration_s > 0);
  assert.ok(first.prepare.started_at >= first.granted_at); assert.ok(first.prepare.finished_at <= first.command.started_at);
  const cache = fs.readFileSync(path.join(first.desk, 'cache/token'), 'utf8');
  const b = f.add({ sha: f.sha2 }, node("if(require('fs').readFileSync('version','utf8')!=='two')throw Error('wrong sha')"));
  await f.run(b);
  const second = read(b.receipt);
  assert.equal(second.outcome, 'pass', second.error); assert.equal(second.desk_previous_sha, f.sha1); assert.equal(second.prepare, 'none');
  assert.equal(f.git('rev-parse', 'HEAD'), f.sha2, 'submitter checkout is untouched');
  assert.equal(fs.readFileSync(path.join(first.desk, 'cache/token'), 'utf8'), cache);
  assert.equal(execFileSync('git', ['-C', first.desk, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), f.sha1);
});

test('two named desks keep independent previous SHAs and prepared state in A, B, A order', async t => {
  const f = fixture(t);
  const a = f.add({ desk: 'A' }, node("require('fs').mkdirSync('cache');require('fs').writeFileSync('cache/prepared','A')"));
  const b = f.add({ desk: 'B', sha: f.sha2 }, node("require('fs').mkdirSync('cache');require('fs').writeFileSync('cache/prepared','B')"));
  const again = f.add({ desk: 'A' }, node("if(require('fs').readFileSync('cache/prepared','utf8')!=='A')throw Error('A lost its state')"));
  await f.run(a, b, again);
  const ra = read(a.receipt), rb = read(b.receipt), rc = read(again.receipt);
  assert.equal(ra.outcome, 'pass'); assert.equal(rb.outcome, 'pass'); assert.equal(rc.outcome, 'pass');
  assert.notEqual(ra.desk, rb.desk); assert.equal(rc.desk, ra.desk);
  assert.equal(rc.desk_previous_sha, f.sha1); assert.equal(rb.desk_previous_sha, f.sha2);
  assert.equal(fs.readFileSync(path.join(rb.desk, 'cache/prepared'), 'utf8'), 'B');
  assert.throws(() => f.add({ desk: path.join(ra.desk, 'nested') }), /desk must be outside/);
});

test('groups pin SHA and tree across completion and status lists individual group receipts', async t => {
  const f = fixture(t), a = f.add({ group: 'run-1' });
  assert.throws(() => f.add({ group: 'run-1', sha: f.sha2 }), /group run-1 is fixed at sha/);
  const b = f.add({ group: 'run-1' }), other = f.add({ group: 'other', sha: f.sha2 });
  await f.run(a, b, other);
  assert.throws(() => f.add({ group: 'run-1', sha: f.sha2 }), /fixed/);
  const rows = status(f.queue, { group: 'run-1' });
  assert.deepEqual(rows.jobs.map(job => job.receipt), [a.receipt, b.receipt]);
  assert.equal('outcome' in rows, false);
  // A corrupted/stale tree binding cannot be silently accepted either.
  f.queue.inbox.transaction(data => { data.jobs[0].tree = '0'.repeat(40); });
  assert.throws(() => f.add({ group: 'run-1' }), /fixed/);
});

test('dirty runner desks refuse without discarding edits or running the next job; arbitrary existing desks are refused', async t => {
  const f = fixture(t), a = f.add(); await f.run(a);
  const desk = read(a.receipt).desk; fs.writeFileSync(path.join(desk, 'version'), 'preserve me');
  const marker = path.join(f.root, 'unsafe');
  const b = f.add(), c = f.add({}, node(`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`));
  await f.run(b, c);
  assert.equal(read(b.receipt).outcome, 'error'); assert.match(read(b.receipt).error, /desk is dirty/);
  assert.equal(fs.readFileSync(path.join(desk, 'version'), 'utf8'), 'preserve me');
  assert.equal(fs.existsSync(c.receipt), false); assert.equal(fs.existsSync(marker), false);
  assert.equal(status(f.queue, { id: c.job }).jobs[0].state, 'pending-admission');
  const existingPath = path.join(f.storeRoot, 'existing-desk'); fs.mkdirSync(existingPath);
  const existing = f.add({ desk: existingPath });
  await f.run(existing);
  assert.match(read(existing.receipt).error, /not created by this runner/);
});

test('an absolute desk is created by the runner and a mismatching checked-out tree refuses execution', async t => {
  const f = fixture(t), a = f.add({ desk: path.join(f.storeRoot, 'absolute-desk') });
  await f.run(a); assert.equal(read(a.receipt).outcome, 'pass');
  const b = f.add(); f.queue.inbox.transaction(data => { data.jobs.find(job => job.id === b.job).tree = '0'.repeat(40); });
  await f.run(b); assert.match(read(b.receipt).error, /tree differs/);
});

test('absolute desks under system temp, the repository and configured write roots refuse at submit and admit', t => {
  const f = fixture(t);
  for (const desk of [path.join(os.tmpdir(), 'verify-refused-desk'), path.join(f.repo, 'desk'), path.join(f.repo, '.git/desk'), path.join(f.org, 'desk')]) {
    assert.throws(() => f.add({ desk }), /desk must be outside/);
    assert.equal(fs.existsSync(desk), false);
  }
  const alias = path.join(f.storeRoot, 'desk-alias'); fs.symlinkSync(f.repo, alias);
  assert.throws(() => f.add({ desk: path.join(alias, 'desk') }), /desk must be outside/);
  const workers = path.join(f.storeRoot, 'workers'), guarded = queueFor(f.repo, f.queue.directory, { untrustedRoots: [workers] });
  assert.throws(() => submit(guarded, { org: f.org, item: 'ENG-1', sha: f.sha1, desk: path.join(workers, 'desk') }, node('')), /desk must be outside/);
  const job = f.add();
  f.queue.inbox.transaction(data => { data.jobs[0].desk = path.join(f.root, 'admission-desk'); });
  assert.throws(() => admitJobs(f.queue, [job.job]), /desk must be outside/);
  assert.equal(fs.existsSync(f.queue.directory), false);
});

test('deskFor rechecks isolation before execution and preserves named persistent desks', async t => {
  const f = fixture(t), desk = path.join(f.storeRoot, 'newly-untrusted-desk'), marker = path.join(f.root, 'must-not-run');
  const job = f.add({ desk }, node(`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`));
  const admission = admitJobs(f.queue, [job.job]);
  const guarded = queueFor(f.repo, f.queue.directory, { untrustedRoots: [desk] });
  await drain(guarded, admission, { notify: f.notify });
  assert.match(read(job.receipt).error, /desk must be outside/); assert.equal(read(job.receipt).outcome, 'error');
  assert.equal(fs.existsSync(desk), false); assert.equal(fs.existsSync(marker), false);
  const first = f.add({ desk: 'persistent' }), second = f.add({ desk: 'persistent' });
  await f.run(first); await f.run(second);
  assert.equal(read(second.receipt).outcome, 'pass'); assert.equal(read(first.receipt).desk, read(second.receipt).desk);
});

test('a desk that remains dirty after restoration halts the batch and preserves the leftover', async t => {
  const f = fixture(t), job = f.add({}, node("require('fs').mkdirSync('nested');require('child_process').execFileSync('git',['init','-q','nested']);")), next = f.add();
  await f.run(job, next); const receipt = read(job.receipt);
  assert.equal(receipt.outcome, 'error'); assert.match(receipt.restore_error, /desk is dirty/);
  assert.equal(fs.existsSync(path.join(receipt.desk, 'nested/.git')), true);
  assert.equal(fs.existsSync(next.receipt), false);
});

test('public submit --admit parses prepare argv, detaches and exposes individual group receipts', async t => {
  const f = fixture(t);
  const result = await waitForExit(spawnChild(t, process.execPath, [CLI, 'submit', '--admit', '--repo', f.repo, '--state-dir', f.queue.directory,
    '--org', f.org, '--item', 'ENG-1', '--sha', f.sha1, '--group', 'public', '--herdr', f.fake,
    '--prepare', ...node("require('fs').mkdirSync('cache');require('fs').writeFileSync('cache/ready','yes')"), '--', ...node("if(require('fs').readFileSync('cache/ready','utf8')!=='yes')process.exit(1)")]));
  assert.equal(result.code, 0, result.stderr);
  const job = JSON.parse(result.stdout); await until(() => f.queue.load().runner === null, 'submitted worker did not finish');
  assert.equal(read(job.receipt).outcome, 'pass');
  const grouped = await f.cli(['status', '--group', 'public']);
  assert.deepEqual(grouped.jobs.map(row => row.receipt), [job.receipt]);
});

test('prepare failure produces error, records its exit and never runs the command', async t => {
  const f = fixture(t), marker = path.join(f.root, 'ran');
  const job = f.add({}, node(`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`), node('process.exit(7)'));
  await f.run(job); const receipt = read(job.receipt);
  assert.equal(receipt.outcome, 'error'); assert.equal(receipt.prepare.exit, 7);
  assert.ok(receipt.prepare.duration_s > 0); assert.equal(receipt.desk_previous_sha, f.sha1);
  assert.equal(fs.existsSync(marker), false); assert.equal(receipt.desk_restored, true);
});

test('TAP, Vitest, named test, exit, artifact and JSON expectations record actual values and mismatches', async t => {
  const f = fixture(t), payload = 'artifact';
  const job = f.add({ expect: ['exit=3'], 'expect-tap': ['pass>=1,fail=0,skip=1'], 'expect-vitest': ['pass=2,fail=0,skip=1'],
    'expect-test': ['named TAP test', 'suite > named Vitest test'], 'expect-file': [`out=${sha256(payload)}`],
    'expect-json': ['result.json#/a~1b/0={"x":true,"y":2}'] }, node(String.raw`const fs=require('fs');fs.writeFileSync('out',${JSON.stringify(payload)});fs.writeFileSync('result.json',JSON.stringify({'a/b':[{y:2,x:true}]}));console.log('ok 1 - named TAP test\nok 2 - skipped # SKIP\n# pass 1\n# fail 0\n# skipped 1\n ✓ suite > named Vitest test 4ms\n Tests  2 passed | 1 skipped (3)');process.exit(3)`));
  await f.run(job); const receipt = read(job.receipt);
  assert.equal(receipt.outcome, 'pass', JSON.stringify(receipt));
  assert.ok(receipt.expectations.every(row => row.passed));
  assert.deepEqual(receipt.totals.tap, { pass: 1, fail: 0, skip: 1 });
  const missing = f.add({ 'expect-tap': ['pass=0'], 'expect-test': ['missing'], 'expect-file': [`absent=${sha256('no')}`], 'expect-json': ['absent.json#/x=true'] });
  await f.run(missing); const failures = read(missing.receipt);
  assert.equal(failures.outcome, 'fail'); assert.equal(failures.expectations.filter(row => !row.passed).length, 4);
  assert.equal(fs.existsSync(path.join(receipt.desk, 'out')), false, 'generated artifacts cleaned after evaluation');
});

test('prepare output cannot satisfy named tests or totals; paths cannot escape the desk and missing JSON differs from null', async t => {
  const f = fixture(t), job = f.add({ 'expect-tap': ['pass=1'], 'expect-test': ['prepare title'] }, node("console.log('command')"), node(String.raw`console.log('ok 1 - prepare title\n# pass 1\n# fail 0\n# skipped 0')`));
  await f.run(job); assert.equal(read(job.receipt).outcome, 'fail');
  assert.throws(() => parseExpectations({ 'expect-file': [`../secret=${'a'.repeat(64)}`] }), /relative/);
  const desk = read(job.receipt).desk, log = path.join(f.root, 'empty'); fs.writeFileSync(log, '');
  fs.symlinkSync('/etc/hosts', path.join(desk, 'link'));
  fs.writeFileSync(path.join(desk, 'result.json'), '{"x":null}');
  const checked = await evaluate(parseExpectations({ 'expect-file': [`link=${'a'.repeat(64)}`], 'expect-json': ['result.json#/absent=null'] }), { desk, exit: 0, signal: null, log });
  assert.equal(checked.expectations[1].passed, false); assert.match(checked.expectations[1].error, /outside/);
  assert.equal(checked.expectations[2].passed, false); assert.match(checked.expectations[2].error, /absent/);
});

test('receipts use exclusive create and completed jobs cannot be admitted or executed twice', async t => {
  const f = fixture(t), a = f.add(); await f.run(a);
  const before = fs.readFileSync(a.receipt);
  assert.throws(() => writeReceipt(a.receipt, { outcome: 'different' }), { code: 'EEXIST' });
  assert.deepEqual(fs.readFileSync(a.receipt), before);
  assert.throws(() => admitJobs(f.queue, [a.job]), /already has a receipt/);
  const retry = f.add(); assert.notEqual(retry.job, a.job); assert.notEqual(retry.receipt, a.receipt);
});

for (const kind of ['wall', 'idle']) test(`a verification job passes its legacy ${kind} cap, restores its desk and never retries`, async t => {
  const f = fixture(t), job = f.add({ 'timeout-seconds': '.05', 'idle-timeout-seconds': kind === 'idle' ? '.05' : '0' },
    node(kind === 'idle' ? 'setTimeout(()=>{},250)' : 'const progress=setInterval(()=>console.log("working"),20);setTimeout(()=>clearInterval(progress),250)'));
  await f.run(job); const receipt = read(job.receipt);
  assert.equal(receipt.outcome, 'pass', receipt.error); assert.equal(receipt.timeout, null);
  assert.equal(receipt.slot_execution.limits.wall_seconds, 0);
  assert.equal(receipt.slot_execution.limits.wall_source, 'watch');
  assert.ok(receipt.command.duration_s >= .25, 'the payload exceeds the legacy cap');
  assert.equal(receipt.slot_execution.attempts, 1); assert.equal(receipt.desk_restored, true);
  assert.equal(fs.existsSync(process.env.MONITOR_TEST_SLOT_PATH), false);
});

// Explicit cancellation exercises the same final capture and cleanup as the
// last-resort stop, without restoring a wall or silence cap for working jobs.
async function cancelJob(f, job, ready, afterSignal = async () => {}) {
  const running = f.run(job), result = path.join(path.dirname(job.receipt), 'job-result.json');
  const wait = (condition, message) => until(condition, message, running,
    () => fs.existsSync(job.receipt) ? `; ${JSON.stringify(read(job.receipt))}` : '; no final receipt');
  await wait(() => fs.existsSync(result) && ready(), 'job did not reach its cancellation boundary');
  const phase = lookupProcess(read(result).command_pid);
  assert.ok(phase.ok && phase.value?.command.includes(job.job), 'the admitted phase is still owned');
  const coordinator = registerProcess(phase.value.ppid);
  assert.ok(coordinator.command.includes('verify/execute.mjs --hold') && coordinator.command.includes(job.job));
  assert.equal(killProcess(coordinator, 'SIGTERM').signaled, true);
  await afterSignal(phase.value, wait);
  await running;
}

test('a captured descendant completes naturally before the host slot is released', async t => {
  const f = fixture(t, { proving: true }), pids = path.join(f.root, 'escaped'), parent = path.join(f.root, 'parent');
  const parentExit = path.join(f.root, 'parent-exit'), release = path.join(f.root, 'release');
  const escaped = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pids)},String(process.pid));
    setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(0);},25);`;
  const job = f.add({}, node(`const fs=require('fs');require('child_process').spawn(process.execPath,
    ['-e',${JSON.stringify(escaped)}],{detached:true,stdio:'ignore'}).unref();
    fs.writeFileSync(${JSON.stringify(parent)},String(process.pid));
    setInterval(()=>{if(fs.existsSync(${JSON.stringify(parentExit)}))process.exit(0);},25);`));
  let finished = false;
  const running = f.run(job).then(() => { finished = true; });
  try {
    const phase = path.join(path.dirname(job.receipt), 'phases.json');
    await until(() => fs.existsSync(pids) && fs.existsSync(parent) && fs.existsSync(phase) &&
      read(phase).tracked.some(row => row.pid === Number(fs.readFileSync(pids))), 'escaped birth was not captured', running, () => fs.existsSync(job.receipt) ? `; ${JSON.stringify(read(job.receipt))}` : '; no final receipt');
    fs.writeFileSync(parentExit, 'complete');
    await until(() => lookupProcess(Number(fs.readFileSync(parent)), { identityOnly: true }).value === null, 'parent did not complete', running, () => fs.existsSync(job.receipt) ? `; ${JSON.stringify(read(job.receipt))}` : '; no final receipt');
    assert.equal(finished, false); assert.ok(fs.existsSync(process.env.MONITOR_TEST_SLOT_PATH));
    assert.ok(lookupProcess(Number(fs.readFileSync(pids)), { identityOnly: true }).value);
  } finally {
    fs.writeFileSync(parentExit, 'complete'); fs.writeFileSync(release, 'complete'); await running;
  }
  const receipt = read(job.receipt), pid = Number(fs.readFileSync(pids));
  assert.equal(receipt.outcome, 'pass', receipt.error);
  assert.equal(receipt.reaped_processes.some(row => row.pid === pid && row.signal), false, 'natural completion selects no signal');
  const live = lookupProcess(pid, { identityOnly: true }); assert.equal(live.ok, true); assert.ok(!live.value || /^Z/.test(live.value.state));
  assert.equal(fs.existsSync(process.env.MONITOR_TEST_SLOT_PATH), false);
});

test('cancellation records and reaps a captured escaped descendant before releasing the host slot', async t => {
  const f = fixture(t), pids = path.join(f.root, 'timed-escape');
  const escaped = `require('fs').writeFileSync(${JSON.stringify(pids)},String(process.pid));setInterval(()=>{},1000);`;
  const job = f.add({ 'timeout-seconds': '1', 'idle-timeout-seconds': '3' }, node(`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(escaped)}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000);`));
  await cancelJob(f, job, () => fs.existsSync(pids)); const receipt = read(job.receipt), pid = Number(fs.readFileSync(pids));
  assert.equal(receipt.timeout, null); assert.equal(receipt.slot_execution.signal, 'SIGTERM');
  assert.ok(receipt.reaped_processes.some(row => row.pid === pid && row.identity));
  const captured = read(path.join(path.dirname(job.receipt), 'captured.json'));
  const recorded = receipt.reaped_processes.find(row => row.pid === pid);
  assert.ok(captured.some(row => row.pid === pid && row.identity === recorded.identity));
  const live = lookupProcess(pid, { identityOnly: true }); assert.equal(live.ok, true); assert.ok(!live.value || /^Z/.test(live.value.state));
  assert.equal(fs.existsSync(process.env.MONITOR_TEST_SLOT_PATH), false);
});

test('the final timeout walk publishes a newly observable escaped identity before any signal', async () => {
  const root = { pid: 100, ppid: 1, pgid: 100, state: 'S', identity: '1:1' };
  const escaped = { pid: 101, ppid: 100, pgid: 101, state: 'S', identity: '2:1' };
  // The phase's earlier poll has not seen this child. The final watchdog walk
  // must give the receipt owner its identity before destroying the parent tree.
  const rows = new Map([[root.pid, root], [escaped.pid, escaped]]), events = [];
  let published;
  await stopGateGroup(root.pid, { ownsGroup: false, tracked: new Map(),
    lookup: pid => ({ ok: true, value: pid === undefined ? new Map(rows) : rows.get(pid) ?? null }),
    onCapture: tracked => { published = tracked; events.push('capture'); },
    signal: pid => {
      assert.equal(published.get(pid).identity, rows.get(pid).identity);
      events.push(pid); rows.delete(pid);
    } });
  assert.deepEqual(events, ['capture', root.pid, escaped.pid]);
  assert.equal(published.get(escaped.pid).identity, escaped.identity);
});

test('cancellation captures an escaped descendant while its phase observer is stopped', async t => {
  const f = fixture(t), pids = path.join(f.root, 'paused-observer-escape');
  const job = f.add({ 'timeout-seconds': '1', 'idle-timeout-seconds': '3' }, node(`
    const fs=require('fs'), cp=require('child_process');
    const phase=process.ppid;
    if(phase<=1)throw Error('fixture phase parent is absent');
    process.kill(phase,'SIGSTOP');
    const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    child.unref();
    fs.writeFileSync(${JSON.stringify(pids + '.tmp')},String(child.pid));
    fs.renameSync(${JSON.stringify(pids + '.tmp')},${JSON.stringify(pids)});
    setInterval(()=>{},1000);
  `));
  await cancelJob(f, job, () => fs.existsSync(pids), async (phase, wait) => {
    const captured = path.join(path.dirname(job.receipt), 'captured.json');
    await wait(() => fs.existsSync(captured) && read(captured).some(row => row.pid === phase.pid && /^T/.test(row.state)), 'paused phase was not captured');
    const owner = registerProcess(phase.pid);
    assert.equal(owner.identity, phase.identity); assert.equal(owner.command, phase.command);
    assert.equal(killProcess(owner, 'SIGKILL').signaled, true, 'explicit fixture force follows the original cancellation/capture');
  });
  const receipt = read(job.receipt), pid = Number(fs.readFileSync(pids));
  assert.equal(receipt.timeout, null); assert.equal(receipt.slot_execution.signal, 'SIGTERM');
  assert.ok(receipt.reaped_processes.some(row => row.pid === pid && row.identity));
  const captured = read(path.join(path.dirname(job.receipt), 'captured.json'));
  assert.ok(captured.some(row => row.pid === receipt.slot_execution.command_pid && /^T/.test(row.state)));
  assert.ok(captured.some(row => row.pid === pid && row.identity === receipt.reaped_processes.find(row => row.pid === pid).identity));
  const live = lookupProcess(pid, { identityOnly: true }); assert.equal(live.ok, true); assert.ok(!live.value || /^Z/.test(live.value.state));
  assert.equal(fs.existsSync(process.env.MONITOR_TEST_SLOT_PATH), false);
});

test('a previously observed orphan retains the host hold after TERM until explicit owned force', async t => {
  const f = fixture(t, { proving: true }), pids = path.join(f.root, 'orphan'), seen = path.join(f.root, 'held-during-cleanup'), slot = process.env.MONITOR_TEST_SLOT_PATH;
  const leaf = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pids)},String(process.pid));process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(seen)},String(fs.existsSync(${JSON.stringify(slot)})))});setInterval(()=>{},1000);`;
  const middle = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,stdio:'ignore'}).unref();setTimeout(()=>{},500);`;
  const job = f.add({ 'timeout-seconds': '1.5', 'idle-timeout-seconds': '5' }, node(`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000);`));
  let forced;
  await cancelJob(f, job, () => {
    if (!fs.existsSync(pids)) return false;
    const pid = Number(fs.readFileSync(pids)), phase = path.join(path.dirname(job.receipt), 'phases.json');
    return fs.existsSync(phase) && read(phase).tracked.some(row => row.pid === pid) && lookupProcess(pid).value?.ppid === 1;
  }, async (_phase, wait) => {
    await wait(() => fs.existsSync(seen), 'the orphan did not handle the original TERM');
    assert.equal(fs.readFileSync(seen, 'utf8'), 'true'); assert.ok(fs.existsSync(slot));
    const pid = Number(fs.readFileSync(pids)), owner = registerProcess(pid);
    const saved = read(path.join(path.dirname(job.receipt), 'phases.json')).tracked.find(row => row.pid === pid);
    assert.equal(owner.identity, saved.identity);
    forced = killProcess(owner, 'SIGKILL'); assert.ok(forced.ok && forced.signaled);
  });
  const receipt = read(job.receipt), pid = Number(fs.readFileSync(pids));
  assert.equal(receipt.timeout, null); assert.equal(receipt.slot_execution.signal, 'SIGTERM'); assert.equal(fs.readFileSync(seen, 'utf8'), 'true');
  assert.ok(receipt.reaped_processes.some(row => row.pid === pid && row.signal === 'SIGTERM'));
  assert.ok(forced.ok && forced.signaled, 'the test requested force explicitly; no elapsed escalation is inferred');
  const live = lookupProcess(pid, { identityOnly: true }); assert.equal(live.ok, true); assert.ok(!live.value || /^Z/.test(live.value.state));
  assert.equal(fs.existsSync(slot), false);
});

test('large output drains completely before totals are parsed and private logs are hashed', async t => {
  const f = fixture(t), job = f.add({ 'expect-tap': ['pass=1,fail=0,skip=0'] }, node(String.raw`process.stdout.write('x'.repeat(256*1024)+'\n# pass 1\n# fail 0\n# skipped 0\n');`));
  await f.run(job); const receipt = read(job.receipt);
  assert.equal(receipt.outcome, 'pass');
  const log = receipt.logs.find(row => row.path.endsWith('/command.log'));
  assert.equal(fs.readFileSync(log.path, 'utf8').length, 256 * 1024 + '\n# pass 1\n# fail 0\n# skipped 0\n'.length);
  assert.equal(sha256(fs.readFileSync(log.path)), log.sha256);
});

test('distribution manifest and release guard include the queue and all runtime imports', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url)), files = productFiles(root);
  for (const file of ['verify/verify.mjs', 'verify/execute.mjs', 'verify/expectations.mjs', 'verify/README.md']) assert.ok(files.includes(file), file);
  assert.ok(!files.some(file => file.startsWith('verify/test/')));
  const release = fs.readFileSync(path.join(root, 'herdr/release.sh'), 'utf8');
  for (const file of ['verify/verify.mjs', 'verify/execute.mjs', 'verify/expectations.mjs']) assert.ok(release.includes(file));
});

// Inject the observer's process source, leaving confirmed births and cleanup
// lookups real. The command waits for the test so captures and failures can be
// ordered explicitly, including repeated failures after a later capture.
for (const kind of ['after-capture', 'before-capture', 'non-signal', 'wrong-birth', 'missing-time']) test(`tracking interruption ${kind} is bound to capture time and the runner's birth`, async t => {
  const f = fixture(t), directory = path.join(f.root, 'phase'); fs.mkdirSync(directory);
  const captured = path.join(directory, 'captured.json'), finish = path.join(directory, 'finish');
  const faults = path.join(directory, 'faults.json'), preload = path.join(directory, 'inject.mjs');
  const execute = fileURLToPath(new URL('../execute.mjs', import.meta.url));
  const error = kind === 'non-signal' ? 'process source unavailable: injected permission refusal' : 'process source unavailable: terminated by SIGTERM';
  fs.writeFileSync(preload, `
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { lookupProcess } from ${JSON.stringify(fileURLToPath(new URL('../../lib/processes.mjs', import.meta.url)))};
    if (process.argv[1] === ${JSON.stringify(execute)}) {
    const root = lookupProcess(process.pid, { identityOnly: true });
    if (!root.ok || !root.value) throw Error('fixture runner birth unconfirmed');
    const kind = ${JSON.stringify(kind)}, captured = ${JSON.stringify(captured)}, finish = ${JSON.stringify(finish)};
    if (kind !== 'before-capture') {
      const row = { ...root.value, captured_at: new Date().toISOString() };
      if (kind === 'wrong-birth') row.identity += ':replacement';
      if (kind === 'missing-time') delete row.captured_at;
      fs.writeFileSync(captured, JSON.stringify([row]), { mode: 0o600 });
    }
    const native = cp.spawnSync, list = fs.readdirSync;
    let count = 0;
    const fail = () => {
      if (fs.existsSync(finish)) return false;
      fs.writeFileSync(${JSON.stringify(faults + '.tmp')}, JSON.stringify({ count: ++count }));
      fs.renameSync(${JSON.stringify(faults + '.tmp')}, ${JSON.stringify(faults)});
      return true;
    };
    cp.spawnSync = (file, argv, ...args) => {
      if (String(file).includes('process-source-') && argv.every(arg => arg === '--identity') && fail())
        return ${kind === 'non-signal' ? "{ error: Error('injected permission refusal') }" : "{ signal: 'SIGTERM' }"};
      return native(file, argv, ...args);
    };
    fs.readdirSync = (file, ...args) => {
      if (String(file) === '/proc' && fail()) throw Error(${JSON.stringify(error.replace('process source unavailable: ', ''))});
      return list(file, ...args);
    };
    syncBuiltinESMExports();
    }
  `);
  const command = node(`const fs=require('fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)}))clearInterval(timer)},20);`);
  const child = spawnChild(t, process.execPath, [execute, JSON.stringify({ desk: f.root, argv: command }), directory],
    { env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}` } });
  const phases = path.join(directory, 'phases.json');
  await until(() => fs.existsSync(phases) && read(phases).tracking_error_at, 'first tracking failure persisted');
  const firstSeen = read(phases).tracking_error_at;
  assert.ok(Number.isFinite(Date.parse(firstSeen)));
  if (kind === 'before-capture') {
    while (Date.now() <= Date.parse(firstSeen)) await new Promise(resolve => setTimeout(resolve, 1));
    const root = lookupProcess(child.pid, { identityOnly: true });
    assert.equal(root.ok, true); assert.ok(root.value);
    fs.writeFileSync(captured, JSON.stringify([{ ...root.value, captured_at: new Date().toISOString() }]), { mode: 0o600 });
  }
  const count = read(faults).count;
  await until(() => read(faults).count > count, 'subsequent tracking failure observed');
  assert.equal(read(phases).tracking_error_at, firstSeen, 'later failures cannot replace the first time');
  fs.writeFileSync(finish, 'done');
  if (kind === 'after-capture') {
    const result = await waitForExit(child); assert.equal(result.code, 0, result.stderr);
    const state = read(phases), capture = read(captured)[0];
    assert.deepEqual(state.tracking_interrupted, { error, seen_at: firstSeen, captured_at: capture.captured_at });
    assert.ok(Date.parse(firstSeen) >= Date.parse(capture.captured_at));
    assert.equal(state.cleanup_error, undefined);
  } else {
    await until(() => read(phases).error === error, 'uncovered tracking failure retained the hold');
    const state = read(phases);
    assert.equal(state.cleanup_error, error); assert.equal(state.tracking_interrupted, undefined);
    assert.ok(state.command.finished_at); assert.equal(state.command.exit, 0);
    assert.equal(child.exitCode, null, 'runner remains alive instead of releasing unknown ownership');
    if (kind === 'before-capture') assert.ok(Date.parse(firstSeen) < Date.parse(read(captured)[0].captured_at));
    assert.equal(child.kill('SIGKILL'), true);
    assert.equal((await waitForExit(child)).signal, 'SIGKILL');
  }
});

test('a measurement interrupted after the watchdog capture includes its error and both times in the receipt', async t => {
  const f = fixture(t), preload = path.join(f.root, 'post-capture.mjs'), ready = path.join(f.root, 'measuring');
  const execute = fileURLToPath(new URL('../execute.mjs', import.meta.url));
  fs.writeFileSync(preload, `
    import fs from 'node:fs';
    import path from 'node:path';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    if (process.argv[1] === ${JSON.stringify(execute)} && process.argv[2] !== '--hold') {
      const captured = path.join(process.argv[3], 'captured.json');
      const native = cp.spawnSync, list = fs.readdirSync;
      let pending = true;
      const interrupted = () => {
        if (!pending) return false;
        pending = false;
        fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
        // Keep a source lookup in flight until the real, independent watchdog
        // has completed and preserved its walk. It then returns a signal error.
        while (!fs.existsSync(captured)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        return true;
      };
      cp.spawnSync = (file, argv, ...args) => {
        if (String(file).includes('process-source-') && argv.every(arg => arg === '--identity') && interrupted()) return { signal: 'SIGTERM' };
        return native(file, argv, ...args);
      };
      fs.readdirSync = (file, ...args) => {
        if (String(file) === '/proc' && interrupted()) throw Error('terminated by SIGTERM');
        return list(file, ...args);
      };
      syncBuiltinESMExports();
    }
  `);
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}`;
  const job = f.add({ 'timeout-seconds': '1', 'idle-timeout-seconds': '3' }, node('setInterval(()=>{},1000)'));
  await cancelJob(f, job, () => fs.existsSync(ready));
  const receipt = read(job.receipt), directory = path.dirname(job.receipt), phases = read(path.join(directory, 'phases.json'));
  const interrupted = receipt.tracking_interrupted;
  assert.ok(interrupted, receipt.error);
  assert.deepEqual(interrupted, phases.tracking_interrupted);
  assert.equal(interrupted.error, 'process source unavailable: terminated by SIGTERM');
  assert.equal(interrupted.seen_at, phases.tracking_error_at);
  assert.ok(Date.parse(interrupted.seen_at) >= Date.parse(interrupted.captured_at));
  assert.ok(read(path.join(directory, 'captured.json')).some(row => row.pid === receipt.slot_execution.command_pid && row.captured_at === interrupted.captured_at));
  assert.equal(phases.cleanup_error, undefined); assert.equal(phases.cleanup_confirmed, true);
  assert.equal(receipt.timeout, null); assert.equal(receipt.slot_execution.signal, 'SIGTERM');
  assert.equal(receipt.halted, false); assert.equal(receipt.desk_restored, true);
  assert.equal(fs.existsSync(process.env.MONITOR_TEST_SLOT_PATH), false);
});

test('cancellation records a captured descendant sharing the stopped phase runner group', async t => {
  const f = fixture(t), pids = path.join(f.root, 'shared-group-child');
  const job = f.add({ 'timeout-seconds': '1', 'idle-timeout-seconds': '3' }, node(`
    const fs=require('fs'), cp=require('child_process');
    if(process.ppid<=1)throw Error('fixture phase parent is absent');
    process.kill(process.ppid,'SIGSTOP');
    const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:false,stdio:'ignore'});
    child.unref();
    fs.writeFileSync(${JSON.stringify(pids + '.tmp')},String(child.pid));
    fs.renameSync(${JSON.stringify(pids + '.tmp')},${JSON.stringify(pids)});
    setInterval(()=>{},1000);
  `));
  await cancelJob(f, job, () => fs.existsSync(pids));
  const receipt = read(job.receipt), pid = Number(fs.readFileSync(pids)), directory = path.dirname(job.receipt);
  const phases = read(path.join(directory, 'phases.json')), captured = read(path.join(directory, 'captured.json'));
  const saved = captured.find(row => row.pid === pid);
  assert.equal(receipt.timeout, null); assert.equal(receipt.slot_execution.signal, 'SIGTERM');
  assert.ok(saved?.identity, 'watchdog captured the child birth');
  assert.equal(saved.pgid, phases.pgid, 'child shares the phase group');
  assert.notEqual(saved.pid, saved.pgid, 'child is not the group leader');
  assert.notEqual(receipt.slot_execution.command_pid, phases.pgid, 'phase runner is nested in the live hold group');
  const live = lookupProcess(pid, { identityOnly: true }); assert.equal(live.ok, true); assert.ok(!live.value || /^Z/.test(live.value.state));
  t.diagnostic(JSON.stringify({ child_pid: pid, phase_pgid: phases.pgid, captured_child: saved, reaped_processes: receipt.reaped_processes }));
  const recorded = receipt.reaped_processes.find(row => row.pid === pid && row.identity === saved.identity);
  assert.ok(recorded, 'receipt includes cleanup of the captured child in the shared group');
  assert.equal(recorded.source, 'job-watchdog'); assert.equal(recorded.confirmed_gone, true);
  assert.equal(receipt.halted, false); assert.equal(receipt.desk_restored, true);
  assert.equal(fs.existsSync(process.env.MONITOR_TEST_SLOT_PATH), false);
});


test('readiness observation surfaces the associated real execution failure', async t => {
  const f = fixture(t), job = f.add({}, ['/herdr-fixture-command-that-does-not-exist']);
  const running = f.run(job);
  await assert.rejects(until(() => false, 'fixture readiness absent', running,
    () => fs.existsSync(job.receipt) ? `; ${JSON.stringify(read(job.receipt))}` : ''),
    /fixture readiness absent|ENOENT|spawn|command/i);
  await running;
  assert.equal(read(job.receipt).outcome, 'error');
});
