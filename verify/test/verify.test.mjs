import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { queueFor, submit, admit, drain, status, deliver, writeReceipt } from '../verify.mjs';
import { parseExpectations, evaluate, sha256 } from '../expectations.mjs';
import { initOrg, transact, loadEvents } from '../../lib/store.mjs';
import { enqueueSupervisor, readInbox as snapshot } from '../../supervisor/prompt-supervisor.mjs';
import { acquireTestSlot } from '../../test-slot/test-slot.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { stopFixtureInbox } from '../../test/helpers/inbox.mjs';
import { lookupProcess } from '../../lib/processes.mjs';
import { productFiles } from '../../lib/product-files.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';

const CLI = fileURLToPath(new URL('../verify.mjs', import.meta.url));
const inboxCLI = fileURLToPath(new URL('../../supervisor/prompt-supervisor.mjs', import.meta.url));
const node = code => [process.execPath, '-e', code];
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
async function until(fn, message) {
  const by = Date.now() + loadTimeout(10000);
  while (Date.now() < by) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(message);
}
function fixture(t, { defaultState = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'))), repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const before = { ...process.env };
  process.env.MONITOR_TEST_SLOT_PATH = process.env.MONITOR_TEST_SLOT_COMPAT_PATH = path.join(root, 'slot');
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
  const queue = queueFor(repo, defaultState ? undefined : path.join(root, 'state'));
  const add = (opt = {}, argv = node("console.log('ok')"), prepare = null) => submit(queue, { org, item: 'ENG-1', sha: sha1, to: 'ops-fixture', herdr: fake, ...opt }, argv, prepare);
  const notify = async (to, text, opt) => enqueueSupervisor(to, text, opt);
  const run = async (...jobs) => { const token = admit(queue, jobs.map(job => job.job)); await drain(queue, token, { notify }); };
  const cli = async args => {
    const result = await waitForExit(spawnChild(t, process.execPath, [CLI, ...args, '--repo', repo, '--state-dir', queue.directory], { env: process.env }));
    assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout);
  };
  t.after(async () => {
    await stopFixtureInbox(path.join(org, 'supervisor/inbox.log'), { script: inboxCLI });
    for (const desk of Object.keys(queue.load().desks)) git('worktree', 'remove', '--force', desk);
    fs.rmSync(root, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  });
  return { root, repo, org, queue, sha1, sha2, git, add, run, cli, notify, fake };
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
  holder.release(); await f.run(job);
  assert.equal(read(job.receipt).outcome, 'pass'); assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
});

test('the default persistent desk and queue use canonical Git identity from a linked checkout', async t => {
  const f = fixture(t, { defaultState: true }), lane = path.join(f.root, 'lane');
  f.git('worktree', 'add', '--detach', lane, f.sha1);
  try {
    assert.equal(queueFor(lane).directory, f.queue.directory);
    const job = f.add(); await f.run(job);
    assert.equal(read(job.receipt).outcome, 'pass');
    assert.equal(read(job.receipt).desk, path.join(f.repo, '.git/verify/desks/default'));
  } finally { f.git('worktree', 'remove', '--force', lane); }
});

