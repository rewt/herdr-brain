// Synthetic source-shaped data. No live files, subprocesses, clocks or network.
const at = '2026-09-18T20:30:00Z';
export const projects = ['harbor', 'orchard'].map((name) => ({
  name,
  org: `/fixture/${name}/.org`,
  cwd: `/fixture/${name}`,
  ledger_dir: `/fixture/${name}/ledger`,
  session_cap: 30,
}));
const goalTitles = [
  'Reliable imports',
  'Clear account recovery',
  'Fast search',
  'Calm releases',
  'Useful audit trail',
  'Readable field notes',
];
const themes = [
  'Validate imports',
  'Retry interrupted batches',
  'Review error messages',
  'Measure slow requests',
  'Explain recovery steps',
  'Check saved filters',
  'Test keyboard paths',
  'Simplify progress reports',
  'Document fallback steps',
  'Verify release checklist',
];
export const goals = goalTitles.map((title, i) => ({
  id: `G-${i + 1}`,
  kind: 'goal',
  title,
  role: 'architect',
  parent: null,
  priority: i + 1,
  project: i === 5 ? 'orchard' : 'harbor',
  status: 'active',
  accept: ['The user can complete the work without guessing what happened.'],
  budget: { tokens: 120000 },
  meta: { stage: 1 },
  created: { at },
  children: [],
  runs: [],
  notes: [
    { at, text: 'Keep the existing format readable while improving recovery.' },
  ],
  blocked_by: [],
  blocks: [],
}));
export const tasks = goals.flatMap((goal, g) =>
  themes.map((title, t) => {
    const role =
      t % 5 === 2 ? 'reviewer' : t % 5 === 3 ? 'researcher' : 'engineer';
    const id = `${role === 'reviewer' ? 'REV' : role === 'researcher' ? 'RES' : 'ENG'}-${g * 10 + t + 1}`;
    return {
      id,
      kind: 'item',
      title:
        g === 0
          ? title
          : `${title} for ${['imports', 'accounts', 'search', 'releases', 'audit', 'notes'][g]}`,
      role,
      capability: 'software',
      parent: t === 9 ? `ENG-${g * 10 + 1}` : goal.id,
      priority: t + 1,
      project: goal.project,
      accept: [
        'Existing saved work stays readable.',
        'The failure case has a reproducible check.',
      ],
      budget: { tokens: 24000 },
      meta: { stage: [1, 1, 1, 2, 2, 3, 3, 4, 'keys', 'parked'][t] },
      created: { at },
      closed: null,
      outcome: null,
      runs: [],
      notes: [{ at, text: 'Prefer a small change with clear evidence.' }],
      status: t % 4 === 0 ? 'active' : t % 4 === 2 ? 'blocked' : 'ready',
      blocked_by: t % 4 === 2 ? [`ENG-${g * 10 + 1}`] : [],
      blocks: [],
      children: [],
    };
  }),
);
export const human = [0, 1, 5].map((g, i) => ({
  id: `HUM-${i + 1}`,
  kind: 'item',
  title: [
    'Choose the recovery wording',
    'Set the review window',
    'Choose a note export format',
  ][i],
  role: 'human',
  parent: `G-${g + 1}`,
  project: goals[g].project,
  priority: i + 1,
  status: 'ready',
  meta: { category: 'decision', recommend: '1', stage: i === 1 ? 2 : 1 },
  created: { at },
  runs: [],
  children: [],
  blocked_by: [],
  blocks: [tasks[g * 10 + 2].id],
  notes: [],
  accept: [],
}));
export const items = [...goals, ...tasks, ...human];
for (const item of items)
  if (item.parent)
    items.find((p) => p.id === item.parent)?.children.push(item.id);
