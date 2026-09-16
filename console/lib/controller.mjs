// Keys to state changes and effects. Pure: reduce(state, input, key, ctx) returns
// { state, effects }. The app performs effects (quit, answer, open, focus, reload,
// project) and never decides anything itself.
//
// ctx: { rows, listPage, readerPage, readerMax, projectCount }

export function initialState() {
  return {
    focus: 'list',
    tab: 0,
    expanded: false,
    readerScroll: 0,
    listOffset: 0,
    selectedKey: null,
    help: false,
    mode: null, // { kind: 'reason' | 'confirm', action, answer, question, headline, text }
    message: '',
    messageStyle: 'status',
  };
}

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

function say(state, message, style = 'status') {
  return { ...state, message, messageStyle: style };
}

function move(state, ctx, to) {
  const keys = ctx.rows.map((r) => r.key);
  if (!keys.length) return state;
  const at = Math.max(0, keys.indexOf(state.selectedKey));
  const next = Math.min(keys.length - 1, Math.max(0, to(at, keys.length)));
  if (keys[next] === state.selectedKey) return state;
  return { ...state, selectedKey: keys[next], readerScroll: 0, message: '' };
}

function scroll(state, ctx, to) {
  const max = ctx.readerMax ?? 0;
  return { ...state, readerScroll: Math.min(max, Math.max(0, to(state.readerScroll, max))) };
}

// Navigation keys shared by the list and the reader.
function navigate(state, input, key, ctx) {
  const inReader = state.focus === 'reader' || state.expanded;
  const page = Math.max(1, (inReader ? ctx.readerPage : ctx.listPage) ?? 10);
  const go = inReader ? (fn) => scroll(state, ctx, fn) : (fn) => move(state, ctx, fn);
  if (key.downArrow || input === 'j') return go((at) => at + 1);
  if (key.upArrow || input === 'k') return go((at) => at - 1);
  if (key.pageDown) return go((at) => at + page);
  if (key.pageUp) return go((at) => at - page);
  if (key.home) return go(() => 0);
  if (key.end) return go((_, n) => (inReader ? n : n - 1));
  return null;
}

function selected(state, ctx) {
  return ctx.rows.find((r) => r.key === state.selectedKey) ?? null;
}

function modeKeys(state, input, key) {
  const m = state.mode;
  if (key.escape) return { state: say({ ...state, mode: null }, 'Cancelled; nothing was recorded.'), effects: [] };
  if (m.kind === 'reason') {
    if (key.return) {
      if (!m.text.trim()) return { state: say(state, 'A reason is required (one line).', 'warn'), effects: [] };
      return { state: say({ ...state, mode: { ...m, kind: 'confirm', text: m.text.trim() } }, ''), effects: [] };
    }
    if (key.backspace || key.delete) return { state: { ...state, mode: { ...m, text: [...m.text].slice(0, -1).join('') } }, effects: [] };
    if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
      const text = (m.text + input).replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
      return { state: { ...state, mode: { ...m, text: text.slice(0, 300) } }, effects: [] };
    }
    return { state, effects: [] };
  }
  if (key.return) {
    const answer = m.answer;
    return {
      state: say({ ...state, mode: null }, `Recording ${answer}: ${m.headline}…`),
      effects: [{ type: 'answer', question: m.question, answer, note: m.text || null, overrule: m.action === 'overrule', headline: m.headline }],
    };
  }
  return { state: say(state, 'Enter to confirm, Esc to cancel.'), effects: [] };
}

export function reduce(state, input, key = {}, ctx = { rows: [] }) {
  const done = (s, effects = []) => ({ state: s, effects });
  if (state.mode) return modeKeys(state, input, key);

  if (state.help) {
    if (key.escape || input === '?' || input === 'q') return done({ ...state, help: false });
    return done(state);
  }

  if (key.escape) {
    if (state.expanded) return done({ ...state, expanded: false });
    if (state.focus === 'reader') return done({ ...state, focus: 'list' });
    if (state.message) return done(say(state, ''));
    return done(state);
  }

  const nav = navigate(state, input, key, ctx);
  if (nav) return done(nav);

  const row = selected(state, ctx);
  if (key.tab) return done({ ...state, focus: state.focus === 'list' ? 'reader' : 'list' });
  if (key.return) return done({ ...state, expanded: !state.expanded, readerScroll: 0 });
  if (['1', '2', '3'].includes(input)) return done({ ...state, tab: Number(input) - 1, readerScroll: 0 });
  if (input === '?') return done({ ...state, help: true });
  if (input === 'q') {
    if (state.focus === 'list' && !state.expanded) return done(state, [{ type: 'quit' }]);
    return done(say(state, 'q quits from the list; press Esc first.'));
  }
  if (input === 'r') return done(say(state, 'Reloading…'), [{ type: 'reload' }]);
  if (input === 'p') {
    if ((ctx.projectCount ?? 1) < 2) return done(say(state, 'Only one project is configured.'));
    return done(say(state, 'Switching project…'), [{ type: 'project' }]);
  }
  if (input === 'y') {
    if (!row?.actions.includes('approve')) return done(say(state, 'Nothing to approve here: select a question under Waiting on you.', 'warn'));
    return done(say({ ...state, mode: { kind: 'confirm', action: 'approve', answer: 'yes', question: row.question, headline: row.headline, text: '' } }, ''));
  }
  if (input === 'n') {
    const action = row?.actions.includes('decline') ? 'decline' : row?.actions.includes('overrule') ? 'overrule' : null;
    if (!action) return done(say(state, 'Nothing to decline here.', 'warn'));
    const answer = action === 'overrule' ? overruleAnswer(row.data?.answer) : 'no';
    return done(say({ ...state, mode: { kind: 'reason', action, answer, question: row.question, headline: row.headline, text: '' } }, ''));
  }
  if (input === 'o') {
    if (!row?.doc?.path && !row?.doc?.text) return done(say(state, `No document to open: ${row?.doc?.missing ?? 'nothing selected'}.`, 'warn'));
    return done(state, [{ type: 'open', row: row.key, path: row.doc.path ?? null, text: row.doc.text ?? null }]);
  }
  if (input === 'f') {
    if (!row?.agent) return done(say(state, 'No agent for this row.', 'warn'));
    return done(state, [{ type: 'focus', agent: row.agent }]);
  }
  return done(state);
}
