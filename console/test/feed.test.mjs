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
  assert.match(text, /SESSIONS · 2 live/); assert.match(text, /● lane-wrapper +claude · 25m/); assert.match(text, /ENG-2 +Build the wrapper/);
  assert.match(text, /DECIDE · 1/); assert.match(text, /HUM-3 Spend on Chipnet\?/); assert.match(text, /question · all recommended/);
  assert.match(text, /ENG-2 +new Build the wrapper/); assert.match(text, /“The wrapper is missing\.”/);
  assert.ok(session.frame(60, 40).lines.every(l => lineText(l).length <= 60));
  const f = session.frame(60, 40), y = f.hits.findIndex(h => h.some(x => x.id.startsWith('item:ENG-2')));
  await session.mouse({ x: 3, y, button: 'left', press: true });
  assert.equal(session.ui.view, 'item'); text = session.frame(60, 40).lines.map(lineText).join('\n');
  assert.match(text, /The wrapper is missing\. It blocks stage 3\./); assert.match(text, /created .* by R-1 · under ARCH-1/); assert.match(text, /R-2 claude · eng-agent · working/);
  await session.key('o', {}); assert.deepEqual(gone, [{ agent: 'eng-agent' }]);
  await session.key('', { escape: true }); assert.equal(session.ui.view, 'feed');
  await session.key('F', {}); assert.equal(session.ui.filter, 'HUM');
  assert.equal(await session.key('q', {}), true);
});

test('the IDs on the chat screen resolve to items, runs to the item they work, the rest is shorthand', () => {
  const screen = 'Done with ARCH-1 (R-1). OD-1 recorded. See archive/REVIEW-20260930.md. Now R-2 is building; HUM-3 waits.';
  const m = feedModel({ status, events, agents, now, screen });
  assert.deepEqual(m.onScreen.map(o => [o.id, o.via, o.said]), [['ARCH-1', 'R-1', ['R-1']], ['ENG-2', 'R-2', ['R-2']], ['HUM-3', null, []]]);
  assert.deepEqual(m.shorthand, ['OD-1']);
  assert.equal(m.onScreen.find(o => o.id === 'ENG-2').working.state, 'working');
  assert.equal(m.onScreen.find(o => o.id === 'ARCH-1').latest.verb, 'decided');
});

test('the pane reads the agent sharing its tab and lists what that chat mentions', async () => {
  const reads = [];
  const session = createFeedSession({ config: { projects: [{ name: 'Alpha', org: '/org' }] }, env: { HERDR_PANE_ID: 'w:p9' },
    deps: { now: () => now, orgStatus: async () => status, orgLog: async () => events, herdrAgents: async () => ({ ok: true, agents: [...agents, { name: 'supervisor', pane: 'w:p1', status: 'idle' }] }),
      herdrList: async () => [{ pane_id: 'w:p1', tab_id: 'w:t1', agent: 'claude' }, { pane_id: 'w:p9', tab_id: 'w:t1' }, { pane_id: 'w:p2', tab_id: 'w:t2', agent: 'claude' }],
      herdrVisible: async t => { reads.push(t); return { ok: true, text: 'Next: ENG-2 (R-2).' }; } } });
  await session.refresh();
  assert.deepEqual(reads, ['w:p1'], 'only the visible screen of the tab neighbour is read');
  const text = session.frame(60, 40).lines.map(lineText).join('\n');
  assert.match(text, /● lane-wrapper +claude · 25m ◂/, 'the session the chat talks about is marked'); assert.doesNotMatch(text, /ALSO IN THE CHAT/);
});

test('a plan label resolves only through a recorded alias, preferring an open item', () => {
  const withAlias = { ...status, items: [...status.items.map(i => i.id === 'ENG-2' ? { ...i, meta: { alias: 'S1, 3B' } } : i),
    { id: 'ENG-9', kind: 'work', role: 'engineer', title: 'Old slice S1', status: 'done', closed: { at: at(900) }, meta: { alias: 'S1' }, created: { at: at(900) }, runs: [], notes: [] }] };
  const m = feedModel({ status: withAlias, events, agents, now, screen: 'S1 is built; 3B next. P9 guards it.' });
  assert.deepEqual(m.onScreen.map(o => [o.id, o.said]), [['ENG-2', ['S1', '3B']]]);
  assert.ok(!m.shorthand.includes('S1') && !m.shorthand.includes('3B'), 'recorded aliases resolve'); assert.ok(!m.shorthand.includes('P9'), 'P9 is not a label pattern');
  const session = { ui: {} };
  const text = renderFeed({ s: { view: 'feed', scroll: 0, watching: 'supervisor', errors: {} }, model: m, project: { name: 'Alpha' }, now }, 60, 30).lines.map(lineText).join('\n');
  assert.match(text, /● lane-wrapper +claude · 25m ◂/);
});

