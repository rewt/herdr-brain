import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { serialize, deserialize } from 'node:v8';
import { createHash } from 'node:crypto';
import { initOrg, loadEvents, loadRecord, transact, withLock } from '../lib/store.mjs';
import { fold, nextItemId, nextRunId, wouldCycleBlock } from '../lib/state.mjs';
import { SNAPSHOT_FILE } from '../lib/record-snapshot.mjs';
import { recordLockTimingJournal } from '../lib/run-timing.mjs';
import { fold as oldFold } from './fixtures/state-v0.mjs';

const stamp = '2026-10-27T12:00:00.000Z';
const encode = events => events.map(e => JSON.stringify(e) + '\n').join('');
function fixture(t, initial = [
  { type: 'item.added', id: 'ENG-1', title: 'alpha' },
  { type: 'run.started', id: 'R-1', item: 'ENG-1', meta: {} },
  { type: 'run.claimed', run: 'R-1', owner: { controller: 'brain' } },
]) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'record-snapshot-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  initOrg(dir);
  const file = path.join(dir, 'events.jsonl'), snapshot = path.join(dir, SNAPSHOT_FILE);
  const seed = initial.map((event, i) => ({ seq: i + 1, at: stamp, by: 'old-writer', ...event }));
  fs.writeFileSync(file, encode(seed));
  const append = event => {
    const events = JSON.parse('[' + fs.readFileSync(file, 'utf8').trim().split('\n').join(',') + ']');
    const row = { seq: (events.at(-1)?.seq ?? 0) + 1, at: stamp, by: 'old-writer', ...event };
    withLock(dir, () => fs.appendFileSync(file, encode([row])));
    return row;
  };
  return { dir, file, snapshot, seed, append };
}
function equivalent(f) {
  const cached = loadRecord(f.dir), replay = loadRecord(f.dir, { snapshot: false });
  assert.deepEqual(cached.events, replay.events);
  assert.deepEqual(cached.state, fold(replay.events));
  assert.equal(cached.tornTail, replay.tornTail);
  return cached;
}

test('snapshot plus old-writer tails equals full replay, including unknown events and cross-subject state', t => {
  const f = fixture(t);
  assert.equal(loadRecord(f.dir).snapshot.used, false);
  const initial = fs.readFileSync(f.snapshot);
  assert.equal(loadRecord(f.dir).snapshot.used, true);
  f.append({ type: 'item.added', id: 'ENG-2', title: 'other', parent: 'ENG-1' });
  f.append({ type: 'link.added', blocker: 'ENG-1', blocked: 'ENG-2' });
  f.append({ type: 'run.updated', id: 'R-1', meta: { agent: 'worker', pane: 'w:p', worker_workspace: 'w', terminal_id: 'term' } });
  f.append({ type: 'run.session_bound', run: 'R-1', session: 'session' });
  f.append({ type: 'future.event', run: 'R-1', opaque: { held: true } });
  f.append({ type: 'report.ingested', run: 'R-1', report: { outcome: 'done' }, sha256: 'digest', file: 'R-1.md' });
  const result = equivalent(f);
  assert.equal(result.snapshot.used, true);
  assert.equal(result.snapshot.tailEvents, 6);
  assert.equal(result.state.runs.get('R-1').owner_generation, 3);
  assert.equal(result.state.items.get('ENG-1').outcome.value, 'done');
  assert.deepEqual(oldFold(result.events).items.get('ENG-1').outcome, result.state.items.get('ENG-1').outcome);
  assert.deepEqual(fs.readFileSync(f.snapshot), initial, 'small tails do not rewrite the checkpoint');
  result.events[0].title = 'caller mutation'; result.state.items.clear();
  assert.equal(equivalent(f).state.items.get('ENG-1').title, 'alpha');
});

for (const damage of ['checksum', 'truncated', 'version', 'foreign']) test(`a ${damage} snapshot rebuilds only from the log`, t => {
  const f = fixture(t); loadRecord(f.dir);
  const bytes = fs.readFileSync(f.snapshot);
  if (damage === 'checksum') { bytes[bytes.length - 1] ^= 1; fs.writeFileSync(f.snapshot, bytes); }
  else if (damage === 'truncated') fs.writeFileSync(f.snapshot, bytes.subarray(0, 20));
  else {
    const data = deserialize(bytes.subarray(65));
    if (damage === 'version') data.version = 'other-reader';
    else data.source.file = '/foreign/events.jsonl';
    const body = serialize(data), digest = createHash('sha256').update(body).digest('hex');
    fs.writeFileSync(f.snapshot, Buffer.concat([Buffer.from(digest + '\n'), body]));
  }
  assert.equal(loadRecord(f.dir).snapshot.used, false);
  equivalent(f);
  assert.equal(loadRecord(f.dir).snapshot.used, true);
});

