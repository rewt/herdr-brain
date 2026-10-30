import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dispatchLaneName } from '../../lib/lane-name.mjs';
import { fixture, promptCalls } from './dispatch-fixture.mjs';

test('new lane names contain the exact item and retain line/review prefixes and length bounds', () => {
  assert.equal(dispatchLaneName('topic', 'ENG-71'), 'topic-eng-71');
  assert.equal(dispatchLaneName('line-eng-71-1', 'ENG-71'), 'line-eng-71-1');
  assert.equal(dispatchLaneName('review-eng-71-r1', 'ENG-71'), 'review-eng-71-r1');
  assert.equal(dispatchLaneName('topic-eng-710', 'ENG-71'), 'topic-eng-710-eng-71');
  assert.equal(dispatchLaneName('topic', 'ENG-71', { existing: true }), 'topic');
  const topic = 'a'.repeat(61), name = dispatchLaneName(topic, 'ENG-71');
  assert.equal(name.length, 61);
  assert.match(name, /^[a-z0-9][a-z0-9-]{1,60}$/);
  assert.ok(name.endsWith('-eng-71'));
  assert.notEqual(name, dispatchLaneName('a'.repeat(60) + 'b', 'ENG-71'));
  assert.equal(dispatchLaneName(name, 'ENG-71'), name);
});

test('a dispatch without an item in --lane records the new name throughout and retries it after failure', t => {
  const f = fixture(t), expected = `topic-${f.item.toLowerCase()}`;
  f.fail('open');
  const failed = f.start(); assert.equal(failed.status, 1, failed.stderr);
  const journal = f.jobs()[0], original = JSON.parse(fs.readFileSync(journal));
  assert.equal(original.lane, expected); assert.equal(original.run, null);
  f.fail('');
  const retried = f.dispatch(['--retry', journal]); assert.equal(retried.status, 0, retried.stderr);
  const receipt = JSON.parse(retried.stdout), run = f.show(receipt.run);
  assert.equal(receipt.lane, expected); assert.equal(run.meta.lane, expected);
  assert.equal(f.git(['branch', '--show-current'], run.workspace), `lane/${expected}`);
  assert.ok(f.calls().filter(c => c.type === 'lane' && ['open', 'prepare', 'dispatch'].includes(c.a[0])).every(c => c.a[1] === expected));
  assert.equal(promptCalls(f).length, 1);
});

test('dispatch preserves a preexisting lane branch and existing run metadata', t => {
  const f = fixture(t);
  f.git(['worktree', 'add', '-b', 'lane/topic', path.join(f.root, 'lane')]);
  const prior = f.rec(['start', f.item, '--workspace', f.repo, '--meta', 'lane=topic']).match(/R-\d+/)[0];
  f.rec(['abandon', prior]);
  const result = f.start(); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).lane, 'topic');
  assert.equal(f.show(prior).meta.lane, 'topic');
  assert.equal(f.git(['for-each-ref', '--format=%(refname)', 'refs/heads/lane/']), 'refs/heads/lane/topic');
});

test('a saved pre-policy request retries its original lane even before a branch exists', t => {
  const f = fixture(t); f.fail('open');
  assert.equal(f.start().status, 1);
  const journal = f.jobs()[0], saved = JSON.parse(fs.readFileSync(journal));
  fs.writeFileSync(journal, JSON.stringify({ ...saved, lane: 'legacy-topic' }));
  f.fail('');
  const result = f.dispatch(['--retry', journal]); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).lane, 'legacy-topic');
  assert.equal(f.show(JSON.parse(result.stdout).run).meta.lane, 'legacy-topic');
});
