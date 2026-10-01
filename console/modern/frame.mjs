// Cell-measured native-space layout. Uses the same Ink span renderer as the
// existing console; every interactive label has both a key focus and a hit box.
import path from 'node:path';
import { cropTerminalSpans } from './terminal.mjs';
import { cutSpans } from '../lib/frame.mjs';
import { pad, clip, wrap, sanitize, cellWidth } from '../lib/text.mjs';
import { projectRows, composeModes, currentBlock, checkoutName } from './project.mjs';
import { needChoices, needActions, needEffect } from './needs.mjs';
import { regionFor, pickerEntries } from './navigation.mjs';
import { relatedWork, acceptanceCriteria, itemOrigin } from './model.mjs';

// These are the actual light/dark tokens from modern-console-overview.html.
export const MODERN_PALETTES = {
  light: { bg: '#fafcfe', panel: '#e6edf7', selected: '#d6e5f9', fg: '#22354c', bright: '#22354c', muted: '#546b85', faint: '#546b85', rule: '#cbd9ea', blue: '#245d9b', band: '#e5edf9', goal: '#45589a', goalBg: '#f0f3fb', amber: '#775015', attentionBg: '#fff1d8', teal: '#176b60' },
  dark: { bg: '#121b28', panel: '#19283c', selected: '#29466a', fg: '#e0e8f4', bright: '#e0e8f4', muted: '#a5b7cf', faint: '#a5b7cf', rule: '#34465f', blue: '#9bc7ff', band: '#203550', goal: '#b9c7f9', goalBg: '#1d273c', amber: '#efc887', attentionBg: '#392e1d', teal: '#79d2c2' },
};
export const MODERN_PALETTE = MODERN_PALETTES.light;
// Needs you, then the groups folded out of it; each stays one keypress away.
export const NEED_FOLDS = [
  { view: 'needs', list: 'needs', title: 'Needs you', label: 'Open' },
  { view: 'resolved', list: 'resolved', title: 'Resolved in the record', label: 'Resolved', about: 'Session questions whose record item has closed, or that a newer result about the same item replaced.' },
  { view: 'ended', list: 'ended', title: 'Ended sessions', label: 'Ended sessions', about: 'Questions from sessions that ended over a day ago, with no record item recording them.' },
  { view: 'reports', list: 'reports', title: 'Session reports', label: 'Reports', about: 'Sessions that finished and reported without asking for a decision.' },
  { view: 'later', list: 'later', title: 'Saved for later', label: 'Saved for later' },
  { view: 'parked', list: 'parked', title: 'Future stages', label: 'Future stages' },
];
const clean = text => sanitize(String(text ?? ''));
const age = (at, now) => at ? `${Math.max(0, Math.floor((now - at) / 1000))}s ago` : 'not loaded';
const ss = (text, fg = 'fg', bg = 'bg', bold = false) => ({ text: clean(text), fg, bg, bold });

const checkoutOrderFirst = m => m.spaces.slice().sort((a, b) => Number(Boolean(a.worktree?.is_linked_worktree)) - Number(Boolean(b.worktree?.is_linked_worktree)))[0]?.workspace_id;

