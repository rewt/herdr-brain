// A board fixture for the console tests: sample org, Herdr and transcript data at
// 20:50 on 2026-09-16 in America/Chicago. Not a test file; it only exports.
import { buildBoard } from '../../lib/model.mjs';

process.env.TZ = 'America/Chicago';
export const at = (hhmm) => new Date(`2026-09-16T${hhmm}:00-05:00`).toISOString();
export const NOW = Date.parse(at('20:50'));

export function boardToday() {
  return {
    project: { org: '/tmp/org', as_of: at('20:50'), day: { date: '2026-09-16' }, item_prefixes: ['ENG', 'G', 'HUM', 'REV'] },
    waiting: [
      { id: 'HUM-5', title: 'Promote the Herdr Brain console into main?', status: 'ready', category: 'tooling', recommend: 'yes',
        why: 'It works.', on_yes: 'Merged.', on_no: 'Stays in its lane.', memo: null, priority: 80,
        created: { at: at('19:19'), by: 'settle-r-4' }, blocks: [], unblocks_prioritized: 0 },
    ],
    decided: [
      { kind: 'question', id: 'HUM-4', seq: 38, title: 'Install storage tool v0.3 now?', category: 'tooling', recommend: 'yes',
        answer: 'yes', answered_by: 'auto', overruled: false, note: null, at: at('16:05'), by: 'exec-1600', blocks: [] },
      { kind: 'note', id: 'ENG-7', seq: 40, title: 'Implement the theft fix', summary: 'Keep the cells', text: 'Keep R-12 cells',
        at: at('16:10'), by: 'exec-1610' },
    ],
    running: [
      { run: 'R-4', item: 'ENG-1', title: 'Build the console', role: 'engineer', started: at('20:06'), agent: 'lane-console-a',
        lane: 'brain-console-v1', harness: 'claude-code', model: 'opus', effort: 'high', workspace: '/w/herdr-org/lane-brain-console-v1', round: 3,
        brief_path: '/tmp/org/runs/R-4/brief.md', report_path: '/tmp/r.md' },
      { run: 'R-6', item: 'ENG-2', title: 'Port the relay to REV-9 rules', role: 'engineer', started: at('20:30'), agent: 'lane-gone-recent',
        lane: 'relay', harness: 'codex', model: 'gpt-6-astra', effort: 'xhigh', workspace: '/w/herdr-org/lane-relay', round: 1,
        brief_path: '/tmp/org/runs/R-6/brief.md', report_path: '/tmp/r6.md' },
      { run: 'R-2', item: 'ENG-3', title: 'Old abandoned work', role: 'engineer', started: at('09:00'), agent: 'lane-gone-old',
        lane: 'old', harness: null, model: null, effort: null, workspace: null, round: 1, brief_path: '/tmp/org/runs/R-2/brief.md', report_path: '/tmp/r2.md' },
    ],
    finished: [
      { kind: 'report', run: 'R-3', item: 'ENG-1', title: 'Build the console', role: 'engineer', outcome: 'done',
        headline: 'Console round two is fixed', summary: 'Fixed.', report_file: '/tmp/org/reports/R-3.md', at: at('19:06') },
    ],
    approvals: { policy: { default: 'ask', categories: {} }, counts: {} },
    attention: [],
  };
}

export const boardHerdr = () => ({ ok: true, agents: [
  { name: 'lane-console-a', status: 'working', tab: 'w1:t2', pane: 'w1:p2', cwd: '/w/herdr-org/lane-brain-console-v1', workspace: 'w1',
    tool: 'claude', title: 'Verifying correction round three', session: 's-console' },
  { name: 'settle-r-4-1912', status: 'done', tab: 'w1:t3', pane: 'w1:p3', cwd: '/r/herdr-org', workspace: 'w1',
    tool: 'claude', title: 'settle-r-4-1912', session: 's-settle' },
  { name: null, status: 'idle', tab: 'w2:t1', pane: 'w2:p1', cwd: '/r/coach', workspace: 'w2',
    tool: 'claude', title: 'Coach.me connector with Claude chat', session: null },
  { name: 'board-messages', status: 'blocked', tab: 'w3:t4', pane: 'w3:p4', cwd: '/w/herdr-lanes/lane-board-messages', workspace: 'w3',
    tool: 'codex', title: null, session: null },
  { name: null, status: 'working', tab: 'w4:t1', pane: 'w4:p1', cwd: '/r/zeta', workspace: 'w4', tool: 'claude', title: 'Zeta work here', session: null },
] });

export const boardTabs = () => [
  { tab: 'w2:t1', label: '1', number: 1, workspace: 'w2' },
  { tab: 'w4:t1', label: 'zeta shell', number: 1, workspace: 'w4' },
];

const REPOS = {
  '/w/herdr-org/lane-brain-console-v1': 'herdr-org', '/w/herdr-org/lane-relay': 'herdr-org', '/r/herdr-org': 'herdr-org',
  '/r/coach': 'coach', '/w/herdr-lanes/lane-board-messages': 'herdr-lanes', '/r/zeta': 'zeta',
};
export const boardRepoOf = (cwd) => (REPOS[cwd] ? { root: `/r/${REPOS[cwd]}`, name: REPOS[cwd], path: `~/${REPOS[cwd]}`, git: true } : null);

const TRANSCRIPTS = {
  's-console': { file: '/c/s-console.jsonl', model: 'claude-opus-5', firstAt: at('20:00'), note: { text: 'Working on it.', at: at('20:49') } },
  's-settle': { file: '/c/s-settle.jsonl', model: 'claude-fable-5-1', firstAt: at('19:12'), note: { text: 'Settled.', at: at('19:40') } },
};

export function board(overrides = {}) {
  return buildBoard({
    today: boardToday(),
    herdr: boardHerdr(),
    tabs: boardTabs(),
    transcriptOf: (a) => TRANSCRIPTS[a.session] ?? null,
    repoOf: boardRepoOf,
    briefOf: (p) => (p === '/tmp/org/runs/R-6/brief.md' ? '# Brief: run R-6 on ENG-2\n\n- **ENG-2** Port the relay to the new rules.' : null),
    nowMs: NOW,
    seen: new Map([['lane-gone-recent', NOW - 5 * 60000], ['lane-gone-old', NOW - 3 * 3600000]]),
    ...overrides,
  });
}

