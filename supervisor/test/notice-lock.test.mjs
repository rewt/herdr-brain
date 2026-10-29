import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from '../../test/helpers/bounded-test.mjs';
import { noticeLock, ownerPid } from '../notice-lock.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'inbox.log.lock');
  return { root, directory, owner: path.join(directory, 'owner.json') };
}

function contender(f) {
  const candidate = fs.mkdtempSync(`${f.directory}.new-`);
  const bytes = JSON.stringify({ pid: process.ppid, at: 'contender', argv: [] });
  fs.writeFileSync(path.join(candidate, 'owner.json'), bytes);
  return { candidate, bytes };
}

function renameAfterUnlink(t, f, candidate) {
  const unlink = fs.unlinkSync;
  let renames = 0;
  t.mock.method(fs, 'unlinkSync', (file, ...args) => {
    const result = unlink(file, ...args);
    if (file === f.owner) { fs.renameSync(candidate, f.directory); renames++; }
    return result;
  });
  return () => renames;
}

test('release tolerates a contender rename between owner unlink and rmdir', t => {
  const f = fixture(t), release = noticeLock(f.directory), next = contender(f);
  const renames = renameAfterUnlink(t, f, next.candidate);
  assert.doesNotThrow(release);
  assert.equal(renames(), 1, 'the contender published over the empty lock directory');
  assert.equal(fs.readFileSync(f.owner, 'utf8'), next.bytes);
  release();
  assert.equal(fs.readFileSync(f.owner, 'utf8'), next.bytes, 'repeated release preserves the contender');
});

test('release removes its own lock once and preserves a different owner', t => {
  const f = fixture(t), release = noticeLock(f.directory);
  assert.equal(ownerPid(f.directory), process.pid);
  release(); release();
  assert.equal(fs.existsSync(f.directory), false);

  const staleRelease = noticeLock(f.directory), next = contender(f);
  fs.writeFileSync(f.owner, next.bytes);
  staleRelease();
  assert.equal(fs.readFileSync(f.owner, 'utf8'), next.bytes);
});

test('release tolerates a directory already removed after owner unlink', t => {
  const f = fixture(t), release = noticeLock(f.directory), rmdir = fs.rmdirSync;
  let removals = 0;
  t.mock.method(fs, 'rmdirSync', (directory, ...args) => {
    if (directory === f.directory) { rmdir(directory); removals++; }
    return rmdir(directory, ...args);
  });
  assert.doesNotThrow(release);
  assert.equal(removals, 1);
  assert.equal(fs.existsSync(f.directory), false);
});

function deadOwner(t, f) {
  const pid = 2147483647, kill = process.kill;
  t.mock.method(process, 'kill', (target, signal) => {
    if (target === pid) throw Object.assign(new Error('dead fixture owner'), { code: 'ESRCH' });
    return kill(target, signal);
  });
  fs.mkdirSync(f.directory);
  fs.writeFileSync(f.owner, JSON.stringify({ pid }));
}

test('dead-owner recovery preserves a contender renamed after owner unlink', t => {
  const f = fixture(t); deadOwner(t, f);
  const next = contender(f), renames = renameAfterUnlink(t, f, next.candidate);
  assert.throws(() => noticeLock(f.directory), /locked: .*owner is live or unidentified/);
  assert.equal(renames(), 1);
  assert.equal(fs.readFileSync(f.owner, 'utf8'), next.bytes);
  assert.equal(fs.existsSync(`${f.directory}.recovery`), false, 'the recovery guard was released');
});

test('dead-owner recovery acquires and releases the recovered lock', t => {
  const f = fixture(t); deadOwner(t, f);
  const release = noticeLock(f.directory);
  assert.equal(ownerPid(f.directory), process.pid);
  assert.equal(fs.existsSync(`${f.directory}.recovery`), false);
  release();
  assert.equal(fs.existsSync(f.directory), false);
});

for (const kind of ['live', 'unidentified']) test(`notice lock preserves a ${kind} owner`, t => {
  const f = fixture(t), bytes = kind === 'live' ? JSON.stringify({ pid: process.pid }) : '{';
  fs.mkdirSync(f.directory); fs.writeFileSync(f.owner, bytes);
  assert.throws(() => noticeLock(f.directory), /locked:/);
  assert.equal(fs.readFileSync(f.owner, 'utf8'), bytes);
  assert.equal(fs.existsSync(`${f.directory}.recovery`), false);
});

test('recovery receipts bracket removal and retain the exact recorded owner identity', t => {
  const f = fixture(t); deadOwner(t, f);
  const bytes = fs.readFileSync(f.owner, 'utf8'), receipts = [];
  const release = noticeLock(f.directory, { onRecovery: receipt => {
    receipts.push(receipt);
    assert.equal(fs.existsSync(f.owner), receipt.phase === 'intent');
  } });
  assert.deepEqual(receipts.map(r => r.phase), ['intent', 'recovered']);
  assert.deepEqual(receipts[0].owner, JSON.parse(bytes));
  assert.equal(receipts[0].proof.result, 'ESRCH');
  assert.match(receipts[0].owner_sha256, /^[a-f0-9]{64}$/);
  assert.ok(receipts[0].lock_identity);
  release();
});

for (const kind of ['receipt-failure', 'same-pid-new-owner', 'live-replacement', 'probe-refused'])
  test(`recovery preserves the lock after ${kind}`, t => {
    const f = fixture(t); deadOwner(t, f);
    const original = fs.readFileSync(f.owner, 'utf8');
    let expected = original;
    assert.throws(() => noticeLock(f.directory, { onRecovery: receipt => {
      assert.equal(receipt.phase, 'intent');
      if (kind === 'receipt-failure') throw Error('receipt unavailable');
      if (kind === 'probe-refused') {
        t.mock.method(process, 'kill', () => { throw Object.assign(Error('probe denied'), { code: 'EPERM' }); });
      } else {
        expected = JSON.stringify({ pid: kind === 'live-replacement' ? process.pid : JSON.parse(original).pid, at: 'new owner' });
        fs.writeFileSync(f.owner, expected);
      }
    } }), /receipt unavailable|owner changed/);
    assert.equal(fs.readFileSync(f.owner, 'utf8'), expected);
    assert.equal(fs.existsSync(`${f.directory}.recovery`), false);
  });

test('a live replacement under the recovery guard is re-read and retained without a recovery receipt', t => {
  const f = fixture(t); deadOwner(t, f);
  const rename = fs.renameSync, bytes = JSON.stringify({ pid: process.pid, identity: 'different-birth' });
  t.mock.method(fs, 'renameSync', (from, to) => {
    const result = rename(from, to);
    if (to === `${f.directory}.recovery`) fs.writeFileSync(f.owner, bytes);
    return result;
  });
  assert.throws(() => noticeLock(f.directory, { onRecovery: () => assert.fail('live owner cannot be recovered') }), /locked:/);
  assert.equal(fs.readFileSync(f.owner, 'utf8'), bytes);
});

test('dead recovery guards use the same serialized receipt path', t => {
  const f = fixture(t); deadOwner(t, f);
  fs.mkdirSync(`${f.directory}.recovery`);
  fs.copyFileSync(f.owner, path.join(`${f.directory}.recovery`, 'owner.json'));
  const receipts = [], release = noticeLock(f.directory, { onRecovery: r => receipts.push(r) });
  assert.deepEqual(receipts.map(r => [r.directory, r.phase]), [
    [`${f.directory}.recovery`, 'intent'], [`${f.directory}.recovery`, 'recovered'],
    [f.directory, 'intent'], [f.directory, 'recovered'],
  ]);
  release();
});
