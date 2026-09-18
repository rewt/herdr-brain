// Keys and clicks to state changes and effects. Pure: reduce(state, input, key, ctx)
// and reduceMouse(state, event, ctx) return { state, effects }. The session performs
// the effects (quit, answer, act, open, go, reload, project) and never decides anything.
//
// ctx: { rows, scopeItems, listPage, popupPage, popupMax, projectCount, menuX, popupMode,
//        lineOf(key) → screen line, hitAt(x, y) → target }
// rows are the rows of the current view in screen order; a target is
// { type: 'row', key } | { type: 'option', key, option } | { type: 'menu', index } |
// { type: 'scope', index } | { type: 'tab', tab } | { type: 'popup' } | null.
//
// Acting on what a session left behind (a 'result' row) is one `act` effect:
//   { type: 'act', verb: 'pick' | 'send' | 'later' | 'drop' | 'dispatch', key, option?, text? }
// Every verb that reaches into a session or cannot be taken back is confirmed first.

export function initialState() {
  return {
    view: 'list', // 'list' | 'history'
    selectedKey: null,
    historyKey: null,
    listOffset: 0,
    follow: true, // keep the selection in view; the wheel turns this off
    popup: null, // { kind: 'summary', key, tab, scroll } | { kind: 'peek', key, scroll, follow } | { kind: 'menu', key, index, x, y } | { kind: 'scope', index }
    help: false,
    mode: null, // { kind: 'reason' | 'confirm', action, answer, question, headline, text } | { kind: 'reply' | 'act', ... }
    unfolded: [], // folds inside Waiting on you that are open: 'later', 'stages'
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
  if (m.kind === 'reply') {
    return { head: `Reply to ${m.session}: `, title: '', mid: '', reason: m.text, keep: 'end', tail: '▏  Enter send · Esc cancel' };
  }
  if (m.kind === 'instruct') {
    return { head: `Instruction to ${m.project ?? 'the project'}: `, title: '', mid: '', reason: m.text, keep: 'end', tail: '▏  Enter records it · Esc cancel' };
  }
  if (m.kind === 'act') return actParts(m);
  if (m.kind === 'reason') {
    return { head: `${verb(m)} “`, title: m.headline, mid: '”. Reason: ', reason: m.text, keep: 'end', tail: '▏  Enter next · Esc cancel' };
  }
  const question = /[?？]$/.test(m.headline) ? m.headline : `${m.headline}?`;
  return m.text
    ? { head: `${verb(m)}: `, title: question, mid: ' (reason: ', reason: m.text, keep: 'start', tail: ') Enter to confirm, Esc to cancel' }
    : { head: `${verb(m)}: `, title: question, mid: '', reason: '', keep: 'start', tail: ' Enter to confirm, Esc to cancel' };
}

function actParts(m) {
  const confirm = ' Enter to confirm, Esc to cancel';
  switch (m.verb) {
    case 'pick':
      if (m.via === 'answer') return { head: 'Record the answer “', title: m.label, mid: '”?', reason: '', keep: 'start', tail: ' The next pass acts on it. Enter to confirm, Esc to cancel' };
      if (m.via === 'key') return { head: `Press ${m.option} in ${m.session} (“`, title: m.label, mid: '”)?', reason: '', keep: 'start', tail: confirm };
      return { head: `Send to ${m.session}: “`, title: m.text, mid: '”', reason: '', keep: 'start', tail: '  Enter send · e edit · Esc cancel' };
    case 'send':
      return { head: `Send ${m.draft ? 'Claude’s draft ' : ''}to ${m.session}: “`, title: m.text, mid: '”', reason: '', keep: 'start', tail: '  Enter send · e edit · Esc cancel' };
    case 'drop':
      return m.report
        ? { head: 'Clear “', title: m.headline, mid: '” from the list?', reason: '', keep: 'start', tail: confirm }
        : { head: 'Drop “', title: m.headline, mid: '” for good? It will not come back.', reason: '', keep: 'start', tail: confirm };
    case 'dispatch':
      return { head: 'Start a session to work out “', title: m.headline, mid: '”? It comes back here with the choices.', reason: '', keep: 'start', tail: confirm };
    default:
      return { head: `${m.verb} “`, title: m.headline ?? '', mid: '”?', reason: '', keep: 'start', tail: confirm };
  }
}

export function promptText(state) {
  const p = promptParts(state);
  return p && `${p.head}${p.title}${p.mid}${p.reason}${p.tail}`;
}

// The row menu (right click or m).
export function menuItems(row) {
  if (!row) return [];
  const has = (a) => row.actions?.includes(a);
  const items = [];
  if (row.kind === 'fold') return [{ label: row.open ? 'Hide them' : 'Show them', hint: 'Enter', action: 'fold' }];
  if (has('peek')) items.push({ label: 'Peek at its screen', hint: 'Enter', action: 'peek' });
  if (row.kind === 'result') {
    for (const o of (row.options ?? []).slice(0, 9)) items.push({ label: `${o.key}  ${o.label}`, hint: o.key, action: 'pick', option: o.key });
    if (has('draft')) items.push({ label: 'Send Claude’s draft', hint: 'y', action: 'draft' });
  }
  if (has('reply')) items.push({ label: 'Reply in your words', hint: 'r', action: 'reply' });
  if (has('go')) items.push({ label: 'Go to session', hint: 'g', action: 'go' });
  items.push({ label: 'Summary', hint: 's', action: 'summary' });
  if (has('approve')) items.push({ label: 'Approve', hint: 'y', action: 'approve' });
  if (has('decline')) items.push({ label: 'Decline', hint: 'n', action: 'decline' });
  if (has('dispatch')) items.push({ label: 'Have a session work it out', hint: 'd', action: 'dispatch' });
  if (has('overrule')) items.push({ label: 'Overrule', hint: 'n', action: 'overrule' });
  if (has('later')) items.push({ label: 'Save for later', hint: 'l', action: 'later' });
  if (has('drop')) items.push({ label: ['finished', 'report'].includes(row.category) ? 'Clear, I have read it' : 'Drop it', hint: 'x', action: 'drop' });
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

// A session row always asks: the session says why it cannot go (gone, Herdr down).
function goTo(state, row) {
  if (row?.kind === 'session' || row?.actions?.includes('go')) return done(state, [{ type: 'go', key: row.key }]);
  const why = row?.kind === 'question' ? 'A question has no session to go to; y or n answers it.'
    : row?.kind === 'result' ? 'That session is no longer in Herdr; there is nothing to go to.'
      : 'Nothing to go to here.';
  return done(say(state, why, 'warn'));
}

function peek(state, row) {
  return { ...state, popup: { kind: 'peek', key: row.key, scroll: 0, follow: true }, message: '' };
}

function toggleFold(state, row) {
  const open = state.unfolded ?? [];
  const unfolded = open.includes(row.fold) ? open.filter((f) => f !== row.fold) : [...open, row.fold];
  return { ...state, unfolded, follow: true, message: '' };
}

// Enter or a left click on a row: a session is peeked at without leaving the
// console; a question opens its summary; a fold opens or closes.
function activate(state, row) {
  if (!row) return done(state);
  if (row.kind === 'fold') return done(toggleFold(state, row));
  if (row.actions?.includes('peek')) return done(peek(state, row));
  return done(summary(state, row.key));
}

const isReport = (row) => ['finished', 'report'].includes(row?.category);

// The verbs on what a session left behind. Each returns null when it does not
// apply to the row, so the caller can fall back to what the key meant before.
function pick(state, row, option) {
  if (row?.kind !== 'result' && row?.kind !== 'question') return null;
  if (row.kind === 'question') {
    if (option === 'y') return ask(state, row, 'approve');
    if (option === 'n') return ask(state, row, 'decline');
    if (row.via !== 'answer') return done(say(state, 'This question is answered with y or n.', 'warn'));
  }
  const o = row.options?.find((x) => x.key === String(option));
  if (!o) {
    const keys = (row.options ?? []).map((x) => x.key);
    return done(say(state, keys.length ? `Pick ${keys.join(', ')}.` : 'No choices were worked out for this one; r replies in your own words.', 'warn'));
  }
  const mode = { kind: 'act', verb: 'pick', key: row.key, option: o.key, label: o.label, via: row.via, session: row.session, headline: row.headline, text: o.label };
  return done(say({ ...state, mode }, ''));
}

function sendDraft(state, row) {
  if (!row?.suggestion) return null;
  return done(say({ ...state, mode: { kind: 'act', verb: 'send', draft: true, key: row.key, session: row.session, headline: row.headline, text: row.suggestion } }, ''));
}

function reply(state, row, text = '') {
  if (!row?.actions?.includes('reply')) {
    return done(say(state, row?.kind === 'result' ? 'That session is no longer in Herdr, so nothing can be sent to it.' : 'Nothing to reply to here.', 'warn'));
  }
  return done(say({ ...state, mode: { kind: 'reply', key: row.key, session: row.session, text } }, ''));
}

function later(state, row) {
  if (!row?.actions?.includes('later')) return done(say(state, row?.later ? 'It is already saved for later.' : 'Only what a session left behind can be saved for later.', 'warn'));
  return done(say(state, `Saving for later: ${row.headline}…`), [{ type: 'act', verb: 'later', key: row.key }]);
}

function drop(state, row) {
  if (!row?.actions?.includes('drop')) return done(say(state, 'Only what a session left behind can be dropped from here.', 'warn'));
  return done(say({ ...state, mode: { kind: 'act', verb: 'drop', key: row.key, report: isReport(row), session: row.session, headline: row.headline } }, ''));
}

function dispatch(state, row) {
  if (!row?.actions?.includes('dispatch')) return done(say(state, 'Only a question can be sent off to be worked out.', 'warn'));
  return done(say({ ...state, mode: { kind: 'act', verb: 'dispatch', key: row.key, headline: row.headline } }, ''));
}

// y on a result: Claude's draft when there is one, else the recommended choice.
function accept(state, row) {
  if (row?.kind !== 'result') return null;
  if (row.suggestion) return sendDraft(state, row);
  if (row.recommendKey) return pick(state, row, row.recommendKey);
  return done(say(state, row.options?.length ? 'Nothing is recommended; pick a number.' : 'Nothing to accept here; r replies, x clears it.', 'warn'));
}

// n on a result: the choice that says no, when there is exactly one.
function refuse(state, row) {
  if (row?.kind !== 'result') return null;
  const no = (row.options ?? []).filter((o) => /^no\b/i.test(o.label.trim()));
  if (no.length === 1) return pick(state, row, no[0].key);
  return done(say(state, 'Pick a number, or r to reply in your own words.', 'warn'));
}

// The keys that act on a row, shared by the list and the peek.
function rowVerb(state, row, input) {
  if (/^[1-9]$/.test(input)) return row?.kind === 'result' || (row?.kind === 'question' && row.via === 'answer') ? pick(state, row, input) : null;
  switch (input) {
    case 'g':
      return goTo(state, row);
    case 'r':
      return row?.kind === 'result' || row?.kind === 'session' ? reply(state, row) : null;
    case 'l':
      return row?.kind === 'result' ? later(state, row) : null;
    case 'x':
      return row?.kind === 'result' ? drop(state, row) : null;
    case 'd':
      return row?.kind === 'question' ? dispatch(state, row) : null;
    case 'y':
      return accept(state, row);
    case 'n':
      return refuse(state, row);
    default:
      return null;
  }
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
  switch (item.action) {
    case 'go': return goTo(closed, row);
    case 'summary': return done(summary(closed, row.key));
    case 'peek': return done(peek(closed, row));
    case 'fold': return done(toggleFold(closed, row));
    case 'pick': return pick(closed, row, item.option) ?? done(closed);
    case 'draft': return sendDraft(closed, row) ?? done(closed);
    case 'reply': return reply(closed, row);
    case 'later': return later(closed, row);
    case 'drop': return drop(closed, row);
    case 'dispatch': return dispatch(closed, row);
    default: return ask(closed, row, item.action) ?? done(closed);
  }
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

function typed(text, input, key, max) {
  if (key.backspace || key.delete) return [...text].slice(0, -1).join('');
  if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
    return (text + input).replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').slice(0, max);
  }
  return null;
}

function modeKeys(state, input, key) {
  const m = state.mode;
  if (m.kind === 'reply') {
    if (key.escape) return done(say({ ...state, mode: null }, 'Cancelled; nothing was sent.'));
    if (key.return) {
      if (!m.text.trim()) return done(say(state, 'Type the reply first, or Esc to cancel.', 'warn'));
      return done(say({ ...state, mode: null }, `Sending to ${m.session}…`), [{ type: 'act', verb: 'send', key: m.key, text: m.text.trim() }]);
    }
    const text = typed(m.text, input, key, 2000);
    return done(text === null ? state : { ...state, mode: { ...m, text } });
  }
  if (m.kind === 'instruct') {
    if (key.escape) return done(say({ ...state, mode: null }, 'Cancelled; nothing was recorded.'));
    if (key.return) {
      if (!m.text.trim()) return done(say(state, 'Type the instruction first, or Esc to cancel.', 'warn'));
      return done(say({ ...state, mode: null }, 'Recording the instruction…'), [{ type: 'instruct', text: m.text.trim() }]);
    }
    const text = typed(m.text, input, key, 2000);
    return done(text === null ? state : { ...state, mode: { ...m, text } });
  }
  if (m.kind === 'act') {
    if (key.escape) return done(say({ ...state, mode: null }, m.verb === 'drop' || m.verb === 'dispatch' ? 'Cancelled; nothing changed.' : 'Cancelled; nothing was sent.'));
    if (key.return) {
      const effect = { type: 'act', verb: m.verb, key: m.key };
      if (m.verb === 'pick') effect.option = m.option;
      if (m.verb === 'send') effect.text = m.text;
      const busy = { pick: m.via === 'key' ? `Pressing ${m.option} in ${m.session}…` : `Sending to ${m.session}…`, send: `Sending to ${m.session}…`, drop: 'Updating the list…', dispatch: 'Starting a session…' };
      return done(say({ ...state, mode: null, popup: m.verb === 'drop' ? null : state.popup }, busy[m.verb] ?? ''), [effect]);
    }
    // e turns a proposed message into a reply to edit before sending.
    if (input === 'e' && (m.verb === 'send' || (m.verb === 'pick' && m.via !== 'key'))) {
      return done(say({ ...state, mode: { kind: 'reply', key: m.key, session: m.session, text: m.text } }, ''));
    }
    return done(say(state, 'Enter to confirm, Esc to cancel.'));
  }
  if (key.escape) return done(say({ ...state, mode: null }, 'Cancelled; nothing was recorded.'));
  if (m.kind === 'reason') {
    if (key.return) {
      if (!m.text.trim()) return done(say(state, 'A reason is required (one line).', 'warn'));
      return done(say({ ...state, mode: { ...m, kind: 'confirm', text: m.text.trim() } }, ''));
    }
    const text = typed(m.text, input, key, 300);
    return done(text === null ? state : { ...state, mode: { ...m, text } });
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
  if (key.return) return row?.actions?.includes('peek') ? done(peek({ ...state, popup: null }, row)) : goTo(state, row);
  if (input === 'f') return goTo(state, row);
  if (input === 'o') return done(state, [{ type: 'open', key: p.key, tab: p.tab }]);
  if (input === 'y' && row?.kind !== 'result') return ask(state, row, 'approve');
  if (input === 'n' && row?.kind !== 'result') return ask(state, row, 'decline') ?? done(say(state, 'Nothing to decline here.', 'warn'));
  const verb = rowVerb(state, row, input);
  if (verb) return verb;
  if (input === 'q') return done(say(state, 'q quits from the list; press Esc first.'));
  if (input === '?') return done({ ...state, help: true });
  return done(state);
}

// The peek: a session's own screen inside the console. It follows the end
// until the operator scrolls up; End or G follows again. Esc comes back to
// the list with the same row selected.
function peekKeys(state, input, key, ctx) {
  const p = state.popup;
  const row = rowByKey(ctx, p.key);
  const page = Math.max(1, ctx.popupPage ?? 10);
  const max = Math.max(0, ctx.popupMax ?? 0);
  if (key.escape) return done({ ...state, popup: null });
  if (key.end || input === 'G') return done({ ...state, popup: { ...p, scroll: max, follow: true } });
  const at = p.follow ? max : p.scroll;
  const nav = key.home ? () => 0 : navKey(input, key, page);
  if (nav) {
    const scroll = Math.min(max, Math.max(0, nav(at, max)));
    return done({ ...state, popup: { ...p, scroll, follow: scroll >= max } });
  }
  if (input === 's') return done(summary({ ...state, popup: null }, p.key));
  if (input === 'q') return done(say(state, 'q quits from the list; Esc goes back to it.'));
  if (input === '?') return done({ ...state, help: true });
  const verb = rowVerb(state, row, input);
  if (verb) return verb;
  if (key.return) return goTo(state, row);
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
  if (p?.kind === 'peek') return peekKeys(state, input, key, ctx);
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
    // Summoned as a Herdr popup, Esc on the list closes it, back to the pane below.
    if (ctx.popupMode) return done(state, [{ type: 'quit' }]);
    return done(state.message ? say(state, '') : state);
  }

  const nav = navKey(input, key, Math.max(1, ctx.listPage ?? 10));
  if (nav) return done(move(state, ctx, nav));

  const row = rowByKey(ctx, cursorKey(state));
  if (key.return) return activate(state, row);
  if (key.tab) return done(say(state, LAUNCH_LATER));
  if (state.view !== 'history') {
    const verb = rowVerb(state, row, input);
    if (verb) return verb;
  }
  switch (input) {
    case 'f':
      return goTo(state, row);
    case 's':
      return row ? done(summary(state, row.key)) : done(say(state, 'Nothing selected.', 'warn'));
    case 'm':
      if (!row) return done(say(state, 'Nothing selected.', 'warn'));
      return done({ ...state, popup: { kind: 'menu', key: row.key, index: 0, x: ctx.menuX ?? 4, y: ctx.lineOf?.(row.key) ?? 2 } });
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
    case 'i':
      return done(say({ ...state, mode: { kind: 'instruct', project: ctx.projectName ?? null, text: '' } }, ''));
    case '?':
      return done({ ...state, help: true });
    case 'q':
      return done(state, [{ type: 'quit' }]);
    case 'R':
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
    if (p?.kind === 'peek') {
      const max = Math.max(0, ctx.popupMax ?? 0);
      const scroll = Math.min(max, Math.max(0, (p.follow ? max : p.scroll) + step));
      return done({ ...state, popup: { ...p, scroll, follow: scroll >= max } });
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
  if (target?.type === 'option') {
    const row = rowByKey(ctx, target.key);
    if (!row) return done(state);
    const selected = { ...withCursor(state, row.key), follow: true, message: '' };
    return left ? pick(selected, row, target.option) ?? done(selected) : done({ ...selected, popup: { kind: 'menu', key: row.key, index: 0, x: event.x, y: event.y } });
  }
  if (target?.type !== 'row') return done(state);
  const row = rowByKey(ctx, target.key);
  if (!row) return done(state);
  const selected = { ...withCursor(state, row.key), follow: true, message: '' };
  if (left) return activate(selected, row);
  return done({ ...selected, popup: { kind: 'menu', key: row.key, index: 0, x: event.x, y: event.y } });
}
