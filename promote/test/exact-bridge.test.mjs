import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { exactFixture } from '../../test/helpers/exact-validation-fixture.mjs';

function land(f) {
  f.add(); f.good(f.drain());
  const result = f.queue.load().results.at(-1);
  assert.equal(result.outcome, 'promoted', JSON.stringify(result));
  return { result, attempt: f.train().attempts.at(-1) };
}

test('lane check --gate and drain share the exact planned command with zero extra runs', t => {
  const f = exactFixture(t);
  assert.match(f.good(f.lane()), /GATE .*\nEXACT key=.* base=/);
  const checked = f.gate(); assert.equal(f.runs(), 1);
  f.env.UNLISTED = 'another pane value';
  const { result, attempt } = land(f);
  assert.equal(f.runs(), 1); assert.equal(result.gate.reused, true); assert.equal(result.gate.exact.outcome, 'reused');
  assert.equal(result.gate.validated_head, checked.head); assert.equal(result.gate.head, f.git(['rev-parse', 'HEAD']));
  assert.equal(attempt.receipt_bridge.outcome, 'reused'); assert.equal(result.gate.command, checked.command);
  assert.equal(fs.readFileSync(f.selections, 'utf8').trim(), 'selected', 'planner supplemental command executed once');
});

test('preparation still runs with the restricted environment before a receipt hit', t => {
  const f = exactFixture(t), prepares = path.join(f.root, 'prepares');
  fs.writeFileSync(path.join(f.root, 'config.json'), JSON.stringify({ prepare: [{ run: `test -z "$UNLISTED" && echo prepared >> '${prepares}'` }] }));
  f.good(f.lane());
  const { result } = land(f);
  assert.equal(result.gate.reused, true); assert.equal(f.runs(), 1);
  assert.equal(fs.readFileSync(prepares, 'utf8'), 'prepared\nprepared\n');
});

test('a lane diagnostic pointer cannot supply missing shared exact evidence', t => {
  const f = exactFixture(t); f.good(f.lane());
  fs.unlinkSync(path.join(f.common, 'lane-validation/exact', f.gate().key + '.json'));
  const { result, attempt } = land(f);
  assert.equal(result.gate.reused, false); assert.equal(f.runs(), 2);
  assert.equal(attempt.receipt_bridge.outcome, 'miss');
});

for (const [name, change] of [
  ['candidate', f => f.commit('work', 'changed content')],
  ['base', f => f.commit('main-change', 'new main', f.repo)],
  ['environment.EXACT_VALUE', f => { f.env.EXACT_VALUE = 'two'; }],
  // Layered canonical configuration changes do not alter candidate content.
  ['commands', f => fs.writeFileSync(path.join(f.root, 'config.json'), JSON.stringify({ validation: { promotion: f.command + ' && true' } }))],
  ['prepare', f => fs.writeFileSync(path.join(f.root, 'config.json'), JSON.stringify({ prepare: [{ run: 'test -z "$UNLISTED"' }] }))],
  ['declared', f => fs.writeFileSync(path.join(f.root, 'config.json'), JSON.stringify({ validation: { environment: 'salt-two' } }))],
]) test(`changed ${name} reports the miss and executes the selected command once`, t => {
  const f = exactFixture(t, { layeredPromotion: name === 'commands' }); f.good(f.lane()); assert.equal(f.runs(), 1);
  change(f);
  const { result, attempt } = land(f);
  assert.equal(result.gate.reused, false); assert.equal(f.runs(), 2);
  assert.equal(attempt.receipt_bridge.outcome, 'miss');
  assert.equal(attempt.receipt_bridge.field, name);
});

test('a settle-style added review document reuses and records its excluded delta', t => {
  const f = exactFixture(t); f.good(f.lane());
  const review = 'docs/reviews/topic/abcdef0-r1.md'; f.commit(review, 'PASS');
  const { result, attempt } = land(f);
  assert.equal(f.runs(), 1); assert.equal(result.gate.reused, true);
  assert.deepEqual(result.gate.exact.excluded_delta, [review]);
  assert.equal(attempt.test_plan.changed.includes(review), false);
});

for (const variant of ['notes', 'modify', 'executable']) test(`${variant} review delta cannot reuse and reports candidate`, t => {
  const f = exactFixture(t), review = 'docs/reviews/topic/abcdef0-r1.md';
  if (variant === 'modify') f.commit(review, 'first');
  f.good(f.lane());
  f.commit(variant === 'notes' ? 'docs/reviews/notes.md' : review, 'second', f.workspace, variant === 'executable' ? 0o755 : undefined);
  const { result, attempt } = land(f);
  assert.equal(f.runs(), 2); assert.equal(result.gate.reused, false); assert.equal(attempt.receipt_bridge.field, 'candidate');
});

for (const mode of ['unknown', 'undeclared', 'failed', 'env']) test(`${mode} selection refuses with code and zero check runs`, t => {
  const f = exactFixture(t, { planner: mode !== 'undeclared' });
  if (mode === 'unknown') f.commit('unmapped', 'unknown path');
  if (mode === 'failed') { f.commit('planner.mjs', 'throw Error("broken planner")', f.repo); }
  if (mode === 'env') f.env.LANE_VALIDATE = 'true';
  f.add(); f.good(f.drain());
  const result = f.queue.load().results.at(-1);
  assert.equal(result.outcome, 'refused'); assert.equal(result.code, 'SELECTION_UNKNOWN', JSON.stringify(result)); assert.equal(f.runs(), 0);
  assert.match(result.reason, mode === 'unknown' ? /unmapped/ : mode === 'env' ? /source is env/ : /planner/);
});

test('lane check refuses a base behind main and a lane copy cannot activate the bridge', t => {
  const f = exactFixture(t); f.commit('main-change', 'new main', f.repo);
  assert.match(f.lane().stderr, /EXACT_BASE_BEHIND/); assert.equal(f.runs(), 0);
  const absent = exactFixture(t, { declared: false }); absent.commit('.validation-receipts.json', JSON.stringify(absent.declaration));
  assert.match(absent.lane().stderr, /not declared by canonical main/); assert.equal(absent.runs(), 0);
});

test('multi-lane misses report candidate and execute one selected batch', t => {
  const f = exactFixture(t); f.good(f.lane());
  const other = path.join(f.root, 'other'); f.git(['worktree', 'add', '-qb', 'lane/other', other]);
  f.commit('other', 'another lane', other); f.add(); f.add('other'); f.good(f.drain());
  const attempt = f.train().attempts[0];
  assert.equal(f.queue.load().results.every(r => r.outcome === 'promoted'), true);
  assert.equal(f.runs(), 2); assert.equal(attempt.receipt_bridge.field, 'candidate');
});
