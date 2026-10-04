import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDetailReader } from '../modern/details.mjs';
import { createFeedReader, reportFeed } from '../modern/feed.mjs';
import { actionableFixture, now, at } from './fixtures/actionable.mjs';

const facts = f => ({ project: f.project, status: f.status, reports: reportFeed(f.status, f.journal), train: createFeedReader().train(f.project), now });
const content = document => document.sections.map(s => `${s.title}\n${s.content}`).join('\n');

test('historical runs retain readable reports, all findings, promotions, decisions and honest stage timings', t => {
  const f = actionableFixture(t), reader = createDetailReader();
  const doc = reader.document({ kind: 'run', run: 'R-2' }, facts(f)), output = content(doc);
  assert.match(output, /ENG-2 · Make every console row useful/); assert.match(output, /Outcome: done · Check: pass/);
  assert.match(output, /readable report/); assert.match(output, /Second verified fact/);
  assert.match(output, /Review · PASS/); assert.match(output, /A second retained finding/);
  assert.match(output, /green batch fast-forward/); assert.match(output, /Commit: def5678/);
  assert.match(output, /Settle: promotable/); assert.match(output, /Engineering: 30m 0s/);
  assert.match(output, /Review: not recorded/); assert.match(output, /CI: 7m 0s/); assert.match(output, /Report → main: 29m 0s/);
  assert.equal(doc.sections.find(s => s.id === 'report').open.kind, 'report');
  assert.equal(doc.sections.find(s => s.id === 'promotion').open.kind, 'result');
});

test('report views include the archived body and review; watcher exceptions explain an absent report', t => {
  const f = actionableFixture(t), reader = createDetailReader();
  assert.match(content(reader.document({ kind: 'report', run: 'R-3' }, facts(f))), /Waiting for the operator/);
  const missing = reader.document({ kind: 'report', run: 'R-99', report: 'notice:missing' }, { ...facts(f), reports: [{ id: 'notice:missing', run: 'R-99', item: 'ENG-99', outcome: 'no report', check: 'unknown' }] });
  assert.match(content(missing), /Outcome: no report/); assert.match(content(missing), /No report recorded/);
  assert.doesNotMatch(content(missing), /green batch/);
});

test('details reject foreign settlements and altered report or review bytes', t => {
  const f = actionableFixture(t), reader = createDetailReader(), file = `${f.org}/settle/R-2.json`;
  const saved = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ ...saved, common: '/foreign' }));
  assert.throws(() => reader.document({ kind: 'run', run: 'R-2' }, facts(f)), /different run or project/);
  fs.writeFileSync(file, JSON.stringify({ ...saved, review: { ...saved.review, text: 'Changed' } }));
  assert.throws(() => reader.document({ kind: 'run', run: 'R-2' }, facts(f)), /Review bytes differ/);
  fs.writeFileSync(file, JSON.stringify(saved)); fs.appendFileSync(`${f.org}/reports/R-2.md`, 'Changed');
  assert.throws(() => reader.document({ kind: 'run', run: 'R-2' }, facts(f)), /Report bytes differ/);
});

test('train details read running telemetry and bounded log tails, then retain the same batch after completion', t => {
  for (const telemetry of [true, false]) {
    const f = actionableFixture(t, { telemetry }), reader = createDetailReader();
    const open = { kind: 'batch', batch: 'batch-1' };
    const initial = content(reader.document(open, facts(f)));
    assert.match(initial, /Lanes: console/); assert.match(initial, /Check: node offline-check.mjs/);
    assert.match(initial, telemetry ? /Elapsed: 2m 0s/ : /Elapsed: not recorded/);
    fs.appendFileSync(f.checkLog, 'check finished green\n');
    f.batch.phase = 'complete'; f.batch.attempts[0].phase = 'complete';
    f.batch.attempts[0].gate = { command: 'node offline-check.mjs', started_at: at(2), finished_at: at(1), duration_s: 60, exit_code: 0, log: f.checkLog };
    f.batch.results = { 'job-1': { outcome: 'refused', reason: 'main moved after CI', gate: f.batch.attempts[0].gate } };
    fs.writeFileSync(f.batchFile, JSON.stringify(f.batch)); f.queue.current = null; fs.writeFileSync(f.queueFile, JSON.stringify(f.queue));
    const final = content(reader.document(open, facts(f)));
    assert.match(final, /Phase: complete/); assert.match(final, /Elapsed: 1m 0s · finished/);
    assert.match(final, /console: refused · main moved after CI/); assert.match(final, /check finished green/);
    fs.writeFileSync(f.checkLog, 'old\n'.repeat(100000) + '\x1b[2Jlatest safe line\n');
    const tail = reader.document(open, facts(f)).sections.find(s => s.id === 'log:0').content;
    assert.ok(tail.length < 65536); assert.match(tail, /latest safe line/); assert.doesNotMatch(tail, /\x1b/);
  }
});
