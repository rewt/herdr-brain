import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDetailReader } from '../modern/details.mjs';
import { createFeedReader } from '../modern/feed.mjs';
import { pipelineFixture } from './fixtures/pipelines.mjs';
import { now, at } from './fixtures/actionable.mjs';

const facts = f => ({ project: f.project, status: f.status, train: createFeedReader().train(f.project), now });

test('red CI shows earlier failing test diagnostics even when they have scrolled out of the tail', t => {
  const f = pipelineFixture(t, 'failed');
  fs.writeFileSync(f.checkLog, 'not ok 1 - preserves the reviewed tree\n  ---\n  error: expected stable tree\n  expected: original\n  actual: changed\n  ...\n' + 'ok 2 - later output\n'.repeat(10000));
  const doc = createDetailReader().document({ kind: 'batch-link', batch: f.batch.id, stage: 'ci' }, facts(f));
  const failure = doc.sections.find(s => s.id === 'failures:0').content;
  assert.match(failure, /preserves the reviewed tree/); assert.match(failure, /expected stable tree/); assert.match(failure, /actual: changed/);
  assert.doesNotMatch(doc.sections.find(s => s.id === 'output:0').content, /expected stable tree/);
});

test('a bisected batch keeps each check output tied to its own attempt even when opened through an earlier result', t => {
  const f = pipelineFixture(t, 'failed'), nextLog = path.join(f.root, 'next-check.log');
  fs.writeFileSync(f.checkLog, 'not ok 1 - isolated failure\n  ---\n  error: isolated lane failed\n  ...\n');
  fs.writeFileSync(nextLog, 'next group passed\n');
  f.batch.attempts.push({ phase: 'complete', gate: { started_at: at(1), finished_at: at(0), duration_s: 60, exit_code: 0, log: nextLog } });
  fs.writeFileSync(f.batchFile, JSON.stringify(f.batch));
  const reader = createDetailReader();
  const doc = reader.document({ kind: 'batch-link', batch: f.batch.id, stage: 'ci' }, facts(f));
  assert.match(doc.sections.find(s => s.id === 'output:0').content, /isolated lane failed/);
  assert.match(doc.sections.find(s => s.id === 'output:1').content, /next group passed/);
  const result = reader.document({ kind: 'result', job: 'job-1' }, facts(f));
  assert.match(result.sections.find(s => s.id === 'log:0').content, /next group passed/);
});

test('release candidate links open the exact candidate gate and foreign dispatch evidence is rejected', t => {
  const f = pipelineFixture(t), gateLog = path.join(f.root, 'candidate.log'); fs.writeFileSync(gateLog, 'release suite failed\n');
  const reader = createDetailReader(), pending = reader.document({ kind: 'run', run: 'R-2' }, facts(f)).sections[0].pipeline.at(-1).open;
  f.status.candidates = [{ id: 'RC-1', identity: f.project.repoKey, commit: 'later', commits: ['def5678'], tag: 'candidate-1',
    started: { at: at(5) }, gate: { result: 'failed', at: at(1), detail: 'release suite exited 1', log: gateLog } }];
  const doc = reader.document({ kind: 'run', run: 'R-2' }, facts(f));
  const candidate = doc.sections[0].pipeline.at(-1); assert.equal(candidate.status, 'failed');
  for (const descriptor of [candidate.open, pending]) {
    const opened = reader.document(descriptor, facts(f));
    const content = opened.sections.map(s => s.content).join('\n');
    assert.match(content, /RC-1 \u00b7 candidate-1/); assert.match(content, /release suite failed/);
  }
  const request = path.join(f.root, 'dispatch.json');
  f.status.runs[1].meta.dispatch_journal = request;
  fs.writeFileSync(request, JSON.stringify({ common: '/foreign', run: 'R-2', item: 'ENG-2', org: f.org }));
  assert.throws(() => reader.document({ kind: 'run-link', run: 'R-2', stage: 'dispatch' }, facts(f)), /different run or project/);
});

test('a handled promotion notice completes the notify link after an earlier undelivered receipt', t => {
  const f = pipelineFixture(t, 'refused'), record = facts(f);
  record.train.results.find(r => r.id === 'job-1').delivered = false;
  record.train.results.find(r => r.id === 'job-1').finished = at(0);
  record.journal = [{ type: 'notice', id: 'promote:job-1', at: at(1), message: '[promote-queue] id=job-1 outcome=refused' },
    { type: 'autopilot', id: 'promote:job-1', result: { disposition: 'handled' } }];
  const reader = createDetailReader(), doc = reader.document({ kind: 'batch', batch: f.batch.id }, record);
  assert.equal(doc.sections[0].pipeline.at(-1).status, 'done');
  const notice = reader.document(doc.sections[0].pipeline.at(-1).open, record);
  assert.match(notice.sections.find(s => s.id === 'notices').content, /handled/);
});
