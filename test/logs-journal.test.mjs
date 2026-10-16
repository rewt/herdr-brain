import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import io from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LogJournal, LIMITS } from '../logs/journal.mjs';
import { canonical, MAX_EVENT_BYTES } from '../messages/schema.mjs';
import { sourceGap } from '../logs/inputs.mjs';
import { logFixture, AT, at } from './helpers/log-fixture.mjs';

test('append-once survives restart, conflicts, private files and immediate contention', async t => {
  const f = logFixture(t), first = await f.journal.append(f.event());
  assert.equal(first.disposition, 'accepted');
  const restarted = new LogJournal(f.scope), second = await restarted.append(f.event());
  assert.deepEqual(second.cursor, first.cursor); assert.equal(second.disposition, 'duplicate');
  await assert.rejects(restarted.append({ ...f.event(), payload: { changed: true } }), /conflict/);
  await assert.rejects(restarted.append({ ...f.event(2), eventId: f.event().eventId }), /conflict/);
  await assert.rejects(restarted.append({ ...f.event(), eventId: 'another' }), /conflict/);
  assert.equal((await restarted.read()).entries.length, 1);
  const lock = path.join(f.journal.directory, 'log-writer.lock'); fs.writeFileSync(lock, 'fixture owner', { mode: 0o600 });
  await assert.rejects(restarted.append(f.event(2)), /writer locked/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'fixture owner'); fs.unlinkSync(lock);
  await restarted.append(f.event(2));
  assert.equal(fs.statSync(f.journal.directory).mode & 0o077, 0);
  for (const name of fs.readdirSync(f.journal.directory)) assert.equal(fs.statSync(path.join(f.journal.directory, name)).mode & 0o077, 0);
  assert.equal(fs.existsSync(path.join(f.journal.directory, 'shadow.jsonl')), false);
  assert.equal(LIMITS.retentionBytes, 256 * 1024 * 1024); assert.equal(LIMITS.retentionMs, 7 * 86400000);
});

test('acceptance waits for data and directory fsync; failed sync can retry the durable line', async t => {
  const f = logFixture(t); let release, entered, complete = false, dataSynced = false, directorySynced = false;
  const waiting = new Promise(resolve => entered = resolve), barrier = new Promise(resolve => release = resolve);
  const instrumented = { ...io, open: async (file, ...args) => {
    const handle = await io.open(file, ...args), sync = handle.sync.bind(handle);
    if (path.basename(file).startsWith('segment-')) handle.sync = async () => { entered(); await barrier; await sync(); dataSynced = true; };
    else if (file === f.journal.directory) handle.sync = async () => { assert.equal(dataSynced, true); await sync(); directorySynced = true; };
    return handle;
  } };
  const journal = new LogJournal({ ...f.scope, io: instrumented });
  const pending = journal.append(f.event()).then(value => { complete = true; return value; });
  await waiting; assert.equal(complete, false); assert.equal(dataSynced, false);
  await assert.rejects(f.journal.append(f.event(2)), /writer locked/, 'second writer fails while the first is still waiting for fsync');
  release();
  await pending; assert.equal(directorySynced, true);
  let failed = false;
  const broken = { ...io, open: async (file, ...args) => {
    const handle = await io.open(file, ...args);
    if (path.basename(file).startsWith('segment-') && (args[0] & fs.constants.O_APPEND) && !failed) handle.sync = async () => { failed = true; throw Error('fixture fsync failed'); };
    return handle;
  } };
  await assert.rejects(new LogJournal({ ...f.scope, io: broken }).append(f.event(2)), /fsync failed/);
  assert.equal((await f.journal.append(f.event(2))).disposition, 'duplicate');
  assert.equal((await f.journal.read()).entries.length, 2);
});

