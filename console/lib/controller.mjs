// Keys and clicks to state changes and effects. Pure: reduce(state, input, key, ctx)
// and reduceMouse(state, event, ctx) return { state, effects }. The session performs
// the effects (quit, answer, open, go, reload, project) and never decides anything.
//
// ctx: { rows, scopeItems, listPage, popupPage, popupMax, projectCount,
//        lineOf(key) → screen line, hitAt(x, y) → target }
// rows are the rows of the current view in screen order; a target is
// { type: 'row', key } | { type: 'menu', index } | { type: 'scope', index } |
// { type: 'tab', tab } | { type: 'popup' } | null.

export function initialState() {
  return {
    view: 'list', // 'list' | 'history'
    selectedKey: null,
    historyKey: null,
    listOffset: 0,
    follow: true, // keep the selection in view; the wheel turns this off
    popup: null, // { kind: 'summary', key, tab, scroll } | { kind: 'menu', key, index, x, y } | { kind: 'scope', index }
    help: false,
    mode: null, // { kind: 'reason' | 'confirm', action, answer, question, headline, text }
    scope: { repo: null, view: 'all' },
    message: '',
    messageStyle: 'status',
  };
}

export const LAUNCH_LATER = 'task launching comes in the next round';
const WHEEL = 3;
const VERB = { approve: 'Approve', decline: 'Decline', overrule: 'Overrule' };

// The answer an overrule records: the opposite of the recorded one (a text answer counts as yes).
export function overruleAnswer(recorded) {
  return String(recorded ?? '').trim().toLowerCase() === 'no' ? 'yes' : 'no';
}

function verb(m) {
  return m.action === 'overrule' ? `Overrule to ${m.answer}` : VERB[m.action];
}

// The prompt in parts, so the frame can shorten the title and keep the reason,
// its cursor and the keys in view: head + title + mid + reason + tail.
// `keep` says which end of a long reason stays visible.
export function promptParts(state) {
  const m = state.mode;
  if (!m) return null;
  if (m.kind === 'reason') {
    return { head: `${verb(m)} “`, title: m.headline, mid: '”. Reason: ', reason: m.text, keep: 'end', tail: '▏  Enter next · Esc cancel' };
  }
  const question = /[?？]$/.test(m.headline) ? m.headline : `${m.headline}?`;
  return m.text
    ? { head: `${verb(m)}: `, title: question, mid: ' (reason: ', reason: m.text, keep: 'start', tail: ') Enter to confirm, Esc to cancel' }
    : { head: `${verb(m)}: `, title: question, mid: '', reason: '', keep: 'start', tail: ' Enter to confirm, Esc to cancel' };
}

export function promptText(state) {
  const p = promptParts(state);
  return p && `${p.head}${p.title}${p.mid}${p.reason}${p.tail}`;
}

// The row menu (right click or m).
export function menuItems(row) {
  if (!row) return [];
  const items = [];
  if (row.kind === 'session') items.push({ label: 'Go to session', hint: 'Enter', action: 'go' });
  items.push({ label: 'Summary', hint: 's', action: 'summary' });
  if (row.actions?.includes('approve')) items.push({ label: 'Approve', hint: 'y', action: 'approve' });
  if (row.actions?.includes('decline')) items.push({ label: 'Decline', hint: 'n', action: 'decline' });
  if (row.actions?.includes('overrule')) items.push({ label: 'Overrule', hint: 'n', action: 'overrule' });
  return items;
}

const done = (state, effects = []) => ({ state, effects });

function say(state, message, style = 'status') {
  return { ...state, message, messageStyle: style };
}

function cursorKey(state) {
  return state.view === 'history' ? state.historyKey : state.selectedKey;
}

function withCursor(state, key) {
  return state.view === 'history' ? { ...state, historyKey: key } : { ...state, selectedKey: key };
}

function rowByKey(ctx, key) {
  return ctx.rows.find((r) => r.key === key) ?? null;
}

