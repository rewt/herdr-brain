import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { asQuestions, categoryOf, readQueue, titleFor } from '../lib/brain.mjs';
import { buildBoard, contextPairs } from '../lib/model.mjs';
import { lineText, renderFrame } from '../lib/frame.mjs';
import { initialState } from '../lib/controller.mjs';

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
});

test('a row never says "your reply" without saying which reply', () => {
  // A generic prompt is replaced by the operator's own words.
  assert.equal(
    titleFor({ unsent: 'yes to the live-gate checklist wording' }, { question: 'Send your stranded reply now?' }),
    'Send your reply: "yes to the live-gate checklist wording"',
  );
  // A real question keeps its words and carries the reply after them.
  assert.equal(
    titleFor(stranded, stranded.digest),
    'Should the packet drop four fields? — you said "yes, route B"',
  );
  // Nothing is added when the question already quotes it.
  assert.equal(
    titleFor({ unsent: 'quit the browsers' }, { question: "Clear the dialog so your 'quit the browsers' reply can send?" }),
    "Clear the dialog so your 'quit the browsers' reply can send?",
  );
  // With no stranded reply the question stands alone.
  assert.equal(titleFor(obstacle, obstacle.digest), 'Teach auto mode about your environment?');
});

test('a long reply is cut, and only its first line is used', () => {
  const long = { unsent: `${'x'.repeat(80)}\nsecond line` };
  const t = titleFor(long, { question: 'Send your reply now?' });
  assert.ok(t.length < 70, t);
  assert.ok(!t.includes('second line'));
  assert.ok(t.endsWith('…"'));
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

test('a result title preserves run codes, commit hashes and possessive codes', () => {
  const question = "Merge R-9's fixes at d3a5751?";
  const coded = {
    ...obstacle,
    id: 'coded-result',
    digest: { ...obstacle.digest, question },
  };
  const row = buildBoard({
    today: { project: { item_prefixes: ['ENG'] }, waiting: [] },
    brain: { rows: [coded] },
  }).waiting[0];
  assert.equal(row.kind, 'result');
  assert.equal(row.title, question);
  assert.equal(row.headline, question);
  assert.equal(Object.fromEntries(contextPairs(row)).asked, question);
});

test('no brain configured leaves the board exactly as it was', () => {
  const today = { project: {}, waiting: [{ id: 'HUM-1', title: 'q', created: { at: '2026-09-17T20:00:00.000Z' } }] };
  assert.equal(buildBoard({ today }).waiting.length, 1);
  assert.equal(buildBoard({ today, brain: { rows: [], off: true } }).waiting.length, 1);
});

test('Waiting on you shows this project plus unmatched results and counts configured projects waiting elsewhere', () => {
  const alpha = { ...obstacle, id: 'alpha-row', project: 'alpha' };
  const beta = { ...finished, id: 'beta-row', project: 'beta' };
  const elsewhere = { ...finished, id: 'other-row', project: 'other', session: 'elsewhere' };
  const legacy = { ...finished, id: 'legacy-row', session: 'legacy' };
  const today = { project: { item_prefixes: [] }, waiting: [] };
  const board = buildBoard({
    today,
    brain: { rows: [alpha, beta, elsewhere, legacy] },
    projectName: 'alpha',
    projectNames: ['alpha', 'beta'],
  });

  assert.deepEqual(board.waiting.filter((r) => r.kind === 'result').map((r) => r.data.id), ['alpha-row', 'legacy-row', 'other-row']);
  assert.deepEqual(board.otherWaiting, [{ project: 'beta', count: 1 }]);
  const frame = renderFrame({
    glyphs: 'plain', version: 'test', header: { project: 'alpha' }, board, scopeItems: [], state: initialState(), project: {}, launch: {},
  }, 140, 30);
  assert.match(frame.lines.map(lineText).join('\n'), /1 waiting in beta/);
  assert.match(frame.lines.map(lineText).join('\n'), /elsewhere/);

  const switched = buildBoard({ today, brain: { rows: [alpha, beta, elsewhere, legacy] }, projectName: 'beta', projectNames: ['alpha', 'beta'] });
  assert.deepEqual(switched.waiting.filter((r) => r.kind === 'result').map((r) => r.data.id), ['legacy-row', 'other-row', 'beta-row']);
  assert.deepEqual(switched.otherWaiting, [{ project: 'alpha', count: 1 }]);
});

test('the queue child uses the exact configuration file loaded by the console', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-brain-config-'));
  const bin = path.join(dir, 'brain.mjs');
  const configFile = path.join(dir, 'named-console.json');
  fs.writeFileSync(bin, 'process.stdout.write(JSON.stringify([{ project: process.env.HERDR_ORG_CONSOLE_CONFIG }]))\n');
  const queue = await readQueue(bin, { configFile, env: {} });
  assert.equal(queue.error, undefined);
  assert.equal(queue.rows[0].project, configFile);
});
