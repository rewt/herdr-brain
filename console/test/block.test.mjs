// The block screen, offline: a recap derived by the core from synthetic events,
// live sessions and Brain rows from fixtures. No model, no Herdr, no org writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fold, statusMap } from '../../lib/state.mjs';
import { blockJson } from '../../lib/block.mjs';
import { itemJson } from '../../lib/render.mjs';
import { createModernSession } from '../modern/session.mjs';
import { plainTitle, laneFamily, actorWords, provenance, blockView } from '../modern/block.mjs';
import { lineText } from '../lib/frame.mjs';

process.env.TZ = 'America/Chicago';
const at = (day, hm) => new Date(`2026-09-${day}T${hm}:00-05:00`).toISOString();
let seq = 0;
const e = (day, hm, by, type, fields) => ({ seq: ++seq, at: at(day, hm), by, type, ...fields });
const item = (id, title, parent, extra = {}) => ({ id, kind: 'work', title, role: extra.role ?? 'engineer', parent, accept: [], budget: {}, meta: {}, ...extra });

// Thursday: the operator's idea. Friday afternoon: an orchestrator starts a
// worker, which spawns follow-ups and a question; the operator answers through it.
const events = [
  e(24, '09:00', 'human', 'item.added', item('G-1', 'Pool shipped', null, { kind: 'goal', role: null })),
  e(24, '09:05', 'human', 'item.added', item('ENG-1', 'Old proposal nobody picked up', 'G-1')),
  e(24, '22:00', 'human', 'item.added', item('ARCH-1', 'Research (operator): verify proofs in script. More words.', 'G-1', { role: 'architect' })),
  e(25, '12:41', 'sup-1', 'item.added', item('ARCH-2', 'ARCH-1: prototype the one-hash input', 'ARCH-1', { role: 'architect' })),
  e(25, '12:43', 'sup-1', 'run.started', { id: 'R-1', item: 'ARCH-2', meta: { agent: 'lane-hash-1', lane: 'pool-hash' } }),
  e(25, '13:44', 'run:R-1', 'report.ingested', { run: 'R-1', item: 'ARCH-2', report: { run: 'R-1', outcome: 'done', summary: 'Measured.', headline: 'The key shrinks to half a kilobyte' } }),
  e(25, '13:44', 'run:R-1', 'item.added', { ...item('ENG-2', 'Adopt the one-hash input', 'ARCH-2'), from_run: 'R-1' }),
  e(25, '13:44', 'run:R-1', 'item.added', { ...item('HUM-1', 'Adopt it before the audit?', 'ARCH-2', { role: 'human' }), from_run: 'R-1' }),
  e(25, '13:50', 'sup-1', 'run.started', { id: 'R-2', item: 'ENG-2', meta: { agent: 'lane-hash-2', lane: 'pool-hash-review' } }),
  e(25, '15:06', 'sup-1', 'note.added', { id: 'HUM-1', text: 'Answered yes: adopt it', decision: true, kind: 'answer' }),
  e(25, '15:06', 'sup-1', 'item.updated', { id: 'HUM-1', fields: { meta: { answer: 'yes', answered_by: 'sup-1' } } }),
  e(25, '15:06', 'sup-1', 'item.closed', { id: 'HUM-1', as: 'done', note: 'Operator: adopt it' }),
  e(25, '16:20', 'sup-1', 'note.added', { id: 'ARCH-2', text: 'Accepted.', summary: 'One-hash input accepted', decision: true }),
  e(25, '17:15', 'sup-1', 'item.added', item('HUM-2', 'Which curve?', 'ARCH-2', { role: 'human' })),
];
const now = new Date(at(25, '18:30'));
const s = fold(events), statuses = statusMap(s);
const recap = back => blockJson(s, events, { now, back });
const status = { items: [...s.items.keys()].map(id => itemJson(s, id, statuses)), runs: [...s.runs.values()] };
const today = { project: {}, waiting: [{ id: 'HUM-2', title: 'Which curve?', status: 'ready', created: { at: at(25, '17:15'), by: 'sup-1' }, blocks: [] }], running: [], agent_runs: [], decided: [], finished: [] };

function fixture() {
  const space = { workspace_id: 'w1', label: 'main', active_tab_id: 'w1:t1', worktree: { repo_key: '/a/.git', repo_root: '/a', repo_name: 'a', checkout_path: '/a', is_linked_worktree: false } };
  const agents = [{ name: 'lane-hash-2', pane: 'w1:p2', tab: 'w1:t1', workspace: 'w1', cwd: '/a', tool: 'claude', status: 'working' }];
  const brainRow = { id: 'b1', session: 'old-session', where: '/a', project: 'a', at: at(17, '21:30'), state: 'idle', status: 'digested', pane: 'gone:1', digest: { kind: 'decision', needs_you: true, item: 'ENG-1', question: 'Stop the old job?' } };
  const backs = [];
  const deps = {
    identity: cwd => cwd?.startsWith('/a') ? { key: '/a/.git', root: '/a', name: 'a', git: true } : null,
    orgToday: async () => today, orgStatus: async () => status, orgRecap: async (p, back) => { backs.push(back); return recap(back); },
    brainQueue: async () => ({ rows: [brainRow], off: false }), herdrList: async what => what === 'workspace' ? [space] : what === 'tab' ? [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'main' }] : [],
    herdrAgents: async () => ({ ok: true, agents }), herdrRead: async () => ({ ok: true, text: '' }), gitSummary: async () => null, now: () => now.getTime(),
    observeTerminal: null, controlTerminal: null,
  };
  const session = createModernSession({ config: { projects: [{ name: 'a', cwd: '/a', org: '/org-a' }], refresh_seconds: 60 }, deps, env: {} });
  return { session, backs };
}
const screen = (session, cols = 140, rows = 50) => session.frame(cols, rows).lines.map(lineText).join('\n');

