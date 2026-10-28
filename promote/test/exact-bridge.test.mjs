import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { exactFixture } from '../../test/helpers/exact-validation-fixture.mjs';

function land(f, options) {
  f.add('topic', options); f.good(f.drain());
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

test('the sorted union of bound required tests reuses the worker receipt', t => {
  const requiredTests = ['test/review.test.mjs', 'test/component.test.mjs', 'test/review.test.mjs'];
  const f = exactFixture(t, { requiredTests });
  f.good(f.lane(['check', '--gate', '--required-tests', JSON.stringify(requiredTests)]));
  const checked = f.gate(), { result, attempt } = land(f, { requiredTests });
  assert.deepEqual(attempt.test_plan.required, ['test/component.test.mjs', 'test/review.test.mjs']);
  assert.deepEqual(attempt.test_plan.files, [...attempt.test_plan.required, 'test/focus.test.mjs']);
  assert.equal(result.gate.command, checked.command);
  assert.equal(result.gate.reused, true); assert.equal(result.gate.exact.outcome, 'reused');
  assert.equal(f.runs(), 1, 'the bound train gate adds no execution');
});

for (const provided of [[], ['test/component.test.mjs']]) test(`an incomplete worker required-test list (${provided.length} files) misses commands and runs once`, t => {
  const requiredTests = ['test/review.test.mjs', 'test/component.test.mjs'];
  const f = exactFixture(t, { requiredTests });
  f.good(f.lane(provided.length ? ['check', '--gate', '--required-tests', JSON.stringify(provided)] : undefined));
  const checked = f.gate(), { result, attempt } = land(f, { requiredTests });
  assert.notEqual(result.gate.command, checked.command);
  assert.deepEqual(attempt.test_plan.required, [...requiredTests].sort());
  assert.equal(result.gate.reused, false); assert.equal(attempt.receipt_bridge.field, 'commands');
  assert.equal(f.runs(), 2, 'a missing bound test forces one selected execution');
});

test('required-test CLI input is validated before executing a check', t => {
  const f = exactFixture(t);
  const invalid = ['{', 'null', '{}', '"test/one.test.mjs"', '[1]', '["../test/one.test.mjs"]', '["/test/one.test.mjs"]', '["test/one.js"]', JSON.stringify(Array(513).fill('test/one.test.mjs'))];
  for (const value of invalid) {
    const result = f.lane(['check', '--gate', '--required-tests', value]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /required test files|required-tests must be a JSON array/);
  }
  assert.match(f.lane(['check', '--required-tests', '[]']).stderr, /requires --gate/);
  assert.match(f.lane(['check', '--gate', '--required-tests', '[]', '--required-tests', '[]']).stderr, /only be specified once/);
  assert.equal(f.runs(), 0);
});

test('a removed required test cannot reuse earlier evidence', t => {
  const requiredTests = ['test/review.test.mjs'], f = exactFixture(t, { requiredTests });
  const args = ['check', '--gate', '--required-tests', JSON.stringify(requiredTests)];
  f.good(f.lane(args));
  f.git(['rm', requiredTests[0]], f.workspace); f.git(['commit', '-qm', 'Remove bound test'], f.workspace);
  const check = f.lane(args);
  assert.equal(check.status, 1); assert.match(check.stderr, /SELECTION_UNKNOWN:.*required test file is missing:/s);
  f.add('topic', { requiredTests }); f.good(f.drain());
  const result = f.queue.load().results.at(-1);
  assert.equal(result.outcome, 'refused'); assert.equal(result.code, 'SELECTION_UNKNOWN', JSON.stringify(result));
  assert.match(result.reason, /required test file is missing: test\/review\.test\.mjs/);
  assert.equal(f.runs(), 1, 'the removed file prevents any additional check execution');
});

test('worker planning refuses a plan that omits bound coverage', t => {
  const requiredTests = ['test/review.test.mjs'], f = exactFixture(t, { requiredTests });
  f.commit('planner.mjs', "console.log(JSON.stringify({files:[]}));\n", f.repo);
  f.git(['rebase', 'main'], f.workspace);
  const result = f.lane(['check', '--gate', '--required-tests', JSON.stringify(requiredTests)]);
  assert.equal(result.status, 1); assert.match(result.stderr, /SELECTION_UNKNOWN:.*no longer covers/);
  assert.equal(f.runs(), 0);
});

for (const pointer of ['missing', 'legacy', 'unreadable']) test(`a ${pointer} lane pointer has an explicit diagnostic without a repo mismatch`, t => {
  const f = exactFixture(t);
  if (pointer === 'legacy') {
    f.good(f.lane(['check', '--tier', 'promotion'], { UNLISTED: undefined }));
    assert.equal(f.gate().exact, undefined);
  } else if (pointer === 'unreadable') {
    fs.mkdirSync(path.join(f.workspace, '.lane'));
    fs.writeFileSync(path.join(f.workspace, '.lane/gate.json'), '{');
  }
  const { result, attempt } = land(f);
  assert.equal(result.gate.reused, false);
  assert.equal(attempt.receipt_bridge.field, 'candidate');
  assert.equal(attempt.receipt_bridge.pointer, pointer);
  assert.equal(f.runs(), pointer === 'legacy' ? 2 : 1);
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
