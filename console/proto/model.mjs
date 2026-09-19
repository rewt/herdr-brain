import {
  projects,
  items,
  goals,
  tasks,
  human,
  queue,
  sessions,
  runs,
  lanes,
  today,
} from './fixtures.mjs';
import { rankedGoals, decisionsFor } from './autonomy.mjs';
export { projects, items, goals, tasks, sessions, runs, lanes, today };
export const byId = (id) => items.find((x) => x.id === id);
export function ancestors(id) {
  const result = [];
  let item = byId(id);
  const seen = new Set();
  while (item && !seen.has(item.id)) {
    result.unshift(item);
    seen.add(item.id);
    item = byId(item.parent);
  }
  return result;
}
export const goalOf = (id) =>
  ancestors(id).find((x) => x.kind === 'goal')?.id ?? null;
export const openItems = [
  ...queue.map((q) => ({
    key: `queue:${q.id}`,
    id: q.id,
    kind: 'waiting',
    title: q.headline,
    project: q.project,
    task: q.digest?.item,
    goal: goalOf(q.digest?.item),
    tag: q.unsent ? 'reply' : 'decision',
    data: q,
  })),
  ...human.map((q) => ({
    key: `human:${q.id}`,
    id: q.id,
    kind: 'waiting',
    title: q.title,
    project: q.project,
    goal: goalOf(q.id),
    task: null,
    related: q.blocks,
    tag: 'decision',
    data: {
      ...q,
      digest: {
        explain: q.explain ?? 'This question sets the next step for the goal.',
        options: q.options ?? [
          { key: '1', label: 'Use the proposed approach' },
          { key: '2', label: 'Ask for another pass' },
        ],
        recommend: q.meta.recommend,
        why: q.why ?? 'It preserves the existing workflow.',
      },
    },
  })),
  ...today.finished.map((f) => ({
    key: `finished:${f.project}:${f.item}:${f.seq}`,
    id: f.item,
    kind: 'read',
    title: f.title,
    project: f.project,
    task: f.item,
    goal: goalOf(f.item),
    tag: 'read',
    data: f,
  })),
];
export function openRows(s, { global = false } = {}) {
  return openItems
    .filter(
      (o) =>
        !s.dismissed.includes(o.key) &&
        Boolean(s.later.includes(o.key)) === (s.view === 'later'),
    )
    .filter(
      (o) =>
        global ||
        ((s.scope === 'all' || o.project === s.scope) &&
          (!s.goal || o.goal === s.goal) &&
          (!s.task || o.task === s.task || o.related?.includes(s.task))),
    );
}
export const matches = (row, q) =>
  !q ||
  `${row.id ?? ''} ${row.title ?? row.name ?? row.topic} ${row.project}`
    .toLowerCase()
    .includes(q.toLowerCase());
export function lists(s) {
  const scoped = (x) => s.scope === 'all' || x.project === s.scope;
  const result = {
    goals: [{ id: null, title: 'All goals' }, ...projects.flatMap((p) => rankedGoals(s, p.name)).filter(scoped)],
    tasks: [
      { id: null, title: 'All tasks' },
      ...tasks
        .filter(scoped)
        .filter((t) => !s.goal || ancestors(t.id).some((p) => p.id === s.goal))
        .filter((t) => s.stage === 'all' || String(t.meta.stage) === s.stage),
    ],
    open: openRows(s, { global: s.view === 'inbox' || s.view === 'later' }),
    sessions: sessions.filter(scoped),
    lanes: lanes.filter(scoped),
    decisions: decisionsFor(s),
    history: [...today.finished, ...today.decided]
      .filter(scoped)
      .map((x, i) => ({
        ...x,
        key: `history:${i}`,
        id: x.item ?? x.id,
        kind: 'history',
      })),
  };
  if (s.query && result[s.focus])
    result[s.focus] = result[s.focus].filter((x) => matches(x, s.query));
  return result;
}
export const identity = (row) => row?.key ?? row?.id ?? row?.name ?? null;
export function selected(s, area = s.focus) {
  const list = lists(s)[area] ?? [];
  return list.find((r) => identity(r) === s.cursor[area]) ?? list[0];
}
export function counts(s) {
  const all = openItems.filter(
    (o) => !s.dismissed.includes(o.key) && !s.later.includes(o.key),
  );
  return {
    needs: all.filter((o) => o.kind === 'waiting').length,
    read: all.filter((o) => o.kind === 'read').length,
    later: s.later.length,
  };
}
