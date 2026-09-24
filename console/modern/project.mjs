// The project screen: the work block in hand and its tasks, what needs the
// operator, then every session grouped by the checkout it runs in. Cells carry
// independent targets, as in the overview it replaces.
import path from 'node:path';
import { pad, padStart, wrap } from '../lib/text.mjs';

const cell = (text, col, w, extra = {}) => ({ text, col, w, fg: 'fg', bg: 'bg', ...extra });
const link = (kind, id, source) => `link-${kind}:${id}|${source}`;
const stateColor = state => state === 'working' ? 'teal' : state === 'blocked' ? 'amber' : 'muted';
const stateLabel = state => `${state === 'working' ? '●' : state === 'blocked' ? '!' : '○'} ${state}`;
const ORDER = { working: 0, blocked: 1, idle: 2 };
const byState = (a, b) => (ORDER[a.state] ?? 3) - (ORDER[b.state] ?? 3);

// The block is the goal the operator is working in now. An open goal marked
// meta.block (morning, afternoon, overnight) is one by declaration; otherwise
// the goal most current sessions are linked to is the block in practice.
export function currentBlock(m) {
  const declared = m.goals.filter(g => g.meta?.block);
  if (declared.length) return { goal: declared.at(-1), declared: true, others: declared.slice(0, -1) };
  const counts = new Map();
  for (const a of m.sessions) if (a.goal && !a.recorded) counts.set(a.goal, (counts.get(a.goal) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]).map(([id]) => m.itemsById.get(id)).filter(Boolean);
  return ranked.length ? { goal: ranked[0], declared: false, others: ranked.slice(1) } : null;
}

// What the start bar can start: a chat with each configured agent kind, and a
// task when the project has an organization to record it in.
export function composeModes(project, kinds = ['claude', 'codex']) {
  return [...kinds.map(agent => ({ kind: 'chat', agent })), ...(project?.org ? [{ kind: 'task' }] : [])];
}

// Checkouts in the order the project screen lists them: main first.
export const checkoutOrder = spaces => spaces.slice().sort((a, b) => Number(Boolean(a.worktree?.is_linked_worktree)) - Number(Boolean(b.worktree?.is_linked_worktree)));

export const checkoutName = w => w?.worktree?.is_linked_worktree ? path.basename(w.worktree.checkout_path).replace(/^lane-/, '') : 'Main checkout';

