import assert from 'node:assert/strict';
import test from 'node:test';
import { asQuestions, categoryOf } from '../lib/brain.mjs';
import { buildBoard } from '../lib/model.mjs';

const stranded = {
  id: '2026091723594-settle-r-124', at: '2026-09-17T23:59:40.000Z', session: 'settle-r-124-1814',
  state: 'done', unsent: 'yes, route B', headline: 'Settled.',
  digest: { kind: 'decision', question: 'Should the packet drop four fields?', recommend: '1', options: [{ key: '1', label: 'Yes, rebuild from chain', causes: 'unblocks two items' }, { key: '2', label: 'No', causes: 'one gap stays open' }] },
};
const obstacle = {
  id: '2026091723594-settle-r-119', at: '2026-09-17T23:59:41.000Z', session: 'settle-r-119-1717',
  state: 'blocked', unsent: null, headline: 'Teach auto mode about your environment?',
  digest: { kind: 'obstacle', question: 'Teach auto mode about your environment?', recommend: '2', options: [{ key: '2', label: 'Not now', causes: 'clears the dialog' }] },
};
const finished = {
  id: '2026091723594-settle-r-126', at: '2026-09-17T23:59:42.000Z', session: 'settle-r-126-1906',
  state: 'done', unsent: null, headline: 'The pstore design review came back not ready yet.',
  digest: { kind: 'report', question: null, recommend: null, options: [], next_step: 'start the sixth amendment' },
};

test('a reply the operator typed but never sent outranks every other kind', () => {
  assert.equal(categoryOf(stranded), 'stranded');
  assert.equal(categoryOf(obstacle), 'obstacle');
  assert.equal(categoryOf(finished), 'report');
  const order = asQuestions([finished, obstacle, stranded]).map((q) => q.category);
  assert.deepEqual(order, ['stranded', 'obstacle', 'report']);
});

test('a result with no digest still lands, categorized by the session state', () => {
  const raw = { id: 'x', at: '2026-09-17T23:00:00.000Z', session: 's', state: 'blocked', headline: 'stopped' };
  const [q] = asQuestions([raw]);
  assert.equal(q.category, 'obstacle');
  assert.equal(q.title, 'stopped');
  assert.equal(q.recommend, null);
});

test('the recommendation names the option the operator would press', () => {
  const [q] = asQuestions([stranded]);
  assert.equal(q.recommend, '1 · Yes, rebuild from chain');
  assert.equal(q.title, 'Should the packet drop four fields?');
});

test('results come before org questions, and org rows are untouched', () => {
  const today = { project: { item_prefixes: ['ENG'] }, waiting: [{ id: 'HUM-26', title: 'An org question', category: 'design', recommend: 'yes', created: { at: '2026-09-17T20:00:00.000Z' } }] };
  const board = buildBoard({ today, brain: { rows: [obstacle] } });
  assert.equal(board.waiting.length, 2);
  assert.equal(board.waiting[0].kind, 'result');
  assert.equal(board.waiting[0].headline, 'Teach auto mode about your environment?');
  assert.equal(board.waiting[1].kind, 'question');
  assert.equal(board.waiting[1].question, 'HUM-26');
});

test('no brain configured leaves the board exactly as it was', () => {
  const today = { project: {}, waiting: [{ id: 'HUM-1', title: 'q', created: { at: '2026-09-17T20:00:00.000Z' } }] };
  assert.equal(buildBoard({ today }).waiting.length, 1);
  assert.equal(buildBoard({ today, brain: { rows: [], off: true } }).waiting.length, 1);
});