import { reportDecisions, waitingQueue, answerMessage, promptDraft } from '../modern/feed.mjs';
const REPORT = `# Report\n\n## Decisions for the operator\n\n1. **Adopt the new slot?** Recommend **yes as the successor design**, gated on review.\n2. **Split the verifier now?** Recommend **no split now**. Measure first.\n\n## Next\n\n1. not a decision\n`;

test('a report’s operator decisions become numbered questions with their recommendations', () => {
  assert.deepEqual(reportDecisions(REPORT).map(d => [d.n, d.question, d.recommend]), [[1, 'Adopt the new slot?', 'yes as the successor design'], [2, 'Split the verifier now?', 'no split now']]);
  assert.deepEqual(reportDecisions('# Report\n\nNo decisions here.'), []);
});

test('the queue holds open questions and unanswered report decisions, most blocking then newest first', () => {
  const items = new Map([
    ['HUM-3', { id: 'HUM-3', role: 'human', status: 'open', title: 'Spend?', created: { at: at(50), run: 'R-1' }, blocks: ['ENG-2', 'ENG-4'], meta: { recommend: 'yes' } }],
    ['ARCH-1', { id: 'ARCH-1', role: 'architect', status: 'done', title: 'Plan', created: { at: at(300) }, blocks: [], notes: [] }],
    ['ARCH-5', { id: 'ARCH-5', role: 'architect', status: 'done', title: 'Old plan', created: { at: at(300) }, blocks: [], notes: [] }],
  ]);
  const ev = [{ seq: 10, at: at(20), type: 'report.ingested', run: 'R-7', item: 'ARCH-1', report: { headline: 'Planned.' } },
    { seq: 11, at: at(19), type: 'report.ingested', run: 'R-8', item: 'ARCH-5', report: {} },
    { seq: 12, at: at(5), type: 'note.added', id: 'ARCH-5', decision: true, text: 'Operator: yes' }];
  const decisions = new Map([['R-7', reportDecisions(REPORT)], ['R-8', reportDecisions(REPORT)]]);
  const q = waitingQueue(items, new Map(), ev, decisions);
  assert.deepEqual(q.map(w => [w.key, w.decisions.length]), [['HUM-3', 1], ['R-7', 2]], 'ARCH-5 has a decision note since its report');
  assert.deepEqual(waitingQueue(items, new Map(), ev, decisions, 'oldest').map(w => w.key), ['HUM-3', 'R-7']);
  const entry = q[1];
  assert.equal(answerMessage(entry, {}), null);
  assert.equal(answerMessage(entry, { 1: 'rec', 2: 'no' }, 'measure first'), 'Operator answer from the items pane for R-7 (ARCH-1) decisions: 1 yes as the successor design (as recommended); 2 no. measure first');
  assert.equal(answerMessage(q[0], { 1: 'yes' }), 'Operator answer from the items pane for HUM-3: yes');
});

test('a prompt box with unsent text is detected; an empty one is not', () => {
  const rule = '─'.repeat(40);
  assert.equal(promptDraft(`history\n❯ old message\n${rule}\n❯ yes on all four\n${rule}\n  ⏵⏵ auto mode`), 'yes on all four');
  assert.equal(promptDraft(`history\n❯ old message\n${rule}\n❯ \n${rule}\n  ⏵⏵ auto mode`), null);
});

test('answering from the pane sends one message to the supervisor, never over an unsent draft', async () => {
  const sent = []; let screen = `x\n${'─'.repeat(20)}\n❯ half typed\n${'─'.repeat(20)}`;
  const withRep = { ...status, runs: [...status.runs.map(r => r.id === 'R-1' ? { ...r, report_path: '/r1.md' } : r)] };
  const session = createFeedSession({ config: { projects: [{ name: 'Alpha', org: '/org' }] }, env: { HERDR_FEED_WATCH: 'w:p1' },
    deps: { now: () => now, orgStatus: async () => withRep, orgLog: async () => events.filter(e => e.seq !== 5), readFile: async () => REPORT,
      herdrAgents: async () => ({ ok: true, agents: [...agents, { name: 'supervisor', pane: 'w:p1', status: 'idle' }] }),
      herdrVisible: async () => ({ ok: true, text: screen }), herdrPrompt: async (agent, text) => { sent.push([agent, text]); return { ok: true }; } } });
  await session.refresh();
  const entry = session.model.waiting.find(w => w.key === 'R-1'); assert.ok(entry, 'the report decisions wait on the operator');
  await session.ui.targets; session.frame(60, 60);
  const y = session.frame(60, 60).hits.findIndex(h => h.some(x => x.id === 'wait:R-1'));
  await session.mouse({ x: 2, y, button: 'left', press: true });
  let text = session.frame(60, 60).lines.map(lineText).join('\n');
  assert.match(text, /TITLE[\s\S]*SUMMARY[\s\S]*DECISIONS · 2[\s\S]*ACTION/); assert.match(text, /★ recommend: no split now/);
  await session.key('a', {}); await session.key('1', {}); await session.key('n', {});
  await session.key('', { return: true });
  assert.deepEqual(sent, []); assert.match(session.ui.message, /unsent text/);
  screen = `x\n${'─'.repeat(20)}\n❯ \n${'─'.repeat(20)}`;
  await session.key('', { return: true });
  assert.deepEqual(sent, [['supervisor', 'Operator answer from the items pane for R-1 (ARCH-1) decisions: 1 no; 2 no split now (as recommended)']]);
  assert.match(session.frame(60, 60).lines.map(lineText).join('\n'), /sent .*: waiting for the supervisor/);
});


