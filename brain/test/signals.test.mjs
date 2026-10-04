import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from '../../test/helpers/bounded-test.mjs';
import { buildDigest, recordDigest } from '../lib/signals.mjs';

const BIN = fileURLToPath(new URL('../bin/brain.mjs', import.meta.url));
const stamp = '2026-10-04T12:00:00.000Z';
function events(rows) {
  return rows.map((e, i) => ({ seq: i + 1, at: stamp, by: 'worker', ...e }));
}
const base = [
  { type: 'item.added', id: 'ENG-1', title: 'A change', meta: { paths: ['brain'] } },
  { type: 'run.started', id: 'R-1', item: 'ENG-1' },
  { type: 'report.ingested', run: 'R-1', item: 'ENG-1', report: { outcome: 'done', learnings: ['Check brain/lib/capture.mjs before parsing a composer.', 'Preserve brain/lib/capture.mjs typed input.'] } },
  { type: 'run.started', id: 'R-2', item: 'ENG-1' },
  { type: 'note.added', id: 'R-2', text: 'Independent review verdict: NEEDS-WORK. [Major] brain/lib/capture.mjs:12 loses typed input.', decision: true },
  { type: 'release.gate.finished', id: 'RC-1', gate: { result: 'failed', detail: 'composer test failed', log: 'gate.log', stage: 'gate', exit_code: 1 } },
  { type: 'note.added', id: 'R-1', text: 'CI failed: brain/test/capture.test.mjs dropped the fixture.' },
  { type: 'note.added', id: 'R-1', text: 'Dispatch refused: record lock held.' },
  { type: 'note.added', id: 'R-1', text: 'Retry after the record lock clears.' },
  { type: 'note.added', id: 'HUM-1', kind: 'answer', text: 'Answered no (overruling yes): keep the loop foreground.', by: 'human' },
  { type: 'future.unknown', id: 'ENG-1' },
];
const signals = d => d.groups.flatMap(g => g.signals);
function fixture(t, rows = base) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-signals-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const orgDir = path.join(root, 'record'), stateDir = path.join(root, 'brain');
  fs.mkdirSync(orgDir);
  const write = rows => fs.writeFileSync(path.join(orgDir, 'events.jsonl'), events(rows).map(JSON.stringify).join('\n') + '\n');
  write(rows);
  return { root, orgDir, stateDir, write };
}

test('digest groups record signals by module and kind and retains evidence and verdicts', () => {
  const d = buildDigest(events(base));
  const rows = signals(d);
  assert.equal(d.count, 9);
  assert.deepEqual(new Set(rows.map(s => s.kind)), new Set(['learning', 'rounds', 'review', 'gate-failure', 'ci-failure', 'refusal', 'retry', 'overrule']));
  const learnings = d.groups.find(g => g.module === 'brain' && g.kind === 'learning');
  assert.equal(learnings.signals.length, 2);
  assert.deepEqual(learnings.signals[0].paths, ['brain/lib/capture.mjs']);
  assert.deepEqual(learnings.signals[0].evidence, ['event:3', 'R-1', 'ENG-1']);
  assert.equal(rows.find(s => s.kind === 'review').verdict, 'NEEDS-WORK');
  assert.equal(rows.find(s => s.kind === 'gate-failure').source, 'gate.log');
  assert.deepEqual(rows.find(s => s.kind === 'gate-failure').evidence, ['event:6']);
  assert.equal(rows.find(s => s.kind === 'rounds').round, 2);
});

test('bounded pages resume inside a report without losing or repeating signals', () => {
  const es = events(base);
  let cursor, all = [], pages = 0;
  do {
    const d = buildDigest(es, { cursor, limit: 1 });
    assert.ok(d.count <= 1);
    all.push(...signals(d).map(s => s.key));
    cursor = d.to;
    pages++;
  } while (cursor.seq < es.at(-1).seq && pages < 20);
  assert.equal(pages, 9);
  assert.deepEqual(all, signals(buildDigest(es)).map(s => s.key));
  assert.equal(new Set(all).size, all.length);
});

test('serialized digest obeys character bounds and makes progress on long signals', () => {
  const es = events([...base, { type: 'note.added', id: 'R-1', text: 'Retry ' + '😀'.repeat(10000) }]);
  let cursor, keys = [];
  for (let i = 0; i < 30; i++) {
    const d = buildDigest(es, { cursor, maxChars: 2048 });
    assert.ok(JSON.stringify(d, null, 2).length <= 2048);
    keys.push(...signals(d).map(s => s.key));
    cursor = d.to;
    if (cursor.seq === es.at(-1).seq) break;
  }
  assert.equal(keys.length, 10);
  assert.throws(() => buildDigest(es, { limit: 0 }), /limit/);
  assert.throws(() => buildDigest(es, { maxChars: 100 }), /max-chars/);
});

