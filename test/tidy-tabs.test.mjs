import test from 'node:test';
import assert from 'node:assert/strict';
import { isShellOnly, planTidy, reviewedAgentsFromRecords, reviewVerdict, sessionOrderFromLedgers } from '../contrib/tidy-tabs.mjs';

const tab = (tab_id, label, lane = false) => ({ tab_id, label, workspace_id: lane ? 'wL' : 'wM', lane });
const pane = (pane_id, tab_id, shellOnly = true) => ({ pane_id, tab_id, shellOnly });
const ids = (list) => list.map((x) => x.tab_id).sort();

test('closes exited watchers and old finished sessions, keeps the newest session', () => {
  const plan = planTidy({
    tabs: [tab('t1', 'watch R-1'), tab('t2', 'deliver R-2'), tab('t3', 'settle R-3'), tab('t4', 'settle R-4'), tab('t5', 'executive')],
    panes: [pane('p1', 't1'), pane('p2', 't2'), pane('p3', 't3'), pane('p4', 't4'), pane('p5', 't5')],
    agents: [
      { name: 'settle-r-3-1700', status: 'idle', pane_id: 'p3' },
      { name: 'settle-r-4-1800', status: 'done', pane_id: 'p4' },
      { name: 'exec-1900', status: 'idle', pane_id: 'p5' },
    ],
    sessionOrder: sessionOrderFromLedgers([{ day: '2026-09-16', text: '17:00:00 settle-r-3-1700 settle R-3\n18:00:00 settle-r-4-1800 settle R-4\n19:00:00 exec-1900 continue \n' }]),
    keepSessions: 1,
  });
  assert.deepEqual(ids(plan.close), ['t1', 't2', 't3', 't4']);
  assert.deepEqual(plan.keep.map((k) => k.tab_id), ['t5']);
});

test('never closes active, unnamed or still-running tabs, or its own tab', () => {
  const plan = planTidy({
    tabs: [tab('t1', 'watch R-1'), tab('t2', 'settle R-2'), tab('t3', 'supervisor'), tab('t4', 'executive'), tab('t5', 'watch R-5')],
    panes: [pane('p1', 't1', false), pane('p2', 't2'), pane('p3', 't3'), pane('p4', 't4'), pane('p5', 't5')],
    agents: [
      { name: 'settle-r-2-1700', status: 'working', pane_id: 'p2' },
      { name: null, status: 'idle', pane_id: 'p3' },
      { name: 'exec-1800', status: 'blocked', pane_id: 'p4' },
    ],
    selfTab: 't5',
    keepSessions: 0,
  });
  assert.deepEqual(plan.close, []);
  assert.deepEqual(ids(plan.keep), ['t1', 't2', 't3', 't4', 't5']);
});

test('an operator chat (unnamed agent) is kept even in a session or lane tab', () => {
  const plan = planTidy({
    tabs: [tab('t1', 'executive'), tab('t2', 'chat', true)],
    panes: [pane('p1', 't1'), pane('p2', 't2')],
    agents: [
      { name: null, status: 'idle', pane_id: 'p1' },
      { name: null, status: 'done', pane_id: 'p2' },
    ],
    keepSessions: 0,
  });
  assert.deepEqual(plan.close, []);
  for (const k of plan.keep) assert.match(k.why, /unnamed agent/);
});

test('closes lane worker tabs only when every worker there has a recorded report', () => {
  const plan = planTidy({
    tabs: [tab('t1', 'engineer', true), tab('t2', 'review', true), tab('t3', 'shell', true)],
    panes: [pane('p1', 't1'), pane('p2', 't2'), pane('p3', 't3')],
    agents: [
      { name: 'lane-a-1', status: 'idle', pane_id: 'p1' },
      { name: 'lane-b-1', status: 'done', pane_id: 'p2' },
    ],
    reportedAgents: new Set(['lane-a-1']),
  });
  assert.deepEqual(ids(plan.close), ['t1']);
  assert.match(plan.keep.find((k) => k.tab_id === 't2').why, /no recorded report for lane-b-1/);
  assert.match(plan.keep.find((k) => k.tab_id === 't3').why, /not a tab this tool manages/);
});

