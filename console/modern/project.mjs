// The project screen: counts, the work block in hand and its tasks, what needs
// the operator, then every session, numbered, under the checkout it runs in.
// One row per session: number, state, name, time in its state, uptime, harness,
// what it is doing. Cells carry independent targets; a session's name renames it.
import path from 'node:path';
import { pad, padStart, wrap, clip } from '../lib/text.mjs';

const cell = (text, col, w, extra = {}) => ({ text, col, w, fg: 'fg', bg: 'bg', ...extra });
const link = (kind, id, source) => `link-${kind}:${id}|${source}`;
const QUIET_AFTER_MS = 20 * 60e3;
const span = ms => ms < 3600e3 ? `${Math.floor(ms / 60e3)}m` : `${Math.floor(ms / 3600e3)}h${String(Math.floor(ms % 3600e3 / 60e3)).padStart(2, '0')}m`;
const GLYPH = { working: '●', blocked: '!', idle: '○', done: '✔' };
const stateColor = state => state === 'working' ? 'teal' : state === 'blocked' ? 'amber' : state === 'done' ? 'teal' : 'muted';
const ORDER = { blocked: 0, working: 1, idle: 2, done: 3 };
const byState = (a, b) => (ORDER[a.state] ?? 4) - (ORDER[b.state] ?? 4);
const toolColor = tool => /claude/i.test(tool ?? '') ? 'amber' : /codex/i.test(tool ?? '') ? 'blue' : 'goal';

// 45s, 5m, 2h, 3d: the width of a column, not a timestamp.
export function shortAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

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

// What the prompt bar can start: a task when there is an organization to
// record it in, then a chat with each configured agent kind.
export function composeModes(project, kinds = ['claude', 'codex']) {
  return [...(project?.org ? [{ kind: 'task' }] : []), ...kinds.map(agent => ({ kind: 'chat', agent }))];
}

// Checkouts in the order the project screen lists them: main first.
export const checkoutOrder = spaces => spaces.slice().sort((a, b) => Number(Boolean(a.worktree?.is_linked_worktree)) - Number(Boolean(b.worktree?.is_linked_worktree)));
export const checkoutName = w => w?.worktree?.is_linked_worktree ? path.basename(w.worktree.checkout_path).replace(/^lane-/, '') : 'main';
export const sessionName = a => a.label ?? a.session;

// Sessions in screen order, grouped by checkout, so a number means one session.
export function sessionGroups(m) {
  const own = w => m.sessions.filter(a => a.space === w.workspace_id).sort(byState);
  const spaces = checkoutOrder(m.spaces).sort((a, b) => Number(Boolean(a.worktree?.is_linked_worktree)) - Number(Boolean(b.worktree?.is_linked_worktree))
    || Number(!own(a).length) - Number(!own(b).length));
  const groups = spaces.map(w => ({ space: w, name: checkoutName(w), sessions: own(w) })).filter(g => g.sessions.length);
  const away = m.sessions.filter(a => !m.spaces.some(w => w.workspace_id === a.space)).sort(byState);
  if (away.length) groups.push({ space: null, name: 'other workspaces', sessions: away });
  return { groups, idle: spaces.filter(w => !own(w).length), order: groups.flatMap(g => g.sessions) };
}