export function renderModern({ state: s, project: p, model: m, now }, cols, rows) {
  cols = Math.max(1, cols); rows = Math.max(1, rows);
  const lines = Array.from({ length: rows }, () => ({ spans: [ss(' '.repeat(cols))] }));
  const hits = Array.from({ length: rows }, () => []), controls = [];
  if (cols < 80 || rows < 20) {
    lines[0] = { spans: [ss(clip('Projects needs at least 80 columns × 20 rows. Resize, or q to quit.', cols))] };
    return { lines, hits, controls, bodyHeight: 1, maxScroll: 0 };
  }
  // The project screen keeps a start bar under its body.
  const bar = (s.view === 'overview' && p) || s.view === 'need' ? 2 : 0;
  const rail = s.showCheckouts === false ? 0 : cols >= 120 ? 25 : cols >= 100 ? 22 : 18, x = rail + 2, width = cols - x - 2, top = 6, bodyHeight = rows - top - 2 - bar;
  const put = (y, from, text, fg = 'fg', bg = 'bg', bold = false, limit = cols - from) => {
    if (y < 0 || y >= rows || from >= cols) return;
    limit = Math.max(0, Math.min(limit, cols - from));
    const cell = ss(pad(clip(clean(text), limit), limit), fg, bg, bold);
    const current = lines[y].spans;
    lines[y] = { spans: [...cutSpans(current, 0, from), cell, ...cutSpans(current, from + limit, cols)] };
  };
  const control = (id, label, y, from, w, fg = 'fg', bodyRow = null, bg = 'bg', bold = false, region = null) => {
    if (!controls.some(c => c.id === id)) controls.push({ id, bodyRow, region: region ?? regionFor({ id, y, from, rail, bodyRow }) });
    if (y < 0 || y >= rows - 1) return;
    put(y, from, label, fg, s.focus === id ? 'selected' : bg, s.focus === id || bold, w);
    hits[y].push({ from, to: from + w, id });
  };
  // Native Herdr already owns spaces/agents. Its companion starts without a
  // second rail; checkouts remain available on demand with w.
  if (rail) {
  for (let y = 0; y < rows - 1; y++) put(y, 0, '', 'fg', 'panel', false, rail);
  put(0, 1, 'Herdr Monitor', 'bright', 'panel', true, rail - 2);
  put(2, 1, 'Project', 'muted', 'panel', false, rail - 2);
  control('scope', `${p?.name ?? 'Choose project'} ▾`, 3, 1, rail - 2, 'blue', null, 'panel');
  control('home', `${s.view === 'overview' ? '▏' : ' '}Project overview`, 5, 0, rail, 'blue', null, s.view === 'overview' ? 'selected' : 'panel');
  const spaces = m.spaces.slice().sort((a, b) => Number(Boolean(a.worktree?.is_linked_worktree)) - Number(Boolean(b.worktree?.is_linked_worktree)));
  let railY = 7;
  if (spaces.length && !spaces.some(w => !w.worktree?.is_linked_worktree)) { put(railY++, 1, 'Main not open', 'muted', 'panel', false, rail - 2); }
  const focusedSpace = spaces.findIndex(w => `space:${w.workspace_id}` === s.focus || (s.view === 'output' && w.workspace_id === s.space));
  const spaceRoom = Math.max(1, rows - railY - 6), offset = Math.max(0, focusedSpace - spaceRoom + 1);
  spaces.forEach((w, i) => {
    const linked = w.worktree?.is_linked_worktree;
    const own = m.sessions.filter(a => a.space === w.workspace_id), working = own.filter(a => a.state === 'working').length;
    const suffix = working ? `${working} ●` : own.length ? `${own.length} ○` : '·';
    const name = linked ? `│ ${path.basename(w.worktree.checkout_path).replace(/^lane-/, '')}` : 'Main checkout';
    const label = `${pad(name, rail - 7)} ${pad(suffix, 4)}`;
    if (i >= offset && i < offset + spaceRoom) control(`space:${w.workspace_id}`, label, railY + i - offset, 1, rail - 2, working ? 'teal' : 'fg', null, s.view === 'output' && s.space === w.workspace_id ? 'selected' : 'panel');
    else controls.push({ id: `space:${w.workspace_id}`, bodyRow: null, region: 'checkouts' });
  });
  if (!spaces.length) put(7, 1, 'No open checkouts', 'muted', 'panel', false, rail - 2);
  control('folder', '+ Open folder', rows - 5, 1, rail - 2, 'blue', null, 'panel');
  control('appearance', `D ${s.appearance === 'dark' ? 'Light' : 'Dark'} appearance`, rows - 4, 1, rail - 2, 'muted', null, 'panel');
  control('view:help', '? Keys', rows - 3, 1, rail - 2, 'muted', null, 'panel');
  put(rows - 2, 1, 'Live', 'muted', 'panel', false, rail - 2);
  }

  if (!rail) control('scope', `${p?.name ?? 'Choose project'} ▾`, 0, x, Math.min(26, width - 35), 'blue');
  const breadcrumbX = rail ? x : x + Math.min(28, width - 33);
  if (s.history.length) control('back', '‹', 0, breadcrumbX, 2, 'blue');
  else put(0, breadcrumbX, '‹', 'muted', 'bg', false, 2);
  const viewName = s.view === 'item' ? m.itemsById.get(s.detail)?.id ?? 'Item' : s.view.charAt(0).toUpperCase() + s.view.slice(1);
  put(0, breadcrumbX + 3, `Project / ${viewName}`, 'muted', 'bg', false, cols - breadcrumbX - 16);
  control('refresh', 'r Refresh', 0, cols - 11, 10, 'blue');
  const space = m.spaces.find(w => w.workspace_id === s.space);
  const title = s.view === 'projects' ? 'Your projects' : s.view === 'folder' ? 'Open a folder' : s.view === 'ideas' ? 'Start with an idea' : s.view === 'output' ? space?.label ?? 'Session output' : p?.name ?? 'Start where you are';
  const action = s.view === 'overview' && p ? 'n Start' : 'Read only';
  put(2, x, title, 'bright', 'bg', true, width - action.length - 2);
  put(2, cols - action.length - 2, action, 'muted', 'bg', false, action.length);
  const errors = Object.entries(s.errors);
  if (errors.length || s.loading) put(3, x, errors.length ? `Connection issue · ${errors.map(([k]) => k).join(', ')} · r to retry` : 'Reading current work…', 'amber', 'bg', false, width);
  put(5, rail, '─'.repeat(cols - rail), 'rule');
  if (s.view !== 'output') {
    let tx = x;
    for (const [id, label] of [['overview', 'Overview'], ['goals', 'Goals'], ['tasks', 'Tasks'], ['activity', 'Activity'], ['needs', `Needs you ${m.needs.length}`]]) {
      control(`view:${id}`, label, 4, tx, label.length + 2, id === 'needs' ? 'amber' : 'fg');
      if (s.view === id || (id === 'needs' && NEED_FOLDS.some(f => f.view === s.view))) put(5, tx, '━'.repeat(label.length), 'blue', 'bg', false, label.length);
      tx += label.length + 3;
    }
    if (width >= 70) control('checkouts', rail ? 'w Hide checkouts' : 'w Checkouts', 4, cols - 18, 16, 'muted');
  } else {
    const tabs = m.tabs.filter(t => t.workspace_id === s.space), selected = tabs.findIndex(t => t.tab_id === s.tab);
    const cell = Math.min(23, Math.max(12, Math.floor(width / Math.min(4, tabs.length || 1))));
    const slots = Math.max(1, Math.floor(width / cell)), start = Math.max(0, selected - slots + 1);
    tabs.forEach((t, i) => { const id = `tab:${t.tab_id}`; if (i >= start && i < start + slots) control(id, `${t.tab_id === s.tab ? '▸ ' : ''}${t.label || t.number || 'Shell'}`, 4, x + (i - start) * cell, cell - 1, 'blue'); else controls.push({ id, bodyRow: null, region: 'tabs' }); });
  }

  const body = [];
  let bodyRegion = 'content';
  const row = (text = '', { id = null, fg = 'fg', bold = false, col = 0, w = width, bg = 'bg', region = bodyRegion, spans = null, native = false } = {}) => { body.push([{ text, id, fg, bold, col, w, bg, region, spans, native }]); return body.length - 1; };
  const paragraph = (text, fg = 'muted') => { for (const line of wrap(clean(text), width)) row(line, { fg }); };
  const section = (title, fg = 'blue') => row(title, { fg, bold: true, bg: 'panel' });
  const compactSessions = width < 90;
  const widths = compactSessions ? [width - 8 - 12 - 9 - 3, 8, 12, 9] : [Math.max(12, Math.floor(width * .25)), 8, Math.max(8, Math.floor(width * .18)), 4, 8];
  if (!compactSessions) widths.push(width - widths.reduce((a, b) => a + b, 0) - 5);
  const fullRow = values => values.map((v, i) => pad(clean(v), widths[i])).join(' ');
  const sessionLabel = a => {
    if (s.view === 'sessions') return fullRow(compactSessions ? [a.session, a.who?.tool, a.where, a.state] : [a.session, a.who?.tool, a.where, a.up === 'unknown' ? '—' : a.up, a.state, a.doing === 'no description' ? '—' : a.doing]);
    const checkout = width >= 90 ? 18 : 0, name = width - 8 - 19 - 9 - (checkout ? checkout + 1 : 0) - 3;
    return `${pad(a.who?.tool || 'Agent', 8)} ${pad(a.session, name)} ${pad(a.goal ? `${a.goal} › ${a.task}${a.recorded ? ' (last)' : ''}` : a.task ?? 'Unlinked', 19)} ${checkout ? pad(a.where, checkout) + ' ' : ''}${a.state}`;
  };
  const sessionRows = list => list.forEach(a => row(sessionLabel(a), { id: `session:${a.pane}`, fg: a.state === 'working' ? 'teal' : a.state === 'blocked' ? 'amber' : 'fg' }));
  const itemRow = i => row(`${pad(i.id, 8)} ${pad(i.status, 8)} ${clip(i.title, width - 18)}`, { id: `item:${i.id}`, fg: i.status === 'blocked' ? 'amber' : i.kind === 'goal' ? 'goal' : 'fg' });
  // A result reads by its digest, not the screen text it was scraped from.
  const needText = n => { const g = n.data?.digest; return g?.question ?? g?.gist ?? g?.what_happened ?? n.title ?? n.headline; };
  const needRow = n => {
    const when = n.data?.at ? new Date(n.data.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    const label = n.handle ?? n.data?.tab_label ?? n.session ?? n.question ?? 'Decision';
    return row(`${pad(clip(label, 16), 16)} ${n.foldedIn ? pad(when, 7) : ''}${needText(n)}${n.later ? ' · later' : ''}`, { id: `need:${n.key}`, fg: n.foldedIn ? 'fg' : 'amber' });
  };
  if (s.view === 'projects' || (!p && s.view === 'overview')) {
    section('Continue a project');
    for (const project of s.projects) {
      row(`${project.name} · ${project.org ? 'Connected' : 'Discovered in Herdr / opened folder'}`, { id: `project:${project.id}`, fg: 'blue' });
      row(project.root ?? project.cwd ?? 'No folder linked', { fg: 'muted' });
    }
    if (!s.projects.length) paragraph('No projects yet. Open a folder, or explore an idea before defining goals.');
    row(); row('Open a folder…', { id: 'folder', fg: 'blue' }); row('Start with an idea', { id: 'ideas', fg: 'goal' });
    paragraph('Discovered projects are available to inspect. They are not registered or changed by opening them.');
  } else if (s.view === 'folder') {
    paragraph('Choose an existing directory. Git, goals and a record are optional.'); row();
    row(`Path: ${s.text}▏`, { fg: 'bright' }); row(); row('Enter  Open folder', { id: 'open-folder', fg: 'blue' });
    paragraph('Opening only reads this folder. It does not create files, run setup scripts or register a project.');
  } else if (s.view === 'ideas') {
    section('Ideas come before goals', 'goal');
    paragraph('You should be able to collect rough ideas and explore them in a conversation before choosing an outcome. A repository and goals should both be optional.'); row();
    paragraph('The live trial currently opens existing folders and sessions. Idea capture and new-project creation are the next onboarding flow; they are not connected yet.'); row();
    row('Open a folder you already have', { id: 'folder', fg: 'blue' }); row('Browse open projects', { id: 'scope', fg: 'blue' });
  } else if (s.view === 'overview') {
    body.push(...projectRows({ model: m, state: s, project: p, width, height: bodyHeight, now }));
  } else if (s.view === 'sessions') {
    section(`Sessions · ${m.sessions.length}`); row(fullRow(compactSessions ? ['Session', 'Who', 'Where', 'State'] : ['Session', 'Who', 'Where', 'Up', 'State', 'Doing']), { fg: 'muted' }); sessionRows(m.sessions);
    if (compactSessions) { row(); paragraph('Open a session for full identity, uptime and activity.'); }
    if (!m.sessions.length) paragraph('No agents in this project.');
  } else if (s.view === 'goals' || s.view === 'tasks') {
    const list = s.view === 'goals' ? m.goals : m.tasks;
    section(`${s.view === 'goals' ? 'Goals' : 'Tasks'} · ${list.length}`, s.view === 'goals' ? 'goal' : 'blue'); list.forEach(itemRow);
    if (!list.length) paragraph(s.errors.status ? 'Record data is unavailable. Refresh to reconnect.' : p?.org ? 'Nothing defined yet. Explore first; structure can follow.' : 'No record connected. Goals and tasks require project setup, which is not connected in this trial. Open a folder or inspect an existing Herdr conversation first.');
  } else if (s.view === 'activity') {
    section(`Activity · ${m.activity.length} moments in the last 36 hours`, 'blue');
    const when = at => { const d = new Date(at); if (Number.isNaN(d.getTime())) return ''; return d.toDateString() === new Date(now).toDateString()
      ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    for (const event of m.activity) {
      const color = event.mark === '!' || event.mark === '?' ? 'amber' : event.mark === '✓' || event.mark === '■' ? 'teal' : event.mark === '▶' || event.mark === '+' ? 'blue' : 'muted';
      row(`${pad(when(event.at), 12)} ${event.mark} ${pad(event.id, 9)} ${pad(event.verb, 11)} ${event.title}`, { id: `item:${event.id}`, fg: color, bold: true });
      if (event.detail) row(`              ${event.detail}`, { id: `item:${event.id}`, fg: 'muted' });
      if (event.summary) for (const line of wrap(`“${event.summary}”`, Math.max(1, width - 14)).slice(0, 2)) row(`              ${line}`, { id: `item:${event.id}`, fg: 'fg' });
    }
    if (!m.activity.length) paragraph(s.errors.events ? 'Activity is unavailable. Refresh to reconnect.' : p?.org ? 'No item activity was recorded in the last 36 hours.' : 'No record connected.');
  } else if (NEED_FOLDS.some(f => f.view === s.view)) {
    const fold = NEED_FOLDS.find(f => f.view === s.view), list = m[fold.list];
    section(`${fold.title} · ${list.length}`, 'amber'); if (fold.about) paragraph(fold.about);
    list.forEach(needRow); if (!list.length) paragraph('Nothing here.');
    row(); for (const f of NEED_FOLDS) if (f.view === 'needs' || m[f.list].length) row(`${f.view === s.view ? '▸ ' : '  '}${f.label} ${m[f.list].length}`, { id: `view:${f.view}`, fg: f.view === 'needs' ? 'amber' : 'muted' });
  } else if (s.view === 'item') {
    const i = m.itemsById.get(s.detail);
    if (!i) paragraph('This item is no longer available in the current project.');
    else {
      section(`${i.id} · ${i.status}`, i.kind === 'goal' ? 'goal' : 'blue'); paragraph(i.title, 'fg'); row();
      const origin = itemOrigin(i);
      if (origin) {
        const at = origin.at ? new Date(origin.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
        paragraph(`${origin.source}${at ? ` · ${at}` : ''}`, origin.unattributed ? 'amber' : 'muted');
        if (origin.why) paragraph(`Why: ${origin.why}`, 'fg');
      }
      if (i.parent) row(`Parent: ${i.parent} · ${m.itemsById.get(i.parent)?.title ?? ''}`, { id: `item:${i.parent}`, fg: 'goal' });
      const related = relatedWork(m, i.id);
      row(); bodyRegion = 'sessions'; section(`Current linked sessions · ${related.current.length}`, 'teal');
      sessionRows(related.current);
      if (!related.current.length) paragraph(`No current session has a recorded link to this ${i.kind === 'goal' ? 'goal or its descendant tasks' : 'task'}.`);
      if (related.unlinked) row(`${related.unlinked} unlinked sessions in this project · inspect sessions ›`, { id: 'view:sessions', fg: 'blue' });
      if (related.historical.length) { row(); section(`Last recorded links · ${related.historical.length}`); sessionRows(related.historical); }
      bodyRegion = 'content'; row(); section('Success criteria');
      const criteria = acceptanceCriteria(i);
      if (criteria.length) criteria.forEach((text, index) => paragraph(`${index + 1}. ${text}`, 'fg'));
      else paragraph('No success criteria recorded.');
      if (i.priority != null) paragraph(`Recorded priority: ${i.priority} · higher values first`);
      if (i.blocked_reason) paragraph(`Blocked: ${i.blocked_reason}`, 'amber');
      for (const n of (i.notes ?? []).slice(-3)) { row(); paragraph(n.text, 'fg'); }
      row(); bodyRegion = 'tasks'; section(`Related active tasks · ${related.tasks.length}`); related.tasks.forEach(itemRow);
      if (!related.tasks.length) paragraph('No active tasks are recorded under this item.');
    }
  } else if (s.view === 'need') {
    // The item's own page: what is asked, why, then the choices as controls.
    const n = m.allNeeds.find(n => n.key === s.detail);
    if (!n) paragraph('This item has left the queue. Return to Needs you for the current list.');
    else {
      const g = n.data?.digest, from = n.kind === 'result' ? `from ${n.data?.tab_label ?? n.session ?? 'a session'}` : 'record question';
      section(`${n.handle ?? n.question ?? 'Decision'} · ${from}`, 'amber');
      paragraph(g?.question ?? n.title ?? n.headline, 'bright'); row();
      if (n.settled) { paragraph(`Folded · ${n.settled}`, 'teal'); row(); }
      const why = g?.explain ?? n.data?.why ?? n.gist ?? n.data?.summary;
      if (why) { paragraph(why); row(); }
      bodyRegion = 'actions';
      const choices = needChoices(n);
      if (choices.length) section('Choose', 'goal');
      for (const c of choices) {
        const armed = s.act?.choice?.id === c.id;
        row(` ${c.key}  ${c.label}${c.recommended ? '   ★ recommended' : ''}`, { id: `choose:${c.id}`, fg: c.recommended ? 'goal' : 'bright', bold: true, bg: armed ? 'attentionBg' : 'bg' });
        if (c.causes) for (const line of wrap(clean(c.causes), width - 5)) row(`    ${line}`, { fg: 'muted' });
      }
      if (!choices.length) paragraph('No choices were worked out for this one. Reply in your own words, or open the session.');
      if (n.recommend && !choices.some(c => c.recommended)) paragraph(`Recommendation: ${n.recommend}`);
      row();
      for (const a of needActions(n, { canOpen: Boolean(n.data?.pane && m.sessions.some(x => x.pane === n.data.pane)) || Boolean(n.go?.agent) })) row(` ${a.key}  ${a.label}`, { id: `choose:${a.id}`, fg: 'blue' });
      bodyRegion = 'content';
    }
  } else if (s.view === 'output' && s.interactive && s.pane) {
    // Interactive: one line of identity and the way back, then the session's own
    // terminal, sized by Herdr to exactly this area, with its cursor.
    const active = m.sessions.find(a => a.pane === s.pane), task = m.itemsById.get(active?.task), goal = m.itemsById.get(active?.goal);
    const who = `${active?.who?.tool ?? 'Agent'} ${active?.session ?? s.pane} · ${active?.state ?? 'unknown'}${goal ? ` · ${goal.id}` : ''}${task ? ` › ${task.id} ${task.title}` : ''}`;
    body.push([{ text: ' ‹ Back  Ctrl+] ', id: 'back', fg: 'blue', bold: true, col: 0, w: 16, bg: 'selected', region: 'actions' },
      { text: who, col: 17, w: width - 17, fg: 'muted', bg: 'bg', region: 'actions' }]);
    bodyRegion = 'terminal';
    if (s.outputError) paragraph(s.outputError, 'amber');
    const available = Math.max(1, bodyHeight - body.length);
    s.screenViewport = { cols: width, rows: available };
    const screen = s.terminalFrame;
    if (!screen) row(' Taking the terminal from Herdr…', { fg: 'terminalFg', bg: 'terminalBg' });
    else {
      const start = Math.max(0, screen.height - available), shownWidth = Math.min(screen.width, width), cursor = screen.cursor;
      screen.lines.slice(start).forEach((line, i) => {
        let grid = cropTerminalSpans(line.spans, 0, shownWidth);
        if (cursor?.visible && cursor.y === start + i && cursor.x < shownWidth) {
          grid = [...cutSpans(grid, 0, cursor.x), ...cutSpans(grid, cursor.x, cursor.x + 1).map(c => ({ ...c, inverse: !c.inverse })), ...cutSpans(grid, cursor.x + 1, shownWidth)];
        }
        row('', { bg: 'terminalBg', native: true, spans: [...grid, ...(width > shownWidth ? [ss(' '.repeat(width - shownWidth), 'terminalFg', 'terminalBg')] : [])] });
      });
    }
  } else if (s.view === 'output') {
    const agents = m.sessions.filter(a => a.tab === s.tab), active = agents.find(a => a.pane === s.pane);
    const task = m.itemsById.get(active?.task), goal = m.itemsById.get(active?.goal);
    bodyRegion = 'content';
    section(active?.recorded ? 'Last recorded work · not a current assignment' : 'Work context', 'goal');
    if (goal) row(` Goal  ${goal.id} · ${goal.title}`, { id: `item:${goal.id}`, fg: 'goal', bg: 'goalBg' });
    if (task) {
      row(` Task  ${task.id} · ${task.status} · ${active.run?.run ?? 'Recorded run'}`, { id: `item:${task.id}`, bg: 'goalBg' });
      for (const line of wrap(` Summary  ${task.title}`, width - 2).slice(0, 2)) row(` ${line}`, { bg: 'goalBg' });
    } else {
      row(' No recorded goal or task link for this session.', { fg: 'muted', bg: 'goalBg' });
      if (active?.doing && active.doing !== 'no description') row(` Activity  ${active.doing}`, { fg: 'muted', bg: 'goalBg' });
    }
    row();
    if (agents.length > 1 || !s.pane) { bodyRegion = 'sessions'; sessionRows(agents); }
    bodyRegion = 'terminal';
    if (!s.pane) {
      if (s.tab) row('o  Open native terminal in Herdr', { id: 'go', fg: 'blue' });
      const away = m.elsewhere.filter(a => a.tab === s.tab);
      if (agents.length) paragraph('Select a session to read its exact pane.');
      else if (away.length) for (const a of away) paragraph(`${a.name ?? a.pane} (${a.status ?? 'unknown'}) is in this tab but works in ${a.repo?.name ?? a.cwd}. Press p and choose that project to read it.`, 'amber');
      else paragraph('Shell tab · open the native terminal to interact.');
    } else {
      const mirror = s.outputMode !== 'transcript';
      row('i  Type into this session here', { id: 'interact', fg: 'blue', bold: true });
      row(`o  Open live ${active?.who?.tool ?? 'agent'} terminal in Herdr`, { id: 'go', fg: 'blue' });
      row(`${s.pane} · ${active?.session ?? 'Session unavailable'} · ${active?.state ?? 'unknown'} · up ${active?.up ?? 'unknown'}`, { fg: 'muted' });
      if (s.outputError) paragraph(s.outputError, 'amber');
      section(mirror ? `Live screen · read only · ${age(s.outputAt, now)}` : `Transcript · plain text · ${age(s.outputAt, now)}`, 'teal');
      const positionRow = mirror && s.terminalFrame ? row() : null;
      const available = Math.max(1, bodyHeight - body.length - 1);
      s.screenViewport = { cols: width - 2, rows: available };
      if (mirror && s.terminalFrame) {
        const screen = s.terminalFrame;
        s.screenScroll = Math.min(s.screenScroll ?? 0, Math.max(0, screen.height - available));
        s.outputX = Math.min(s.outputX ?? 0, Math.max(0, screen.width - s.screenViewport.cols));
        const end = screen.height - s.screenScroll, start = Math.max(0, end - available);
        const shownWidth = Math.min(screen.width - s.outputX, s.screenViewport.cols);
        body[positionRow][0].text = `Native ${screen.width}×${screen.height} · rows ${start + 1}–${end} · cols ${s.outputX + 1}–${s.outputX + shownWidth}${s.screenScroll ? ' · panned' : ' · bottom'}`;
        body[positionRow][0].fg = 'muted';
        for (const line of screen.lines.slice(start, end)) {
          // Crop native cells locally, preserving complete graphemes and styles.
          // Never resize or scroll the actual harness to fit this console.
          const grid = cropTerminalSpans(line.spans, s.outputX, shownWidth);
          row('', { bg: 'terminalBg', native: true, spans: [ss(' ', 'terminalFg', 'terminalBg'), ...grid, ss(' '.repeat(width - shownWidth - 1), 'terminalFg', 'terminalBg')] });
        }
      } else if (mirror && !s.output) {
        row(s.outputError ? ' Native terminal remains available with o.' : ' Connecting to the live terminal…', { fg: 'terminalFg', bg: 'terminalBg' });
      } else {
        const text = sanitize(s.output ?? '', { keepNewlines: true });
        // Preserve spaces even in the explicitly plain transcript. Do not word
        // reflow terminal tables, diagrams or prompts into ordinary prose.
        const out = text.split('\n');
        s.outputScroll = Math.min(s.outputScroll, Math.max(0, out.length - available));
        const end = out.length - s.outputScroll, start = Math.max(0, end - available);
        for (const line of out.slice(start, end)) row(` ${clip(line, width - 2)}`, { fg: 'terminalFg', bg: 'terminalBg' });
      }
      row(mirror ? 'i Type here · Shift+arrows pan · l Transcript · o Native terminal' : `v Live screen · PageUp/PageDown transcript${s.outputScroll ? ` · ↑ ${s.outputScroll} lines above latest` : ''}`, { fg: 'muted' });
    }
  } else if (s.view === 'help') {
    section('Keyboard and mouse');
    for (const text of ['Tab / Shift+Tab  Change section · Enter opens', 'j / k or Up / Down  Select within section', 'Left / Right  Change main view or checkout tab', 'p Project dropdown · type to filter · Esc dismisses', 'h Overview · g Goals · t Tasks · a Activity · s Sessions · ! Needs you', 'w Show/hide checkouts · native Herdr owns the sidebar', 'Esc / b / Alt+Left  Back · Alt+Right Forward', 'PageUp / PageDown or wheel  Scroll; live output switches to transcript', 'v Live screen · l Transcript · Shift+arrows pan screen locally', 'r Refresh · o Open selected native terminal · D Light/dark · q Quit', 'n Start a chat or a task from the project screen · a second Enter confirms', 'Click a session to type into it here; Ctrl+] or ‹ Back returns · i types into a watched session', 'Back restores your project, selection and scroll.', 'For answers and dispatch: record console --project NAME', 'Writes: the start bar, and what you type into a session. No model calls.']) paragraph(text, 'fg');
  }
  const maxScroll = Math.max(0, body.length - bodyHeight); s.scroll = Math.min(s.scroll, maxScroll);
  body.forEach((cells, i) => cells.forEach(c => {
    const y = top + i - s.scroll, visible = y >= top && y < top + bodyHeight;
    // A hit-only cell answers the mouse but is not a keyboard stop; it shows the
    // focus of the row it belongs to.
    if (c.id && c.hitOnly) { if (visible) { put(y, x + c.col, c.text, c.fg, s.focus === c.focusAs ? 'selected' : c.bg ?? 'bg', c.bold || s.focus === c.focusAs, c.w); hits[y].push({ from: x + c.col, to: x + c.col + c.w, id: c.id }); } }
    else if (c.id) { if (visible) control(c.id, c.text, y, x + c.col, c.w, c.fg, i, c.bg ?? 'bg', c.bold, c.region); else if (!controls.some(k => k.id === c.id)) controls.push({ id: c.id, bodyRow: i, region: c.region ?? 'content' }); }
    else if (visible && c.spans) {
      const spans = c.native ? c.spans : cutSpans(c.spans, 0, c.w), used = c.native ? c.w : spans.reduce((n, span) => n + cellWidth(span.text), 0);
      lines[y] = { spans: [...cutSpans(lines[y].spans, 0, x + c.col), ...spans, ss(' '.repeat(Math.max(0, c.w - used)), c.fg, c.bg), ...cutSpans(lines[y].spans, x + c.col + c.w, cols)] };
    } else if (visible) put(y, x + c.col, c.text, c.fg, c.bg ?? 'bg', c.bold, c.w);
  }));
  if (bar && s.view === 'need') {
    // The answer line: what the chosen action will do, or the text it needs.
    put(rows - 3, x, '─'.repeat(width), 'rule');
    const n = m.allNeeds.find(n => n.key === s.detail), a = s.act;
    if (a?.busy) put(rows - 2, x, `${a.says}…`, 'amber', 'bg', true, width);
    else if (a?.stage === 'text') put(rows - 2, x, `${a.choice.needsText}: ${a.text}▏   Enter sends · Esc cancels`, 'bright', 'attentionBg', false, width);
    else if (a) put(rows - 2, x, `${a.says}?   Enter confirms · Esc cancels`, 'amber', 'attentionBg', true, width);
    else if (n) put(rows - 2, x, [needChoices(n).length ? `${needChoices(n).map(c => c.key).join(' ')} choose` : '', ...needActions(n, { canOpen: true }).map(c => `${c.key} ${c.id === 'open' ? 'open' : c.id}`)].filter(Boolean).join(' · '), 'muted', 'bg', false, width);
  } else if (bar) {
    // The prompt: write, and Enter starts it. Tab picks task or a chat kind.
    put(rows - 3, x, '─'.repeat(width), 'rule');
    const c = s.compose;
    const mode = composeModes(p, s.chatKinds)[c?.mode ?? 0] ?? { kind: 'chat', agent: s.chatKinds?.[0] ?? 'claude' }, block = currentBlock(m);
    const w = m.spaces.find(w => w.workspace_id === (c?.space ?? checkoutOrderFirst(m)));
    const target = mode.kind === 'task' ? `task → ${block ? block.goal.id : 'no goal'}` : `${mode.agent} → ${w ? checkoutName(w) : 'no checkout'}`;
    const tw = cellWidth(target) + 2, room = width - tw - 3;
    if (c?.busy) put(rows - 2, x, `› ${mode.kind === 'task' ? 'adding the task' : `starting ${mode.agent}`}…`, 'amber', 'bg', true, width);
    else if (c) {
      const text = [...c.text], shown = text.slice(Math.max(0, text.length - room + 2)).join('');
      control('compose', `› ${shown}▏`, rows - 2, x, room + 2, 'bright', null, 'bg', true, 'actions');
      control('compose-mode', ` ${target} `, rows - 2, x + width - tw, tw, mode.kind === 'task' ? 'goal' : 'amber', null, 'selected', true, 'actions');
    } else {
      control('compose', `› write a task or a message…  n`, rows - 2, x, room + 2, 'muted', null, 'bg', false, 'actions');
      put(rows - 2, x + width - tw, ` ${target} `, 'muted', 'bg', false, tw);
    }
  }
  const issue = errors[0] ? `${errors[0][0]}: ${errors[0][1]}` : '';
  const hints = s.interactive && s.view === 'output' ? ' Typing goes to this session · Ctrl+] or click ‹ Back to return · wheel scrolls' : s.rename ? ' Name this session · Enter saves · Esc cancels · empty clears' : s.compose ? ' Enter starts · Tab task / claude / codex · ↑↓ checkout · Esc closes' : s.view === 'need' ? ' Esc back to the queue · ↑↓ and Enter choose too' : s.view === 'overview' ? ` 1-9 open session · click a name to rename · n write · p project · g goals · t tasks · ! needs${maxScroll ? '  PgDn' : ''}` : ` p scope  Tab pane  ↑↓ rows  ←→ views  Enter open  Esc back  n start${maxScroll ? '  PgDn' : ''}`;
  put(rows - 1, 0, s.message || issue || hints, issue || s.message ? 'amber' : 'muted', 'panel', false, !issue && !s.message && cols >= 100 ? cols - 24 : cols);
  if (!issue && !s.message && cols >= 100) put(rows - 1, cols - 22, `Live · ${age(s.times.agents, now)}`, 'muted', 'panel', false, 22);
  if (s.picker) {
    const entries = pickerEntries(s), left = rail ? 1 : x, upper = rail ? 4 : 1, menuWidth = Math.min(64, cols - left - 2);
    const noMatch = Boolean(s.picker.query) && !entries.some(entry => entry.id.startsWith('project:'));
    const listTop = upper + 2 + Number(noMatch);
    const count = Math.min(entries.length, Math.max(1, Math.floor((rows - upper - 5 - Number(noMatch)) / 2)));
    s.picker.index = Math.min(s.picker.index, entries.length - 1);
    const start = Math.max(0, s.picker.index - count + 1), end = start + count, bottom = upper + count * 2 + 3 + Number(noMatch);
    // Modal hit map: outside clicks dismiss instead of activating covered UI.
    hits.forEach(h => h.splice(0)); controls.splice(0);
    for (let y = upper; y <= bottom; y++) put(y, left, `│${' '.repeat(menuWidth - 2)}│`, 'rule', 'panel', false, menuWidth);
    put(upper, left, `╭${'─'.repeat(menuWidth - 2)}╮`, 'rule', 'panel', false, menuWidth);
    put(upper + 1, left + 2, `Project · ${s.picker.query || 'type to filter'}`, 'blue', 'panel', true, menuWidth - 4);
    if (noMatch) put(upper + 2, left + 2, 'No matching projects', 'muted', 'panel', false, menuWidth - 4);
    entries.slice(start, end).forEach((entry, i) => {
      const y = listTop + i * 2, selected = i + start === s.picker.index;
      put(y, left + 1, ` ${entry.selected ? '●' : ' '} ${entry.label}`, 'fg', selected ? 'selected' : 'panel', selected, menuWidth - 2);
      put(y + 1, left + 1, `   ${entry.path}`, 'muted', selected ? 'selected' : 'panel', false, menuWidth - 2);
      for (const row of [y, y + 1]) hits[row].push({ from: left + 1, to: left + menuWidth - 1, id: entry.id });
    });
    put(bottom, left, `╰${'─'.repeat(menuWidth - 2)}╯`, 'rule', 'panel', false, menuWidth);
    put(rows - 1, 0, ' ↑↓ select   Enter switch   type to filter   Esc close', 'muted', 'panel', false, cols);
  }
  return { lines, hits, controls, bodyHeight, maxScroll };
}
