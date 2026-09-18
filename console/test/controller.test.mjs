// Keys and clicks to state and effects: pure, no Ink.
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, menuItems, overruleAnswer, promptParts, promptText, reduce, reduceMouse } from '../lib/controller.mjs';
import { boardRows, scopeItems } from '../lib/model.mjs';
import { board } from './fixtures/board.mjs';

const B = board();
const ctx = (state, extra = {}) => ({
  rows: boardRows(B, state.view),
  historyRows: boardRows(B, 'history'),
  scopeItems: scopeItems(B),
  listPage: 5,
  popupPage: 4,
  popupMax: 20,
  projectCount: 1,
  lineOf: () => 7,
  hitAt: () => null,
  ...extra,
});
const start = (over = {}) => ({ ...initialState(), selectedKey: 'q:HUM-5', ...over });
function press(state, ...keys) {
  let s = state;
  const effects = [];
  for (const k of keys) {
    const [input, key] = typeof k === 'string' ? [k, {}] : ['', k];
    const r = reduce(s, input, key, ctx(s));
    s = r.state;
    effects.push(...r.effects);
  }
  return { state: s, effects };
}

test('Enter on a session peeks at it without leaving; g goes there; on a question it opens the summary', () => {
  const onSession = press(start({ selectedKey: 'r:R-4' }), { return: true });
  assert.deepEqual(onSession.effects, []);
  assert.deepEqual(onSession.state.popup, { kind: 'peek', key: 'r:R-4', scroll: 0, follow: true });
  assert.deepEqual(press(start({ selectedKey: 'r:R-4' }), 'g').effects, [{ type: 'go', key: 'r:R-4' }]);
  assert.deepEqual(press(start({ selectedKey: 'r:R-4' }), 'f').effects, [{ type: 'go', key: 'r:R-4' }], 'f is kept as an alias');
  const back = press(onSession.state, { escape: true });
  assert.equal(back.state.popup, null, 'Esc comes back from the peek');
  assert.equal(back.state.selectedKey, 'r:R-4', 'with the same row selected');

  const onQuestion = press(start(), { return: true });
  assert.deepEqual(onQuestion.effects, []);
  assert.deepEqual(onQuestion.state.popup, { kind: 'summary', key: 'q:HUM-5', tab: 0, scroll: 0 });
  assert.match(press(start(), 'f').state.message, /no session/);
});

test('s opens the summary; inside it 1-3 switch tabs, keys scroll, Enter goes, Esc closes', () => {
  let { state } = press(start({ selectedKey: 'r:R-4' }), 's');
  assert.deepEqual(state.popup, { kind: 'summary', key: 'r:R-4', tab: 0, scroll: 0 });
  ({ state } = press(state, '2', 'j', 'j', { pageDown: true }));
  assert.deepEqual(state.popup, { kind: 'summary', key: 'r:R-4', tab: 1, scroll: 6 });
  ({ state } = press(state, { end: true }));
  assert.equal(state.popup.scroll, 20);
  ({ state } = press(state, '3'));
  assert.equal(state.popup.scroll, 0, 'a new tab starts at the top');
  const q = press(state, 'q');
  assert.ok(q.state.popup, 'q does not quit from a popup');
  assert.deepEqual(q.effects, []);
  const enter = press(state, { return: true });
  assert.deepEqual(enter.state.popup, { kind: 'peek', key: 'r:R-4', scroll: 0, follow: true }, 'Enter in the summary peeks');
  assert.deepEqual(press(state, 'g').effects, [{ type: 'go', key: 'r:R-4' }]);
  assert.deepEqual(press(state, 'o').effects, [{ type: 'open', key: 'r:R-4', tab: 2 }]);
  ({ state } = press(state, { escape: true }));
  assert.equal(state.popup, null);
  assert.equal(state.selectedKey, 'r:R-4');
});

test('approving from the summary or the list needs Enter to confirm, and Esc cancels', () => {
  let { state, effects } = press(start(), 's', 'y');
  assert.equal(promptText(state), 'Approve: Promote the Herdr Brain console into main? Enter to confirm, Esc to cancel');
  assert.deepEqual(effects, []);
  ({ state, effects } = press(state, { return: true }));
  assert.deepEqual(effects, [{ type: 'answer', question: 'HUM-5', answer: 'yes', note: null, overrule: false, headline: 'Promote the Herdr Brain console into main?' }]);
  assert.equal(state.popup, null, 'the answered question closes its popup');

  ({ state } = press(start(), 'y', { escape: true }));
  assert.equal(state.mode, null);
  assert.match(state.message, /Cancelled; nothing was recorded/);
});

