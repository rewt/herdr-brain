// Proposed read model, synthetic only. These records are not live org authority.
import { goals, items } from './fixtures.mjs';

export function goalFor(id) {
  const seen = new Set();
  let row = items.find((x) => x.id === id);
  while (row && !seen.has(row.id)) {
    if (row.kind === 'goal') return row;
    seen.add(row.id);
    row = items.find((x) => x.id === row.parent);
  }
  return null;
}

export function rankedGoals(s, project) {
  const order = s.autonomy.order[project];
  return goals.filter((g) => g.project === project).sort((a, b) =>
    order ? order.indexOf(a.id) - order.indexOf(b.id)
      : (b.priority ?? -Infinity) - (a.priority ?? -Infinity) || a.id.localeCompare(b.id));
}

export function rankOf(s, goal) {
  return goal ? rankedGoals(s, goal.project).findIndex((g) => g.id === goal.id) + 1 : null;
}

export function moveGoal(s, goal, delta) {
  const order = rankedGoals(s, goal.project).map((g) => g.id);
  const from = order.indexOf(goal.id), to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return s;
  [order[from], order[to]] = [order[to], order[from]];
  return { ...s, autonomy: { ...s.autonomy, order: { ...s.autonomy.order, [goal.project]: order } },
    message: `Demo: ${goal.title} is #${to + 1} in ${goal.project}. Applies to future picks.` };
}

const authority = Object.fromEntries(goals.filter((g) => g.id !== 'G-5').map((g) => [g.id, {
  goal: g.id, project: g.project, revision: `${g.id}/note-42`, by: 'operator',
  at: '2026-09-19 13:40', pickup: g.id === 'G-4' ? 'paused' : g.id === 'G-2' ? 'ask' : 'allowed',
  scope: g.id === 'G-1' ? 'Implement and test import recovery in local lanes; keep the saved format.'
    : `Investigate and implement reversible local changes for ${g.title.toLowerCase()}.`,
  ask: 'Ask before changing saved formats, shared rules, spending money or publishing.',
  gates: 'Promotion needs the exact reviewed head, clean worktrees, green validation and a fast-forward.',
  limits: 'No push or lane deletion. Budgets are advisory. Existing project launch limits still apply.',
}]));
export const policyFor = (s, goal) => s.autonomy.policies[goal?.id ?? goal] ?? authority[goal?.id ?? goal] ?? null;

export const decisions = [
  {
    key: 'harbor:choice-18', id: 'D-18', kind: 'dispatch-decision', project: 'harbor',
    at: '2026-09-19 14:10', title: 'Started retry recovery', result: 'started',
    goal: 'G-1', task: 'ENG-2', run: 'R-2', session: 'batch-retry', rank: 1,
    trigger: 'A completed review freed a lane', actor: 'executive-1410', observed: 'org sequence 245',
    why: 'The first-ranked goal has a ready retry fix; completed imports must stay safe.',
    alternatives: 'ENG-1 already has an open run. G-2 needs wider authority. Search can wait.',
    eligibility: 'Ready, no open run at claim, one lane available; import edits do not overlap account work.',
    authority: { ...authority['G-1'] },
    outcome: 'Started R-2 in lane-2; worker batch-retry observed working.',
    revisit: 'Reconsider remaining work when this run reports or direction changes.',
  },
  {
    key: 'harbor:choice-17', id: 'D-17', kind: 'dispatch-decision', project: 'harbor',
    at: '2026-09-19 14:08', title: 'Deferred account changes', result: 'needs authority',
    goal: 'G-2', task: 'ENG-12', rank: 2, trigger: 'Operator changed goal order',
    actor: 'executive-1408', observed: 'org sequence 243',
    why: 'The ready account change alters the saved recovery format, outside delegated scope.',
    alternatives: 'Import recovery remains authorized and can proceed independently.',
    eligibility: 'Ready, but the proposed format change needs operator authority.',
    authority: { ...authority['G-2'] }, question: 'human:HUM-2',
    outcome: 'Linked the existing format-migration question HUM-2; no lane was started.',
    revisit: 'Reconsider after the operator answers that question.',
  },
  {
    key: 'harbor:choice-16', id: 'D-16', kind: 'dispatch-decision', project: 'harbor',
    at: '2026-09-19 13:55', title: 'Waited for a free lane', result: 'deferred',
    goal: 'G-3', task: 'RES-24', rank: 3, trigger: 'A task became ready',
    actor: 'executive-1355', observed: 'org sequence 240',
    why: 'Both configured engineering slots were occupied; another console change would overlap.',
    alternatives: 'No independent authorized candidate fits the current capacity.',
    eligibility: 'Ready work exists; capacity and overlapping files prevent a start now.',
    authority: { ...authority['G-3'] }, outcome: 'No work started; no operator answer required.',
    revisit: 'Wake on a completion or changed direction, not a polling model call.',
  },
  {
    key: 'orchard:choice-4', id: 'D-4', kind: 'dispatch-decision', project: 'orchard',
    at: '2026-09-19 13:50', title: 'Kept note work paused for its answer', result: 'no pick',
    goal: 'G-6', task: 'ENG-51', rank: 1, trigger: 'Worker stopped with a question',
    actor: 'executive-1350', observed: 'org sequence 80',
    why: 'The export choice is unresolved; remaining ready work would touch the same files.',
    alternatives: 'No independent eligible task was found in this project.',
    eligibility: 'Existing run awaits the operator; a duplicate run would not help.',
    authority: { ...authority['G-6'] }, question: 'human:HUM-3',
    outcome: 'No new run; existing export question remains in Needs you.',
    revisit: 'Reconsider when the export answer is recorded.',
  },
];

export function decisionsFor(s) {
  return decisions.filter((d) => s.scope === 'all' || d.project === s.scope);
}
export function decisionFor(row) {
  return decisions.find((d) => d.project === row.project &&
    (row.name ? d.session === row.name : d.task === row.id));
}

export function priorityText(s, row) {
  const goal = goalFor(row.id ?? row.task);
  if (!goal) return 'Goal priority: unassigned; executive should classify this work.';
  const prefix = `Goal rank #${rankOf(s, goal)} in ${goal.project}: ${goal.title}`;
  if (row.kind === 'goal') return prefix;
  return `${prefix}. Inherited; task preference ${row.priority ?? 'unset'} applies within this goal.`;
}
