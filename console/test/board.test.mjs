// The 0.0.2 board: Waiting on you, sessions grouped by repository, and today's
// history. Pure; fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boardKeys, boardRows, orderBoard, scopeItems, sessionContext, visibleBoard,
} from '../lib/model.mjs';

import { at, board, boardHerdr, boardToday } from './fixtures/board.mjs';

const rowsOf = (b) => b.groups.map((g) => [g.name, g.path, g.rows.map((r) => [r.session, r.who.text, r.where, r.up, r.state, r.doing])]);

test('every Herdr agent is a row in its repository group, with all six columns filled or unknown', () => {
  const b = board();
  assert.deepEqual(b.waiting.map((q) => [q.key, q.headline, q.title, q.category, q.recommend, q.asked]), [
    ['q:HUM-5', 'HUM-5 — Promote the Herdr Brain console into main?', 'Promote the Herdr Brain console into main?', 'tooling', 'yes', '19:19'],
  ]);
  assert.deepEqual(rowsOf(b), [
    // Blocked first, then working (herdr-org and zeta by name), then idle.
    ['herdr-lanes', '~/herdr-lanes', [
      ['board-messages', 'Codex · unknown', 'lane-board-messages', 'unknown', 'blocked', 'no description'],
    ]],
    ['herdr-org', '~/herdr-org', [
      ['lane brain-console-v1 r3', 'Claude Opus 5 · high', 'lane-brain-console-v1', '44m', 'working', 'Verifying correction round three'],
      ['settle-r-4-1912', 'Claude Fable 5.1', 'herdr-org', '1h', 'done', 'no description'],
      ['lane relay r1', 'Codex Astra · xhigh', 'lane-relay', '20m', 'gone', 'Port the relay to the new rules.'],
    ]],
    ['zeta', '~/zeta', [
      ['zeta shell', 'Claude · unknown', 'zeta', 'unknown', 'working', 'Zeta work here'],
    ]],
    ['coach', '~/coach', [
      ['tab 1', 'Claude · unknown', 'coach', 'unknown', 'idle', 'Coach.me connector with Claude chat'],
    ]],
  ]);
  const console = b.groups[1].rows[0];
  assert.equal(console.key, 'r:R-4', 'a row with an org run keeps its identity whether Herdr answers or not');
  assert.equal(console.run.run, 'R-4');
  assert.deepEqual(console.go, { agent: 'lane-console-a', tab: 'w1:t2', pane: 'w1:p2' });
  assert.equal(b.groups[3].rows[0].key, 'h:pane:w2:p1');
  assert.deepEqual(b.groups[3].rows[0].go, { agent: null, tab: 'w2:t1', pane: 'w2:p1' });
  const gone = b.groups[1].rows[2];
  assert.equal(gone.key, 'r:R-6');
  assert.equal(gone.go, null, 'a gone session has nowhere to go');
  assert.deepEqual(b.history.map((r) => [r.kind, r.headline, r.time]), [
    ['report', 'Console round two is fixed', '19:06'],
    ['decision', 'Keep the cells', '16:10'],
    ['answer', 'Install storage tool v0.3 now?', '16:05'],
  ]);
});

test('an org run whose agent is gone stays one hour, and Herdr being down shows unknown, never gone', () => {
  const b = board();
  const keys = b.groups.flatMap((g) => g.rows.map((r) => r.key));
  assert.ok(keys.includes('r:R-6'));
  assert.ok(!keys.includes('r:R-2'), 'gone for three hours: dropped');
  // Never seen by this console: the run's start decides.
  const fresh = board({ seen: new Map() });
  const freshKeys = fresh.groups.flatMap((g) => g.rows.map((r) => r.key));
  assert.ok(freshKeys.includes('r:R-6') && !freshKeys.includes('r:R-2'));
  // Its checkout is unknown: the project's checkout is its group.
  const noWorkspace = board({ nowMs: Date.parse(at('09:30')), seen: new Map(), fallbackCwd: '/r/herdr-org' });
  const old = noWorkspace.groups.flatMap((g) => g.rows).find((r) => r.key === 'r:R-2');
  assert.equal(old.state, 'gone');
  assert.equal(old.where, 'unknown');
  assert.equal(old.repo.name, 'herdr-org');
  assert.equal(old.doing, 'Old abandoned work');

  const down = board({ herdr: { ok: false, agents: [], error: 'no socket' } });
  const rows = down.groups.flatMap((g) => g.rows);
  assert.deepEqual(rows.map((r) => [r.key, r.state]), [['r:R-4', 'unknown'], ['r:R-6', 'unknown'], ['r:R-2', 'unknown']]);
  assert.equal(rows[0].who.text, 'Claude Opus · high', 'no transcript without Herdr: the alias stays');
});

