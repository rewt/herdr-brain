import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { serialize, deserialize } from 'node:v8';
import { createHash } from 'node:crypto';
import { initOrg, loadRecord, loadRecordReader, transact } from '../lib/store.mjs';
import { READER_FILE, readerVersion } from '../lib/record-reader.mjs';

const stamp = '2026-10-30T12:00:00.000Z';
const encode = events => events.map(e => JSON.stringify(e) + '\n').join('');
function fixture(t, events = [
  { type: 'item.added', id: 'ENG-1', title: 'alpha' },
  { type: 'run.started', id: 'R-1', item: 'ENG-1' },
  { type: 'run.claimed', run: 'R-1', owner: { controller: 'brain' } },
]) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'record-reader-')));
  const fleet = process.env.HERDR_MONITOR_FLEET;
  process.env.HERDR_MONITOR_FLEET = path.join(dir, 'no-fleet.json');
  t.after(() => { if (fleet === undefined) delete process.env.HERDR_MONITOR_FLEET; else process.env.HERDR_MONITOR_FLEET = fleet; fs.rmSync(dir, { recursive: true, force: true }); });
  initOrg(dir);
  const file = path.join(dir, 'events.jsonl'), cache = path.join(dir, READER_FILE);
  const seed = events.map((event, i) => ({ seq: i + 1, at: stamp, by: 'fixture', ...event }));
  fs.writeFileSync(file, encode(seed));
  const append = event => transact(dir, () => ({ add: [event] }), { actor: 'fixture' }).added[0];
  return { dir, file, cache, seed, append };
}
function materialize(reader) {
  const state = { ...reader.state };
  for (const key of ['items', 'runs', 'lessons', 'candidates', 'workerReceipts', 'sessionBindings', 'obligations']) state[key] = new Map(state[key]);
  return state;
}
function equivalent(f) {
  const reader = loadRecordReader(f.dir);
  try {
    const full = loadRecord(f.dir, { snapshot: false });
    assert.deepEqual(materialize(reader), full.state);
    assert.deepEqual([...reader.events()], full.events);
    assert.equal(reader.tornTail, full.tornTail);
    assert.equal(reader.position.events, full.events.length);
    assert.equal(reader.position.bytes, fs.statSync(f.file).size);
    assert.equal(reader.position.version, readerVersion);
    assert.equal(reader.fresh(), true);
    return reader.snapshot;
  } finally { reader.close(); }
}

test('compact facts and streamed history equal replay across claims, reports, reopen, late reports and old-writer tails', t => {
  const f = fixture(t);
  assert.equal(equivalent(f).used, false);
  assert.equal(equivalent(f).used, true);
  const tail = [
    { type: 'item.added', id: 'ENG-2', parent: 'ENG-1', title: 'child' },
    { type: 'link.added', blocker: 'ENG-1', blocked: 'ENG-2' },
    { type: 'run.updated', id: 'R-1', meta: { agent: 'worker', pane: 'w:p', worker_workspace: 'w', terminal_id: 'term' } },
    { type: 'run.session_bound', run: 'R-1', session: 'session' },
    { type: 'report.ingested', run: 'R-1', report: { outcome: 'done' }, file: 'R-1.md', sha256: 'one' },
    { type: 'item.reopened', id: 'ENG-1' },
    { type: 'run.started', id: 'R-2', item: 'ENG-1' },
    { type: 'report.ingested', run: 'R-2', report: { outcome: 'blocked' }, file: 'R-2.md' },
    { type: 'report.ingested', run: 'R-1', report: { outcome: 'done' }, file: 'late.md' },
    { type: 'item.acceptance-amended', id: 'ENG-1', accept: ['current'], why: 'updated' },
    { type: 'note.added', id: 'ENG-1', text: 'é'.repeat(300000) },
    { type: 'future.event', run: 'R-2', held: 'UNKNOWN' },
  ].map((event, i) => ({ seq: i + 4, at: stamp, by: 'old-writer', ...event }));
  fs.appendFileSync(f.file, encode(tail));
  assert.equal(equivalent(f).tailEvents, tail.length);
  const r = loadRecordReader(f.dir);
  try {
    assert.equal(r.state.runs.get('R-1').owner_generation, 3);
    assert.equal(r.state.runs.get('R-1').report.late, true);
    assert.equal(r.state.items.get('ENG-1').outcome.value, 'blocked');
    assert.deepEqual([...r.events({ afterSeq: 14 })].map(e => e.seq), [15]);
    r.state.items.get('ENG-1').title = 'caller mutation';
    assert.equal(r.state.items.get('ENG-1').title, 'alpha');
    assert.equal(r.state.items.set, undefined);
  } finally { r.close(); r.close(); }
  assert.throws(() => r.state.items.get('ENG-1'), /closed/);
});