test('declining needs a one-line reason, then confirmation; n elsewhere says task launching comes next round', () => {
  let { state, effects } = press(start(), 'n', { return: true });
  assert.match(state.message, /reason is required/);
  ({ state, effects } = press(state, 'N', 'o', 't', ' ', 'y', 'e', 't', { return: true }));
  assert.equal(promptText(state), 'Decline: Promote the Herdr Brain console into main? (reason: Not yet) Enter to confirm, Esc to cancel');
  ({ state, effects } = press(state, { return: true }));
  assert.equal(effects[0].answer, 'no');
  assert.equal(effects[0].note, 'Not yet');

  for (const k of ['n', { tab: true }]) {
    const r = press(start({ selectedKey: 'r:R-4' }), k);
    assert.equal(r.state.message, 'task launching comes in the next round');
    assert.deepEqual(r.effects, []);
  }
  assert.equal(overruleAnswer('yes'), 'no');
  assert.equal(overruleAnswer('no'), 'yes');
  assert.equal(promptParts(initialState()), null);
});

test('m and a right click open the row menu; its items depend on the row', () => {
  const session = B.groups[1].rows[0];
  const question = B.waiting[0];
  assert.deepEqual(menuItems(session).map((i) => [i.label, i.hint]), [['Peek at its screen', 'Enter'], ['Reply in your words', 'r'], ['Go to session', 'g'], ['Summary', 's']]);
  assert.deepEqual(menuItems(question).map((i) => [i.label, i.hint]), [['Summary', 's'], ['Approve', 'y'], ['Decline', 'n'], ['Have a session work it out', 'd']]);
  assert.deepEqual(menuItems(B.history[2]).map((i) => i.label), ['Summary', 'Overrule']);

  let { state, effects } = press(start({ selectedKey: 'r:R-4' }), 'm');
  assert.deepEqual(state.popup, { kind: 'menu', key: 'r:R-4', index: 0, x: 4, y: 7 });
  ({ state, effects } = press(state, 'j', 'j', 'j', { return: true }));
  assert.deepEqual(state.popup, { kind: 'summary', key: 'r:R-4', tab: 0, scroll: 0 });
  ({ state, effects } = press(start({ selectedKey: 'r:R-4' }), 'm', 'j', 'j', { return: true }));
  assert.deepEqual(effects, [{ type: 'go', key: 'r:R-4' }]);
  assert.equal(state.popup, null);
  ({ state } = press(start({ selectedKey: 'r:R-4' }), 'm', { return: true }));
  assert.equal(state.popup.kind, 'peek');
  ({ state } = press(start(), 'm', { downArrow: true }, { return: true }));
  assert.equal(promptText(state).startsWith('Approve:'), true);
  ({ state } = press(start(), 'm', { escape: true }));
  assert.equal(state.popup, null);

  const hitAt = (x, y) => (y === 9 ? { type: 'row', key: 'r:R-4' } : null);
  const right = reduceMouse(start(), { button: 'right', x: 30, y: 9, press: true }, ctx(start(), { hitAt }));
  assert.equal(right.state.selectedKey, 'r:R-4');
  assert.deepEqual(right.state.popup, { kind: 'menu', key: 'r:R-4', index: 0, x: 30, y: 9 });
  const pick = reduceMouse(right.state, { button: 'left', x: 32, y: 11, press: true },
    ctx(right.state, { hitAt: () => ({ type: 'menu', index: 3 }) }));
  assert.equal(pick.state.popup.kind, 'summary');
  const outside = reduceMouse(right.state, { button: 'left', x: 0, y: 0, press: true }, ctx(right.state));
  assert.equal(outside.state.popup, null);
  assert.deepEqual(outside.effects, [], 'a click outside a popup only closes it');
});

test('a left click on a session row peeks at it; on a question it opens the summary; releases do nothing', () => {
  const hitAt = (x, y) => ({ 3: { type: 'row', key: 'q:HUM-5' }, 9: { type: 'row', key: 'h:pane:w2:p1' } }[y] ?? null);
  const c = (s) => ctx(s, { hitAt });
  let r = reduceMouse(start(), { button: 'left', x: 5, y: 9, press: true }, c(start()));
  assert.equal(r.state.selectedKey, 'h:pane:w2:p1');
  assert.deepEqual(r.effects, []);
  assert.equal(r.state.popup.kind, 'peek');
  r = reduceMouse(start({ selectedKey: 'r:R-4' }), { button: 'left', x: 5, y: 3, press: true }, c(start()));
  assert.equal(r.state.popup.kind, 'summary');
  assert.equal(r.state.popup.key, 'q:HUM-5');
  r = reduceMouse(start(), { button: 'left', x: 5, y: 9, press: false }, c(start()));
  assert.deepEqual([r.state, r.effects], [start(), []]);
  r = reduceMouse(start(), { button: 'left', x: 5, y: 1, press: true }, c(start()));
  assert.deepEqual([r.state, r.effects], [start(), []], 'a click on nothing does nothing');
  // While a reason or a confirmation is asked for, clicks do not act.
  const asking = press(start(), 'y').state;
  r = reduceMouse(asking, { button: 'left', x: 5, y: 9, press: true }, c(asking));
  assert.deepEqual(r.effects, []);
  assert.ok(r.state.mode);
});

