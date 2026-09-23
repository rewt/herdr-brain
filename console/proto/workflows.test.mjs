import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, key, click, mouse, rowDetail } from './controller.mjs';
import { frame, plain } from './frame.mjs';
import { lists, counts, openItems, goals, sessions } from './model.mjs';
import { operationFor, recordedAnswers } from './workflows.mjs';
import { policyFor } from './autonomy.mjs';
import { cellWidth } from '../lib/text.mjs';
const press = (s, input = '', k = {}) => key(s, input, k, frame(s, 80, 30));
const enter = (s) => press(s, '', { return: true });

test('project instruction reviews, cancels, then persists in direction and history across Back', () => {
  let s = { ...initialState(), goal: 'G-1', task: 'ENG-1' };
  const prior = operationFor(s).direction;
  s = press(s, 'i');
  s = press(s, 'Keep the fixture format readable.');
  const cancel = enter(press(press(s, '', { tab: true }), '', { tab: true }));
  assert.equal(cancel.view, 'board');
  assert.equal(cancel.goal, 'G-1');
  assert.equal(operationFor(cancel).direction, prior);
  s = enter(s);
  assert.equal(s.view, 'confirm');
  assert.equal(operationFor(s).direction, prior);
  s = enter(s);
  assert.equal(s.view, 'board');
  assert.equal(operationFor(s).direction, 'Keep the fixture format readable.');
  s = press(s, 'h');
  assert.equal(lists(s).history[0].text, operationFor(s).direction);
  s = press(s, 'h');
  assert.equal(s.goal, 'G-1');
  assert.equal(s.task, 'ENG-1');
  assert.equal(counts(s).needs, 13);
});

test('capture loop review never grants pickup or changes STOP, questions or sessions', () => {
  let s = { ...initialState(), scope: 'orchard' };
  const original = policyFor(s, goals[5]);
  assert.equal(operationFor(s).loop, 'off');
  s = press(s, 'L');
  assert.equal(operationFor(s).loop, 'off');
  assert.equal(s.view, 'confirm');
  s = enter(s);
  assert.equal(operationFor(s).loop, 'on');
  assert.match(plain(frame(s, 80, 30)), /Loop down/, 'enabling capture does not pretend a down service is healthy');
  assert.equal(operationFor(s).stop, true);
  assert.equal(operationFor(s).stale, true);
  assert.equal(policyFor(s, goals[5]), original);
  assert.equal(counts(s).needs, 13);
  assert.equal(lists(s).sessions.length, 2);
  for (const input of ['i', 'L']) {
    const all = press({ ...s, scope: 'all' }, input);
    assert.equal(all.view, 'board');
    assert.match(all.message, /Choose one project/);
  }
});

test('selected-row reply and choices retain review and return to the original list', () => {
  let s = press(initialState(), 'r');
  assert.equal(s.view, 'reply');
  s = enter(s);
  assert.equal(s.view, 'confirm');
  assert.equal(counts(s).needs, 13);
  s = enter(s);
  assert.equal(s.view, 'board');
  assert.equal(counts(s).needs, 12);
  s = press(initialState(), '2');
  assert.equal(s.pending.option, '2');
  assert.equal(counts(s).needs, 13);
  s = press(s, 'b');
  assert.equal(s.view, 'board');
  assert.equal(s.cursor.open, 'queue:Q-1');
  s = press(initialState(), 'l');
  assert.equal(s.view, 'board');
  assert.equal(counts(s).later, 1);
  s = press(rowDetail(initialState(), openItems.find((r) => r.kind === 'read')), 'x');
  assert.equal(s.view, 'confirm');
  assert.equal(counts(s).read, 3);
  s = enter(s);
  assert.equal(counts(s).read, 2);
});

test('actions menu and forwarded right click operate on the selected row', () => {
  let s = press(initialState(), 'm');
  s = press(s, 'r');
  assert.equal(s.view, 'reply');
  assert.match(s.text, /failed rows/);
  s = initialState();
  const f = frame(s, 100, 40);
  const hit = f.hits.find((h) => h.target.type === 'row' && h.target.row.name === 'batch-retry');
  s = mouse(s, { x: hit.x, y: hit.y, button: 'right', press: true }, f);
  assert.equal(s.view, 'actions');
  assert.equal(s.detail.name, 'batch-retry');
  s = press(s, 'g');
  assert.match(s.message, /would focus batch-retry/);
  assert.equal(s.view, 'board');
});