// Moves the cursor in the current view.
function move(state, ctx, to) {
  const keys = ctx.rows.map((r) => r.key);
  if (!keys.length) return state;
  const at = Math.max(0, keys.indexOf(cursorKey(state)));
  const next = Math.min(keys.length - 1, Math.max(0, to(at, keys.length)));
  return { ...withCursor(state, keys[next]), follow: true, message: '' };
}

function navKey(input, key, page) {
  if (key.downArrow || input === 'j') return (at) => at + 1;
  if (key.upArrow || input === 'k') return (at) => at - 1;
  if (key.pageDown) return (at) => at + page;
  if (key.pageUp) return (at) => at - page;
  if (key.home) return () => 0;
  if (key.end) return (_, n) => n;
  return null;
}

function summary(state, key) {
  return { ...state, popup: { kind: 'summary', key, tab: 0, scroll: 0 }, message: '' };
}

function goTo(state, row) {
  if (row?.kind !== 'session') return done(say(state, 'A question has no session to go to; y or n answers it.', 'warn'));
  return done(state, [{ type: 'go', key: row.key }]);
}

// Enter or a left click on a row.
function activate(state, row) {
  if (!row) return done(state);
  if (row.kind === 'session') return goTo(state, row);
  return done(summary(state, row.key));
}

function ask(state, row, action) {
  if (action === 'approve') {
    if (!row?.actions?.includes('approve')) return done(say(state, 'Nothing to approve here: select a question under Waiting on you.', 'warn'));
    return done(say({ ...state, mode: { kind: 'confirm', action, answer: 'yes', question: row.question, headline: row.headline, text: '' } }, ''));
  }
  const kind = row?.actions?.includes('decline') ? 'decline' : row?.actions?.includes('overrule') ? 'overrule' : null;
  if (!kind) return null;
  const answer = kind === 'overrule' ? overruleAnswer(row.data?.answer) : 'no';
  return done(say({ ...state, mode: { kind: 'reason', action: kind, answer, question: row.question, headline: row.headline, text: '' } }, ''));
}

function pickMenu(state, ctx, index) {
  const row = rowByKey(ctx, state.popup.key);
  const item = menuItems(row)[index];
  const closed = { ...state, popup: null };
  if (!item) return done(closed);
  if (item.action === 'go') return goTo(closed, row);
  if (item.action === 'summary') return done(summary(closed, row.key));
  return ask(closed, row, item.action) ?? done(closed);
}

function pickScope(state, ctx, index) {
  const item = ctx.scopeItems?.[index];
  const closed = { ...state, popup: null };
  if (!item) return done(closed);
  if (item.view === 'history') return done(toHistory(closed, ctx, true));
  const scope = { repo: item.repo, view: item.view };
  const name = item.repo ? item.label : item.view === 'all' ? 'all repositories' : item.label;
  return done(say({ ...closed, view: 'list', scope, follow: true }, `Showing ${name}.`));
}

function toggleView(state, view) {
  const next = state.scope.view === view ? 'all' : view;
  return say({ ...state, scope: { ...state.scope, view: next }, follow: true }, next === 'all' ? 'Showing every session.' : `Showing only ${next === 'needs' ? 'what needs you' : 'working sessions'}.`);
}

// ctx.historyRows lets the switch pick the first history row before the rows change.
function toHistory(state, ctx, on) {
  if (!on) return { ...state, view: 'list', listOffset: 0, follow: true };
  const first = (ctx.historyRows ?? []).find((r) => r.key === state.historyKey)?.key ?? ctx.historyRows?.[0]?.key ?? state.historyKey;
  return { ...state, view: 'history', historyKey: first, listOffset: 0, follow: true, message: '' };
}

