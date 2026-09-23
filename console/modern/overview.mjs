// Terminal translation of modern-console-overview.html: activity across the
// top, goals at left, goal-grouped tasks and attention at right. Cells carry
// independent targets so a goal link does not open its containing session.
import { pad, padStart, wrap } from '../lib/text.mjs';

const cell = (text, col, w, extra = {}) => ({ text, col, w, fg: 'fg', bg: 'bg', ...extra });
const link = (kind, id, source) => `link-${kind}:${id}|${source}`;
const stateColor = state => state === 'working' ? 'teal' : state === 'blocked' ? 'amber' : 'muted';
const stateLabel = state => `${state === 'working' ? '●' : state === 'blocked' ? '!' : '○'} ${state}`;

export function overviewRows({ model: m, state: s, project: p, width, height }) {
  const rows = [], add = (...cells) => rows.push(cells.map(c => ({ region: 'sessions', ...c })));
  const compact = width < 90, short = height <= 20;
  const head = (title, action, id, w, bg = 'band', fg = 'blue') => [
    cell(` ${title}`, 0, w - action.length - 2, { bg, fg, bold: true }),
    cell(`${action} `, w - action.length - 2, action.length + 2, { id, bg, fg }),
  ];
  const paragraph = text => wrap(text, width).forEach(t => add(cell(t, 0, width, { fg: 'muted' })));
  const order = { working: 0, blocked: 1, idle: 2 };
  const sessions = m.sessions.slice().sort((a, b) => (order[a.state] ?? 3) - (order[b.state] ?? 3));
  const shown = short ? 2 : compact ? 5 : Math.max(3, Math.min(8, height - 13));
  const working = sessions.filter(a => a.state === 'working').length;
  add(...head(`Sessions · ${sessions.length}`, width >= 85 ? `${working} working   Full table ›` : 'Full table ›', 'view:sessions', width));
  const location = width >= 95 ? Math.floor(width * .24) : 0;
  const purpose = 22, status = 11, name = width - purpose - status - location;
  add(cell(' Session', 0, name, { fg: 'muted' }), cell('Goal › task', name, purpose, { fg: 'muted' }),
    ...(location ? [cell('Checkout', name + purpose, location, { fg: 'muted' })] : []),
    cell('State', width - status, status, { fg: 'muted' }));
  for (const a of sessions.slice(0, shown)) {
    const cells = [cell(` ${a.who?.tool ?? 'Agent'} ${a.session}`, 0, name - 1, { id: `session:${a.pane}` })];
    let offset = name;
    if (a.goal) {
      cells.push(cell(a.goal, offset, a.goal.length, { fg: 'goal', id: link('item', a.goal, `${a.pane}-goal`) })); offset += a.goal.length;
      cells.push(cell(' › ', offset, 3, { fg: 'muted' })); offset += 3;
    }
    cells.push(cell(a.task ? `${a.task}${a.recorded ? ' · last' : ''}` : 'Unlinked', offset, name + purpose - offset,
      { fg: a.task ? 'goal' : 'muted', id: a.task ? link('item', a.task, `${a.pane}-task`) : `session:${a.pane}` }));
    if (location) {
      const w = m.spaces.find(w => w.workspace_id === a.space);
      cells.push(cell(w && !w.worktree?.is_linked_worktree ? 'Main checkout' : a.where, name + purpose, location - 1,
        { fg: 'muted', id: w ? link('space', a.space, a.pane) : `session:${a.pane}` }));
    }
    cells.push(cell(stateLabel(a.state), width - status, status, { fg: stateColor(a.state), id: `session:${a.pane}` }));
    add(...cells);
  }
  if (sessions.length > shown) add(cell(` ${shown} of ${sessions.length} shown · open full table for all sessions`, 0, width, { id: 'view:sessions', fg: 'blue' }));
  if (!sessions.length) paragraph(s.errors.agents ? 'Session data is unavailable. Refresh to reconnect.' : m.spaces.length ? 'No agents in this project. Open a checkout to inspect its shell tabs.' : 'No sessions or checkouts are open for this folder.');
  add(cell('', 0, width));

  const sideBySide = width >= 90;
  const leftWidth = sideBySide ? Math.floor((width - 3) * .44) : width;
  const rightWidth = sideBySide ? width - leftWidth - 3 : width;
  const goals = [head('Goals', `All ${m.goals.length} ›`, 'view:goals', leftWidth, 'goalBg', 'goal')];
  const orderedGoals = m.goals.slice().sort((a, b) => (b.priority ?? -Infinity) - (a.priority ?? -Infinity));
  const goalLimit = short ? 1 : compact ? 3 : 8;
  orderedGoals.slice(0, goalLimit).forEach((g, i) => {
    const count = m.tasks.filter(t => t.goal === g.id).length;
    goals.push([cell(` ${pad(g.priority == null ? '—' : i + 1, 3)}${pad(g.title, leftWidth - 10)}${padStart(count || '·', 4)} `, 0, leftWidth,
      { id: `item:${g.id}`, fg: 'fg', bg: 'goalBg' })]);
  });
  if (!orderedGoals.length) goals.push([cell(s.errors.status ? ' Goals unavailable' : ' No goals yet', 0, leftWidth, { fg: 'muted', bg: 'goalBg' })]);
  if (sideBySide) goals.push([cell(' Priority · outcome · linked tasks', 0, leftWidth, { fg: 'muted', bg: 'goalBg' })]);

  const work = [head(`Tasks · ${m.tasks.length}`, 'All tasks ›', 'view:tasks', rightWidth, 'panel')];
  // This is a compact observational sample, not a dispatch ordering decision.
  const activeTasks = new Set(m.sessions.filter(a => !a.recorded).map(a => a.task));
  const taskOrder = t => activeTasks.has(t.id) ? 0 : t.status === 'active' ? 1 : t.status === 'blocked' ? 2 : 3;
  const tasks = m.tasks.slice().sort((a, b) => taskOrder(a) - taskOrder(b)).slice(0, short ? 1 : compact ? 3 : 6);
  for (const goal of new Set(tasks.map(t => t.goal))) {
    const g = m.itemsById.get(goal);
    work.push([cell(` ${g ? `${g.id} · ${g.title}` : 'No goal assigned'}`, 0, rightWidth, { fg: 'goal', id: g ? link('item', g.id, 'task-group') : null })]);
    for (const t of tasks.filter(t => t.goal === goal)) {
      const idWidth = Math.max(8, t.id.length + 1), stateWidth = Math.max(8, t.status.length + 1);
      work.push([cell(` ${t.id}`, 0, idWidth + 1, { fg: 'muted', id: `item:${t.id}` }),
        cell(t.title, idWidth + 1, rightWidth - idWidth - stateWidth - 3, { id: `item:${t.id}` }),
        cell(padStart(t.status, stateWidth), rightWidth - stateWidth - 1, stateWidth + 1, { fg: t.status === 'blocked' ? 'amber' : 'muted', id: `item:${t.id}` })]);
    }
  }
  if (!tasks.length) work.push([cell(s.errors.status ? ' Tasks unavailable' : ' No tasks yet', 0, rightWidth, { fg: 'muted' })]);
  if (m.tasks.length > tasks.length) work.push([cell(` Showing ${tasks.length} of ${m.tasks.length} · all tasks ›`, 0, rightWidth, { id: 'view:tasks', fg: 'blue' })]);
  if (!short) work.push([cell('', 0, rightWidth)]);
  work.push(head(`Needs you · ${m.needs.length}`, 'Open queue ›', 'view:needs', rightWidth, 'attentionBg', 'amber'));
  for (const n of m.needs.slice(0, short ? 1 : 2)) {
    const raw = n.handle ?? n.question ?? n.session ?? 'Decision';
    const label = String(raw).length <= 12 ? raw : n.kind === 'question' ? 'Decision' : 'Review';
    work.push([cell(` ${label}  ${n.title ?? n.headline ?? ''}`, 0, rightWidth, { id: `need:${n.key}`, fg: 'amber', bg: 'attentionBg' })]);
  }
  if (!m.needs.length) work.push([cell(' Nothing waiting for your decision.', 0, rightWidth, { fg: 'amber', bg: 'attentionBg' })]);
  if (!short) work.push([cell('', 0, rightWidth, { bg: 'attentionBg' })]);
  goals.forEach(cells => cells.forEach(c => c.region = 'goals'));
  work.forEach(cells => cells.forEach(c => c.region = c.bg === 'attentionBg' ? 'needs' : 'tasks'));
  if (sideBySide) {
    for (let i = 0; i < Math.max(goals.length, work.length); i++) add(...(goals[i] ?? []), ...(work[i] ?? []).map(c => ({ ...c, col: c.col + leftWidth + 3 })));
  } else {
    rows.push(...goals, [cell('', 0, width)], ...work);
  }
  add(cell('', 0, width));
  if (!p.org) paragraph('No organization connected. This trial can inspect existing sessions; project setup and chat creation are not connected yet.');
  if (!sessions.length && !p.org) paragraph('To start a conversation now, open this folder in Herdr and start an agent. Return here and press r to discover it.');
  else paragraph('Live state · recorded links only · unlinked sessions stay visible.');
  return rows;
}