export function projectRows({ model: m, state: s, project: p, width, height }) {
  const rows = [], add = (region, ...cells) => rows.push(cells.map(c => ({ region, ...c })));
  const paragraph = (text, fg = 'muted', region = 'content') => wrap(text, width).forEach(t => add(region, cell(t, 0, width, { fg })));
  const compact = width < 90;
  const current = m.sessions.filter(a => !a.recorded);

  // Now: the block and the tasks under it, the ones with a session first.
  const block = currentBlock(m);
  if (block) {
    const g = block.goal, linked = current.filter(a => a.goal === g.id);
    const tag = block.declared ? `Block · ${g.meta.block}` : 'Now';
    const right = linked.length ? `${linked.length} session${linked.length === 1 ? '' : 's'} on it` : '';
    add('goals', cell(` ${tag} · ${g.id} · ${g.title}`, 0, width - right.length - 4, { id: `item:${g.id}`, fg: 'goal', bg: 'goalBg', bold: true }),
      cell(`  ${right} `, width - right.length - 4, right.length + 4, { fg: 'goal', bg: 'goalBg' }));
    if (!block.declared) add('goals', cell(' Inferred from linked sessions; mark a goal meta.block to declare the block.', 0, width, { fg: 'muted', bg: 'goalBg' }));
    const sessionOf = new Map(current.filter(a => a.task).map(a => [a.task, a]));
    const rank = t => sessionOf.has(t.id) ? 0 : t.status === 'active' ? 1 : t.status === 'blocked' ? 2 : 3;
    const under = m.tasks.filter(t => t.goal === g.id).sort((a, b) => rank(a) - rank(b));
    const shown = under.slice(0, compact ? 5 : Math.max(5, Math.min(10, height - 16)));
    const where = compact ? 0 : Math.min(28, Math.floor(width * .24)), status = 9, idWidth = 10;
    for (const t of shown) {
      const a = sessionOf.get(t.id), w = a && m.spaces.find(w => w.workspace_id === a.space);
      add('tasks', cell(` ${a ? '●' : ' '} ${pad(t.id, idWidth)}`, 0, idWidth + 4, { id: `item:${t.id}`, fg: a ? 'teal' : 'muted' }),
        cell(t.title, idWidth + 4, width - idWidth - 4 - status - where - 1, { id: `item:${t.id}` }),
        cell(padStart(t.status, status - 1), width - status - where - 1, status, { id: `item:${t.id}`, fg: t.status === 'blocked' ? 'amber' : 'muted' }),
        ...(where ? [cell(a ? ` ${w ? checkoutName(w) : a.where}` : '', width - where, where, { id: a ? `session:${a.pane}` : `item:${t.id}`, fg: 'teal' })] : []));
    }
    if (!under.length) add('tasks', cell('   No open tasks under this goal.', 0, width, { fg: 'muted' }));
    if (under.length > shown.length) add('tasks', cell(`   ${shown.length} of ${under.length} tasks under ${g.id} · all tasks ›`, 0, width, { id: 'view:tasks', fg: 'blue' }));
    const others = m.goals.filter(x => x.id !== g.id);
    if (others.length) add('goals', cell(`   ${others.length} other open goal${others.length === 1 ? '' : 's'}${block.others.length ? ` · also linked: ${block.others.map(x => x.id).join(', ')}` : ''} · goals ›`, 0, width, { id: 'view:goals', fg: 'blue' }));
  } else {
    add('goals', cell(' Now · no work block', 0, width, { fg: 'goal', bg: 'goalBg', bold: true }));
    paragraph(p?.org ? 'No current session is linked to a goal. Chats need no goal.' : 'No organization connected. Chats need no goal; goals and tasks come with project setup.');
    if (m.goals.length) add('goals', cell(`   ${m.goals.length} open goal${m.goals.length === 1 ? '' : 's'} · goals ›`, 0, width, { id: 'view:goals', fg: 'blue' }));
  }
  add('content', cell('', 0, width));

  // Needs you, briefly: the queue itself is one keypress away.
  if (m.needs.length) {
    const folded = m.resolved.length + m.reports.length + m.ended.length;
    const right = `${folded ? `${folded} folded · ` : ''}Open queue ›`;
    add('needs', cell(` Needs you · ${m.needs.length}`, 0, width - right.length - 2, { fg: 'amber', bg: 'attentionBg', bold: true }),
      cell(`${right} `, width - right.length - 2, right.length + 2, { id: 'view:needs', fg: 'amber', bg: 'attentionBg' }));
    for (const n of m.needs.slice(0, 3)) {
      const label = n.handle ?? n.data?.tab_label ?? 'Decision', text = n.data?.digest?.question ?? n.title ?? n.headline ?? '';
      add('needs', cell(` ${pad(label, 10)} ${text}`, 0, width, { id: `need:${n.key}`, fg: 'amber', bg: 'attentionBg' }));
    }
    if (m.needs.length > 3) add('needs', cell(`   ${m.needs.length - 3} more · open queue ›`, 0, width, { id: 'view:needs', fg: 'amber', bg: 'attentionBg' }));
    add('content', cell('', 0, width));
  }

  // Sessions by checkout: main first, then worktrees with agents, then idle ones.
  const working = current.filter(a => a.state === 'working').length;
  add('sessions', cell(` Checkouts · ${m.spaces.length}`, 0, width - 32, { fg: 'blue', bg: 'band', bold: true }),
    cell(`${m.sessions.length} sessions · ${working} working  Table › `, width - 32, 32, { id: 'view:sessions', fg: 'blue', bg: 'band' }));
  const own = w => m.sessions.filter(a => a.space === w.workspace_id).sort(byState);
  const spaces = m.spaces.slice().sort((a, b) => Number(Boolean(a.worktree?.is_linked_worktree)) - Number(Boolean(b.worktree?.is_linked_worktree))
    || Number(!own(a).length) - Number(!own(b).length) || checkoutName(a).localeCompare(checkoutName(b)));
  const idle = [];
  const purposeWidth = compact ? 16 : 24, stateWidth = 11;
  const sessionRow = a => {
    const cells = [cell(`   ${a.who?.tool ?? 'Agent'} ${a.session}`, 0, width - purposeWidth - stateWidth, { id: `session:${a.pane}` })];
    let offset = width - purposeWidth - stateWidth;
    if (a.goal) { cells.push(cell(a.goal, offset, a.goal.length, { fg: 'goal', id: link('item', a.goal, `${a.pane}-goal`) })); offset += a.goal.length; cells.push(cell(' › ', offset, 3, { fg: 'muted' })); offset += 3; }
    cells.push(cell(a.task ? `${a.task}${a.recorded ? ' · last' : ''}` : 'chat', offset, width - stateWidth - offset, { fg: a.task ? 'goal' : 'muted', id: a.task ? link('item', a.task, `${a.pane}-task`) : `session:${a.pane}` }));
    cells.push(cell(stateLabel(a.state), width - stateWidth, stateWidth, { fg: stateColor(a.state), id: `session:${a.pane}` }));
    add('sessions', ...cells);
  };
  for (const w of spaces) {
    const agents = own(w);
    if (!agents.length && w.worktree?.is_linked_worktree) { idle.push(w); continue; }
    const git = s.checkoutGit?.[w.workspace_id];
    const facts = git ? [git.branch?.split('...')[0], git.changes ? `${git.changes} changed` : 'clean', git.branch?.match(/\[(.*)\]/)?.[1]].filter(Boolean).join(' · ') : '';
    add('sessions', cell(` ${checkoutName(w)}`, 0, Math.min(width, checkoutName(w).length + 2), { id: link('space', w.workspace_id, 'project'), fg: 'bright', bold: true }),
      cell(facts ? ` ${facts}` : '', checkoutName(w).length + 2, width - checkoutName(w).length - 2, { fg: 'muted' }));
    agents.forEach(sessionRow);
    if (!agents.length) add('sessions', cell('   No agent · shell only', 0, width, { fg: 'muted' }));
  }
  // A session can run in this project from a workspace that belongs elsewhere.
  const away = m.sessions.filter(a => !m.spaces.some(w => w.workspace_id === a.space)).sort(byState);
  if (away.length) { add('sessions', cell(' In other workspaces', 0, width, { fg: 'bright', bold: true })); away.forEach(sessionRow); }
  if (idle.length) add('sessions', cell(` No agent: ${idle.map(checkoutName).join(', ')}`, 0, width, { fg: 'muted' }));
  if (!m.spaces.length && !m.sessions.length) paragraph(s.errors.agents ? 'Session data is unavailable. Refresh to reconnect.' : 'No sessions or checkouts are open for this folder.');
  return rows;
}