function modeKeys(state, input, key) {
  const m = state.mode;
  if (key.escape) return done(say({ ...state, mode: null }, 'Cancelled; nothing was recorded.'));
  if (m.kind === 'reason') {
    if (key.return) {
      if (!m.text.trim()) return done(say(state, 'A reason is required (one line).', 'warn'));
      return done(say({ ...state, mode: { ...m, kind: 'confirm', text: m.text.trim() } }, ''));
    }
    if (key.backspace || key.delete) return done({ ...state, mode: { ...m, text: [...m.text].slice(0, -1).join('') } });
    if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
      const text = (m.text + input).replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
      return done({ ...state, mode: { ...m, text: text.slice(0, 300) } });
    }
    return done(state);
  }
  if (key.return) {
    const popup = state.popup?.key === `q:${m.question}` || state.popup?.key === `a:${m.question}` ? null : state.popup;
    return done(say({ ...state, mode: null, popup }, `Recording ${m.answer}: ${m.headline}…`), [
      { type: 'answer', question: m.question, answer: m.answer, note: m.text || null, overrule: m.action === 'overrule', headline: m.headline },
    ]);
  }
  return done(say(state, 'Enter to confirm, Esc to cancel.'));
}

function summaryKeys(state, input, key, ctx) {
  const p = state.popup;
  const row = rowByKey(ctx, p.key);
  const page = Math.max(1, ctx.popupPage ?? 10);
  const max = Math.max(0, ctx.popupMax ?? 0);
  if (key.escape || input === 's') return done({ ...state, popup: null });
  if (['1', '2', '3'].includes(input)) return done({ ...state, popup: { ...p, tab: Number(input) - 1, scroll: 0 } });
  const nav = navKey(input, key, page);
  if (nav) return done({ ...state, popup: { ...p, scroll: Math.min(max, Math.max(0, nav(p.scroll, max))) } });
  if (key.return || input === 'f') return row?.kind === 'session' ? goTo(state, row) : done(say(state, 'A question has no session to go to; y or n answers it.', 'warn'));
  if (input === 'o') return done(state, [{ type: 'open', key: p.key, tab: p.tab }]);
  if (input === 'y') return ask(state, row, 'approve');
  if (input === 'n') return ask(state, row, 'decline') ?? done(say(state, 'Nothing to decline here.', 'warn'));
  if (input === 'q') return done(say(state, 'q quits from the list; press Esc first.'));
  if (input === '?') return done({ ...state, help: true });
  return done(state);
}

function listPopupKeys(state, input, key, ctx, count, pick) {
  const p = state.popup;
  if (key.escape || (p.kind === 'scope' && input === '/') || (p.kind === 'menu' && input === 'm')) return done({ ...state, popup: null });
  const nav = navKey(input, key, 5);
  if (nav) return done({ ...state, popup: { ...p, index: Math.min(count - 1, Math.max(0, nav(p.index, count - 1))) } });
  if (key.return) return pick(state, ctx, p.index);
  return null;
}

