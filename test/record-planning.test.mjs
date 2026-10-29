import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import observed, { captureReads, observeGit, isRecordSourceConflict } from '../lib/record-observation.mjs';
import { initOrg, planTransaction, transact, loadEvents, prepareRecordGuard } from '../lib/store.mjs';
import { gitProject } from '../lib/project.mjs';
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

test('Git semantic rechecks stay outside the record lock across slow failed and changed queries', async t => {
  const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
  for (const mode of ['slow', 'exit-128', 'changed', 'late-change', 'guard']) await t.test(mode, t => {
    const f = fixture(t); f.git(['init', '-qb', 'main']);
    f.git(['config', 'user.name', 'Planner']); f.git(['config', 'user.email', 'planner@example.invalid']);
    f.git(['commit', '--allow-empty', '-qm', 'base']);
    const base = f.git(['rev-parse', 'HEAD']);
    f.git(['commit', '--allow-empty', '-qm', 'changed']);
    const changed = f.git(['rev-parse', 'HEAD']); f.git(['reset', '--hard', base]);
    const bin = path.join(f.root, 'shim'), journal = path.join(f.root, 'git-calls.jsonl');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2), file=${JSON.stringify(journal)};
const rows=fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\\n').map(JSON.parse):[];
const selected=args.includes('--show-toplevel'), second=selected&&rows.filter(r=>r.selected).length===1;
fs.appendFileSync(file,JSON.stringify({selected,locked:fs.existsSync(${JSON.stringify(f.lock)})})+'\\n');
if(second&&${JSON.stringify(mode)}==='slow')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000);
if(second&&${JSON.stringify(mode)}==='exit-128')process.exit(128);
const result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});
process.exit(result.status??1);
`, { mode: 0o755 });
    // A package-free .mjs target keeps the PATH shim independent of Node flags.
    fs.renameSync(path.join(bin, 'git'), path.join(bin, 'git.mjs'));
    fs.symlinkSync('git.mjs', path.join(bin, 'git'));
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    if (mode === 'late-change') onAcquisition(f, t, () => {
      fs.writeFileSync(path.join(f.root, '.git/refs/heads/main'), changed + '\n');
    });
    let commits = 0;
    const plan = () => {
      assert.equal(gitProject(f.root, { env }).identity, path.join(f.root, '.git'));
      if (mode === 'changed') f.git(['update-ref', 'refs/heads/main', changed]);
      return { add: [{ type: 'future.git-checked' }], commit: validate => { commits++; validate(); } };
    };
    if (mode === 'guard') {
      const guard = prepareRecordGuard(f.dir, () => gitProject(f.root, { env }));
      guard.run(() => { assert.equal(fs.existsSync(f.lock), true); guard.validate(); commits++; });
    } else if (['exit-128', 'changed', 'late-change'].includes(mode)) {
      assert.throws(() => planTransaction(f.dir, plan), error => {
        assert.equal(isRecordSourceConflict(error), true);
        if (mode === 'exit-128') assert.equal(error.code, 'RECORD_PLANNING_CONFLICT');
        assert.match(error.message, /record Git observation conflict/); return true;
      });
      assert.equal(fs.readFileSync(f.file, 'utf8'), ''); assert.equal(commits, 0);
    } else {
      const result = planTransaction(f.dir, plan);
      assert.equal(result.added.length, 1); assert.equal(commits, 1);
    }
    const rows = fs.readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(rows.length >= 3, 'the semantic query was rechecked');
    assert.equal(rows.some(row => row.locked), false, JSON.stringify(rows));
    assert.equal(fs.existsSync(f.lock), false);
  });
});

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

test('exact path fences refuse a retargeted ancestor even when both paths name the same inode', t => {
  const f = fixture(t), left = path.join(f.root, 'left'), right = path.join(f.root, 'right'), alias = path.join(f.root, 'alias');
  fs.mkdirSync(left); fs.mkdirSync(right);
  fs.writeFileSync(path.join(left, 'policy'), 'same bytes');
  fs.linkSync(path.join(left, 'policy'), path.join(right, 'policy'));
  fs.symlinkSync(left, alias);
  const observation = captureReads(() => observed.readFileSync(path.join(alias, 'policy'), 'utf8'));
  fs.unlinkSync(alias); fs.symlinkSync(right, alias);
  assert.equal(fs.statSync(path.join(left, 'policy')).ino, fs.statSync(path.join(right, 'policy')).ino);
  assert.throws(observation.validate, /observation conflict/);
});

test('exact path fences resolve unicode and chained symlinks without caching later validation', t => {
  const f = fixture(t), target = path.join(f.root, 'policy-λ'), first = path.join(f.root, 'first'), second = path.join(f.root, 'second');
  fs.writeFileSync(target, 'original'); fs.symlinkSync(target, first); fs.symlinkSync(first, second);
  const observation = captureReads(() => observed.readFileSync(new URL(`file://${second}`), 'utf8'));
  observation.validate(); fs.writeFileSync(target, 'changed!');
  assert.throws(observation.validate, /observation conflict/);
});

test('null-device config observations tolerate timestamp churn from an unrelated audit write', () => {
  const observation = captureReads(() => observed.readFileSync('/dev/null', 'utf8'));
  fs.writeFileSync('/dev/null', 'ordinary stderr/audit output');
  assert.equal(observation.value, ''); observation.validate();
});

for (const field of ['ino', 'rdev', 'mode']) test(`null-device config observations still fence ${field}`, t => {
  const observation = captureReads(() => observed.readFileSync('/dev/null', 'utf8')), stat = fs.statSync;
  fs.statSync = function(file, ...args) {
    const value = stat.call(this, file, ...args);
    if (file === '/dev/null' && typeof value[field] === 'bigint')
      return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { [field]: value[field] + 1n });
    return value;
  };
  t.after(() => { fs.statSync = stat; });
  assert.throws(observation.validate, /observation conflict/);
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

test('a queue/config change during native authorization refuses publication without repeating native work', t => {
  const f = fixture(t), file = path.join(f.root, 'queue.json'); fs.writeFileSync(file, '{}');
  let plans = 0, native = 0, published = 0;
  assert.throws(() => planTransaction(f.dir, () => {
    plans++; observed.readFileSync(file);
    return { add: [{ type: 'future.forbidden' }], commit: validate => {
      native++; fs.writeFileSync(file, '{"changed":true}');
      validate(); published++;
    } };
  }, { replaySafe: true }), /record observation conflict/);
  assert.equal(plans, 1); assert.equal(native, 1); assert.equal(published, 0);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '');
});