test('a real process exit leaves torn bytes and lock; explicit repair archives evidence and replay resumes', async t => {
  const f = logFixture(t); await f.journal.append(f.event());
  const script = `import io from 'node:fs/promises'; import {LogJournal} from ${JSON.stringify(new URL('../logs/journal.mjs', import.meta.url).href)};
    const original=io.open; const broken={...io,open:async(file,...args)=>{const h=await original(file,...args);if(file.includes('segment-')) h.writeFile=async bytes=>{await h.write(bytes.subarray(0,71));await h.sync();process.exit(23);};return h;}};
    await new LogJournal({...${JSON.stringify({ ...f.scope, clock: undefined })},io:broken}).append(${JSON.stringify(f.event(2))});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 23, child.stderr);
  const state = await f.journal.read(); assert.equal(state.entries.length, 1); assert.equal(state.tornTail.bytes, 71);
  await assert.rejects(f.journal.append(f.event(2)), /writer locked/);
  // The child has exited. This is explicit fixture owner inspection/removal,
  // never an automatic stale-lock takeover in the product.
  fs.unlinkSync(path.join(f.journal.directory, 'log-writer.lock'));
  await assert.rejects(f.journal.append(f.event(2)), /torn log tail/);
  const repaired = await f.journal.repair();
  assert.equal(repaired.type, 'service.journal.repaired');
  const evidence = fs.readFileSync(path.join(f.journal.directory, repaired.payload.evidence));
  assert.equal(evidence.length, repaired.payload.offset + 71);
  assert.equal((await f.journal.read()).tornTail, null);
  await f.journal.append(f.event(2));
  assert.equal((await f.journal.read()).entries.filter(e => e.eventId === 'fixture:2').length, 1);
});

test('corrupt middle records and missing segments are never skipped or repaired', async t => {
  const f = logFixture(t, { limits: { segmentBytes: 1 } });
  await f.journal.append(f.event()); await f.journal.append(f.event(2));
  const first = (await f.journal.read()).segments[0].name, file = path.join(f.journal.directory, first), before = fs.readFileSync(file);
  fs.appendFileSync(file, '{broken}\n');
  await assert.rejects(f.journal.read(), /corrupt log segment/);
  await assert.rejects(f.journal.repair(), /corrupt log segment/);
  assert.deepEqual(fs.readFileSync(file), Buffer.concat([before, Buffer.from('{broken}\n')]));
  fs.writeFileSync(file, before); fs.unlinkSync(file);
  await assert.rejects(f.journal.read(), /sequence gap/);
});

test('segment retention journals floor/ranges before deletion, rejects stale producers and returns subscriber gaps', async t => {
  const f = logFixture(t, { limits: { segmentBytes: 1, retentionBytes: 2600 } });
  const first = (await f.journal.append(f.event())).cursor;
  for (let n = 2; n <= 8; n++) await f.journal.append(f.event(n));
  const state = await f.journal.read(); assert.ok(state.floor.sequence > 1);
  assert.ok(state.segments.reduce((n, s) => n + s.bytes, 0) <= 2600);
  assert.ok(state.entries.some(e => e.type === 'service.retention' && e.payload.count > 0 && e.payload.sequenceRanges.length));
  await assert.rejects(f.journal.append(f.event()), /replay horizon/);
  const subscriber = await f.journal.subscribe('viewer', { cursor: { ...first, sequence: 0 }, acknowledge: true, limit: 2 });
  assert.ok(subscriber.gap); assert.deepEqual(subscriber.gap.floor, state.floor); assert.equal(subscriber.entries.length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.journal.directory, 'subscriber-viewer.json'))), subscriber.next);
  const next = await new LogJournal(f.scope).subscribe('viewer'); assert.ok(next.entries.every(e => e.cursor.sequence > subscriber.next.sequence));
  const other = await f.journal.subscribe('other'); assert.equal(other.entries[0].cursor.sequence, state.floor.sequence);
  await assert.rejects(f.journal.subscribe('../escape'), /subscriber id/);
  await assert.rejects(f.journal.subscribe('viewer', { cursor: { epoch: first.epoch, sequence: 999 } }), /ahead/);
  assert.ok((await f.journal.subscribe('new-epoch', { cursor: { epoch: 'old', sequence: 3 } })).gap);
});

test('retention recovers a crash after its deletion intent and repair can reuse durable evidence', async t => {
  const f = logFixture(t, { limits: { segmentBytes: 1 } });
  for (let n = 1; n <= 5; n++) await f.journal.appendRaw(f.event(n));
  let interrupted = false;
  const broken = { ...io, unlink: async file => {
    if (!interrupted && path.basename(file).startsWith('segment-')) { interrupted = true; throw Error('fixture deletion interrupted'); }
    return io.unlink(file);
  } };
  const limited = { ...f.scope, limits: { segmentBytes: 1, retentionBytes: 2300 } };
  await assert.rejects(new LogJournal({ ...limited, io: broken }).retain(), /deletion interrupted/);
  const intent = (await f.journal.read()).entries.at(-1); assert.equal(intent.type, 'service.retention');
  const recovered = new LogJournal(limited); await recovered.retain();
  const state = await recovered.read(); assert.ok(state.entries.every(e => e.cursor.sequence >= intent.payload.floor));
  assert.ok(state.segments.reduce((n, s) => n + s.bytes, 0) <= 2300);
  const last = path.join(f.journal.directory, state.segments.at(-1).name); fs.appendFileSync(last, '{torn');
  const failingRepair = { ...io, open: async (file, ...args) => {
    const handle = await io.open(file, ...args);
    if (path.basename(file).startsWith('segment-') && args[0] === fs.constants.O_WRONLY + fs.constants.O_NOFOLLOW) handle.truncate = async () => { throw Error('fixture truncate interrupted'); };
    return handle;
  } };
  await assert.rejects(new LogJournal({ ...f.scope, io: failingRepair }).repair(), /truncate interrupted/);
  assert.ok(fs.readdirSync(f.journal.directory).some(n => n.endsWith('.evidence')));
  await f.journal.repair(); assert.equal((await f.journal.read()).tornTail, null);
});

test('age retention and source loss are visible durable observations', async t => {
  const f = logFixture(t); await f.journal.append(f.event());
  const old = new LogJournal({ ...f.scope, clock: () => at(8 * 24 * 60) });
  await old.retain(); const state = await old.read();
  assert.equal(state.entries.length, 1); assert.equal(state.entries[0].type, 'service.retention');
  const event = sourceGap({ source: 'fixture-feed', reason: 'events_lost', count: 12, sequenceRanges: [[3, 14]] }, old, AT);
  await old.append(event); await old.append(event);
  assert.equal((await old.read()).entries.filter(e => e.type === 'service.source.gap').length, 1);
});

test('retention checkpoints more producers than fit one control and keeps making progress after restart', async t => {
  const f = logFixture(t, { limits: { segmentBytes: 1, retentionBytes: 2400 } }), producers = [];
  for (let n = 1; n <= 260; n++) {
    const event = { ...f.event(n), producer: { id: `fixture-${n}-${'x'.repeat(64)}`, epoch: 'y'.repeat(64), sequence: 1 } };
    producers.push(event); await f.journal.appendRaw(event);
  }
  const first = await f.journal.retain(), state = await f.journal.read();
  assert.ok(first.payload.watermarkCheckpoint.bytes > MAX_EVENT_BYTES);
  assert.ok(Buffer.byteLength(canonical(first)) <= MAX_EVENT_BYTES);
  assert.equal(Object.keys(state.watermarks).length, first.payload.count);
  assert.ok(Object.keys(state.watermarks).length >= 250);
  assert.ok(state.segments.reduce((n, s) => n + s.bytes, 0) <= 2400);
  const checkpointFile = path.join(f.journal.directory, `watermarks-${state.checkpoint.sha256}.jsonl`);
  assert.equal(fs.statSync(checkpointFile).mode & 0o077, 0);
  for (const row of fs.readFileSync(checkpointFile, 'utf8').trim().split('\n')) assert.ok(Buffer.byteLength(row) <= MAX_EVENT_BYTES);
  const restarted = new LogJournal(f.scope);
  await assert.rejects(restarted.append(producers[0]), /replay horizon/);
  for (let n = 261; n <= 266; n++) {
    const result = await restarted.append({ ...f.event(n), producer: { id: `new-${n}`, epoch: 'new', sequence: 1 } });
    assert.equal(result.disposition, 'accepted'); assert.equal(result.followUp, undefined);
  }
  const after = await restarted.read(); assert.ok(Object.keys(after.watermarks).length >= 260);
  assert.ok(after.segments.reduce((n, s) => n + s.bytes, 0) <= 2400);
  assert.equal(fs.readdirSync(f.journal.directory).filter(n => n.startsWith('watermarks-')).length, 1);
  assert.ok(after.floor.sequence > state.floor.sequence);
});

test('checkpoint bytes alone are not a retention commit; committed checkpoints are verified and preserved', async t => {
  const f = logFixture(t, { limits: { segmentBytes: 1, retentionBytes: 2000 } });
  for (let n = 1; n <= 6; n++) await f.journal.appendRaw(f.event(n));
  f.journal.io = { ...io, open: async (file, ...args) => {
    const handle = await io.open(file, ...args);
    if (path.basename(file).startsWith('watermarks-') && file.endsWith('.tmp')) handle.writeFile = async bytes => {
      await handle.write(bytes.subarray(0, 9)); await handle.sync(); throw Error('fixture partial checkpoint write');
    };
    return handle;
  } };
  await assert.rejects(f.journal.retain(), /partial checkpoint write/);
  assert.equal((await f.journal.read()).floor.sequence, 1);
  assert.ok(fs.readdirSync(f.journal.directory).some(n => n.endsWith('.tmp')));
  f.journal.io = io;
  const write = f.journal.write;
  f.journal.write = async () => { throw Error('fixture before retention commit'); };
  await assert.rejects(f.journal.retain(), /before retention commit/);
  let state = await f.journal.read(); assert.equal(state.floor.sequence, 1); assert.deepEqual(state.watermarks, {});
  assert.equal(state.entries.length, 6); assert.ok(fs.readdirSync(f.journal.directory).some(n => n.startsWith('watermarks-')));
  f.journal.write = write;
  await f.journal.retain(); state = await f.journal.read();
  const file = path.join(f.journal.directory, `watermarks-${state.checkpoint.sha256}.jsonl`), bytes = fs.readFileSync(file);
  fs.writeFileSync(file, 'corrupt\n'); await assert.rejects(f.journal.read(), /checkpoint digest\/size/);
  fs.writeFileSync(file, bytes);
  fs.renameSync(file, file + '.saved'); fs.symlinkSync(file + '.saved', file);
  await assert.rejects(f.journal.read(), /ELOOP/);
});

test('a committed append returns its cursor when detector or retention follow-up fails, then reconciles', async t => {
  const f = logFixture(t), event = f.event(1, 'worker.observation', { validated: true, process: 'stopped', report: 'absent' }, { run: 'R-1' });
  const reconcile = f.journal.reconcileDetectors, retain = f.journal.retain;
  let retained = false;
  f.journal.reconcileDetectors = async () => {
    // Simulate an unlocked observation seeing another writer's partial line.
    throw Error('torn log tail observed during concurrent append');
  };
  f.journal.retain = async () => { retained = true; };
  const result = await f.journal.append(event);
  assert.equal(result.disposition, 'accepted'); assert.deepEqual(result.cursor, (await f.journal.read()).entries[0].cursor);
  assert.deepEqual(result.followUp, [{ phase: 'detectors', error: 'torn log tail observed during concurrent append' }]);
  assert.equal(retained, false, 'retain source evidence for the next detector pass');
  f.journal.reconcileDetectors = reconcile;
  f.journal.retain = async () => { throw Error('log writer locked'); };
  const retry = await f.journal.append(event);
  assert.equal(retry.disposition, 'duplicate'); assert.deepEqual(retry.cursor, result.cursor);
  assert.deepEqual(retry.followUp, [{ phase: 'retention', error: 'log writer locked' }]);
  f.journal.retain = retain;
  const recovered = await f.journal.append(event); assert.equal(recovered.followUp, undefined);
  assert.equal((await f.journal.read()).entries.filter(e => e.type === 'detector.hit').length, 1);
  const appendRaw = f.journal.appendRaw.bind(f.journal), lock = path.join(f.journal.directory, 'log-writer.lock');
  f.journal.appendRaw = async (input, internal) => {
    const result = await appendRaw(input, internal);
    if (!internal) fs.writeFileSync(lock, 'fixture concurrent writer', { mode: 0o600 });
    return result;
  };
  const next = { ...f.event(2, 'worker.observation', event.payload, { run: 'R-2' }) };
  const contended = await f.journal.append(next);
  assert.equal(contended.disposition, 'accepted'); assert.equal(contended.followUp[0].phase, 'detectors');
  assert.match(contended.followUp[0].error, /writer locked/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'fixture concurrent writer');
  fs.unlinkSync(lock); f.journal.appendRaw = appendRaw;
  const retryNext = await f.journal.append(next); assert.deepEqual(retryNext.cursor, contended.cursor); assert.equal(retryNext.followUp, undefined);
});

test('private resolver and all owned files refuse symlinks, nonprivate files and replaced roots', async t => {
  const f = logFixture(t); await f.journal.append(f.event());
  const state = await f.journal.read(), file = path.join(f.journal.directory, state.segments[0].name), copy = path.join(f.root, 'copy');
  fs.renameSync(file, copy); fs.symlinkSync(copy, file);
  await assert.rejects(f.journal.read(), /ELOOP/); fs.unlinkSync(file); fs.renameSync(copy, file);
  fs.chmodSync(file, 0o644); await assert.rejects(f.journal.append(f.event(2)), /private regular file/); fs.chmodSync(file, 0o600);
  const moved = f.scope.root + '-moved'; fs.renameSync(f.scope.root, moved); fs.symlinkSync(moved, f.scope.root);
  await assert.rejects(f.journal.read(), /symlink/); await assert.rejects(f.journal.append(f.event(2)), /symlink/);
});