test('proposed and active evidence covers signals; retired lessons and shared paths do not', () => {
  const es = events([...base,
    { type: 'lesson.proposed', id: 'L-1', text: 'Claim', scope: 'project', paths: ['brain'], evidence: [{ kind: 'event', seq: 3 }] },
    { type: 'lesson.proposed', id: 'L-2', text: 'Claim', scope: 'project', evidence: [{ kind: 'event', seq: 6 }] },
    { type: 'lesson.activated', id: 'L-2' },
    { type: 'lesson.proposed', id: 'L-3', text: 'Old', scope: 'project', evidence: [{ kind: 'event', seq: 7 }] },
    { type: 'lesson.retired', id: 'L-3', reason: 'No longer helps' },
  ]);
  const d = buildDigest(es);
  assert.equal(d.covered, 3);
  assert.equal(d.count, 6);
  assert.ok(signals(d).some(s => s.kind === 'review'));
  assert.ok(signals(d).some(s => s.kind === 'ci-failure'));
  const byRun = buildDigest(events([...base, { type: 'lesson.proposed', id: 'L-4', evidence: [{ kind: 'run', id: 'R-1' }] }]));
  assert.ok(!signals(byRun).some(s => s.run === 'R-1'));
});

test('cursor advances only on acknowledgement, replays pending output and isolates record identities', t => {
  const f = fixture(t);
  const first = recordDigest({ ...f, limit: 1 });
  assert.deepEqual(recordDigest({ ...f, limit: 1 }), first);
  assert.throws(() => recordDigest({ ...f, ack: 'bogus' }), /pending/);
  recordDigest({ ...f, ack: first.pass });
  assert.deepEqual(recordDigest({ ...f, ack: first.pass }).cursor, first.to, 'lost ack replies are safe to retry');
  const next = recordDigest({ ...f, limit: 1 });
  assert.notEqual(next.pass, first.pass);
  assert.notEqual(signals(next)[0].key, signals(first)[0].key);
  assert.throws(() => recordDigest({ ...f, ack: first.pass }), /pending/);
  const alias = path.join(f.root, 'alias');
  fs.symlinkSync(f.orgDir, alias);
  assert.deepEqual(recordDigest({ ...f, orgDir: alias, limit: 1 }), next);
  const stateAlias = path.join(f.root, 'brain-alias');
  fs.symlinkSync(f.stateDir, stateAlias);
  assert.deepEqual(recordDigest({ ...f, stateDir: stateAlias, limit: 1 }), next);
  const other = path.join(f.root, 'other');
  fs.mkdirSync(other);
  fs.copyFileSync(path.join(f.orgDir, 'events.jsonl'), path.join(other, 'events.jsonl'));
  assert.equal(signals(recordDigest({ ...f, orgDir: other, limit: 1 }))[0].key, signals(first)[0].key);
});

test('new appended events survive acknowledgement; rewritten or truncated records fail closed', t => {
  const f = fixture(t);
  const first = recordDigest(f);
  f.write([...base, { type: 'note.added', id: 'R-1', text: 'Retry a new failure.' }]);
  recordDigest({ ...f, ack: first.pass });
  const next = recordDigest(f);
  assert.equal(next.count, 1);
  recordDigest({ ...f, ack: next.pass });
  f.write(base.slice(0, 2));
  assert.throws(() => recordDigest(f), /cursor|changed/);
});

test('malformed state, interior corruption and sequence changes never silently reset the cursor', t => {
  const f = fixture(t);
  const first = recordDigest(f);
  recordDigest({ ...f, ack: first.pass });
  const log = path.join(f.orgDir, 'events.jsonl');
  const original = fs.readFileSync(log, 'utf8');
  fs.writeFileSync(log, original.replace('A change', 'Changed'));
  assert.throws(() => recordDigest(f), /changed/);
  fs.writeFileSync(log, original + '{broken}\n');
  assert.throws(() => recordDigest(f), /not valid JSON/);
  fs.writeFileSync(log, original + '{"seq":1,"type":"future"}\n');
  assert.throws(() => recordDigest(f), /sequence/);
  fs.writeFileSync(log, original);
  const dir = fs.readdirSync(path.join(f.stateDir, 'distill'))[0];
  fs.writeFileSync(path.join(f.stateDir, 'distill', dir, 'cursor.json'), '{broken');
  assert.throws(() => recordDigest(f), /JSON/);
});