test('bounded fold batches preserve references inside one event with many sibling runs and restoration events', t => {
  const events = [{ type: 'item.added', id: 'ENG-1', title: 'history' }];
  for (let i = 1; i <= 300; i++) events.push({ type: 'run.started', id: `R-${i}`, item: 'ENG-1' });
  events.push({ type: 'report.ingested', run: 'R-300', report: { outcome: 'done' } },
    { type: 'report.ingested', run: 'R-1', report: { outcome: 'blocked' } },
    { type: 'lesson.proposed', id: 'L-1', text: 'lesson', evidence: [] }, { type: 'lesson.activated', id: 'L-1' },
    { type: 'release.cut', id: 'RC-1', commit: 'abc' }, { type: 'release.gate.finished', id: 'RC-1', gate: { result: 'PASS' } },
    { type: 'category.flagged', id: 'ENG-1', source: 'fixture', category: 'design', signals: [] },
    { type: 'line.priority-holds-migrated', changes: [{ id: 'ENG-1', after: { held: true } }] });
  const f = fixture(t, events); equivalent(f);
  const original = loadRecord(f.dir).state.items.get('ENG-1');
  f.append({ type: 'decision.restored', items: [{ ...original, title: 'restored' }], links: [], decision: 'ENG-1' });
  equivalent(f);
});

for (const damage of ['checksum', 'truncated', 'version', 'foreign']) test(`${damage} compact projections rebuild from the authoritative log`, t => {
  const f = fixture(t); equivalent(f);
  const bytes = fs.readFileSync(f.cache);
  if (damage === 'checksum') { bytes[0] ^= 1; fs.writeFileSync(f.cache, bytes); }
  else if (damage === 'truncated') fs.writeFileSync(f.cache, bytes.subarray(0, 20));
  else {
    const footer = bytes.subarray(-72), length = Number(footer.readBigUInt64BE()), start = bytes.length - 72 - length;
    const header = deserialize(bytes.subarray(start, start + length));
    if (damage === 'version') header.version = 'another-reader'; else header.source.file = '/foreign/events.jsonl';
    const body = serialize(header), next = Buffer.from(footer);
    next.writeBigUInt64BE(BigInt(body.length)); createHash('sha256').update(body).digest().copy(next, 8);
    fs.writeFileSync(f.cache, Buffer.concat([bytes.subarray(0, start), body, next]));
  }
  assert.equal(equivalent(f).used, false);
  assert.equal(equivalent(f).used, true);
});

for (const change of ['replacement', 'truncation', 'rewrite', 'rewrite+append']) test(`${change} invalidates old compact state and positions`, t => {
  const f = fixture(t), old = loadRecordReader(f.dir), text = fs.readFileSync(f.file, 'utf8');
  try {
    if (change === 'replacement') { fs.renameSync(f.file, f.file + '.old'); fs.writeFileSync(f.file, text.replace('alpha', 'bravo')); }
    else if (change === 'truncation') fs.writeFileSync(f.file, encode(f.seed.slice(0, 1)));
    else fs.writeFileSync(f.file, text.replace('alpha', 'bravo') + (change === 'rewrite+append' ? encode([{ type: 'future.event', seq: 4 }]) : ''));
    assert.equal(old.fresh(), false); assert.throws(() => old.verify(), { code: 'RECORD_READER_STALE' });
    assert.throws(() => [...old.events()], { code: 'RECORD_READER_STALE' });
    assert.equal(old.state.items.get('ENG-1').title, 'alpha', 'already opened immutable facts retain their position');
    assert.equal(equivalent(f).used, false);
  } finally { old.close(); }
});

test('old readers retain exact facts across concurrent append, while scans refuse mixed positions and fresh readers apply tails', t => {
  const f = fixture(t), old = loadRecordReader(f.dir), cursor = old.events();
  try {
    assert.equal(cursor.next().value.seq, 1);
    f.append({ type: 'note.added', id: 'ENG-1', text: 'concurrent writer' });
    assert.equal(old.state.items.get('ENG-1').notes.length, 0);
    assert.equal(old.fresh(), false);
    assert.throws(() => [...cursor], { code: 'RECORD_READER_STALE' });
    const result = equivalent(f); assert.equal(result.used, true); assert.equal(result.tailEvents, 1);
    assert.equal(old.state.items.get('ENG-1').notes.length, 0);
  } finally { old.close(); }
});