import fsx from 'node:fs';
import osx from 'node:os';
import pathx from 'node:path';
import { addLine, createChatIndex, transcriptPath } from '../modern/chatindex.mjs';
import { unblockers, trackedItems, actionFor } from '../modern/feed.mjs';
const line = (type, text, ts) => JSON.stringify({ type, timestamp: ts, message: { content: type === 'assistant' ? [{ type: 'text', text }] : text } });

test('the chat index keeps every code the transcript mentions, incrementally and across handoffs', () => {
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'chatidx-'));
  try {
    const t1 = pathx.join(dir, 'a.jsonl'), file = pathx.join(dir, 'state', 'chat-index.json');
    fsx.writeFileSync(t1, line('assistant', 'Promote R-876, then dispatch 3D. ENG-765 waits.', '2026-09-30T18:00:00Z') + '\n' + line('user', '[org-report] run=R-873 item=ENG-776', '2026-09-30T18:01:00Z') + '\n');
    const idx = createChatIndex({ file });
    assert.equal(idx.update('s1', t1), true);
    assert.deepEqual(Object.keys(idx.data.mentions).sort(), ['3D', 'ENG-765', 'ENG-776', 'R-873', 'R-876']);
    assert.equal(idx.data.mentions['R-876'].messages[0].role, 'supervisor'); assert.equal(idx.data.mentions['R-873'].messages[0].role, 'notice');
    fsx.appendFileSync(t1, line('user', 'yes on R-876', '2026-09-30T18:05:00Z') + '\n' + '{"type":"assist');
    idx.update('s1', t1);
    assert.equal(idx.data.mentions['R-876'].count, 2); assert.equal(idx.data.lastOperatorAt, '2026-09-30T18:05:00Z');
    // A new transcript after a handoff adds to the same index; nothing is forgotten.
    const t2 = pathx.join(dir, 'b.jsonl'); fsx.writeFileSync(t2, line('assistant', 'Now ENG-788.', '2026-09-30T19:00:00Z') + '\n');
    const again = createChatIndex({ file }); again.update('s2', t2);
    assert.ok(again.data.mentions['R-876'] && again.data.mentions['ENG-788'], 'the saved index survives a restart and a new session');
    assert.equal(addLine({ mentions: {} }, 'not json', 's'), false);
  } finally { fsx.rmSync(dir, { recursive: true, force: true }); }
});

test('a transcript is found by session id under any Claude config directory', () => {
  const home = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'home-'));
  try {
    const d = pathx.join(home, '.claude-personal', 'projects', '-Users-x-repo'); fsx.mkdirSync(d, { recursive: true });
    fsx.writeFileSync(pathx.join(d, 'abc-123.jsonl'), '');
    assert.equal(transcriptPath('abc-123', '/Users/x/repo', { home, env: {} }), pathx.join(d, 'abc-123.jsonl'));
    assert.equal(transcriptPath('../etc', '/Users/x/repo', { home, env: {} }), null);
  } finally { fsx.rmSync(home, { recursive: true, force: true }); }
});