for (const change of ['replacement', 'truncation', 'same-size rewrite', 'prefix rewrite plus append']) test(`${change} invalidates the source-bound checkpoint`, t => {
  const f = fixture(t); loadRecord(f.dir);
  const text = fs.readFileSync(f.file, 'utf8');
  if (change === 'replacement') {
    fs.renameSync(f.file, f.file + '.old'); fs.writeFileSync(f.file, text.replace('alpha', 'bravo'));
  } else if (change === 'truncation') fs.writeFileSync(f.file, encode(f.seed.slice(0, 1)));
  else fs.writeFileSync(f.file, text.replace('alpha', 'bravo') + (change === 'prefix rewrite plus append'
    ? encode([{ seq: 4, at: stamp, by: 'old', type: 'note.added', id: 'ENG-1', text: 'appended' }]) : ''));
  const result = equivalent(f);
  assert.equal(result.snapshot.used, false);
  assert.equal(result.state.items.get('ENG-1').title, change === 'truncation' ? 'alpha' : 'bravo');
});

test('torn and complete EOF tails retain public repair and strict-tail behavior', t => {
  const f = fixture(t); loadRecord(f.dir);
  fs.appendFileSync(f.file, '{"seq":4,"type":');
  assert.equal(equivalent(f).tornTail, true);
  const torn = fs.readFileSync(f.file);
  let calls = 0;
  assert.throws(() => transact(f.dir, () => { calls++; }, { strictTail: true }), /incomplete record tail/);
  assert.equal(calls, 0); assert.deepEqual(fs.readFileSync(f.file), torn);
  const repaired = transact(f.dir, events => ({ add: [{ type: 'note.added', id: 'ENG-1', text: 'repaired' }], result: events.length }));
  assert.equal(repaired.repaired, true); assert.equal(repaired.added[0].seq, 4); assert.equal(repaired.result, 3);
  const complete = { seq: 5, at: stamp, by: 'old', type: 'note.added', id: 'ENG-1', text: 'EOF é' };
  fs.appendFileSync(f.file, JSON.stringify(complete));
  assert.equal(equivalent(f).events.at(-1).text, 'EOF é');
  const next = transact(f.dir, () => ({ add: [{ type: 'future.event' }] }));
  assert.equal(next.repaired, false); assert.equal(next.added[0].seq, 6);
  assert.equal(equivalent(f).events.length, 6);
});

test('malformed complete input is never concealed by a snapshot or repaired by a transaction', t => {
  const f = fixture(t); loadRecord(f.dir);
  fs.appendFileSync(f.file, '\nnot-json\n');
  const before = fs.readFileSync(f.file);
  assert.throws(() => loadEvents(f.dir), /events.jsonl line 5 is not valid JSON/);
  let calls = 0;
  assert.throws(() => transact(f.dir, () => { calls++; }), /manual repair/);
  assert.equal(calls, 0); assert.deepEqual(fs.readFileSync(f.file), before);
});

test('preparation is outside the lock; unrelated appends get current final IDs and sequences without replay', t => {
  const f = fixture(t); let preparations = 0, commits = 0;
  const result = transact(f.dir, (events, state, observation) => {
    commits++; assert.ok(fs.existsSync(path.join(f.dir, 'lock')));
    assert.equal(observation, 'observed');
    const id = nextItemId(state, { role: 'engineer' });
    assert.equal(id, 'ENG-3');
    return { add: [{ type: 'item.added', id, title: 'final allocation' }], result: events.length };
  }, { subjects: ['ENG-1', 'R-1'], prepare: (state, events) => {
    preparations++; assert.equal(fs.existsSync(path.join(f.dir, 'lock')), false);
    state.items.clear(); events.length = 0;
    f.append({ type: 'item.added', id: 'ENG-2', title: 'unrelated' });
    return 'observed';
  } });
  assert.equal(preparations, 1); assert.equal(commits, 1);
  assert.equal(result.added[0].seq, 5); assert.equal(result.result, 4);
  equivalent(f);
});

for (const event of [
  { type: 'note.added', id: 'ENG-1', text: 'subject revision' },
  { type: 'run.claimed', run: 'R-1', owner: { controller: 'other' } },
  { type: 'item.updated', id: 'ENG-1', fields: { meta: { hold: true } } },
  { type: 'report.ingested', run: 'R-1', report: { outcome: 'done' }, sha256: 'other' },
  { type: 'future.effect', original: { run: 'R-1' }, disposition: 'UNKNOWN' },
  { type: 'future.global-hold', held: true },
]) test(`${event.type} after preparation rejects stale observations before any commit effect`, t => {
  const f = fixture(t), effects = path.join(f.dir, 'external-effects'); let preparations = 0, commits = 0;
  assert.throws(() => transact(f.dir, () => {
    commits++; fs.appendFileSync(effects, 'commit\n'); return { add: [{ type: 'should.not.commit' }] };
  }, { subjects: ['ENG-1', 'R-1'], prepare: () => {
    preparations++; fs.appendFileSync(effects, 'prepared\n'); f.append(event); return 'stale';
  } }), /preparation conflict/);
  assert.equal(preparations, 1); assert.equal(commits, 0);
  assert.equal(fs.readFileSync(effects, 'utf8'), 'prepared\n');
  assert.equal(loadEvents(f.dir).events.at(-1).type, event.type);
});