test('one detached admitted worker returns before grant, drains FIFO and records holders plus one note and notice', async t => {
  const f = fixture(t), order = path.join(f.root, 'order');
  const holder = await acquireTestSlot('fixture holder', { lockPath: process.env.MONITOR_TEST_SLOT_PATH, waitSeconds: 0 });
  t.after(() => holder.release());
  const a = f.add({}, node(`require('fs').appendFileSync(${JSON.stringify(order)},'A')`));
  const b = f.add({}, node(`require('fs').appendFileSync(${JSON.stringify(order)},'B')`));
  await f.cli(['admit', b.job, a.job]);
  assert.equal(fs.existsSync(a.receipt), false); assert.equal(fs.existsSync(b.receipt), false);
  assert.throws(() => admit(f.queue, [a.job]), /admission is active/);
  await until(() => fs.existsSync(path.join(f.queue.directory, 'jobs', a.job, 'execution.log')) && fs.readFileSync(path.join(f.queue.directory, 'jobs', a.job, 'execution.log'), 'utf8').includes('TEST_SLOT_WAIT'), 'worker did not wait for slot');
  holder.release();
  await until(() => f.queue.load().runner === null, 'detached worker did not finish');
  assert.equal(fs.readFileSync(order, 'utf8'), 'AB');
  const receipt = read(a.receipt);
  assert.equal(receipt.schema, 'verify-receipt/v1'); assert.equal(receipt.sha, f.sha1);
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

test('a desk edited during a busy slot wait is refused at grant and its edits are preserved', async t => {
  const f = fixture(t), holder = await acquireTestSlot('busy grant fixture', { lockPath: process.env.MONITOR_TEST_SLOT_PATH, waitSeconds: 0 });
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
  const f = fixture(t), slot = process.env.MONITOR_TEST_SLOT_PATH;
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
  assert.throws(() => f.add({ desk: path.join(ra.desk, 'nested') }), /must not overlap/);
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
  f.queue.transaction(data => { data.jobs[0].tree = '0'.repeat(40); });
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
  const existing = f.add({ desk: f.repo });
  await f.run(existing);
  assert.match(read(existing.receipt).error, /not created by this runner/);
});

test('an absolute desk is created by the runner and a mismatching checked-out tree refuses execution', async t => {
  const f = fixture(t), a = f.add({ desk: path.join(f.root, 'absolute-desk') });
  await f.run(a); assert.equal(read(a.receipt).outcome, 'pass');
  const b = f.add(); f.queue.transaction(data => { data.jobs.find(job => job.id === b.job).tree = '0'.repeat(40); });
  await f.run(b); assert.match(read(b.receipt).error, /tree differs/);
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
  assert.throws(() => admit(f.queue, [a.job]), /already has a receipt/);
  const retry = f.add(); assert.notEqual(retry.job, a.job); assert.notEqual(retry.receipt, a.receipt);
});

for (const kind of ['wall', 'idle']) test(`${kind} cap ends one job, restores its desk and records watchdog evidence without retry`, async t => {
  const f = fixture(t), job = f.add({ 'timeout-seconds': kind === 'wall' ? '.8' : '4', 'idle-timeout-seconds': kind === 'idle' ? '.5' : '3' }, node('setInterval(()=>{},1000)'));
  await f.run(job); const receipt = read(job.receipt);
  assert.equal(receipt.outcome, 'error'); assert.equal(receipt.timeout.kind, kind);
  assert.equal(receipt.slot_execution.attempts, 1); assert.equal(receipt.desk_restored, true);
  assert.equal(fs.existsSync(process.env.MONITOR_TEST_SLOT_PATH), false);
});

test('a captured descendant in a separate session is identity-confirmed, reaped and recorded before the next job', async t => {
  const f = fixture(t), pids = path.join(f.root, 'escaped');
  const escaped = `require('fs').writeFileSync(${JSON.stringify(pids)},String(process.pid));setInterval(()=>{},1000);`;
  const job = f.add({}, node(`const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(escaped)}],{detached:true,stdio:'ignore'});c.unref();setTimeout(()=>{},500);`));
  await f.run(job); const receipt = read(job.receipt), pid = Number(fs.readFileSync(pids));
  assert.equal(receipt.outcome, 'pass', receipt.error);
  assert.ok(receipt.reaped_processes.some(row => row.pid === pid && row.signal === 'SIGTERM' && row.identity));
  const live = lookupProcess(pid, { identityOnly: true }); assert.equal(live.ok, true); assert.ok(!live.value || /^Z/.test(live.value.state));
  assert.equal(fs.existsSync(process.env.MONITOR_TEST_SLOT_PATH), false);
});

test('timeout also records and reaps a captured escaped descendant before releasing the host slot', async t => {
  const f = fixture(t), pids = path.join(f.root, 'timed-escape');
  const escaped = `require('fs').writeFileSync(${JSON.stringify(pids)},String(process.pid));setInterval(()=>{},1000);`;
  const job = f.add({ 'timeout-seconds': '1', 'idle-timeout-seconds': '3' }, node(`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(escaped)}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000);`));
  await f.run(job); const receipt = read(job.receipt), pid = Number(fs.readFileSync(pids));
  assert.equal(receipt.timeout.kind, 'wall');
  assert.ok(receipt.reaped_processes.some(row => row.pid === pid && row.identity));
  const live = lookupProcess(pid, { identityOnly: true }); assert.equal(live.ok, true); assert.ok(!live.value || /^Z/.test(live.value.state));
  assert.equal(fs.existsSync(process.env.MONITOR_TEST_SLOT_PATH), false);
});

test('a previously observed orphan is reaped inside the host hold after job timeout', async t => {
  const f = fixture(t), pids = path.join(f.root, 'orphan'), seen = path.join(f.root, 'held-during-cleanup'), slot = process.env.MONITOR_TEST_SLOT_PATH;
  const leaf = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pids)},String(process.pid));process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(seen)},String(fs.existsSync(${JSON.stringify(slot)})))});setInterval(()=>{},1000);`;
  const middle = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,stdio:'ignore'}).unref();setTimeout(()=>{},500);`;
  const job = f.add({ 'timeout-seconds': '1.5', 'idle-timeout-seconds': '5' }, node(`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000);`));
  await f.run(job); const receipt = read(job.receipt), pid = Number(fs.readFileSync(pids));
  assert.equal(receipt.timeout.kind, 'wall'); assert.equal(fs.readFileSync(seen, 'utf8'), 'true');
  assert.ok(receipt.reaped_processes.some(row => row.pid === pid && row.signal === 'SIGKILL'));
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