test('titles, lanes and actors read in plain words', () => {
  assert.equal(plainTitle('ARCH-191: fast proving-key loading for wallets. Verify the key once.'), 'Fast proving-key loading for wallets');
  assert.equal(plainTitle('Re-scope task 5.4: replace the ladder'), 'Re-scope task 5.4: replace the ladder');
  assert.equal(laneFamily('pool-crs-coverage-review2'), 'pool-crs-coverage');
  const r = recap(0);
  assert.equal(actorWords('run:R-1', r), 'R-1 pool-hash');
  assert.equal(actorWords('human', r), 'human', 'recorded as human is not proof it was the operator');
  assert.equal(actorWords('sup-1', r), 'sup-1');
});

test('provenance says which run spawned an item, while working on what', () => {
  const items = new Map(status.items.map(i => [i.id, i])), runs = new Map(status.runs.map(r => [r.id, r]));
  assert.match(provenance(items.get('ENG-2'), runs, items), /^Spawned by R-1 · lane pool-hash while working ARCH-2 Prototype the one-hash input · Sep 25 13:44$/);
  assert.match(provenance(items.get('ARCH-2'), runs, items), /^Added by sup-1 · /);
  assert.match(provenance({ created: { by: 'human', at: at(25, '09:00'), unattributed: true } }), /no session named \(unverified\)/);
});

test('the block screen: when, what it grew from, the org\'s decisions apart from session prompts, threads, steering, sessions', async () => {
  const { session } = fixture(); await session.refresh();
  const text = screen(session);
  assert.match(text, /Block {3}Pending 1 {3}Decide 1 · 1 prompts {3}Backlog 2/);
  assert.match(text, /Fri afternoon · 12:41–now · \d+(\.\d)?h · still going/);
  assert.match(text, /‹ \[ Thu overnight/);
  assert.match(text, /grew from ARCH-1 Research \(operator\): verify proofs in script/);
  assert.match(text, /Decide · 1 .*the same list as org today/);
  assert.match(text, /HUM-2 {4}Which curve\?/);
  assert.match(text, /\+ 1 stopped session left a question the org does not record · oldest Sep 17 21:30/);
  assert.match(text, /\?ARCH-2 {4}Prototype the one-hash in.*\s2\s+1\s+1\s+1 {2}16:20 One-hash input accepted/);
  assert.match(text, /15:06 {2}HUM-1 → yes +Operator: adopt it\s+· sup-1/);
  assert.match(text, /13:44 {2}asked HUM-1 +Adopt it before the audit\?\s+· R-1 pool-hash/);
  assert.match(text, /1 {2}● lane-hash-2\s+main\s+working\s+1 run this block/);
  assert.match(text, /· sup-1\s+orchestrator\s+2 runs started · 1 answers · 1 decisions/);
  assert.match(text, /Backlog · 2 older open items, folded · 0 untouched 2d\+ · 1 reported done, never closed/);
  // The decision list is exactly the org's open questions.
  const v = blockView(session.model);
  assert.deepEqual(v.decide.map(q => q.id), today.waiting.map(q => q.id));
  assert.ok(v.decide[0].need, 'an org question links to its answer page');
});

test('Enter opens a thread with its pending work, steering and runs; [ steps to the block before', async () => {
  const { session, backs } = fixture(); await session.refresh();
  await session.activate('thread:ARCH-2');
  let text = screen(session);
  assert.equal(session.ui.view, 'thread');
  assert.match(text, /ARCH-2 · done · 2 runs by 2 sessions in 1 lane/);
  assert.match(text, /grew from ARCH-1 Research \(operator\): verify proofs in script · added Sep 24 22:00 by human/);
  assert.match(text, /Pending here · 1 of 1 spawned\s*\n\s*ENG-2 {4}active {2}Adopt the one-hash input\s+R-1 · 13:44/);
  assert.match(text, /13:50 {2}R-2 +ENG-2 +running/);
  await session.activate('view:pending'); text = screen(session);
  assert.match(text, /Pending · 1 items the sessions identified in Fri afternoon/);
  await session.activate('view:backlog'); text = screen(session);
  assert.match(text, /Backlog · 2 open items outside this block/);
  assert.match(text, /G-1 Pool shipped\s+2 open · 0 untouched 2d\+/);
  await session.activate('view:overview'); await session.key('[');
  assert.deepEqual(backs.slice(-1), [1]);
  text = screen(session);
  assert.match(text, /Thu overnight · 22:00–22:00/);
  assert.match(text, /Fri afternoon \] ›/);
  assert.match(text, /Decide · 1 now/, 'an earlier block still shows what waits now, and says so');
  await session.key(']'); assert.match(screen(session), /Fri afternoon · 12:41/);
});

test('without a recap the project screen is unchanged', async () => {
  const { session } = fixture();
  session.ui.back = 0;
  await session.refresh();
  session.model.recap.block = null;
  assert.doesNotMatch(screen(session), /Fri afternoon/);
});