test('SESSION and DOING never show codes', () => {
  const b = board();
  const CODE = /\b(?:ENG|G|HUM|REV|R)-\d+\b/;
  for (const r of b.groups.flatMap((g) => g.rows)) {
    assert.doesNotMatch(r.session, CODE);
    assert.doesNotMatch(r.doing, CODE);
  }
  const titled = board({ herdr: { ok: true, agents: [{ ...boardHerdr().agents[0], title: 'REV-8 pstore retention design' }] } });
  assert.equal(titled.groups[0].rows[0].doing, 'pstore retention design');
  // A session may belong to another organization: the prefixes org issues by default go too.
  const other = board({ herdr: { ok: true, agents: [{ ...boardHerdr().agents[0], title: 'ARCH-28 successor wording fixes' }] } });
  assert.equal(other.groups[0].rows[0].doing, 'successor wording fixes');
});

test('groups follow their most urgent session, then name; worktrees join their main repository', () => {
  const b = board();
  assert.deepEqual(b.groups.map((g) => g.key), ['/r/herdr-lanes', '/r/herdr-org', '/r/zeta', '/r/coach']);
  assert.equal(b.groups[1].rows.length, 3, 'two worktrees and the main checkout in one group');
  // An agent outside any known folder still has a group.
  const lost = board({ herdr: { ok: true, agents: [{ name: 'x', status: 'idle', cwd: '/nowhere', tool: 'claude' }] }, today: { ...boardToday(), running: [] } });
  assert.deepEqual(lost.groups.map((g) => [g.name, g.path]), [['unknown repository', '']]);
});

test('refreshes keep groups and rows in place; a scope narrows what is shown', () => {
  const first = board();
  const keys = boardKeys(first);
  // Next refresh: coach starts working and would sort before zeta.
  const h = boardHerdr();
  h.agents[2].status = 'working';
  const next = orderBoard(board({ herdr: h }), keys);
  assert.deepEqual(next.groups.map((g) => g.name), ['herdr-lanes', 'herdr-org', 'zeta', 'coach']);
  const natural = board({ herdr: h });
  assert.deepEqual(natural.groups.map((g) => g.name), ['herdr-lanes', 'coach', 'herdr-org', 'zeta']);

  assert.deepEqual(boardRows(first, 'list').map((r) => r.key), [
    'q:HUM-5', 'h:board-messages', 'r:R-4', 'h:settle-r-4-1912', 'r:R-6', 'h:pane:w4:p1', 'h:pane:w2:p1',
  ]);
  assert.deepEqual(boardRows(first, 'history').map((r) => r.kind), ['report', 'decision', 'answer']);

  const org = visibleBoard(first, { repo: '/r/herdr-org', view: 'all' });
  assert.deepEqual(org.groups.map((g) => g.name), ['herdr-org']);
  assert.equal(org.waiting.length, 1, 'questions stay in every scope');
  assert.deepEqual(visibleBoard(first, { repo: null, view: 'working' }).groups.map((g) => g.rows.map((r) => r.state)), [['working'], ['working']]);
  assert.deepEqual(visibleBoard(first, { repo: null, view: 'needs' }).groups.map((g) => g.name), ['herdr-lanes']);
  const empty = visibleBoard(first, { repo: '/r/none', view: 'all' });
  assert.deepEqual(empty.groups, []);

  assert.deepEqual(scopeItems(first).map((i) => [i.label, i.count]), [
    ['All repositories', 6],
    ['herdr-lanes', 1], ['herdr-org', 3], ['zeta', 1], ['coach', 1],
    ['needs you', 2], ['working', 2], ['history', 3],
  ]);
  assert.deepEqual(scopeItems(first).map((i) => [i.repo, i.view]), [
    [null, 'all'], ['/r/herdr-lanes', 'all'], ['/r/herdr-org', 'all'], ['/r/zeta', 'all'], ['/r/coach', 'all'],
    [null, 'needs'], [null, 'working'], [null, 'history'],
  ]);
});