test('settle enrichment uses only verified evidence tied to the recorded run and report', t => {
  const text = '**NEEDS-WORK**\n## Findings\n- [Major] brain/lib/capture.mjs:12 - Drops input; Fix: keep input\n## Re-executed\nNone';
  const f = fixture(t, [...base.slice(0, 3), { type: 'note.added', id: 'R-1', text: 'Settle: fix_round. Evidence follows.' }]);
  f.write([{ ...base[0] }, base[1], { ...base[2], sha256: 'report-hash' }, { type: 'note.added', id: 'R-1', text: `Settle: fix_round. Evidence: ${f.orgDir}/settle/R-1.json` }]);
  const receipt = { run: 'R-1', item: 'ENG-1', org: f.orgDir, reportHash: 'report-hash', settleDecision: `Settle: fix_round. Evidence: ${f.orgDir}/settle/R-1.json`, review: { verdict: 'NEEDS-WORK', text, sha256: createHash('sha256').update(text).digest('hex'), path: 'docs/reviews/one.md' } };
  fs.mkdirSync(path.join(f.orgDir, 'settle'));
  const file = path.join(f.orgDir, 'settle/R-1.json');
  fs.writeFileSync(file, JSON.stringify(receipt));
  const review = signals(recordDigest(f)).find(s => s.kind === 'review');
  assert.match(review.text, /Drops input/);
  assert.equal(review.verdict, 'NEEDS-WORK');
  receipt.review.sha256 = 'wrong';
  fs.writeFileSync(file, JSON.stringify(receipt));
  const fallback = signals(recordDigest(f)).find(s => s.kind === 'review');
  assert.match(fallback.text, /Settle: fix_round/);
  assert.equal(fallback.verdict, null);
  assert.match(fallback.detail, /unavailable/);
});

test('foreground CLI is model-free, read-only on the record, and persists only Brain state', t => {
  const f = fixture(t);
  const env = { ...process.env, BRAIN_STATE: f.stateDir, ORG_DIR: f.orgDir };
  const before = fs.readFileSync(path.join(f.orgDir, 'events.jsonl'), 'utf8');
  const cli = args => spawnSync(process.execPath, [BIN, 'digest', ...args], { env, encoding: 'utf8' });
  const result = cli(['--org', f.orgDir, '--json', '--limit', '2']);
  assert.equal(result.status, 0, result.stderr);
  const digest = JSON.parse(result.stdout);
  assert.equal(digest.count, 2);
  assert.equal(cli(['--org', f.orgDir, '--ack', digest.pass]).status, 0);
  assert.match(cli(['--org', f.orgDir]).stdout, /Record signal digest/);
  assert.notEqual(cli(['--org', f.orgDir, '--limt', '2']).status, 0);
  assert.equal(fs.readFileSync(path.join(f.orgDir, 'events.jsonl'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(f.orgDir), ['events.jsonl']);
});

test('empty and entirely covered records can be acknowledged without a model', t => {
  const f = fixture(t, []);
  const empty = recordDigest(f);
  assert.equal(empty.count, 0);
  assert.equal(empty.more, false);
  recordDigest({ ...f, ack: empty.pass });
  f.write([...base, { type: 'lesson.proposed', id: 'L-1', evidence: events(base).map(e => ({ kind: 'event', seq: e.seq })) }]);
  const covered = recordDigest(f);
  assert.equal(covered.count, 0);
  assert.equal(covered.covered, 9);
  recordDigest({ ...f, ack: covered.pass });
  assert.equal(recordDigest(f).covered, 0);
});

test('torn record writes and overlapping state access refuse without losing a pending pass', t => {
  const f = fixture(t);
  const first = recordDigest(f);
  const log = path.join(f.orgDir, 'events.jsonl');
  fs.appendFileSync(log, '{"seq":');
  assert.throws(() => recordDigest({ ...f, ack: first.pass }), /incomplete/);
  f.write(base);
  const dir = path.join(f.stateDir, 'distill', fs.readdirSync(path.join(f.stateDir, 'distill'))[0]);
  fs.mkdirSync(path.join(dir, 'lock'));
  assert.throws(() => recordDigest(f), /busy/);
  fs.rmdirSync(path.join(dir, 'lock'));
  assert.deepEqual(recordDigest(f), first);
  recordDigest({ ...f, ack: first.pass });
});

test('bare findings, explicit module selectors and unsafe prose paths are handled deterministically', () => {
  const es = events([
    { type: 'item.added', id: 'ENG-1', title: 'Fix', meta: { paths: ['brain'], modules: ['capture'] } },
    { type: 'note.added', id: 'ENG-1', text: '[Minor] brain/lib/capture.mjs:12 - Expand the fixture.' },
    { type: 'note.added', id: 'ENG-1', text: 'Retry https://example.com/file.mjs /outside/file.mjs ../escape/file.mjs a/../escape.mjs.' },
    { type: 'item.added', id: 'ENG-2', title: 'Old metadata', meta: { paths: 'brain', modules: 1 } },
    { type: 'note.added', id: 'ENG-2', text: 'Retry without selectors.' },
  ]);
  const d = buildDigest(es);
  assert.equal(signals(d)[0].kind, 'review');
  assert.equal(signals(d)[0].module, 'capture');
  assert.deepEqual(signals(d)[1].paths, ['brain']);
  assert.equal(signals(d)[2].module, 'record');
});