test('undeclared preparation conflicts on any append and rewritten prefixes conflict despite unrelated subjects', t => {
  for (const rewrite of [false, true]) {
    const f = fixture(t); let commits = 0;
    assert.throws(() => transact(f.dir, () => { commits++; }, {
      ...(rewrite ? { subjects: ['R-1'] } : {}), prepare: () => {
        if (rewrite) fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('alpha', 'bravo'));
        f.append({ type: 'item.added', id: 'ENG-2', title: 'unrelated' });
      },
    }), /preparation conflict/);
    assert.equal(commits, 0);
  }
});

test('legacy callbacks run once on a refreshed view; current cross-subject invariants still refuse invalid changes', t => {
  const f = fixture(t), mkdir = fs.mkdirSync; let injected = false, calls = 0;
  fs.mkdirSync = function (file, ...args) {
    if (file === path.join(f.dir, 'lock') && !injected) {
      injected = true;
      fs.appendFileSync(f.file, encode([{ seq: 4, at: stamp, by: 'old', type: 'item.added', id: 'ENG-2', title: 'race' }]));
    }
    return mkdir.call(this, file, ...args);
  };
  try {
    const result = transact(f.dir, (events, state) => {
      calls++; assert.equal(state.items.get('ENG-2').title, 'race');
      return { add: [{ type: 'note.added', id: 'ENG-2', text: 'current' }], result: events.length };
    });
    assert.equal(result.result, 4); assert.equal(result.added[0].seq, 5);
  } finally { fs.mkdirSync = mkdir; }
  assert.equal(calls, 1);
  assert.throws(() => transact(f.dir, (_events, state) => {
    assert.equal(state.items.has('NOPE-1'), false); throw Error('unknown item NOPE-1');
  }), /unknown item/);
  f.append({ type: 'link.added', blocker: 'ENG-1', blocked: 'ENG-2' });
  const before = fs.readFileSync(f.file);
  assert.throws(() => transact(f.dir, (_events, state) => {
    if (wouldCycleBlock(state, 'ENG-2', 'ENG-1')) throw Error('cycle');
    return { add: [{ type: 'link.added', blocker: 'ENG-2', blocked: 'ENG-1' }] };
  }), /cycle/);
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('concurrent processes preserve one write order, final IDs, claim generations and fsync before unlock', async t => {
  const f = fixture(t, []), store = new URL('../lib/store.mjs', import.meta.url).href, state = new URL('../lib/state.mjs', import.meta.url).href;
  const child = `import {transact} from ${JSON.stringify(store)};import {nextItemId,nextRunId} from ${JSON.stringify(state)};
    for(let i=0;i<6;i++)transact(process.argv[1],(_events,s)=>{const id=nextItemId(s,{role:'engineer'}),run=nextRunId(s);return{add:[
      {type:'item.added',id,title:'concurrent'},{type:'run.started',id:run,item:id},
      {type:'run.claimed',run,owner:{controller:'brain'}}]};},{actor:'concurrent-fixture'});`;
  const workers = Array.from({ length: 4 }, () => spawn(process.execPath, ['--input-type=module', '-e', child, f.dir], { stdio: ['ignore', 'pipe', 'pipe'] }));
  const exits = workers.map(async worker => {
    let stderr = ''; worker.stderr.on('data', data => { stderr += data; }); worker.stdout.resume();
    const [code] = await once(worker, 'exit'); assert.equal(code, 0, stderr);
  });
  await Promise.all(exits);
  const result = equivalent(f);
  assert.equal(result.state.items.size, 24); assert.equal(result.state.runs.size, 24);
  assert.deepEqual(result.events.map(e => e.seq), Array.from({ length: 72 }, (_, i) => i + 1));
  for (const run of result.state.runs.values()) assert.equal(run.owner_generation, result.events.find(e => e.type === 'run.claimed' && e.run === run.id).seq);
  const fsync = fs.fsyncSync; let synced = false;
  fs.fsyncSync = function (fd) { assert.ok(fs.existsSync(path.join(f.dir, 'lock'))); synced = true; return fsync.call(this, fd); };
  try { transact(f.dir, () => ({ add: [{ type: 'future.event' }] })); }
  finally { fs.fsyncSync = fsync; }
  assert.equal(synced, true); assert.equal(fs.existsSync(path.join(f.dir, 'lock')), false);
});

test('lock timing separates wait from acquisition-through-release and failed diagnostics preserve callback results', t => {
  const f = fixture(t), journal = recordLockTimingJournal(f.dir);
  fs.unlinkSync(journal);
  withLock(f.dir, () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15));
  assert.equal(fs.existsSync(path.join(f.dir, 'lock')), false);
  const [sample] = fs.readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(sample.schema, 'record-lock/v1'); assert.equal(sample.node, process.version);
  assert.ok(sample.hold_ms >= 10); assert.ok(sample.wait_ms >= 0);
  assert.equal(loadEvents(f.dir).events.length, f.seed.length, 'telemetry is not record state');
  fs.unlinkSync(journal); fs.mkdirSync(journal);
  assert.equal(withLock(f.dir, () => 42), 42);
  assert.throws(() => withLock(f.dir, () => { throw Error('original callback error'); }), /original callback error/);
});