export function reduce(state, input, key = {}, ctx = { rows: [] }) {
  if (state.mode) return modeKeys(state, input, key);

  if (state.help) {
    if (key.escape || input === '?' || input === 'q') return done({ ...state, help: false });
    return done(state);
  }

  const p = state.popup;
  if (p?.kind === 'summary') return summaryKeys(state, input, key, ctx);
  if (p?.kind === 'menu') {
    const row = rowByKey(ctx, p.key);
    const items = menuItems(row);
    const r = listPopupKeys(state, input, key, ctx, items.length, pickMenu);
    if (r) return r;
    const byHint = items.findIndex((i) => i.hint === input);
    return byHint >= 0 ? pickMenu(state, ctx, byHint) : done(state);
  }
  if (p?.kind === 'scope') {
    return listPopupKeys(state, input, key, ctx, ctx.scopeItems?.length ?? 0, pickScope) ?? done(state);
  }

  if (key.escape) {
    if (state.view === 'history') return done(toHistory(state, ctx, false));
    return done(state.message ? say(state, '') : state);
  }

  const nav = navKey(input, key, Math.max(1, ctx.listPage ?? 10));
  if (nav) return done(move(state, ctx, nav));

  const row = rowByKey(ctx, cursorKey(state));
  if (key.return) return activate(state, row);
  if (key.tab) return done(say(state, LAUNCH_LATER));
  switch (input) {
    case 'f':
      return goTo(state, row);
    case 's':
      return row ? done(summary(state, row.key)) : done(say(state, 'Nothing selected.', 'warn'));
    case 'm':
      if (!row) return done(say(state, 'Nothing selected.', 'warn'));
      return done({ ...state, popup: { kind: 'menu', key: row.key, index: 0, x: 4, y: ctx.lineOf?.(row.key) ?? 2 } });
    case 'y':
      return ask(state, row, 'approve');
    case 'n':
      return ask(state, row, 'decline') ?? done(say(state, LAUNCH_LATER));
    case 'h':
      return done(toHistory(state, ctx, state.view !== 'history'));
    case '/': {
      const items = ctx.scopeItems ?? [];
      const at = items.findIndex((i) => i.repo === state.scope.repo && i.view === state.scope.view);
      return done({ ...state, popup: { kind: 'scope', index: Math.max(0, at) } });
    }
    case '!':
      return done(toggleView(state, 'needs'));
    case 'w':
      return done(toggleView(state, 'working'));
    case 'o':
      if (!row) return done(say(state, 'Nothing selected.', 'warn'));
      return done(state, [{ type: 'open', key: row.key, tab: null }]);
    case '?':
      return done({ ...state, help: true });
    case 'q':
      return done(state, [{ type: 'quit' }]);
    case 'r':
      return done(say(state, 'Reloading…'), [{ type: 'reload' }]);
    case 'p':
      if ((ctx.projectCount ?? 1) < 2) return done(say(state, 'Only one project is configured.'));
      return done(say(state, 'Switching project…'), [{ type: 'project' }]);
    default:
      return done(state);
  }
}

export function reduceMouse(state, event, ctx = { rows: [] }) {
  if (!event?.press || event.button === 'motion' || event.button === 'middle' || event.button === 'none') return done(state);
  const p = state.popup;
  if (event.button === 'wheelUp' || event.button === 'wheelDown') {
    const step = event.button === 'wheelUp' ? -WHEEL : WHEEL;
    if (p?.kind === 'summary') {
      const max = Math.max(0, ctx.popupMax ?? 0);
      return done({ ...state, popup: { ...p, scroll: Math.min(max, Math.max(0, p.scroll + step)) } });
    }
    if (p || state.help) return done(state);
    return done({ ...state, listOffset: Math.max(0, (state.listOffset ?? 0) + step), follow: false });
  }
  if (state.mode) return done(say(state, 'Enter to confirm, Esc to cancel.'));
  if (state.help) return done({ ...state, help: false });

  const target = ctx.hitAt?.(event.x, event.y) ?? null;
  const left = event.button === 'left';
  if (p) {
    if (left && p.kind === 'menu' && target?.type === 'menu') return pickMenu(state, ctx, target.index);
    if (left && p.kind === 'scope' && target?.type === 'scope') return pickScope(state, ctx, target.index);
    if (left && p.kind === 'summary' && target?.type === 'tab') return done({ ...state, popup: { ...p, tab: target.tab, scroll: 0 } });
    if (target?.type === 'popup' || (target && target.type !== 'row' && target.type !== 'scope')) return done(state);
    return done({ ...state, popup: null });
  }
  if (target?.type === 'scope') return left ? pickScope(state, ctx, target.index) : done(state);
  if (target?.type !== 'row') return done(state);
  const row = rowByKey(ctx, target.key);
  if (!row) return done(state);
  const selected = { ...withCursor(state, row.key), follow: true, message: '' };
  if (left) return activate(selected, row);
  return done({ ...selected, popup: { kind: 'menu', key: row.key, index: 0, x: event.x, y: event.y } });
}