export function projectRows({ model: m, state: s, project: p, width, height, now = Date.now() }) {
  const rows = [], add = (region, ...cells) => rows.push(cells.map(c => ({ region, ...c })));
  const paragraph = (text, fg = 'muted', region = 'content') => wrap(text, width).forEach(t => add(region, cell(t, 0, width, { fg })));
  const compact = width < 90;
  const current = m.sessions.filter(a => !a.recorded);
  const { groups, idle, order } = sessionGroups(m);
  const number = new Map(order.map((a, i) => [a.pane, i + 1]));

  // Counts first, the way a glance reads them.
  const count = st => m.sessions.filter(a => a.state === st).length;
  const stats = [[m.sessions.length, 'sessions', 'bright'], [count('working'), 'working', 'teal'], [count('blocked'), 'blocked', 'amber'], [count('idle'), 'idle', 'muted'], [count('done'), 'done', 'teal']];
  let sx = 1; const statCells = [];
  for (const [n, label, fg] of stats) {
    const digits = String(n);
    if (sx + digits.length + label.length + 1 > width) break;
    statCells.push(cell(digits, sx, digits.length, { fg, bold: true }), cell(` ${label}`, sx + digits.length, label.length + 1, { fg: 'muted' }));
    sx += digits.length + label.length + 4;
  }
  add('content', ...statCells);
  if (s.fleet) paragraph(`Fleet session limit ${s.fleet.session_limit} · advisory`);
  if (p?.stale) paragraph(`Stale checkout · ${p.cwd}`, 'amber');
  for (const flag of m.categoryFlags ?? []) {
    for (const text of wrap(`${flag.id} · ${flag.text}`, width - 1)) add('needs', cell(text, 1, width - 1, { id: `item:${flag.id}`, fg: 'amber', bold: true }));
  }
  // Quiet: nothing working and nothing recorded for a while. A long run keeps the
  // record quiet with a session working; quiet with nothing working is a stall
  // nobody reports (a refused promotion, a lost watcher). Its own line, never cut.
  const quiet = m.lastAt ? now - Date.parse(m.lastAt) : null;
  if (!count('working') && quiet >= QUIET_AFTER_MS) {
    const d = new Date(m.lastAt), at = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    wrap(`quiet ${span(quiet)} · nothing working, nothing recorded since ${at}`, width - 1).forEach(t => add('content', cell(t, 1, width - 1, { fg: 'amber', bold: true })));
  }
  add('content', cell('', 0, width));

  // The operator's durable steering surface is visible before the work list.
  let cx = 0; const steering = [];
  for (const [view, label, count, fg] of [['decided', 'Decided', m.decided.length, 'teal'], ['asked', 'Asked', m.asked.length, 'blue'], ['needs', 'Waiting on you', m.needs.length, 'amber']]) {
    const text = ` ${label} ${count} `;
    steering.push(cell(text, cx, text.length, { id: `view:${view}`, fg, bg: 'panel', bold: true }));
    cx += text.length + 1;
  }
  add('content', ...steering);
  if (m.decided[0]) add('content', cell(` Last: ${m.decided[0].text}`, 0, width, { id: `decision:${m.decided[0].key}`, fg: 'muted' }));
  const routeState = s.errors.routes ? 'unavailable · r retry' : m.routes?.suggested ? 'suggested defaults · confirmation pending' : m.routes ? 'project configuration' : 'not loaded';
  add('content', cell(` Routes · ${routeState} · u open`, 0, width, { id: 'view:routes', fg: 'blue' }));
  add('content', cell(` Priorities · ${m.priorities?.priorities.length ?? 0} operator outcomes · P open`, 0, width, { id: 'view:priorities', fg: 'blue' }));
  add('content', cell('', 0, width));

  // Now: the block and its open tasks, the ones a session works on first.
  const block = currentBlock(m);
  if (block) {
    const g = block.goal, linked = current.filter(a => a.goal === g.id);
    const tag = block.declared ? g.meta.block : 'now';
    const right = `${linked.length ? `${linked.length} on it · ` : ''}goals ›`;
    add('goals', cell(` ${tag} · ${g.id} · ${g.title}`, 0, width - right.length - 3, { id: `item:${g.id}`, fg: 'goal', bg: 'goalBg', bold: true }),
      cell(`  ${right} `, width - right.length - 3, right.length + 3, { id: 'view:goals', fg: 'goal', bg: 'goalBg' }));
    const sessionOf = new Map(current.filter(a => a.task).map(a => [a.task, a]));
    const rank = t => sessionOf.has(t.id) ? 0 : t.status === 'active' ? 1 : t.status === 'blocked' ? 2 : 3;
    const under = m.tasks.filter(t => t.goal === g.id).sort((a, b) => rank(a) - rank(b));
    const shown = under.slice(0, compact ? 3 : Math.max(3, Math.min(6, height - 22)));
    for (const t of shown) {
      const a = sessionOf.get(t.id), n = a ? number.get(a.pane) : null;
      add('tasks', cell(`  ${a ? '●' : ' '} ${pad(t.id, 9)}`, 0, 13, { id: `item:${t.id}`, fg: a ? 'teal' : 'muted' }),
        cell(t.title, 13, width - 13 - 14, { id: `item:${t.id}` }),
        cell(padStart(t.status, 8), width - 14, 9, { id: `item:${t.id}`, fg: t.status === 'blocked' ? 'amber' : 'muted' }),
        cell(n ? `  #${n}` : '', width - 5, 5, { id: a ? `session:${a.pane}` : `item:${t.id}`, fg: 'teal' }));
    }
    if (!under.length) add('tasks', cell('    No open tasks under this goal.', 0, width, { fg: 'muted' }));
    if (under.length > shown.length) add('tasks', cell(`    ${under.length - shown.length} more tasks · all tasks ›`, 0, width, { id: 'view:tasks', fg: 'blue' }));
  } else if (p?.org) {
    add('goals', cell(' now · no work block · goals ›', 0, width, { id: 'view:goals', fg: 'goal', bg: 'goalBg', bold: true }));
  }
  if (block || p?.org) add('content', cell('', 0, width));

  // Needs you: each item with the answer recommended for it.
  if (m.needs.length || m.aged.length) {
    const folded = m.resolved.length + m.reports.length + m.ended.length;
    const right = `${folded ? `${folded} folded · ` : ''}open queue ›`;
    add('needs', cell(` Waiting on you · ${m.needs.length}`, 0, width - right.length - 3, { fg: 'amber', bg: 'attentionBg', bold: true }),
      cell(`  ${right} `, width - right.length - 3, right.length + 3, { id: 'view:needs', fg: 'amber', bg: 'attentionBg' }));
    for (const n of m.needs.slice(0, 3)) {
      const label = n.handle ?? n.data?.tab_label ?? 'Decision', text = n.data?.digest?.question ?? n.title ?? n.headline ?? '';
      const rec = n.options?.find(o => o.key === n.recommendKey), hint = rec ? `★ ${rec.key} ${rec.label}` : n.kind === 'question' ? 'y / n' : '';
      const hw = compact || !hint ? 0 : Math.min(34, hint.length + 2);
      add('needs', cell(`  ${pad(label, 9)} ${text}`, 0, width - hw - (hw ? 2 : 0), { id: `need:${n.key}`, fg: 'amber', bg: 'attentionBg' }),
        ...(hw ? [cell('', width - hw - 2, 2, { bg: 'attentionBg' }), cell(pad(clip(hint, hw - 1), hw), width - hw, hw, { id: `need:${n.key}`, fg: 'goal', bg: 'attentionBg' })] : []));
    }
    if (m.needs.length > 3) add('needs', cell(`    ${m.needs.length - 3} more · open queue ›`, 0, width, { id: 'view:needs', fg: 'amber', bg: 'attentionBg' }));
    if (m.aged.length) add('needs', cell(` ${m.aged.length} parked ${m.aged.length === 1 ? 'question' : 'questions'} (>7 days) · record today --parked`, 0, width, { id: 'view:aged', fg: 'muted' }));
    add('content', cell('', 0, width));
  }

  // Sessions, numbered, under their checkout.
  const nameW = Math.max(16, Math.min(34, Math.floor(width * .24))), sinceW = compact ? 0 : 5, upW = 5, toolW = compact ? 0 : 8;
  const descX = 6 + nameW + sinceW + upW + toolW + 1;
  for (const g of groups) {
    const git = g.space && s.checkoutGit?.[g.space.workspace_id];
    const branch = git?.branch?.split('...')[0]?.split(' ')[0];
    const facts = git ? [[g.name, `lane/${g.name}`, `lane-${g.name}`].includes(branch) ? null : branch, git.changes ? `${git.changes} changed` : null, git.branch?.match(/\[(.*)\]/)?.[1]].filter(Boolean).join(' · ') : '';
    const head = ` ${g.name} · ${g.sessions.length}`;
    add('sessions', cell(head, 0, head.length + 1, { id: g.space ? link('space', g.space.workspace_id, 'project') : null, fg: g.sessions.some(a => a.state === 'working') ? 'teal' : 'blue', bold: true }),
      cell(facts ? `  ${facts}` : '', head.length + 1, width - head.length - 1, { fg: 'muted' }));
    for (const a of g.sessions) {
      const n = number.get(a.pane), renaming = s.rename?.pane === a.pane, row = `session:${a.pane}`;
      const task = a.task && m.itemsById.get(a.task);
      const doing = task ? `${a.goal ? `${a.goal} › ` : ''}${task.id}${a.recorded ? ' (last)' : ''} ${task.title}` : a.doing && a.doing !== 'no description' ? a.doing : 'chat';
      add('sessions',
        cell(`${padStart(n, 3)}  `, 0, 5, { id: row, fg: 'muted' }),
        cell(GLYPH[a.state] ?? '·', 5, 1, { id: row, fg: stateColor(a.state) }),
        renaming ? cell(` ${s.rename.text}▏`, 6, nameW, { fg: 'bright', bg: 'selected', bold: true })
          : cell(` ${sessionName(a)}`, 6, nameW, { id: `rename:${a.pane}`, hitOnly: true, focusAs: row, fg: a.state === 'blocked' ? 'amber' : 'bright', bold: a.state === 'working' || a.state === 'blocked' }),
        ...(sinceW ? [cell(padStart(a.since ? shortAge(now - a.since) : '', sinceW - 1), 6 + nameW, sinceW, { id: row, fg: 'muted' })] : []),
        cell(padStart(a.up === 'unknown' ? '' : a.up ?? '', upW - 1), 6 + nameW + sinceW, upW, { id: row, fg: 'muted' }),
        ...(toolW ? [cell(` ${(a.who?.tool ?? 'agent').toLowerCase()}`, 6 + nameW + sinceW + upW, toolW, { id: row, fg: toolColor(a.who?.tool) })] : []),
        cell(` ${doing}`, descX - 1, width - descX + 1, { id: task ? link('item', task.id, a.pane) : row, fg: task ? 'fg' : 'muted' }));
    }
  }
  if (idle.length) add('sessions', cell(` no agent · ${idle.map(checkoutName).join(', ')}`, 0, width, { fg: 'muted' }));
  if (!m.sessions.length) paragraph(s.errors.agents ? 'Session data is unavailable. Refresh to reconnect.' : 'No sessions here yet. Write below to start one.');
  return rows;
}