test('a newer lane review verdict finishes its idle review tab, but an older verdict does not', () => {
  const reviewedAgents = reviewedAgentsFromRecords([
    { name: 'lane-topic-review-old', role: 'review', topic: 'topic', created_at: '2026-09-18T15:00:00Z' },
    { name: 'lane-topic-review-new', role: 'review', topic: 'topic', created_at: '2026-09-18T17:00:00Z' },
    { name: 'lane-topic-engineer', role: 'engineer', topic: 'topic', created_at: '2026-09-18T15:00:00Z' },
  ], [
    { topic: 'topic', verdict: true, mtimeMs: Date.parse('2026-09-18T16:00:00Z') },
    { topic: 'not-a-verdict', verdict: false, mtimeMs: Date.parse('2026-09-18T18:00:00Z') },
  ]);
  assert.deepEqual([...reviewedAgents], ['lane-topic-review-old']);

  const plan = planTidy({
    tabs: [tab('t1', 'review old', true), tab('t2', 'review new', true), tab('t3', 'engineer', true), tab('t4', 'working', true)],
    panes: [pane('p1', 't1'), pane('p2', 't2'), pane('p3', 't3'), pane('p4', 't4')],
    agents: [
      { name: 'lane-topic-review-old', status: 'idle', pane_id: 'p1' },
      { name: 'lane-topic-review-new', status: 'done', pane_id: 'p2' },
      { name: 'lane-topic-engineer', status: 'idle', pane_id: 'p3' },
      { name: 'lane-topic-working', status: 'working', pane_id: 'p4' },
    ],
    reportedAgents: new Set(['lane-topic-engineer']),
    reviewedAgents,
  });
  assert.deepEqual(ids(plan.close), ['t1', 't3']);
  assert.match(plan.close.find((c) => c.tab_id === 't1').why, /review verdict is recorded/);
  assert.match(plan.keep.find((k) => k.tab_id === 't2').why, /no recorded report/);
  assert.match(plan.keep.find((k) => k.tab_id === 't4').why, /still active/);
});

test('a FAIL review record on its first nonempty line finishes an older review session', () => {
  assert.equal(reviewVerdict('\n\n**FAIL**\nSchema: lane-review/v1\n'), 'FAIL');
  assert.equal(reviewVerdict('\nheading\n**PASS**\n'), null);
  const reviewed = reviewedAgentsFromRecords([
    { name: 'lane-topic-review', role: 'review', topic: 'topic', created_at: '2026-09-18T15:00:00Z' },
  ], [
    { topic: 'topic', verdict: reviewVerdict('\n**FAIL**\n'), mtimeMs: Date.parse('2026-09-18T16:00:00Z') },
  ]);
  assert.deepEqual([...reviewed], ['lane-topic-review']);
});

test('a watcher label in a lane workspace or with an agent inside is left alone', () => {
  const plan = planTidy({
    tabs: [tab('t1', 'watch R-1', true), tab('t2', 'watch R-2')],
    panes: [pane('p1', 't1'), pane('p2', 't2')],
    agents: [{ name: 'lane-x', status: 'idle', pane_id: 'p2' }],
  });
  assert.deepEqual(plan.close, []);
});

test('shell-only detection', () => {
  assert.equal(isShellOnly({ shell_pid: 5, foreground_processes: [{ name: 'zsh', argv0: 'zsh', pid: 5 }] }), true);
  assert.equal(isShellOnly({ shell_pid: 5, foreground_processes: [{ name: 'node', argv0: 'node', pid: 9 }] }), false);
  assert.equal(isShellOnly(null), false);
});
