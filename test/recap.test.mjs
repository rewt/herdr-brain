import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { report, setupOrg } from './helpers.mjs';
import { BLOCK_RULES, blockName, listBlocks } from '../lib/block.mjs';
import { writer } from '../lib/store.mjs';

process.env.TZ = 'America/Chicago'; // UTC-5 in September
const ev = (at) => ({ at });
const local = (day, hm) => new Date(`2026-09-${day}T${hm}:00-05:00`).toISOString();

test('blocks are stretches of activity split by a two-hour quiet gap', () => {
  const events = [local(24, '09:00'), local(24, '10:30'), local(24, '12:10'), local(24, '15:00'), local(24, '15:40')].map(ev);
  const blocks = listBlocks(events, new Date(local(25, '08:00')));
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => [b.start, b.end, b.events, b.live]), [
    [local(24, '09:00'), local(24, '12:10'), 3, false],
    [local(24, '15:00'), local(24, '15:40'), 2, false],
  ]);
  assert.equal(blocks[0].name, 'Thu morning');
  assert.equal(blocks[1].name, 'Thu afternoon');
});

test('an overnight run is one block; a long day is cut at 06, 12, 18 and 22, short pieces joining a neighbour', () => {
  // 20:30 to 11:30 without a two-hour gap: cut at 22:00 and 06:00; 20:30-21:50 is short and joins the night.
  const night = [];
  for (let t = Date.parse(local(19, '20:30')); t <= Date.parse(local(20, '11:30')); t += 50 * 60000) night.push(ev(new Date(t).toISOString()));
  const blocks = listBlocks(night, new Date(local(20, '18:00')));
  assert.deepEqual(blocks.map((b) => b.name), ['Sat overnight', 'Sun morning']);
  assert.ok(Date.parse(blocks[0].start) === Date.parse(local(19, '20:30')));
  assert.ok(Date.parse(blocks[1].start) >= Date.parse(local(20, '06:00')));
  // Under eight hours nothing is cut, even across a boundary.
  const afternoon = [local(25, '12:41'), local(25, '14:00'), local(25, '15:40'), local(25, '17:10'), local(25, '18:22')].map(ev);
  const one = listBlocks(afternoon, new Date(local(25, '18:30')));
  assert.equal(one.length, 1);
  assert.equal(one[0].live, true, 'within the gap of now, the block is still going');
  assert.equal(blockName(Date.parse(local(25, '12:41')), Date.parse(local(25, '18:22'))), 'Fri afternoon');
  assert.deepEqual(BLOCK_RULES.cutHours, [6, 12, 18, 22]);
});

test('a write without ORG_ACTOR and without a terminal is flagged unattributed, never refused', () => {
  assert.deepEqual(writer({}, { isTTY: true }), { actor: 'human', unattributed: false });
  assert.deepEqual(writer({}, { isTTY: false }), { actor: 'human', unattributed: true });
  assert.deepEqual(writer({ ORG_ACTOR: 'sup-1' }, {}), { actor: 'sup-1', unattributed: false });
  const t = setupOrg();
  const r = t.org(['add', 'Something an agent noticed', '--role', 'engineer']);
  assert.equal(r.code, 0);
  assert.match(r.err, /unattributed .*ORG_ACTOR=<its session name>/);
  t.ok(['add', 'Named', '--role', 'engineer'], { env: { ORG_ACTOR: 'sup-1' } });
  t.ok(['add', 'The operator, through the console', '--role', 'engineer'], { env: { ORG_ACTOR: 'human' } });
  const added = t.events().filter((e) => e.type === 'item.added');
  assert.deepEqual(added.map((e) => [e.by, e.unattributed ?? false]), [['human', true], ['sup-1', false], ['human', false]]);
  const show = t.json(['show', 'ENG-1', '--json']);
  assert.equal(show.created.unattributed, true);
});

// One afternoon: the operator's idea, an orchestrator session starting a worker,
// the worker spawning follow-ups and a question, the operator answering through
// the orchestrator, plus older untouched backlog.
function afternoon() {
  const t = setupOrg({ tz: 'America/Chicago' });
  const human = { env: { ORG_ACTOR: 'human' } };
  const sup = { env: { ORG_ACTOR: 'sup-1' } };
  const at = (day, hm, extra = human) => ({ ...extra, now: local(day, hm) });
  t.ok(['add', '--goal', 'Pool shipped'], at(22, '09:00'));
  t.ok(['add', 'Old proposal nobody picked up', '--parent', 'G-1', '--role', 'engineer'], at(22, '09:05')); // ENG-1
  t.ok(['add', 'Research: verify proofs in script', '--parent', 'G-1', '--role', 'architect'], at(24, '22:00')); // ARCH-1, the idea
  t.ok(['add', 'Prototype the one-hash input', '--parent', 'ARCH-1', '--role', 'architect'], at(25, '12:41', sup)); // ARCH-2
  t.ok(['start', 'ARCH-2', '--meta', 'agent=lane-hash-1', '--meta', 'lane=pool-hash'], at(25, '12:43', sup)); // R-1
  fs.writeFileSync(path.join(t.dir, 'runs/R-1/report.md'), report([
    'run: R-1', 'outcome: done', 'summary: Measured it. The key shrinks.', 'headline: A one-hash input shrinks the key to half a kilobyte',
    'proposals:', '  - role: engineer', '    title: Adopt the one-hash input', '    why: it is cheaper',
    '  - role: human', '    title: Adopt the one-hash input before the audit?', '    why: it changes the circuit',
    '  - role: reviewer', '    title: Review the prototype', '    why: independent check',
  ].join('\n')));
  t.ok(['sync'], at(25, '13:44', sup)); // ENG-2, HUM-1, REV-1 by run:R-1
  t.ok(['answer', 'HUM-1', 'yes', '--note', 'Operator 2026-09-25: adopt it'], at(25, '15:06', sup));
  t.ok(['note', 'ARCH-2', '--decision', '--summary', 'One-hash input accepted', 'Accepted after review.'], at(25, '16:20', sup));
  t.ok(['close', 'REV-1', '--note', 'folded into ENG-2'], at(25, '16:21', sup));
  t.ok(['ask', 'Which curve?', '--parent', 'ARCH-2', '--category', 'design', '--recommend', 'yes', '--why', 'Both work.'], at(25, '17:15', sup)); // HUM-2
  return t;
}

