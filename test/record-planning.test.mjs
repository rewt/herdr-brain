import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import observed, { captureReads, observeGit } from '../lib/record-observation.mjs';
import { initOrg, planTransaction, transact, loadEvents } from '../lib/store.mjs';
import { nextItemId, fold } from '../lib/state.mjs';
import { fold as oldFold } from './fixtures/state-v0.mjs';
import { protectRecordMutation } from '../lib/record-guard.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'record-plan-'))), dir = path.join(root, '.org');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initOrg(dir);
  const file = path.join(dir, 'events.jsonl'), lock = path.join(dir, 'lock');
  const git = args => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  return { root, dir, file, lock, git };
}
function onAcquisition(f, t, action) {
  const original = fs.mkdirSync;
  fs.mkdirSync = function(file, ...rest) {
    const result = original.call(this, file, ...rest);
    if (file === f.lock) action();
    return result;
  };
  t.after(() => { fs.mkdirSync = original; });
}

test('read-only planning and queue discovery run outside the append lock', t => {
  const f = fixture(t); f.git(['init', '-qb', 'main']);
  f.git(['config', 'user.name', 'Planner']); f.git(['config', 'user.email', 'planner@example.invalid']);
  fs.writeFileSync(path.join(f.root, 'base'), 'base'); f.git(['add', 'base']); f.git(['commit', '-qm', 'base']);
  let calls = 0;
  const result = planTransaction(f.dir, (events, state) => {
    calls++;
    assert.equal(fs.existsSync(f.lock), false);
    const id = nextItemId(state, { role: 'engineer' });
    return protectRecordMutation({ org: f.dir, events, state, command: 'add', mutation: {
      add: [{ type: 'item.added', id, role: 'engineer', title: 'Planned' }, { type: 'future.unknown', id }], result: id,
    } });
  }, { actor: 'planner' });
  assert.equal(calls, 1); assert.equal(result.result, 'ENG-1');
  assert.deepEqual(result.added.map(e => e.seq), [1, 2]);
  assert.equal(result.added[0].by, 'planner');
  assert.equal(fold(loadEvents(f.dir).events).items.get('ENG-1').title, 'Planned');
  assert.equal(oldFold(loadEvents(f.dir).events).items.get('ENG-1').title, 'Planned');
});

for (const type of ['run.claimed', 'item.updated', 'future.unknown']) test(`record CAS refuses ${type} without replaying the planner`, t => {
  const f = fixture(t); let calls = 0;
  const append = () => fs.appendFileSync(f.file, JSON.stringify({ seq: 1, type, id: 'ENG-9', fields: { meta: { hold: true } } }) + '\n');
  onAcquisition(f, t, append);
  assert.throws(() => planTransaction(f.dir, () => {
    calls++; return { add: [{ type: 'item.added', id: 'ENG-1', title: 'Must not append' }] };
  }), /record planning conflict/);
  assert.equal(calls, 1);
  assert.deepEqual(loadEvents(f.dir).events.map(e => e.type), [type]);
  assert.equal(fs.existsSync(f.lock), false);
});

for (const change of ['edit', 'replace', 'create', 'symlink']) test(`configuration/queue read set refuses a late ${change}`, t => {
  const f = fixture(t), input = path.join(f.root, 'policy.json');
  if (change !== 'create') fs.writeFileSync(input, '{}');
  let calls = 0;
  onAcquisition(f, t, () => {
    if (change === 'replace' || change === 'symlink') fs.renameSync(input, input + '.old');
    if (change === 'symlink') fs.symlinkSync(input + '.old', input);
    else fs.writeFileSync(input, '{"changed":true}');
  });
  assert.throws(() => planTransaction(f.dir, () => {
    calls++; if (observed.existsSync(input)) observed.readFileSync(input);
    return { add: [{ type: 'future.unknown' }] };
  }), /record observation conflict/);
  assert.equal(calls, 1); assert.equal(fs.readFileSync(f.file, 'utf8'), '');
});

test('directory read sets detect new queue receipts, while identity reads allow unrelated sibling appends', t => {
  const f = fixture(t), folder = path.join(f.root, 'receipts'); fs.mkdirSync(folder);
  const identity = captureReads(() => observed.realpathSync(folder));
  const listing = captureReads(() => observed.readdirSync(folder));
  fs.writeFileSync(path.join(folder, 'new.json'), '{}');
  identity.validate(); assert.throws(listing.validate, /observation conflict/);
});

test('descriptor policy reads retain their path and detect a post-read replacement', t => {
  const f = fixture(t), file = path.join(f.root, 'policy'); fs.writeFileSync(file, 'old');
  const observation = captureReads(() => {
    const fd = observed.openSync(file, 'r');
    try { return observed.readFileSync(fd, 'utf8'); } finally { observed.closeSync(fd); }
  });
  fs.renameSync(file, file + '.old'); fs.writeFileSync(file, 'new');
  assert.equal(observation.value, 'old'); assert.throws(observation.validate, /observation conflict/);
});

