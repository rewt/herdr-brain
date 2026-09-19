import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, key, rowDetail, click, mouse } from './controller.mjs';
import { frame, plain } from './frame.mjs';
import { goals, tasks, sessions, lists, counts } from './model.mjs';
import { rankOf, rankedGoals, policyFor, decisions, priorityText } from './autonomy.mjs';
import { cellWidth } from '../lib/text.mjs';

const press = (s, input = '', k = {}) => key(s, input, k, frame(s, 80, 30));
const enter = (s) => press(s, '', { return: true });
const authority = (s = initialState(), goal = goals[0]) => press(rowDetail(s, goal), 'a');
const clickKey = (s, input, w = 80, h = 30) => {
  const f = frame(s, w, h);
  const hit = f.hits.find((h) => h.target.type === 'key' && h.target.input === input);
  assert.ok(hit, `missing clickable ${input}`);
  return mouse(s, { x: hit.x, y: hit.y, press: true, button: 'left' }, f);
};

test('relative ranking stays in its project, follows identity, and survives Back', () => {
  let s = { ...initialState(), scope: 'all' };
  s = click(s, { type: 'row', area: 'goals', row: goals[0] });
  s = press(s, ']');
  assert.equal(rankOf(s, goals[0]), 2);
  assert.equal(s.goal, 'G-1');
  assert.equal(s.cursor.goals, 'G-1');
  assert.deepEqual(rankedGoals(s, 'orchard').map((g) => g.id), ['G-6']);
  const before = s;
  s = press(rowDetail(s, goals[0]), ']');
  s = press(s, 'b');
  assert.equal(rankOf(s, goals[0]), 3);
  assert.equal(rankOf(before, goals[0]), 2, 'previous state must stay immutable');
  s = press(press(s, '['), '[');
  assert.equal(rankOf(s, goals[0]), 1);
  assert.equal(press(s, '['), s, 'first goal cannot cross project boundary');
  assert.equal(counts(s).needs, 13);
  assert.equal(lists(s).sessions.length, 8);
  assert.equal(policyFor(s, goals[3]).pickup, 'paused');
});