test('a write during initial preparation is refreshed before publication, without exposing a mixed view', t => {
  const f = fixture(t), read = fs.readSync; let injected = false;
  fs.readSync = function (...args) {
    const count = read.apply(this, args);
    if (!injected) { injected = true; fs.appendFileSync(f.file, encode([{ seq: 4, type: 'note.added', id: 'ENG-1', text: 'raced', at: stamp }])); }
    return count;
  };
  try {
    const r = loadRecordReader(f.dir);
    try { assert.equal(r.position.events, 4); assert.equal(r.state.items.get('ENG-1').notes[0].text, 'raced'); r.verify(); }
    finally { r.close(); }
  } finally { fs.readSync = read; }
  equivalent(f);
});

test('concurrent compact publishers and a compatible writer preserve all committed facts and the original log', async t => {
  const f = fixture(t), module = new URL('../lib/store.mjs', import.meta.url).href;
  const writer = `import {transact} from ${JSON.stringify(module)};for(let i=0;i<12;i++)transact(process.argv[1],()=>({add:[{type:'note.added',id:'ENG-1',text:'writer '+i}]}),{actor:'fixture'});`;
  const reader = `import {loadRecordReader} from ${JSON.stringify(module)};for(let i=0;i<12;i++){let r;try{r=loadRecordReader(process.argv[1]);if(r.state.items.get('ENG-1').id!=='ENG-1')throw Error('mixed view');}catch(e){if(!/changed repeatedly/.test(e.message))throw e;}finally{r?.close();}}`;
  const workers = [writer, reader, reader].map(script => spawn(process.execPath, ['--input-type=module', '-e', script, f.dir], {
    env: { ...process.env, HERDR_MONITOR_FLEET: path.join(f.dir, 'no-fleet.json') }, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  await Promise.all(workers.map(async child => {
    let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; }); child.stdout.resume();
    const [code] = await once(child, 'exit'); assert.equal(code, 0, stderr);
  }));
  equivalent(f);
  const final = loadRecord(f.dir, { snapshot: false });
  assert.equal(final.state.items.get('ENG-1').notes.length, 12);
  assert.deepEqual(final.events.map(e => e.seq), Array.from({ length: 15 }, (_, i) => i + 1));
});

test('torn tails, valid EOF, blank lines, invalid complete JSON and read-only cache failures retain log truth', t => {
  const f = fixture(t); equivalent(f);
  fs.appendFileSync(f.file, '\n{"seq":4,"type":');
  equivalent(f);
  assert.throws(() => transact(f.dir, () => ({}), { strictTail: true }), /incomplete record tail/);
  f.append({ type: 'note.added', id: 'ENG-1', text: 'repaired by existing writer' }); equivalent(f);
  fs.appendFileSync(f.file, JSON.stringify({ type: 'note.added', id: 'ENG-1', text: 'EOF é', seq: 5, at: stamp }));
  equivalent(f);
  f.append({ type: 'future.event' }); equivalent(f);
  fs.unlinkSync(f.cache); fs.mkdirSync(f.cache);
  assert.equal(equivalent(f).used, false, 'nonregular cache targets never replace authority');
  fs.appendFileSync(f.file, 'not-json\n');
  assert.throws(() => loadRecordReader(f.dir), /not valid JSON/);
  assert.equal(fs.statSync(f.cache).isDirectory(), true);
});

test('compact CLI show preserves full JSON and text for items and runs', t => {
  const f = fixture(t);
  f.append({ type: 'note.added', id: 'ENG-1', text: 'history' });
  const env = { ...process.env, ORG_DIR: f.dir, ORG_NOW: stamp, HERDR_MONITOR_FLEET: path.join(f.dir, 'no-fleet.json') };
  for (const id of ['ENG-1', 'R-1']) for (const format of [[], ['--json']]) {
    const args = [new URL('../bin/org.mjs', import.meta.url).pathname, 'show', id, ...format];
    const full = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
    const compact = spawnSync(process.execPath, [...args, '--compact'], { env, encoding: 'utf8' });
    assert.equal(full.status, 0, full.stderr); assert.equal(compact.status, 0, compact.stderr);
    assert.equal(compact.stdout, full.stdout);
  }
});