test('Git inputs fence a moved HEAD and a newly created reference before append', t => {
  const f = fixture(t); f.git(['init', '-qb', 'main']);
  const observation = captureReads(() => observeGit(f.root));
  fs.mkdirSync(path.join(f.root, '.git/refs/heads'), { recursive: true });
  fs.writeFileSync(path.join(f.root, '.git/refs/heads/main'), 'a'.repeat(40) + '\n');
  assert.throws(observation.validate, /observation conflict/);
});

test('torn tails retain explicit refusal and compatible repair, including partial writes', t => {
  const f = fixture(t); fs.writeFileSync(f.file, '{"torn":');
  assert.throws(() => planTransaction(f.dir, () => ({ add: [{ type: 'future.unknown' }] }), { strictTail: true }), /incomplete record tail/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{"torn":');
  const write = fs.writeSync;
  fs.writeSync = function(fd, buffer, offset, length, position) { return write.call(this, fd, buffer, offset, Math.min(3, length), position); };
  t.after(() => { fs.writeSync = write; });
  const result = planTransaction(f.dir, () => ({ add: [{ type: 'future.unknown' }] }));
  assert.equal(result.repaired, true); assert.equal(result.added[0].seq, 1);
  assert.deepEqual(loadEvents(f.dir).events, result.added);
});

test('legacy callbacks still execute once under lock, and planned errors append nothing', t => {
  const f = fixture(t); let calls = 0;
  transact(f.dir, () => { calls++; assert.equal(fs.existsSync(f.lock), true); return {}; });
  assert.equal(calls, 1);
  assert.throws(() => planTransaction(f.dir, () => { calls++; throw Error('original error'); }), /original error/);
  assert.equal(calls, 2); assert.equal(fs.readFileSync(f.file, 'utf8'), '');
});

test('only explicitly replay-safe derivations refresh IDs after a concurrent append', t => {
  const f = fixture(t); let calls = 0, raced = false;
  onAcquisition(f, t, () => {
    if (raced) return;
    raced = true;
    fs.appendFileSync(f.file, JSON.stringify({ seq: 1, type: 'item.added', id: 'ENG-1', title: 'Concurrent' }) + '\n');
  });
  const result = planTransaction(f.dir, (_events, state) => {
    calls++;
    return { add: [{ type: 'item.added', id: nextItemId(state, { role: 'engineer' }), title: 'Fresh' }] };
  }, { replaySafe: true });
  assert.equal(calls, 2); assert.equal(result.added[0].id, 'ENG-2'); assert.equal(result.added[0].seq, 2);
});

test('commit effects run once under the exact record lock after a retried pure plan', t => {
  const f = fixture(t); let plans = 0, commits = 0, raced = false;
  onAcquisition(f, t, () => {
    if (raced) return;
    raced = true; fs.appendFileSync(f.file, JSON.stringify({ seq: 1, type: 'future.unknown' }) + '\n');
  });
  const result = planTransaction(f.dir, () => {
    plans++; assert.equal(fs.existsSync(f.lock), false);
    return { add: [{ type: 'future.committed' }], commit: () => {
      commits++; assert.equal(fs.existsSync(f.lock), true);
      assert.equal(loadEvents(f.dir).events.length, 1);
    } };
  }, { replaySafe: true });
  assert.equal(plans, 2); assert.equal(commits, 1); assert.equal(result.added[0].seq, 2);
});

test('native commit refusals never retry a plan or append, even with a conflict-shaped code', t => {
  const f = fixture(t); let plans = 0, commits = 0;
  assert.throws(() => planTransaction(f.dir, () => {
    plans++; return { add: [{ type: 'future.forbidden' }], commit: () => {
      commits++; throw Object.assign(Error('native refused'), { code: 'RECORD_PLANNING_CONFLICT' });
    } };
  }, { replaySafe: true }), /native refused/);
  assert.equal(plans, 1); assert.equal(commits, 1); assert.equal(fs.readFileSync(f.file, 'utf8'), '');
});

test('a nested configuration audit revokes planner replay and preserves its original effect', t => {
  const f = fixture(t); let plans = 0, commits = 0;
  assert.throws(() => planTransaction(f.dir, () => {
    plans++;
    transact(f.dir, () => ({ add: [{ type: 'config.changed', operation: 'original-audit' }] }));
    return { add: [{ type: 'future.forbidden' }], commit: () => { commits++; } };
  }, { replaySafe: true }), /record planning conflict/);
  assert.equal(plans, 1); assert.equal(commits, 0);
  assert.deepEqual(loadEvents(f.dir).events.map(e => e.operation), ['original-audit']);
});