export const sessions = [0, 1, 2, 10, 20, 30, 50, 51].map((t, i) => ({
  name: [
    'import-recovery',
    'batch-retry',
    'import-review',
    'account-recovery',
    'search-timing',
    'release-checks',
    'note-reader',
    'note-export',
  ][i],
  kind: i % 2 ? 'claude' : 'codex',
  status: [
    'blocked',
    'working',
    'done',
    'working',
    'idle',
    'working',
    'blocked',
    'done',
  ][i],
  cwd: `/fixture/${tasks[t].project}/lane-${(i % 5) + 1}`,
  workspace: `fixture-${tasks[t].project}`,
  tab: `t${i + 1}`,
  pane: `p${i + 1}`,
  project: tasks[t].project,
  task: tasks[t].id,
  doing: [
    'Waiting for a retry policy',
    'Testing interrupted batches',
    'Finished the error review',
    'Tracing a recovery edge case',
    'Ready for the next sample',
    'Checking the release steps',
    'Waiting for an export choice',
    'Finished the note preview',
  ][i],
  up: `${[32, 18, 45, 24, 12, 9, 14, 36][i]}m`,
}));
export const runs = sessions.map((s, i) => ({
  run: `R-${i + 1}`,
  item: s.task,
  title: tasks.find((t) => t.id === s.task).title,
  role: tasks.find((t) => t.id === s.task).role,
  started: at,
  agent: s.name,
  lane: s.cwd.split('/').at(-1),
  harness: s.kind,
  model: s.kind === 'codex' ? 'Astra' : 'Opus',
  effort: 'high',
  workspace: s.cwd,
  round: 1,
  brief_path: `/fixture/briefs/${s.task}.md`,
  report_path: null,
}));
for (const run of runs) tasks.find((t) => t.id === run.item).runs.push(run.run);
const headlines = [
  'Choose a retry policy',
  'Keep the existing file format',
  'Accept the message review',
  'Pick a recovery timeout',
  'Review the search sample',
  'Schedule the release check',
  'Approve the audit wording',
  'Choose a fallback path',
  'Resolve the export question',
  'Keep draft notes private',
];
const taskIndices = [0, 0, 2, 10, 20, 30, 40, 11, 50, 51];
export const queue = taskIndices.map((t, i) => ({
  at,
  type: 'result',
  id: `Q-${i + 1}`,
  session: sessions.find((s) => s.task === tasks[t].id)?.name ?? null,
  agent: 'codex',
  state: 'waiting',
  where: `/fixture/${tasks[t].project}`,
  workspace: 'fixture',
  tab: 't1',
  pane: 'p1',
  tab_label: 'import-recovery',
  title: headlines[i],
  screen:
    'Fixture session screen\nChecked the retry path with an interrupted batch.\nNo saved records changed.\nWaiting for your choice.\n1 Retry only failed rows\n2 Retry the full batch',
  said: 'The retry path is ready for a decision.',
  unsent:
    i === 0 ? 'Retry only the failed rows; keep the completed rows.' : null,
  suggestion: i === 1 ? 'Keep the existing format for this release.' : null,
  dialog: { question: headlines[i] },
  project: tasks[t].project,
  headline: headlines[i],
  status: 'digested',
  digest: {
    kind: 'decision',
    item: tasks[t].id,
    gist: headlines[i],
    explain:
      i === 0
        ? 'An interrupted import leaves completed rows safe. Choose how the next attempt handles the unfinished rows.'
        : 'The work is ready. The session needs one choice before it can continue.',
    what_happened: 'The session checked both paths against saved fixtures.',
    needs_you: true,
    question: headlines[i],
    options:
      i === 0
        ? [
            { key: '1', label: 'Retry only failed rows' },
            { key: '2', label: 'Retry the full batch' },
            { key: '3', label: 'Ask for more evidence' },
          ]
        : [
            { key: '1', label: 'Use the proposed approach' },
            { key: '2', label: 'Ask for another pass' },
          ],
    recommend: '1',
    why:
      i === 0
        ? 'Completed rows stay untouched; the retry is smaller and easier to inspect.'
        : 'It keeps the change small and preserves saved work.',
    next_step: 'The session continues after your answer.',
  },
  answer: null,
}));
export const finished = [2, 30, 51].map((t, i) => ({
  kind: 'report',
  item: tasks[t].id,
  seq: i + 1,
  title: [
    'Error review is ready',
    'Release rehearsal finished',
    'Note preview is ready',
  ][i],
  role: 'reviewer',
  as: 'done',
  note: 'The fixture checks passed. Read the evidence before deciding what comes next.',
  at,
  by: 'agent',
  project: tasks[t].project,
}));
export const today = {
  project: {
    org: '/fixture/harbor/.org',
    as_of: at,
    events: 245,
    item_prefixes: ['ENG', 'REV', 'RES', 'HUM'],
    day: '2026-09-18',
    open_stage: 1,
    top_goal: { id: 'G-1' },
  },
  waiting: human,
  decided: [
    {
      kind: 'note',
      id: 'G-1',
      seq: 1,
      title: 'Keep saved work readable',
      summary: 'Keep the existing format.',
      text: 'Use the existing format for this release.',
      at,
      by: 'human',
      project: 'harbor',
    },
  ],
  running: runs,
  finished,
  approvals: { policy: 'ask', counts: { pending: 13 } },
  attention: [],
};
export const status = { items, runs };
export const lanes = Array.from({ length: 5 }, (_, i) => ({
  id: `lane-${i + 1}`,
  topic: [
    'import-recovery',
    'account-recovery',
    'search-timing',
    'release-checks',
    'note-export',
  ][i],
  branch: `lane/${['imports', 'accounts', 'search', 'releases', 'notes'][i]}`,
  ahead: i + 1,
  behind: i === 2 ? 2 : 0,
  dirty: i === 1,
  rebase: i === 2 ? 'needed' : 'clear',
  path: `/fixture/${i === 4 ? 'orchard' : 'harbor'}/lane-${i + 1}`,
  project: i === 4 ? 'orchard' : 'harbor',
}));
