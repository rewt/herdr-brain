import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { fold } from '../lib/state.mjs';
import { itemLaunchHold } from '../lib/item-launch-hold.mjs';

function fixture({ parent = {}, ancestor = {}, child = {} } = {}) {
  return fold([
    { type: 'item.added', id: 'G-1', kind: 'goal' },
    { type: 'item.added', id: 'DEC-1', kind: 'work', role: 'decision', parent: 'G-1', ...ancestor },
    { type: 'item.added', id: 'ENG-1', kind: 'work', role: 'engineer', parent: 'DEC-1', ...parent },
    { type: 'item.added', id: 'ENG-2', kind: 'work', role: 'engineer', parent: 'ENG-1', ...child },
    { type: 'item.closed', id: 'DEC-1', as: 'done' },
    { type: 'item.closed', id: 'ENG-1', as: 'done' },
  ]);
}

test('completed work ancestors leave direct and nested follow-ups dispatchable without changing ancestry', () => {
  for (const role of ['decision', 'engineer', 'architect', 'planner', null]) {
    const state = fixture({ parent: { role } }), before = structuredClone(state);
    assert.equal(state.items.get('ENG-2').created.run, null, 'legacy direct filings have no proposing run');
    assert.equal(itemLaunchHold(state, 'ENG-2'), null, role);
    state.items.get('ENG-1').closed = null;
    assert.equal(itemLaunchHold(state, 'ENG-1'), null, 'direct child of the completed decision');
    state.items.get('ENG-1').closed = before.items.get('ENG-1').closed;
    assert.deepEqual(state, before, 'selection does not reopen or reparent completed work');
  }
});

test('completion never authorizes a closed target, closed goal, dropped ancestor or completed review', () => {
  const cases = [
    ['ENG-2', state => { state.items.get('ENG-2').closed = { as: 'done' }; }],
    ['ENG-2', state => { state.items.get('ENG-2').closed = { as: 'dropped' }; }],
    ['G-1', state => { state.items.get('G-1').closed = { as: 'done' }; }],
    ['ENG-1', state => { state.items.get('ENG-1').closed = { as: 'dropped' }; }],
    ['DEC-1', state => { state.items.get('DEC-1').closed = { as: 'dropped' }; }],
    ['ENG-1', state => { state.items.get('ENG-1').role = 'reviewer'; }],
    ['DEC-1', state => { state.items.get('DEC-1').role = 'review'; }],
  ];
  for (const [subject, change] of cases) {
    const state = fixture(); change(state);
    assert.equal(itemLaunchHold(state, 'ENG-2', [])?.subject, subject);
  }
});

test('completed ancestry retains every explicit hold, reservation and human boundary', () => {
  for (const subject of ['ENG-2', 'ENG-1', 'DEC-1', 'G-1']) {
    for (const flag of ['hold', 'held', 'reserved', 'operator_reserved']) {
      const state = fixture(); state.items.get(subject).meta[flag] = true;
      assert.equal(itemLaunchHold(state, 'ENG-2')?.subject, subject, `${subject} ${flag}`);
    }
    const state = fixture(); state.items.get(subject).role = 'human';
    assert.equal(itemLaunchHold(state, 'ENG-2')?.subject, subject, `${subject} human`);
  }
});

test('completion does not bypass missing ancestry, cycles or a misplaced formal correction', () => {
  const missing = fixture(); missing.items.delete('DEC-1');
  assert.match(itemLaunchHold(missing, 'ENG-2').reason, /DEC-1 is missing/);
  const cycle = fixture(); cycle.items.get('DEC-1').parent = 'ENG-1';
  assert.match(itemLaunchHold(cycle, 'ENG-2').reason, /ancestor cycle at ENG-1/);
  const formal = fixture({ child: { meta: { review_fix_of: 'ENG-9:captured-head' } } });
  assert.equal(itemLaunchHold(formal, 'ENG-2', [])?.subject, 'ENG-1');
});
