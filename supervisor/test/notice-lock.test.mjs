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