test('document and context tabs show evidence without taking numbered answers', () => {
  let s = rowDetail(initialState(), openItems[0]);
  s = press(s, 'D');
  assert.equal(s.readerTab, 'document');
  assert.match(plain(frame(s, 80, 30)), /Fixture session screen/);
  s = press(s, 'C');
  assert.match(plain(frame(s, 80, 30)), /run: R-1/);
  s = press(s, 'V');
  assert.match(plain(frame(s, 80, 30)), /Your draft/);
  assert.equal(press(s, '2').view, 'confirm');
  s = press(rowDetail(initialState(), sessions[1]), 'D');
  assert.match(plain(frame(s, 80, 30)), /ACCEPTANCE/);
  s = press(s, 'o');
  assert.match(s.message, /would open \/fixture\/briefs\/ENG-2.md/);
  assert.match(s.message, /No file was opened/);
});

test('decline and agent-draft shortcuts review the actual answer or text', () => {
  const question = openItems.find((r) => r.id === 'HUM-1');
  let s = press(rowDetail(initialState(), question), 'n');
  assert.equal(s.view, 'confirm');
  assert.equal(s.pending.option, '2');
  assert.match(s.pending.label, /^No,/);
  const proposed = openItems.find((r) => r.id === 'Q-2');
  s = press(rowDetail(initialState(), proposed), 'Y');
  assert.equal(s.view, 'confirm');
  assert.equal(s.text, proposed.data.suggestion);
  s = press(rowDetail(initialState(), openItems[0]), 'n');
  assert.equal(s.view, 'detail');
  assert.match(s.message, /no explicit No/);
});

test('history overrule requires a reason and preserves the original answer', () => {
  let s = press(initialState(), 'h');
  s = press(s, 'n');
  assert.equal(s.view, 'overrule');
  assert.equal(enter(s).view, 'overrule');
  s = enter(press(s, 'The new fixture needs remote evidence.'));
  assert.equal(s.view, 'confirm');
  assert.equal(lists(s).history[0].answer, 'yes');
  s = enter(s);
  assert.equal(s.view, 'history');
  const answer = lists(s).history[0];
  assert.equal(answer.answer, 'no');
  assert.equal(answer.originalAnswer, 'yes');
  assert.equal(answer.answeredBy, 'operator');
  assert.equal(recordedAnswers[0].answer, 'yes', 'fixture history stays immutable');
  assert.equal(press(s, 'n').view, 'history', 'an operator answer is not offered for automatic overrule');
});

test('working session filter preserves global needs and can be cleared with the mouse in readers', () => {
  let s = press(initialState(), 'w');
  assert.ok(lists(s).sessions.every((r) => r.status === 'working'));
  assert.equal(lists(s).open.length, 12);
  assert.equal(counts(s).needs, 13);
  s = rowDetail(s, sessions[1]);
  s = click(s, { type: 'session-filter' });
  assert.equal(lists(s).sessions.length, 6);
  s = press(initialState(), 'i');
  const unchanged = click(s, { type: 'session-filter' });
  assert.equal(unchanged, s, 'background session controls are inert in editors');
});

test('project-control editor keys are text; header clicks cannot type commands', () => {
  for (const view of ['instruct', 'overrule']) {
    let s = view === 'instruct' ? press(initialState(), 'i') : press(press(initialState(), 'h'), 'n');
    s = press(s, 'bqLi!12', { paste: true });
    assert.equal(s.text, 'bqLi!12');
    s = click(s, { type: 'key', input: 'L' });
    assert.equal(s.text, 'bqLi!12');
    assert.equal(s.view, view);
    assert.equal(operationFor(s).loop, 'on');
  }
});

test('status, editors and source readers retain usable dimensions and controls at every width', () => {
  for (const [w, h] of [[80, 30], [100, 40], [140, 45]]) {
    const goalState = click(initialState(), { type: 'row', area: 'goals', row: goals[0] });
    assert.ok(frame(goalState, w, h).hits.some((h) => h.target.input === '0'), 'Clear filters remains clickable beside goal rank actions');
    for (const s of [press(initialState(), 'O'), press({ ...initialState(), scope: 'orchard' }, 'O'),
      press(initialState(), 'i'), enter(press(press(initialState(), 'i'), 'Preserve the format.')),
      press(initialState(), 'L'), press(press(initialState(), 'h'), 'n'),
      press(rowDetail(initialState(), sessions[1]), 'D')]) {
      const f = frame(s, w, h);
      assert.equal(f.lines.length, h);
      for (const line of f.lines) assert.equal(cellWidth(line.spans.map((x) => x.text).join('')), w);
      for (const hit of f.hits) assert.ok(hit.x >= 0 && hit.y >= 0 && hit.x + hit.w <= w && hit.y + hit.h <= h);
      assert.match(plain(f), /Needs you 13/);
      assert.match(plain(f), /Status:/);
    }
  }
});
