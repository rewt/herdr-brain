import test from 'node:test';
import assert from 'node:assert/strict';
import { feedModel, itemThread, renderFeed, createFeedSession, categoryColor } from '../modern/feed.mjs';
import { lineText } from '../lib/frame.mjs';

const now = Date.parse('2026-09-30T21:00:00Z'), at = m => new Date(now - m * 60e3).toISOString();
const status = {
  items: [
    { id: 'ARCH-1', kind: 'work', role: 'architect', title: 'Plan stage 3', status: 'active', parent: null, created: { at: at(300), by: 'human' }, runs: ['R-1'], notes: [] },
    { id: 'ENG-2', kind: 'work', role: 'engineer', title: 'Build the wrapper', status: 'active', parent: 'ARCH-1', created: { at: at(30), by: 'run:R-1', run: 'R-1', why: 'The wrapper is missing. It blocks stage 3.' }, runs: ['R-2'], notes: [] },
    { id: 'HUM-3', kind: 'work', role: 'human', title: 'Spend on Chipnet?', status: 'open', parent: 'ARCH-1', created: { at: at(20), by: 'run:R-1', run: 'R-1' }, runs: [], notes: [], meta: { recommend: 'yes' } },
    { id: 'HUM-4', kind: 'work', role: 'human', title: 'Old answered', status: 'done', closed: { at: at(10) }, parent: null, created: { at: at(200) }, runs: [], notes: [] },
  ],
  runs: [
    { id: 'R-1', item: 'ARCH-1', started: { at: at(60) }, report: { outcome: 'done' }, meta: { agent: 'a1', harness: 'codex', lane: 'plan' } },
    { id: 'R-2', item: 'ENG-2', started: { at: at(25) }, report: null, meta: { agent: 'eng-agent', harness: 'claude', lane: 'wrapper' } },
    { id: 'R-3', item: 'ARCH-1', started: { at: at(1) }, report: null, meta: { agent: 'new-agent', harness: 'codex' } },
  ],
};
const events = [
  { seq: 1, at: at(60), by: 'human', type: 'run.started', id: 'R-1', item: 'ARCH-1', meta: { harness: 'codex', lane: 'plan' } },
  { seq: 2, at: at(30), by: 'run:R-1', type: 'item.added', id: 'ENG-2', kind: 'work', title: 'Build the wrapper', parent: 'ARCH-1' },
  { seq: 3, at: at(20), by: 'run:R-1', type: 'item.added', id: 'HUM-3', kind: 'work', title: 'Spend on Chipnet?', parent: 'ARCH-1' },
  { seq: 4, at: at(19), by: 'run:R-1', type: 'report.ingested', run: 'R-1', item: 'ARCH-1', report: { outcome: 'done', headline: 'Stage 3 is planned.', proposals: [1, 2] } },
  { seq: 5, at: at(15), by: 'human', type: 'note.added', id: 'ARCH-1', text: 'Operator: go with plan B.', decision: true },
  { seq: 6, at: at(14), by: 'human', type: 'note.added', id: 'ARCH-1', text: 'plain note' },
  { seq: 7, at: at(10), by: 'human', type: 'item.closed', id: 'HUM-4', as: 'done', note: 'yes' },
];
const agents = [{ name: 'eng-agent', pane: 'w:p2', status: 'working', tool: 'claude' }];

test('the items model: what waits on the operator, who is on what, and the moments that matter', () => {
  const m = feedModel({ status, events, agents, now });
  assert.deepEqual(m.decide.map(d => d.id), ['HUM-3']);
  assert.deepEqual(m.running.map(r => [r.run, r.state]), [['R-3', 'starting'], ['R-2', 'working']]);
  assert.equal(m.onItem.get('ENG-2').agent, 'eng-agent');
  assert.deepEqual(m.feed.map(x => `${x.mark} ${x.id} ${x.verb}`), ['■ HUM-4 answered', '◆ ARCH-1 decided', '✓ ARCH-1 reported', '? HUM-3 asks', '+ ENG-2 new', '▶ ARCH-1 started'], 'plain notes stay out');
  const created = m.feed.find(x => x.id === 'ENG-2');
  assert.equal(created.why, 'The wrapper is missing. It blocks stage 3.'); assert.match(created.detail, /R-1 · under ARCH-1/); assert.equal(created.working.harness, 'claude');
  assert.deepEqual(feedModel({ status, events, agents, now, filter: 'HUM' }).feed.map(x => x.id), ['HUM-4', 'HUM-3']);
  assert.equal(categoryColor('HUM-3'), 'amber'); assert.equal(categoryColor('ENG-2'), 'teal');
});

test('an item thread: why, who is working it, what it spawned, its history', () => {
  const m = feedModel({ status, events, agents, now });
  const t = itemThread(m, 'ARCH-1', events);
  assert.deepEqual(t.children.map(c => c.id), ['ENG-2', 'HUM-3']);
  assert.deepEqual(t.history.map(h => h.verb), ['decided', 'reported', 'started']);
  assert.equal(itemThread(m, 'NOPE-1', events), null);
});

test('the pane renders narrow, opens an item, focuses its session, and never writes', async () => {
  const gone = [];
  const session = createFeedSession({ config: { projects: [{ name: 'Alpha', org: '/org' }] }, env: {},
    deps: { now: () => now, orgStatus: async () => status, orgLog: async () => events, herdrAgents: async () => ({ ok: true, agents }), herdrGo: async t => { gone.push(t); return { ok: true }; } } });
  await session.refresh();
  let text = session.frame(60, 40).lines.map(lineText).join('\n');
  assert.match(text, /decide · 1/); assert.match(text, /HUM-3 +Spend on Chipnet\?/); assert.match(text, /recommend yes/);
  assert.match(text, /ENG-2 +new Build the wrapper/); assert.match(text, /“The wrapper is missing\.”/);
  assert.ok(session.frame(60, 40).lines.every(l => lineText(l).length <= 60));
  const f = session.frame(60, 40), y = f.hits.findIndex(h => h.some(x => x.id.startsWith('item:ENG-2')));
  await session.mouse({ x: 3, y, button: 'left', press: true });
  assert.equal(session.ui.view, 'item'); text = session.frame(60, 40).lines.map(lineText).join('\n');
  assert.match(text, /The wrapper is missing\. It blocks stage 3\./); assert.match(text, /created .* by R-1 · under ARCH-1/); assert.match(text, /R-2 claude · eng-agent · working/);
  await session.key('o', {}); assert.deepEqual(gone, [{ agent: 'eng-agent' }]);
  await session.key('', { escape: true }); assert.equal(session.ui.view, 'feed');
  await session.key('f', {}); assert.equal(session.ui.filter, 'HUM');
  assert.equal(await session.key('q', {}), true);
});