test('the wheel scrolls the list, or the open summary', () => {
  let r = reduceMouse(start({ listOffset: 2 }), { button: 'wheelDown', x: 0, y: 5, press: true }, ctx(start()));
  assert.deepEqual([r.state.listOffset, r.state.follow], [5, false]);
  r = reduceMouse(r.state, { button: 'wheelUp', x: 0, y: 5, press: true }, ctx(r.state));
  r = reduceMouse(r.state, { button: 'wheelUp', x: 0, y: 5, press: true }, ctx(r.state));
  assert.equal(r.state.listOffset, 0);
  const moved = press(r.state, 'j');
  assert.equal(moved.state.follow, true, 'moving the selection brings it back into view');
  const open = press(start(), 's').state;
  r = reduceMouse(open, { button: 'wheelDown', x: 0, y: 5, press: true }, ctx(open));
  assert.equal(r.state.popup.scroll, 3);
  assert.equal(r.state.listOffset, 0);
});

test('h swaps in the history; / and the rail choose a scope; ! and w toggle views', () => {
  let { state } = press(start(), 'h');
  assert.equal(state.view, 'history');
  assert.equal(state.historyKey, 'f:R-3');
  ({ state } = press(state, 'j'));
  assert.equal(state.historyKey, 'n:ENG-7:40');
  assert.equal(state.selectedKey, 'q:HUM-5', 'the list selection is kept');
  const enter = press(state, { return: true });
  assert.deepEqual(enter.state.popup, { kind: 'summary', key: 'n:ENG-7:40', tab: 0, scroll: 0 });
  assert.deepEqual(enter.effects, []);
  ({ state } = press(state, 'j', 'n'));
  assert.equal(promptText(state).startsWith('Overrule to no “Install storage tool'), true, 'an automatic answer can be overruled from the history');
  ({ state } = press(state, { escape: true }, { escape: true }));
  assert.equal(state.view, 'list');
  assert.equal(press(press(start(), 'h').state, 'h').state.view, 'list');

  ({ state } = press(start(), '/'));
  assert.deepEqual(state.popup, { kind: 'scope', index: 0 });
  ({ state } = press(state, 'j', 'j', { return: true }));
  assert.deepEqual(state.scope, { repo: '/r/herdr-org', view: 'all' });
  assert.equal(state.popup, null);
  assert.match(state.message, /Showing herdr-org/);
  ({ state } = press(state, '/'));
  assert.equal(state.popup.index, 2, 'the popup opens on the current scope');
  ({ state } = press(state, { end: true }, { return: true }));
  assert.equal(state.view, 'history');
  assert.deepEqual(state.scope, { repo: '/r/herdr-org', view: 'all' }, 'history leaves the scope alone');

  ({ state } = press(start(), '!'));
  assert.deepEqual(state.scope, { repo: null, view: 'needs' });
  ({ state } = press(state, 'w'));
  assert.deepEqual(state.scope, { repo: null, view: 'working' });
  ({ state } = press(state, 'w'));
  assert.deepEqual(state.scope, { repo: null, view: 'all' });

  const rail = reduceMouse(start(), { button: 'left', x: 2, y: 4, press: true },
    ctx(start(), { hitAt: () => ({ type: 'scope', index: 1 }) }));
  assert.deepEqual(rail.state.scope, { repo: '/r/herdr-lanes', view: 'all' });
});

test('Escape never quits, q quits only from the list or history, and ? shows help', () => {
  let r = press(start(), { escape: true });
  assert.deepEqual(r.effects, []);
  assert.deepEqual(press(start(), 'q').effects, [{ type: 'quit' }]);
  assert.deepEqual(press(start({ view: 'history' }), 'q').effects, [{ type: 'quit' }]);
  r = press(start(), '?');
  assert.equal(r.state.help, true);
  assert.deepEqual(press(r.state, 'q').effects, []);
  assert.equal(press(r.state, { escape: true }).state.help, false);
  r = press(start(), 'R');
  assert.deepEqual(r.effects, [{ type: 'reload' }], 'reload moved to R; r replies');
  assert.deepEqual(press(start(), { escape: true }).effects, [], 'in a pane of its own, Esc never quits');
  const popupCtx = (st) => ({ ...ctx(st), popupMode: true });
  assert.deepEqual(reduce(start(), '', { escape: true }, popupCtx(start())).effects, [{ type: 'quit' }], 'summoned as a popup, Esc on the list closes it');
  assert.match(press(start(), 'p').state.message, /Only one project/);
  // Moving: arrows, j/k, pages, Home/End.
  assert.equal(press(start(), 'j', 'j').state.selectedKey, 'r:R-4');
  assert.equal(press(start(), { end: true }).state.selectedKey, 'h:pane:w2:p1');
  assert.equal(press(start(), { pageDown: true }).state.selectedKey, 'h:pane:w4:p1');
  assert.equal(press(start(), { end: true }, { upArrow: true }).state.selectedKey, 'h:pane:w4:p1');
  assert.equal(press(start(), 'k').state.selectedKey, 'q:HUM-5');
});