test('the Context of a session names where everything is', () => {
  const row = board().groups[1].rows[0];
  const pairs = Object.fromEntries(sessionContext(row, { org: '/tmp/org' }));
  assert.equal(pairs.checkout, '/w/herdr-org/lane-brain-console-v1');
  assert.equal(pairs.repository, '~/herdr-org');
  assert.equal(pairs.agent, 'lane-console-a (claude)');
  assert.equal(pairs.herdr, 'workspace w1 · tab w1:t2 · pane w1:p2 · working');
  assert.equal(pairs.run, 'R-4 on ENG-1: Build the console');
  assert.equal(pairs.brief, '/tmp/org/runs/R-4/brief.md');
  assert.equal(pairs.report, '/tmp/r.md');
  assert.equal(pairs.transcript, '/c/s-console.jsonl');
  assert.equal(pairs.model, 'claude-opus-5 (transcript) · opus (org)');
  assert.equal(pairs.gate, 'not recorded');
  assert.equal(pairs.org, '/tmp/org');
});

test('an idle agent whose org run already finished is named after that run, and a finished run never adds a row', () => {
  const today = boardToday();
  const finishedRun = (run, agent, round) => ({
    run, item: 'ENG-1', title: 'Build the console', role: 'engineer', started: at('12:00'), agent, lane: 'brain-console-v1',
    harness: 'claude-code', model: 'opus', effort: 'high', workspace: '/w/herdr-org/lane-brain-console-v1', round,
    brief_path: `/tmp/org/runs/${run}/brief.md`, report_path: '/tmp/r.md',
  });
  today.agent_runs = [
    finishedRun('R-9', 'lane-console-a', 9), // the same agent as open R-4: the open run wins
    finishedRun('R-8', 'lane-console-old-2', 2),
    finishedRun('R-7', 'lane-console-old-1', 1),
    finishedRun('R-5', 'lane-not-in-herdr', 5),
  ];
  const herdr = boardHerdr();
  for (const name of ['lane-console-old-1', 'lane-console-old-2']) {
    herdr.agents.push({ name, status: 'idle', tab: `w1:${name}`, pane: `w1:${name}`, cwd: '/w/herdr-org/lane-brain-console-v1',
      workspace: 'w1', tool: 'claude', title: name, session: null });
  }
  const b = board({ today, herdr });
  const rows = b.groups.flatMap((g) => g.rows);
  const byAgent = new Map(rows.map((r) => [r.agent, r]));
  assert.equal(byAgent.get('lane-console-a').key, 'r:R-4');
  assert.equal(byAgent.get('lane-console-a').session, 'lane brain-console-v1 r3');
  assert.deepEqual(['lane-console-old-1', 'lane-console-old-2'].map((n) => [byAgent.get(n).session, byAgent.get(n).state, byAgent.get(n).who.text]), [
    ['lane brain-console-v1 r1', 'idle', 'Claude Opus · high'],
    ['lane brain-console-v1 r2', 'idle', 'Claude Opus · high'],
  ]);
  assert.ok(!rows.some((r) => r.key === 'r:R-5' || r.key === 'r:R-9'), 'a finished run without a live agent is not a row');
  assert.ok(!rows.some((r) => r.state === 'gone' && r.run?.round === 5));
});

test('an unregistered lane session is named from its worktree instead of a raw Herdr name', () => {
  const herdr = { ok: true, agents: [
    {
      name: 'lane-brain-console-9621c9-ebe725', status: 'idle', tab: 'w1:t1', pane: 'w1:p1',
      cwd: '/worktrees/herdr-org/lane-brain-console-v1', workspace: 'w1', tool: 'claude',
    },
    {
      name: null, status: 'working', tab: 'w2:t1', pane: 'w2:p1',
      cwd: '/worktrees/herdr-org/lane-console-polish', workspace: 'w2', tool: 'codex',
    },
  ] };
  const b = board({ today: { ...boardToday(), running: [], agent_runs: [] }, herdr, tabs: [] });
  assert.deepEqual(boardRows(b).filter((r) => r.kind === 'session').map((r) => r.session).sort(), [
    'lane brain-console-v1',
    'lane console-polish',
  ]);
});

test('a lane review session is named from the lane session registry', () => {
  const agent = {
    name: 'lane-brain-console-v1-729a9a-7f2c', status: 'idle', tab: 'w1:t9', pane: 'w1:p9',
    cwd: '/w/herdr-org/lane-brain-console-v1', workspace: 'w1', tool: 'claude', session: 'claude-session-9',
  };
  const b = board({
    today: { ...boardToday(), running: [], agent_runs: [] },
    herdr: { ok: true, agents: [agent] },
    tabs: [],
    laneSessionOf: (a) => a.name === agent.name ? { topic: 'brain-console-v1', role: 'review' } : null,
  });
  assert.equal(boardRows(b).find((r) => r.kind === 'session').session, 'review brain-console-v1');
});