test('org recap: threads from the idea, what each spawned and asked, who steered, what is pending', () => {
  const t = afternoon();
  const doc = t.json(['recap', '--json'], { now: local(25, '18:30') });
  assert.equal(doc.block.name, 'Fri afternoon');
  assert.equal(doc.block.live, true);
  assert.equal(doc.blocks.count, 3);
  assert.deepEqual(doc.origins.map((o) => o.id), ['ARCH-1'], 'the thread grew from the operator\'s idea');
  assert.equal(doc.threads.length, 1);
  const [thread] = doc.threads;
  assert.equal(thread.root.id, 'ARCH-2');
  assert.deepEqual(thread.agents, ['lane-hash-1']);
  assert.deepEqual(thread.runs.map((r) => [r.run, r.lane, r.outcome, r.headline]), [['R-1', 'pool-hash', 'done', 'A one-hash input shrinks the key to half a kilobyte']]);
  assert.deepEqual(thread.spawned.map((x) => [x.id, x.by, x.run]), [['ENG-2', 'run:R-1', 'R-1'], ['REV-1', 'run:R-1', 'R-1']]);
  assert.deepEqual(thread.counts, { runs: 1, spawned: 2, open: 1, questions_open: 1, decisions: 1 });
  assert.deepEqual(thread.questions.map((q) => [q.id, q.asked.by, q.answer, q.answered?.by ?? null]), [['HUM-1', 'run:R-1', 'yes', 'sup-1'], ['HUM-2', 'sup-1', null, null]]);
  assert.deepEqual(doc.pending.map((p) => p.id), ['ENG-2']);
  // The decision queue is the org's own: the same open questions as org today.
  const today = t.json(['today', '--json'], { now: local(25, '18:30') });
  assert.deepEqual(doc.waiting.map((q) => q.id), today.waiting.map((q) => q.id));
  assert.deepEqual(doc.waiting.map((q) => q.id), ['HUM-2']);
  // Steering, newest first.
  assert.deepEqual(doc.decisions.map((d) => [d.kind, d.id, d.by]), [
    ['asked', 'HUM-2', 'sup-1'], ['decision', 'ARCH-2', 'sup-1'], ['answered', 'HUM-1', 'sup-1'], ['asked', 'HUM-1', 'run:R-1'],
  ]);
  // Sessions: the orchestrator started the run; the worker is its agent.
  assert.deepEqual(doc.sessions.map((x) => [x.kind, x.name]), [['orchestrator', 'sup-1'], ['worker', 'lane-hash-1']]);
  assert.equal(doc.sessions[0].runs_started, 1);
  assert.equal(doc.sessions[1].headline, 'A one-hash input shrinks the key to half a kilobyte');
  // Older open work is folded, not listed: the idea itself, and one proposal untouched since Sep 22.
  assert.equal(doc.backlog.open, 2);
  assert.equal(doc.backlog.stale, 1);
  assert.deepEqual(doc.backlog.by_origin.map((g) => [g.id, g.count, g.stale]), [['ENG-1', 1, 1], ['ARCH-1', 1, 0]]);
  // The text view says the same thing.
  const text = t.ok(['recap'], { now: local(25, '18:30') });
  assert.match(text, /^Fri afternoon · 12:41–now/);
  assert.match(text, /WAITING ON YOU \(1\)\n {2}HUM-2 {2}Which curve\?/);
  assert.match(text, /grew from ARCH-1 Research: verify proofs in script/);
});

test('org recap --back steps to earlier blocks and refuses a bad count', () => {
  const t = afternoon();
  const earlier = t.json(['recap', '--json', '--back', '1'], { now: local(25, '18:30') });
  assert.equal(earlier.block.name, 'Thu overnight');
  assert.deepEqual(earlier.threads.map((x) => x.root.id), ['ARCH-1']);
  assert.equal(earlier.blocks.next.name, 'Fri afternoon');
  assert.equal(t.json(['recap', '--json', '--back', '9'], { now: local(25, '18:30') }).block, null);
  assert.match(t.fail(['recap', '--back', 'two']), /--back expects a whole number/);
});
