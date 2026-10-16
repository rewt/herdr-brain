import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateRow, validateDocument, safeLog, safeStatus, WITHHELD } from '../board/rows.mjs';
import { boardFixture } from './helpers/board-fixture.mjs';

const set = (object, field, value) => { const keys = field.split('.'); const key = keys.pop(); let target = object; for (const k of keys) target = target[k]; target[key] = value; };
const get = (object, field) => field.split('.').reduce((o, k) => o[k], object);
test('board validator accepts the contract example, nullables, bounds and ignores unknown keys', t => {
  const f = boardFixture(t), raw = f.row(); raw.notes = 'PLANTED-RAW'; raw.where.extra = 'PLANTED-RAW';
  const safe = validateRow(raw, f.options);
  assert.deepEqual(safe, { project: 'bch-cloak', ...f.row() });
  assert.equal(JSON.stringify(safe).includes('PLANTED-RAW'), false);
  for (const [field, values] of Object.entries({ item: [null, 'X9-0'], lane: [null, 'a/b._-'],
    'stage.n': [1, 7], startedAt: [null, '2026-10-16T12:00:00+02:00'], 'result.exit': [null, 0, 255],
    'result.main': [null, 'ABCDEF0123456789'.repeat(2) + '01234567'] })) {
    for (const value of values) { const row = f.row(); set(row, field, value); assert.equal(get(validateRow(row, f.options), field), value, field); }
  }
  for (const kind of ['promotion', 'gate', 'certification', 'preparation', 'release']) assert.equal(validateRow({ ...raw, kind }, f.options).kind, kind);
  for (const phase of ['queued', 'admission', 'stage', 'reconcile', 'landed', 'failed', 'interrupted', 'unknown']) assert.equal(validateRow({ ...raw, phase }, f.options).phase, phase);
  assert.equal(validateRow({ ...raw, stage: { n: 999, m: 999 } }, f.options).stage.m, 999);
  assert.equal(validateRow({ ...raw, clocks: [] }, f.options).clocks.length, 0);
  assert.equal(validateDocument(f.document(), f.options).generatedAt, f.document().generatedAt);
  assert.equal(safeStatus('secrecy 15 hex abcdef012345678'), 'secrecy 15 hex abcdef012345678');
});
test('board validator withholds every rule violation and close lookalike without dropping the row', t => {
  const f = boardFixture(t);
  const cases = {
    id: ['', 'x'.repeat(81), 'safe/id', 'a\n'], item: ['eng-1', 'ENG-1x', 'ENG_1', 1],
    lane: ['/lane', 'Lane', 'a'.repeat(82), 'lane space'], kind: ['promotions', 'Promotion'], phase: ['stages', 'Stage'],
    stage: [{ n: 0, m: 2 }, { n: 3, m: 2 }, { n: 1, m: 1000 }, { n: 1.5, m: 2 }, { n: '1', m: 2 }],
    startedAt: ['2026-10-16', '2026-10-16T12:00:00', '2026-99-99T99:99:99Z', 0], phaseAt: ['yesterday'], endedAt: ['soon'],
    clocks: [new Array(5).fill({ label: 'gate', seconds: 1, legacy: false }), {}],
    'clocks.0.label': ['', 'Gate', 'x'.repeat(33), 'gate/clock'], 'clocks.0.seconds': [-1, 1.5, '1'], 'clocks.0.legacy': ['false', null],
    'status.code': ['', 'Running', 'x'.repeat(41), 'stage running'],
    'status.text': ['x'.repeat(97), '/tmp/path', '~/path', 'abcdef0123456789', 'PLANTED_secret_123', 'value!'],
    'result.exit': [-1, 256, 1.5, '0'], 'result.main': ['a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40)],
    'result.candidate': ['a'.repeat(39), 'g'.repeat(40)],
    'where.pane': ['w2XS:p4x', 'w2XS:t4', 'w:p4', 'w2XS:p4\n'], worktree: ['relative', f.log],
  };
  for (const [field, values] of Object.entries(cases)) for (const value of values) {
    const doc = f.document(); set(doc.rows[0], field, value);
    const safe = validateDocument(doc, f.options);
    assert.equal(safe.rows.length, 1, field);
    assert.equal(get(safe.rows[0], field), WITHHELD, `${field}: ${JSON.stringify(value)}`);
  }
  for (const project of ['BCH', 'x'.repeat(41), 'bch/cloak', 'a\n', '']) assert.equal(validateDocument({ ...f.document(), project }, f.options).project, WITHHELD);
  for (const code of ['secret', 'token', 'passw', 'mnemonic', 'seed', 'private', 'witness', 'bearer', 'auth', 'cookie', 'key=']) {
    assert.equal(safeStatus(`stage ${code}PLANTED`), WITHHELD);
  }
  assert.equal(validateDocument({ schema: 'board-rows/v2', rows: [] }, f.options).rows[0].status.code, 'source-schema');
});
test('board rejects terminal controls in every string field and rejects unsafe log paths', t => {
  const f = boardFixture(t);
  for (const field of ['id', 'item', 'lane', 'kind', 'phase', 'startedAt', 'phaseAt', 'endedAt', 'clocks.0.label', 'status.code', 'status.text', 'result.main', 'result.candidate', 'where.pane', 'where.log', 'worktree']) {
    for (const control of ['\x1b[31m', '\n', '\r', '\t', '\x7f', '\x9b']) {
      const row = f.row(); set(row, field, String(get(row, field) ?? '') + control);
      assert.equal(get(validateRow(row, f.options), field), WITHHELD, field);
    }
  }
  const outside = f.write('outside/job.log', 'outside');
  assert.equal(safeLog(outside, [path.join(f.root, 'logs')]), WITHHELD);
  const link = path.join(f.root, 'logs/link.log'); fs.symlinkSync(f.log, link);
  const directoryLink = path.join(f.root, 'linked'); fs.symlinkSync(path.join(f.root, 'logs'), directoryLink);
  for (const file of [link, path.join(directoryLink, 'job.log'), `${f.root}/logs/../logs/job.log`, path.join(f.root, 'logs'), f.write('secret-data/job.log', ''), f.write('logs/cookie.log', '')]) assert.equal(safeLog(file, [f.root]), WITHHELD, file);
  assert.equal(safeLog(f.log, [f.root]), f.log);
  assert.equal(validateRow(f.row(), { ...f.options, panes: new Set() }).where.pane, WITHHELD);
});