test('tracked items say what they need: decide, blocked with the actions that unblock them, stalled, working, resolved', () => {
  const items = new Map([
    ['ENG-10', { id: 'ENG-10', status: 'blocked', title: 'Blocked work', blocked_by: ['ENG-11', 'REV-12'], runs: [] }],
    ['ENG-11', { id: 'ENG-11', status: 'blocked', title: 'Middle', blocked_by: ['HUM-13', 'ENG-14'], runs: [] }],
    ['REV-12', { id: 'REV-12', status: 'active', title: 'Review', runs: ['R-12'] }],
    ['HUM-13', { id: 'HUM-13', role: 'human', status: 'open', title: 'Spend?', runs: [] }],
    ['ENG-14', { id: 'ENG-14', status: 'ready', title: 'Not started', runs: [] }],
    ['ENG-15', { id: 'ENG-15', status: 'active', title: 'Lost session', runs: ['R-15'] }],
    ['ENG-16', { id: 'ENG-16', status: 'done', title: 'Finished', closed: { at: at(5) }, runs: [] }],
  ]);
  const runs = new Map([['R-12', { id: 'R-12', item: 'REV-12', meta: { agent: 'rev' } }], ['R-15', { id: 'R-15', item: 'ENG-15', meta: { agent: 'gone' } }]]);
  const live = new Map([['rev', { name: 'rev', status: 'working' }]]);
  assert.deepEqual(unblockers(items.get('ENG-10'), items, runs, live).map(u => [u.id, u.kind]), [['HUM-13', 'decide'], ['ENG-14', 'dispatch'], ['REV-12', 'wait']]);
  assert.equal(actionFor(items.get('ENG-15'), runs, live).kind, 'redeploy');
  const chat = { mentions: Object.fromEntries(['ENG-10', 'HUM-13', 'R-15', 'ENG-16', 'R-12'].map((c, i) => [c, { last: at(10 - i), messages: [{ at: at(10 - i), role: 'supervisor', text: `about ${c}` }] }])), lastTurn: { codes: ['R-15'] } };
  const onItem = new Map([['REV-12', { run: 'R-12', state: 'working', harness: 'codex', lane: 'lane-rev', for: 6e4 }]]);
  const t = trackedItems({ items, runs, live, chat, waiting: [], onItem });
  assert.deepEqual(Object.fromEntries(t.map(x => [x.id, x.state])), { 'ENG-10': 'blocked', 'HUM-13': 'decide', 'ENG-15': 'stalled', 'ENG-16': 'resolved', 'REV-12': 'working' });
  assert.deepEqual(t.find(x => x.id === 'ENG-15').said, ['R-15']); assert.equal(t.find(x => x.id === 'ENG-15').latest, true);
});

test('the pane narrows by state, and asks the supervisor to dispatch what blocks an item', async () => {
  const sent = [];
  const items = [...status.items, { id: 'ENG-20', kind: 'work', role: 'engineer', title: 'Blocked thing', status: 'blocked', blocked_by: ['ENG-21'], created: { at: at(40) }, runs: [], notes: [] },
    { id: 'ENG-21', kind: 'work', role: 'engineer', title: 'Prerequisite', status: 'ready', created: { at: at(40) }, runs: [], notes: [] }];
  const chatData = { mentions: { 'ENG-20': { last: at(3), messages: [{ at: at(3), role: 'supervisor', text: 'ENG-20 waits on ENG-21.' }] } }, lastTurn: { codes: ['ENG-20'] } };
  const session = createFeedSession({ config: { projects: [{ name: 'Alpha', org: '/org' }] }, env: { HERDR_FEED_WATCH: 'w:p1' },
    deps: { now: () => now, orgStatus: async () => ({ ...status, items }), orgLog: async () => events, chatIndex: { data: chatData, update: () => false },
      herdrAgents: async () => ({ ok: true, agents: [...agents, { name: 'supervisor', pane: 'w:p1', status: 'idle' }] }), herdrList: async () => [],
      herdrVisible: async () => ({ ok: true, text: '' }), herdrPrompt: async (a, t) => { sent.push([a, t]); return { ok: true }; } } });
  await session.refresh();
  let text = session.frame(60, 80).lines.map(lineText).join('\n');
  assert.match(text, /view: \[unresolved\]/); assert.match(text, /BLOCKED · 1[\s\S]*ENG-20 Blocked thing ◂[\s\S]*→ ENG-21 not started; dispatch it[\s\S]*SESSIONS/);
  await session.key('f', {}); await session.key('f', {}); text = session.frame(60, 80).lines.map(lineText).join('\n');
  assert.match(text, /\[blocked\]/); assert.doesNotMatch(text, /SESSIONS/);
  const f = session.frame(60, 80), y = f.hits.findIndex(h => h.some(x => x.id === 'item:ENG-20~t'));
  await session.mouse({ x: 2, y, button: 'left', press: true });
  text = session.frame(60, 80).lines.map(lineText).join('\n');
  assert.match(text, /BLOCKED BY · 1/); assert.match(text, /IN THE CHAT · 1[\s\S]*ENG-20 waits on ENG-21/);
  const g = session.frame(60, 80), yy = g.hits.findIndex(h => h.some(x => x.id === 'ask:ENG-21'));
  await session.mouse({ x: 2, y: yy, button: 'left', press: true });
  assert.match(session.frame(60, 80).lines.map(lineText).join('\n'), /Enter sends to the supervisor:[\s\S]*please dispatch ENG-21; it/); assert.equal(session.ui.ask.text, 'Operator from the items pane: please dispatch ENG-21; it blocks ENG-20.'); assert.deepEqual(sent, []);
  await session.key('', { return: true });
  assert.deepEqual(sent, [['supervisor', 'Operator from the items pane: please dispatch ENG-21; it blocks ENG-20.']]);
});