test('nested task priority explains its source without changing task statuses', () => {
  const s = initialState();
  assert.match(priorityText(s, tasks[9]), /Goal rank #1 in harbor/);
  assert.match(priorityText(s, tasks[9]), /Inherited; task preference 10 applies within this goal/);
  assert.equal(lists(s).tasks.find((t) => t.id === 'ENG-6').status, 'ready');
  assert.equal(lists(s).tasks.find((t) => t.id === 'ENG-2').status, 'active');
  assert.equal(lists(s).tasks.find((t) => t.id === 'ENG-12').status, 'blocked');
});

test('choice history survives changed rank and authority; reading needs no attention', () => {
  let s = press(rowDetail(initialState(), goals[0]), ']');
  s = authority(s);
  const original = policyFor(s, goals[0]);
  s = press(s, '2');
  assert.equal(policyFor(s, goals[0]).pickup, 'allowed', 'review has not committed');
  s = enter(s);
  assert.equal(policyFor(s, goals[0]).pickup, 'paused');
  assert.equal(original.pickup, 'allowed');
  s = press(s, 'b');
  assert.equal(policyFor(s, goals[0]).pickup, 'paused', 'Back must preserve edits');
  const historical = plain(frame(rowDetail(s, decisions[0]), 140, 45));
  assert.match(historical, /Priority then: #1/);
  assert.match(historical, /Authority then: G-1\/note-42 by operator; pickup allowed/);
  assert.equal(counts(s).needs, 13);
  assert.equal(sessions[1].status, 'working');
});

test('authority editor owns keys and paste, cancels without Esc, reviews before commit', () => {
  let s = authority();
  const original = policyFor(s, goals[0]);
  s = press(s, 'r');
  s = press(s, ' b!12[e', { paste: true });
  assert.equal(s.view, 'authority-edit');
  assert.equal(counts(s).needs, 13);
  s = press(press(s, '', { tab: true }), '', { tab: true });
  s = enter(s);
  assert.equal(s.view, 'authority');
  assert.equal(policyFor(s, goals[0]), original);
  s = press(press(s, 'r'), ' Add a reproducible failure check.');
  s = enter(s);
  assert.equal(s.view, 'confirm');
  assert.match(plain(frame(s, 140, 45)), /Allowed before:/);
  assert.match(plain(frame(s, 140, 45)), /Allowed after:/);
  assert.equal(policyFor(s, goals[0]), original);
  s = enter(s);
  assert.equal(s.view, 'authority');
  assert.match(policyFor(s, goals[0]).scope, /failure check/);
  assert.equal(policyFor(s, goals[0]).ask, original.ask);
  assert.equal(policyFor(s, goals[0]).gates, original.gates);
  assert.equal(decisions[0].authority.scope, original.scope);
});

test('missing authority cannot be enabled by rank, key, or click', () => {
  let s = authority(initialState(), goals[4]);
  assert.match(plain(frame(s, 80, 30)), /No authority recorded/);
  s = press(s, '1');
  assert.equal(policyFor(s, goals[4]), null);
  assert.equal(s.view, 'authority');
  assert.ok(!frame(s, 80, 30).hits.some((h) => h.target.input === '1'));
  s = press(s, 'r');
  assert.equal(s.view, 'authority');
});

test('executive request names project, ignores browse filters, requires review, deduplicates', () => {
  let s = { ...initialState(), goal: 'G-1', task: 'ENG-1', query: 'retry' };
  s = clickKey(s, 'e');
  assert.equal(press(s, 'e'), s, 'Next work must not stack itself');
  assert.equal(lists(s).decisions.length, 3, 'goal/task filters must not hide choices');
  s = clickKey(s, 'n');
  assert.equal(s.view, 'confirm');
  assert.match(plain(frame(s, 80, 30)), /Scope: every goal in harbor/);
  assert.equal(s.autonomy.requested.harbor, undefined);
  s = enter(s);
  assert.match(s.message, /No model ran/);
  assert.equal(s.autonomy.requested.harbor, true);
  s = press(s, 'n');
  assert.equal(s.view, 'decisions');
  assert.match(s.message, /no duplicate/);
  s = press(s, 'b');
  assert.equal(s.goal, 'G-1');
  assert.equal(s.task, 'ENG-1');
  assert.equal(s.query, 'retry');
  assert.equal(s.autonomy.requested.harbor, true);
  s = press({ ...s, scope: 'all' }, 'e');
  assert.equal(lists(s).decisions.length, 4);
  s = press(s, 'n');
  assert.equal(s.view, 'decisions');
  assert.match(s.message, /Choose one project/);
});

test('why-picked and authority questions link to readers with exact return paths', () => {
  let s = press(rowDetail(initialState(), sessions[1]), 'w');
  assert.equal(s.detail.key, decisions[0].key);
  s = press(s, 'b');
  assert.equal(s.detail.name, 'batch-retry');
  s = press(rowDetail(initialState(), sessions[0]), 'w');
  assert.match(s.message, /No pickup decision recorded/);
  s = rowDetail(initialState(), decisions[1]);
  s = press(s, 'o');
  assert.equal(s.detail.id, 'HUM-2');
  assert.equal(s.detail.data.digest.options.length, 3);
  assert.equal(s.detail.data.digest.recommend, '2');
  s = press(s, 'b');
  assert.equal(s.detail.key, decisions[1].key);
  assert.equal(counts(s).needs, 13);
});

test('new screens and mouse controls fit 80, 100 and 140 columns without hiding global counts', () => {
  for (const [w, h] of [[80, 30], [100, 40], [140, 45]]) {
    let s = press(authority(), 's');
    s = clickKey(s, '2', w, h);
    assert.equal(s.view, 'confirm');
    s = enter(s);
    assert.equal(policyFor(s, goals[0]).pickup, 'paused');
    for (const state of [s, press(s, 'r'), press(initialState(), 'e'),
      enter(press(press(initialState(), 'e'), 'n')), ...decisions.map((d) => rowDetail(initialState(), d))]) {
      const f = frame(state, w, h);
      assert.equal(f.lines.length, h);
      for (const line of f.lines) assert.equal(cellWidth(line.spans.map((s) => s.text).join('')), w);
      assert.match(plain(f), /Needs you 13/);
      assert.ok(f.areas.some((a) => a.name === 'sessions'));
      for (const hit of f.hits) assert.ok(hit.x >= 0 && hit.y >= 0 && hit.x + hit.w <= w && hit.y + hit.h <= h);
    }
    const receipt = plain(frame(rowDetail(initialState(), decisions[0]), w, h));
    for (const phrase of ['Why:', 'Authority then:', 'Checked:', 'Outcome:', 'Revisit:']) assert.match(receipt, new RegExp(phrase));
  }
});
