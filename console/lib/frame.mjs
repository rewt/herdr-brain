// The whole screen as lines of coloured spans:
//   renderFrame(view, cols, rows[, { termRows }]) → { lines, listOffset, popupMax, hits }
// Each line is { spans: [{ text, fg, bg, bold }] } and exactly `cols` cells wide, with
// a background on every cell; fg and bg are palette tokens (theme.mjs) the app turns
// into colours. hits[y] lists { from, to, target } for mouse clicks. Nothing here
// depends on Ink, so the layout is tested at any size.
import { menuItems } from './controller.mjs';
import { renderMarkdown } from './markdown.mjs';
import { contextPairs, hhmm, sessionContext, summaryParagraphs } from './model.mjs';
import { asciiFold, glyphsFor } from './theme.mjs';
import { cellWidth, charWidth, clip, clipStart, pad, sanitize, wrap } from './text.mjs';

export const MIN_COLS = 80;
export const MIN_ROWS = 20;
export const RAIL_COLS = 180;
const RAIL_WIDTH = 22;

export const TAB_NAMES = {
  question: ['Summary', 'Memo', 'Context'],
  result: ['Summary', 'Screen', 'Details'],
  session: ['Message', 'Brief', 'Context'],
  other: ['Summary', 'Document', 'Context'],
};

export function tabNames(row) {
  return TAB_NAMES[row?.kind] ?? TAB_NAMES.other;
}

// ---- spans ----------------------------------------------------------------

const span = (text, fg = 'fg', bg = 'bg', bold = false) => ({ text, fg, bg, bold });

export function lineText(line) {
  return line.spans.map((s) => s.text).join('');
}

function spansWidth(spans) {
  return spans.reduce((w, s) => w + cellWidth(s.text), 0);
}

// The cells [from, to) of a span list; a wide character cut in half becomes spaces.
export function cutSpans(spans, from, to) {
  const out = [];
  let x = 0;
  for (const s of spans) {
    let text = '';
    for (const ch of s.text) {
      const w = charWidth(ch);
      if (x >= from && x + w <= to) text += ch;
      else if (x < to && x + w > from) text += ' '.repeat(Math.min(x + w, to) - Math.max(x, from));
      x += w;
    }
    if (text) out.push({ ...s, text });
  }
  return out;
}

function fit(spans, cols, bg = 'bg') {
  const cut = spansWidth(spans) > cols ? cutSpans(spans, 0, cols) : spans;
  const w = spansWidth(cut);
  return w < cols ? [...cut, span(' '.repeat(cols - w), 'fg', bg)] : cut;
}

function line(spans, cols, bg = 'bg') {
  return { spans: fit(spans, cols, bg) };
}

const blank = (cols) => line([], cols);

// ---- layout ---------------------------------------------------------------

// Column widths for a main area `width` cells wide. `doing` takes what is left.
export function layoutFor(width) {
  if (width >= 140) return { kind: 'wide', mark: 3, session: 26, who: 22, where: 18, up: 7, state: 9, doing: width - 93 };
  if (width >= 100) return { kind: 'medium', mark: 3, session: 22, who: 22, where: 0, up: 7, state: 9, doing: width - 70 };
  return { kind: 'narrow', mark: 2, session: width - 35, who: 20, where: 0, up: 0, state: 9, doing: width - 4 };
}

// Moves the window only as far as needed to keep lines [first, last] in view.
export function scrollWindow(offset, first, height, total, last = first) {
  let o = Math.min(Math.max(0, offset ?? 0), Math.max(0, total - height));
  if (first < 0) return o;
  const top = Math.max(0, first - 1);
  if (top < o) o = top;
  if (last >= o + height) o = last - height + 1;
  return o;
}

// ---- pieces ---------------------------------------------------------------

function segmentRow(left, right, cols, G) {
  const draw = (segs, rightSegs) => {
    const out = [];
    segs.forEach((s, i) => {
      out.push(span(` ${s.icon ?? ''}${s.text} `, s.fg ?? 'fg', s.bg, s.bold));
      out.push(span(G.right, s.bg, segs[i + 1]?.bg ?? 'bg'));
    });
    const tail = [];
    rightSegs.forEach((s, i) => {
      tail.push(span(G.left, s.bg, i ? rightSegs[i - 1].bg : 'bg'));
      tail.push(span(` ${s.text} `, s.fg ?? 'fg', s.bg, s.bold));
    });
    const gap = cols - spansWidth(out) - spansWidth(tail);
    return gap < 0 ? null : [...out, span(' '.repeat(gap)), ...tail];
  };
  let l = left.map((s) => ({ ...s }));
  let r = right.map((s) => ({ ...s }));
  for (;;) {
    const drawn = draw(l, r);
    if (drawn) return drawn;
    const long = l.findIndex((s) => s.short !== undefined && s.short !== s.text);
    if (long >= 0) l[long] = { ...l[long], text: l[long].short };
    else if (l.some((s) => s.icon)) l = l.map((s) => ({ ...s, icon: '' }));
    else if (r.length > 1) r = r.slice(1);
    else if (l.length > 1) l = l.slice(0, -1);
    else return cutSpans(draw(l, []) ?? [span(l[0].text, 'fg', l[0].bg)], 0, cols);
  }
}

function headerSegments(view, G) {
  const h = view.header ?? {};
  const alert = (text, short) => ({ text, short, bg: 'segAlert', fg: 'ink', bold: true });
  const left = [
    { icon: G.repo, text: h.project ?? 'no project', bg: 'segProject', fg: 'bright', bold: true },
    { icon: G.clock, text: h.clock ?? '--:--', bg: 'segTime' },
  ];
  if (h.sessions) left.push({ icon: G.sessions, text: `${h.sessions} sessions today`, short: h.sessions, bg: 'segCount' });
  else if (h.sessionsNote) left.push(alert(h.sessionsNote, 'ledger?'));
  const waiting = h.waiting ?? 0;
  left.push(waiting
    ? { icon: G.waiting, text: `${waiting} waiting on you`, short: `${waiting} waiting`, bg: 'segAlert', fg: 'ink', bold: true }
    : { text: 'nothing waiting', short: '0 waiting', bg: 'segCount', fg: 'muted' });
  if (h.alerts) left.push({ ...alert(`${h.alerts} alert${h.alerts === 1 ? '' : 's'}`, `${h.alerts}!`), icon: G.alert });
  if (h.stop) left.push({ ...alert('STOP', 'STOP'), icon: G.stop });
  if (h.herdr) left.push(alert(h.herdr, 'Herdr?'));
  if (h.stale) left.push(alert(h.stale, 'stale'));
  if (h.scope) left.push({ text: `scope: ${h.scope}`, short: h.scope, bg: 'segCount', fg: 'waitFg' });
  const right = [
    { text: `console ${view.version ?? ''}`.trim(), bg: 'segCount', fg: 'muted' },
    { text: '? help', bg: 'segHelp' },
  ];
  return { left, right };
}

function capLine(cols, G, { name, path = '', count, icon = '', pillBg = 'pill', pillFg = 'fg', countFg = 'muted' }) {
  const head = [
    span(' '),
    span(G.capLeft, pillBg),
    span(` ${icon}${name} `, pillFg, pillBg, true),
    span(G.capRight, pillBg),
  ];
  const tail = count === undefined ? [span(' ')] : [span(' '), span(G.capLeft, pillBg), span(` ${count} `, countFg, pillBg), span(G.capRight, pillBg), span(' ')];
  const room = cols - spansWidth(head) - spansWidth(tail);
  const where = path && room > 12 ? ` ${clip(path, room - 8)} ` : ' ';
  const rule = Math.max(0, room - cellWidth(where));
  return [...head, span(where, 'muted'), span(G.rule.repeat(rule), 'rule'), ...tail];
}

function stateCell(row, width, G) {
  return pad(`${G[row.state] ?? ''}${row.state}`, width);
}

function whoSpans(who, width, bg) {
  const toolFg = who.tool === 'Claude' ? 'claude' : who.tool === 'Codex' ? 'codex' : 'fg';
  const rest = who.model ? ` ${who.model}` : ' · unknown';
  const effort = who.effort ? ` · ${who.effort}` : '';
  const full = `${who.tool}${rest}${effort}`;
  if (cellWidth(full) > width) return [span(pad(full, width), toolFg, bg)];
  return [
    span(who.tool, toolFg, bg),
    span(rest, who.model ? 'fg' : 'muted', bg),
    span(effort, 'muted', bg),
    span(' '.repeat(width - cellWidth(full)), 'fg', bg),
  ];
}

function sessionLines(row, L, cols, selected, G) {
  const bg = selected ? 'selected' : 'bg';
  const mark = span(pad(selected ? '>' : '', L.mark), 'working', bg, true);
  const gap = span(' ', 'fg', bg);
  if (L.kind === 'narrow') {
    return [
      [span(' ', 'fg', bg), mark, span(pad(row.session, L.session), 'fg', bg), gap, ...whoSpans(row.who, L.who, bg), gap,
        span(stateCell(row, L.state, G), row.state, bg), gap],
      [span('   ', 'fg', bg), span(pad(row.doing, cols - 4), 'muted', bg), gap],
    ];
  }
  const cells = [span(' ', 'fg', bg), mark, gap, span(pad(row.session, L.session), 'fg', bg), gap, ...whoSpans(row.who, L.who, bg), gap];
  if (L.where) cells.push(span(pad(row.where, L.where), 'muted', bg), gap);
  cells.push(span(pad(row.up, L.up), 'fg', bg), gap, span(stateCell(row, L.state, G), row.state, bg), gap,
    span(pad(row.doing, L.doing), 'doing', bg), gap);
  return [cells];
}

function headsLine(L, cols) {
  const cells = [' ', ' '.repeat(L.mark), ' ', pad('SESSION', L.session), ' ', pad('WHO', L.who), ' '];
  if (L.where) cells.push(pad('WHERE', L.where), ' ');
  cells.push(pad('UP', L.up), ' ', pad('STATE', L.state), ' ', 'DOING');
  return line([span(cells.join(''), 'muted')], cols);
}

function recommendText(row) {
  return row.recommend ? `recommend ${row.recommend}` : 'no recommendation';
}

// What a waiting row says on its right: for a question, its category and the
// recommendation; for what a session left behind, what it needs and where from.
function waitingRight(row, L, bg) {
  if (row.kind === 'result') {
    const fg = row.category === 'stranded' || row.category === 'obstacle' ? 'blocked' : row.category === 'decision' ? 'waitFg' : 'done';
    if (L.kind === 'narrow') return [span(clip(row.categoryWords, 14), fg, bg)];
    return [span(row.categoryWords, fg, bg), span(` · ${clip(row.from, 22)} · ${row.asked}`, 'muted', bg)];
  }
  return L.kind === 'narrow'
    ? [span(clip(row.recommend ?? 'no rec.', 12), row.recommend ? 'done' : 'muted', bg)]
    : [span(`${row.category} ${'·'} `, 'muted', bg), span(clip(recommendText(row), 30), row.recommend ? 'done' : 'muted', bg), span(` · asked ${row.asked}`, 'muted', bg)];
}

const MARKS = { result: { stranded: '!', decision: '?', obstacle: '■', finished: '✓', report: '✓' } };

function questionLine(row, L, cols, selected) {
  const bg = selected ? 'selected' : 'bg';
  const glyph = row.kind === 'result' ? MARKS.result[row.category] ?? '!' : '!';
  const markText = L.kind === 'narrow' ? `${selected ? '>' : ' '}${glyph}` : `${selected ? '>' : ' '} ${glyph}`;
  const right = waitingRight(row, L, bg);
  const rightWidth = spansWidth(right);
  const room = cols - 1 - cellWidth(markText) - 1 - 1 - rightWidth - 1;
  return [
    span(' ', 'fg', bg),
    span(markText, 'waitFg', bg, true),
    span(' ', 'fg', bg),
    span(pad(row.headline, room), 'fg', bg),
    span(' ', 'fg', bg),
    ...right,
    span(' ', 'fg', bg),
  ];
}

// The lines under a waiting row: each choice with what it causes, Claude's
// draft, a stranded reply, the next step. The choices are always shown, so
// the operator can decide without opening anything; a click on one picks it.
const MAX_OPTIONS = 4;

function detailLines(row, width, selected) {
  const bg = selected ? 'selected' : 'bg';
  const indent = width >= 100 ? 7 : 5;
  const out = [];
  const add = (spans, hit) => out.push({ spans: fit([span(' '.repeat(indent), 'fg', bg), ...spans], width, bg), key: row.key, hit });
  const options = row.options ?? [];
  const labelWidth = Math.min(34, Math.max(0, ...options.map((o) => cellWidth(o.label))));
  for (const o of options.slice(0, MAX_OPTIONS)) {
    const rec = row.recommendKey === o.key ? '  ← recommended' : '';
    const room = width - indent - 4 - labelWidth - 2 - cellWidth(rec) - 1;
    const causes = width >= 100 && o.causes && room > 12 ? clip(o.causes, room) : '';
    add([
      span(pad(o.key, 3), 'working', bg, true),
      span(' ', 'fg', bg),
      span(pad(o.label, width >= 100 ? labelWidth : Math.max(8, width - indent - 4 - cellWidth(rec) - 1)), 'fg', bg),
      span(causes ? `  ${causes}` : '', 'muted', bg),
      span(rec, 'done', bg),
    ], { type: 'option', key: row.key, option: o.key });
  }
  if (options.length > MAX_OPTIONS) add([span(`…and ${options.length - MAX_OPTIONS} more: s shows them all`, 'muted', bg)]);
  if (row.unsent) add([span('you typed, never sent: ', 'blocked', bg), span(`“${row.unsent.split('\n')[0]}”`, 'fg', bg)]);
  if (row.suggestion) {
    add([span('Claude drafted, not sent: ', 'muted', bg), span(`“${row.suggestion.split('\n')[0]}”`, 'fg', bg), span('   y sends it · r writes your own', 'muted', bg)]);
  }
  if (row.kind === 'result' && !options.length && !row.suggestion && row.nextStep) add([span(`next: ${row.nextStep}`, 'muted', bg)]);
  return out;
}

function foldLine(row, width, selected, G) {
  const bg = selected ? 'selected' : 'bg';
  const tail = row.open ? 'Enter hides them' : 'Enter shows them';
  const room = width - 5 - cellWidth(tail) - 2;
  return [
    span(' ', 'fg', bg),
    span(`${selected ? '>' : ' '} `, 'working', bg, true),
    span(`${row.open ? '▾' : '▸'} `, 'muted', bg),
    span(pad(row.headline, room), 'muted', bg),
    span(` ${tail} `, 'faint', bg),
  ];
}

function historyLine(row, cols, selected) {
  const bg = selected ? 'selected' : 'bg';
  const right = `${row.tag} · ${row.state}`;
  const rightW = Math.min(cellWidth(right), 40);
  const room = cols - 12 - rightW;
  return [
    span(' ', 'fg', bg),
    span(pad(selected ? '>' : '', 2), 'working', bg, true),
    span(`${row.time} `, 'muted', bg),
    span(' ', 'fg', bg),
    span(pad(row.headline, room), 'fg', bg),
    span(' ', 'fg', bg),
    span(pad(right, rightW), 'muted', bg),
    span(' ', 'fg', bg),
  ];
}

// The scrolling body: [{ spans, key }].
function listBody(view, width, G) {
  const st = view.state ?? {};
  const out = [];
  const board = view.board ?? { waiting: [], groups: [], history: [] };
  if (st.view === 'history') {
    out.push({ spans: capLine(width, G, { name: 'HISTORY', path: 'today, newest first', count: board.history.length, icon: G.clock }) });
    for (const row of board.history) out.push({ spans: historyLine(row, width, row.key === st.historyKey), key: row.key });
    if (!board.history.length) out.push({ spans: [span('   Nothing answered, decided or finished today.', 'muted')] });
    return out;
  }
  const L = layoutFor(width);
  if (board.waiting.length) {
    const count = board.waitingCount ?? board.waiting.length;
    out.push({ spans: capLine(width, G, { name: 'WAITING ON YOU', count, icon: G.question, pillBg: 'waitPill', pillFg: 'waitFg', countFg: 'waitFg' }) });
    if (!count) out.push({ spans: [span('   Nothing needs you right now.', 'muted')] });
    for (const row of board.waiting) {
      const selected = row.key === st.selectedKey;
      if (row.kind === 'fold') {
        out.push({ spans: foldLine(row, width, selected, G), key: row.key });
        continue;
      }
      out.push({ spans: questionLine(row, L, width, selected), key: row.key });
      out.push(...detailLines(row, width, selected));
    }
  }
  if (board.groups.length && L.kind !== 'narrow') out.push({ ...headsLine(L, width), key: null });
  for (const g of board.groups) {
    out.push({ spans: capLine(width, G, { name: g.name, path: g.path, count: g.rows.length, icon: G.branch }) });
    for (const row of g.rows) {
      for (const spans of sessionLines(row, L, width, row.key === st.selectedKey, G)) out.push({ spans, key: row.key });
    }
  }
  if (!board.groups.length) {
    const scoped = st.scope && (st.scope.repo || st.scope.view !== 'all');
    const text = view.header?.herdr && !scoped
      ? `No sessions shown: ${view.header.herdr}. Start or reach Herdr, then press r.`
      : scoped ? 'Nothing matches this scope. Press / to choose another, or ! and w to clear a view.' : 'No sessions right now.';
    out.push({ spans: [span(`   ${text}`, 'muted')] });
  }
  return out;
}

function railLines(view, height, G) {
  const items = view.scopeItems ?? [];
  const scope = view.state?.scope ?? { repo: null, view: 'all' };
  const out = [{ spans: [span(' SCOPE', 'muted', 'bg', true)] }];
  items.forEach((item, index) => {
    if (item.key && !items[index - 1]?.key) out.push({ spans: [span(` ${G.rule.repeat(RAIL_WIDTH - 2)}`, 'rule')] });
    const active = item.view === 'history' ? view.state?.view === 'history' : item.repo === scope.repo && item.view === scope.view && view.state?.view !== 'history';
    const bg = active ? 'selected' : 'bg';
    const label = `${item.key ? `${item.key} ` : ''}${item.label}`;
    const count = String(item.count);
    const text = ` ${active ? '>' : ' '}${pad(label, RAIL_WIDTH - 4 - count.length)} ${count}`;
    out.push({ spans: [span(text, active ? 'bright' : item.view === 'needs' && item.count ? 'waitFg' : 'fg', bg, active)], hit: { type: 'scope', index } });
  });
  return out.slice(0, height);
}

function launchLines(view, cols, G) {
  const width = cols;
  const out = [line([span(G.rule.repeat(width), 'rule')], cols)];
  const hint = 'n  Describe the outcome. Enter adds a line.';
  out.push(line([span(' '), span(pad('Task', 6), 'working', 'bg', true), span(` ${pad(hint, width - 10)} `, 'muted', 'panel'), span(' ')], cols));
  if (width >= 100) {
    const field = (label, value) => [span(`${label} `, 'muted'), span(` ${value} `, 'fg', 'panel'), span('   ')];
    const left = [span(' '.repeat(8)), ...field('Where', view.launch?.where ?? 'choose repository'), ...field('Who', 'choose route'), ...field('Goal', 'choose goal')];
    const button = [span(G.capLeft, 'pill'), span(' Review launch ', 'muted', 'pill'), span(G.capRight, 'pill'), span(' ')];
    const gap = Math.max(0, width - spansWidth(left) - spansWidth(button));
    out.push(line([...left, span(' '.repeat(gap)), ...button], cols));
  }
  return out;
}

// The verbs a row offers, as footer keys, in the order they are most used.
function verbKeys(row, short) {
  const has = (a) => row?.actions?.includes(a);
  const keys = [];
  if (row?.kind === 'result') {
    const n = row.options?.length ?? 0;
    if (n) keys.push([n === 1 ? '1' : `1-${Math.min(n, 9)}`, row.via === 'key' ? 'answer its prompt' : 'pick']);
    if (has('draft')) keys.push(['y', 'send draft']);
    else if (row.recommendKey) keys.push(['y', 'recommended']);
  }
  if (row?.kind === 'question') keys.push(['y/n', 'answer'], ['d', short ? 'work out' : 'work it out']);
  if (has('reply')) keys.push(['r', 'reply']);
  if (has('later')) keys.push(['l', 'later']);
  if (has('drop')) keys.push(['x', ['finished', 'report'].includes(row.category) ? 'clear' : 'drop']);
  if (has('go')) keys.push(['g', short ? 'go' : 'go there']);
  return keys;
}

const KEYS = {
  list: (row, cols) => {
    const short = cols < 100;
    const keys = [['j/k', 'select']];
    if (row?.kind === 'fold') keys.push(['Enter', row.open ? 'hide' : 'show']);
    else if (row?.actions?.includes('peek')) keys.push(['Enter', 'peek']);
    else if (row) keys.push(['Enter', 'summary']);
    keys.push(...verbKeys(row, short));
    if (row?.kind !== 'fold') keys.push(['s', 'summary']);
    if (!row || row.kind === 'session') keys.push(['n', short ? 'task' : 'new task']);
    keys.push(['m', 'menu'], ['h', 'history'], ['/', 'scope'], ['?', 'help'], ['q', 'quit']);
    return short ? keys.filter(([k]) => !['m', 'h', '/'].includes(k)) : keys;
  },
  history: (row) => [['j/k', 'select'], ['Enter', 'summary'], ...(row?.actions?.includes('overrule') ? [['n', 'overrule']] : []), ['o', 'open'], ['h', 'back'], ['q', 'quit']],
  summary: (row) => [['1-3', 'tabs'], ['j/k', 'scroll'], ['o', 'open file'], ...(row?.actions?.includes('peek') ? [['Enter', 'peek']] : []),
    ...(row?.kind === 'question' ? [['y/n', 'answer']] : row?.kind === 'result' ? verbKeys(row, true).filter(([k]) => !/^1/.test(k)) : []), ['Esc', 'close']],
  peek: (row, cols) => [['Esc', 'back'], ['j/k', 'scroll'], ['G', 'follow'], ...verbKeys(row, cols < 120)],
  menu: () => [['↑/↓', 'choose'], ['Enter', 'pick'], ['Esc', 'close']],
  scope: () => [['↑/↓', 'choose'], ['Enter', 'show'], ['Esc', 'close']],
  help: () => [['Esc', 'close']],
};

const MESSAGE_FG = { error: 'blocked', ok: 'done', warn: 'waitFg', status: 'fg' };
const PROMPT_TITLE_MIN = 10;

// Only the title and, past its share, the reason are shortened: the verb, the
// cursor and the Enter/Esc keys always fit.
export function promptLine(p, cols) {
  const room = cols - cellWidth(p.head) - cellWidth(p.mid) - cellWidth(p.tail);
  if (room < 1) return clip(`${p.head}${p.mid}${p.tail}`, cols);
  const titleShare = Math.min(cellWidth(p.title), PROMPT_TITLE_MIN);
  const reasonRoom = room - titleShare;
  const reason = cellWidth(p.reason) <= reasonRoom ? p.reason
    : p.keep === 'end' ? clipStart(p.reason, reasonRoom) : clip(p.reason, reasonRoom);
  const title = clip(p.title, room - cellWidth(reason));
  return clip(`${p.head}${title}${p.mid}${reason}${p.tail}`, cols);
}

function footerLine(view, cols, G, mode, row) {
  const st = view.state ?? {};
  const head = [span(` ${mode} `, 'fg', 'segTime', true), span(G.right, 'segTime')];
  const room = cols - spansWidth(head) - 1;
  if (view.prompt) return line([...head, span(' '), span(promptLine(view.prompt, room), 'waitFg', 'bg', true)], cols);
  if (st.message) return line([...head, span(' '), span(clip(st.message, room), MESSAGE_FG[st.messageStyle] ?? 'fg')], cols);
  const keys = KEYS[mode === 'LIST' ? 'list' : mode.toLowerCase()]?.(row, cols) ?? [];
  if (mode === 'PEEK' && !st.popup?.follow) keys.splice(2, 1, ['G', 'follow the end']);
  const out = [...head, span(' ')];
  const piece = ([k, label]) => [span(` ${k} `, 'ink', 'faint'), span(` ${label}  `, 'muted')];
  // Help and quit always fit: the other keys give way to them when the pane is narrow.
  const tail = keys.filter(([k]) => k === '?' || k === 'q').flatMap(piece);
  for (const key of keys.filter(([k]) => k !== '?' && k !== 'q')) {
    const p = piece(key);
    if (spansWidth(out) + spansWidth(p) + spansWidth(tail) > cols) break;
    out.push(...p);
  }
  if (spansWidth(out) + spansWidth(tail) <= cols) out.push(...tail);
  return line(out, cols);
}

// ---- popups ---------------------------------------------------------------

function box(width, inner, { title = '', footer = '' } = {}, G) {
  const border = 'segHelp';
  const top = `╭${title ? `${G.rule} ${title} ` : ''}`;
  const bottomTail = footer ? ` ${footer} ${G.rule}╯` : '╯';
  const lines = [[span(top + '─'.repeat(Math.max(0, width - cellWidth(top) - 1)) + '╮', border, 'panel')]];
  for (const content of inner) {
    lines.push([span('│', border, 'panel'), span(' ', 'fg', 'panel'), ...fit(content.map((s) => ({ ...s, bg: s.bg === 'bg' ? 'panel' : s.bg })), width - 4, 'panel'), span(' ', 'fg', 'panel'), span('│', border, 'panel')]);
  }
  lines.push([span(`╰${'─'.repeat(Math.max(0, width - 1 - cellWidth(bottomTail)))}${bottomTail}`, border, 'panel')]);
  return lines;
}

const MD_STYLE = {
  heading: ['bright', true], subheading: ['fg', true], code: ['done', false], quote: ['muted', false], rule: ['rule', false],
  meta: ['muted', false], table: ['fg', false], text: ['fg', false], strong: ['bright', true], warn: ['waitFg', false], dim: ['muted', false],
};

const styled = (l) => [span(l.text, MD_STYLE[l.style]?.[0] ?? 'fg', 'panel', MD_STYLE[l.style]?.[1] ?? false)];

function pairLines(pairs, width) {
  const keyWidth = Math.min(16, Math.max(...pairs.map(([k]) => cellWidth(k))) + 1);
  return pairs.flatMap(([k, v]) => wrap(v, width - keyWidth - 1).map((text, i) => [
    span(i ? ' '.repeat(keyWidth) : pad(k, keyWidth), 'muted', 'panel'), span(` ${text}`, 'fg', 'panel'),
  ]));
}

function docLines(doc, width) {
  if (!doc || doc.status === 'loading') return [[span('loading…', 'muted', 'panel')]];
  if (doc.status === 'missing') return wrap(doc.message, width).map((t) => [span(t, 'waitFg', 'panel')]);
  return renderMarkdown(doc.text, width).map(styled);
}

function messageMissing(row) {
  if (row.state === 'gone') return 'no message: the session is gone';
  if (!row.live) return 'no message: Herdr does not list this session';
  if (row.live.tool && row.live.tool !== 'claude') return `no message: ${row.live.tool} transcripts are not read yet`;
  if (!row.live.session && !row.live.name) return 'no message: Herdr gives no session id for this agent';
  return 'no message: transcript not found';
}

export function popupBody(row, tab, width, doc, project) {
  if (!row) return [[span('That row is no longer on screen.', 'muted', 'panel')]];
  if (row.kind === 'session') {
    if (tab === 0) {
      const note = row.transcript?.note;
      if (!note) return wrap(messageMissing(row), width).map((t) => [span(t, 'muted', 'panel')]);
      return [[span(`Last message · ${hhmm(note.at)}`, 'bright', 'panel', true)], [], ...renderMarkdown(note.text, width).map(styled)];
    }
    if (tab === 1) return docLines(doc, width);
    return pairLines(sessionContext(row, project), width);
  }
  if (tab === 0) {
    return summaryParagraphs(row).flatMap((p, i) => [...wrap(p, width).map((t) => [span(t, i ? 'fg' : 'bright', 'panel', i === 0)]), []]).slice(0, -1);
  }
  if (tab === 1) return docLines(doc, width);
  return pairLines(contextPairs(row, project), width);
}

function titleBand(row, width, G) {
  if (!row) return [span(pad('', width), 'fg', 'selected')];
  let parts;
  if (row.kind === 'session') {
    parts = [
      span(`${G[row.state] ?? ''}`, row.state, 'selected'),
      span(row.session, 'bright', 'selected', true),
      span(` ${G.sep} `, 'muted', 'selected'),
      ...whoSpans(row.who, cellWidth(row.who.text), 'selected'),
      span(` ${G.sep} ${row.where} ${G.sep} up ${row.up} ${G.sep} ${row.state}`, 'muted', 'selected'),
    ];
  } else if (row.kind === 'result') {
    parts = [span(`${MARKS.result[row.category] ?? '!'} `, 'waitFg', 'selected', true), span(row.session, 'bright', 'selected', true),
      span(` ${G.sep} ${row.categoryWords} ${G.sep} ${row.data?.state ?? ''} at ${row.asked}`, 'muted', 'selected')];
  } else if (row.kind === 'question') {
    parts = [span('! ', 'waitFg', 'selected', true), span(row.headline, 'bright', 'selected', true), span(` ${G.sep} ${row.category} ${G.sep} ${recommendText(row)}`, 'muted', 'selected')];
  } else {
    parts = [span(`${row.time}  `, 'muted', 'selected'), span(row.headline, 'bright', 'selected', true), span(` ${G.sep} ${row.state}`, 'muted', 'selected')];
  }
  return fit(parts, width, 'selected');
}

function summaryPopup(view, cols, rows, G) {
  const p = view.state.popup;
  const row = view.popupRow;
  const width = Math.max(40, Math.min(cols - 8, 100));
  const height = Math.max(10, Math.min(rows - 4, 36));
  const inner = width - 4;
  const bodyHeight = height - 5;
  const body = popupBody(row, p.tab, inner, view.popupDoc, view.project);
  const popupMax = Math.max(0, body.length - bodyHeight);
  const scroll = Math.min(p.scroll ?? 0, popupMax);
  const tabs = [];
  const tabHits = [];
  let x = 0;
  tabNames(row).forEach((name, i) => {
    const text = i === p.tab ? `[${i + 1} ${name}]` : ` ${i + 1} ${name} `;
    tabs.push(span(text, i === p.tab ? 'working' : 'muted', 'panel', i === p.tab), span('  ', 'fg', 'panel'));
    tabHits.push({ from: x, to: x + cellWidth(text), target: { type: 'tab', tab: i } });
    x += cellWidth(text) + 2;
  });
  const shown = body.slice(scroll, scroll + bodyHeight);
  while (shown.length < bodyHeight) shown.push([]);
  const position = body.length > bodyHeight ? `${scroll + 1}-${Math.min(body.length, scroll + bodyHeight)}/${body.length}` : '';
  const lines = box(width, [titleBand(row, inner, G), tabs, [span(G.rule.repeat(inner), 'rule', 'panel')], ...shown], { footer: position }, G);
  const top = Math.max(1, Math.floor((rows - lines.length) / 2));
  const left = Math.floor((cols - width) / 2);
  return { lines, top, left, popupMax, tabLine: 2, tabHits: tabHits.map((h) => ({ ...h, from: h.from + left + 2, to: h.to + left + 2 })) };
}

// The peek: the session's own screen, re-wrapped to the popup, with what it
// needs from the operator pinned above it when it left something behind.
export function peekBody(peek, width) {
  if (!peek || (peek.text == null && !peek.error)) return [[span('reading its screen…', 'muted', 'panel')]];
  const lines = [];
  if (peek.gone) lines.push([span('This session is no longer in Herdr. This is the last screen captured from it.', 'waitFg', 'panel')], []);
  if (peek.error && peek.text == null) return wrap(`Could not read its screen: ${peek.error}`, width).map((t) => [span(t, 'blocked', 'panel')]);
  const text = String(peek.text ?? '').replace(/\s+$/, '');
  for (const raw of text.split('\n')) {
    const parts = raw.trim() ? wrapKeep(raw, width) : [''];
    for (const t of parts) lines.push([span(t, 'fg', 'panel')]);
  }
  return lines;
}

// Wraps a screen line without collapsing its indentation, so lists and code stay
// legible: every piece of a wrapped line keeps the line's own indent.
export function wrapKeep(raw, width) {
  const line = sanitize(raw).replace(/\s+$/, '');
  if (cellWidth(line) <= width) return [line];
  const lead = /^\s*/.exec(line)[0];
  const indent = lead.length < width / 2 ? lead : '';
  return wrap(line.trimStart(), width - indent.length).map((t) => `${indent}${t}`);
}

function needsLines(row, width) {
  if (row?.kind !== 'result') return [];
  const out = wrap(row.headline, width).slice(0, 2).map((t) => [span(t, 'bright', 'panel', true)]);
  for (const o of (row.options ?? []).slice(0, 6)) {
    const rec = row.recommendKey === o.key ? '  ← recommended' : '';
    out.push([span(`  ${pad(o.key, 3)}`, 'working', 'panel', true), span(clip(o.label, width - 6 - cellWidth(rec)), 'fg', 'panel'), span(rec, 'done', 'panel')]);
  }
  if (row.suggestion) out.push([span('  Claude drafted, not sent: ', 'muted', 'panel'), span(clip(`“${row.suggestion}”`, width - 30), 'fg', 'panel')]);
  if (row.unsent) out.push([span('  You typed, never sent: ', 'blocked', 'panel'), span(clip(`“${row.unsent}”`, width - 26), 'fg', 'panel')]);
  return out;
}

function peekPopup(view, cols, rows, G) {
  const p = view.state.popup;
  const row = view.popupRow;
  const width = cols;
  const height = Math.max(10, rows - 3);
  const inner = width - 4;
  const needs = needsLines(row, inner);
  const head = [titleBand(row, inner, G), ...needs, [span(G.rule.repeat(inner), 'rule', 'panel')]];
  const bodyHeight = Math.max(3, height - 2 - head.length);
  const body = peekBody(view.peek, inner);
  const popupMax = Math.max(0, body.length - bodyHeight);
  const scroll = p.follow ? popupMax : Math.min(p.scroll ?? 0, popupMax);
  const shown = body.slice(scroll, scroll + bodyHeight);
  while (shown.length < bodyHeight) shown.push([]);
  const where = body.length > bodyHeight ? `${scroll + 1}-${Math.min(body.length, scroll + bodyHeight)}/${body.length}` : '';
  const state = p.follow ? 'following' : 'scrolled up · G follows';
  const age = view.peek?.error && view.peek?.text != null ? ` · not refreshed: ${clip(view.peek.error, 40)}` : '';
  const lines = box(width, [...head, ...shown], { title: 'peek · Esc back', footer: `${where ? `${where} · ` : ''}${state}${age}` }, G);
  return { lines, top: 1, left: 0, popupMax, scroll };
}

function listPopup(items, index, width, G, title) {
  const inner = width - 4;
  return box(width, items.map((item, i) => {
    if (item.separator) return [span(G.rule.repeat(inner), 'rule', 'panel')];
    const bg = i === index ? 'selected' : 'panel';
    const hint = item.hint ?? '';
    return [span(`${i === index ? '>' : ' '} `, 'working', bg, true), span(pad(item.label, inner - 3 - cellWidth(hint)), item.active ? 'bright' : 'fg', bg, item.active),
      span(` ${hint}`, 'muted', bg)];
  }), { title }, G);
}

// It opens under its row, or above it when it would cover the launch bar.
function menuPopup(view, cols, rows, G, limit) {
  const p = view.state.popup;
  const items = menuItems(view.popupRow);
  const width = 30;
  const lines = listPopup(items, p.index, width, G);
  let top = p.y + 1;
  if (top + lines.length > limit) top = Math.max(1, p.y - lines.length);
  const left = Math.max(0, Math.min(p.x, cols - width - 1));
  return { lines, top, left, itemHit: (i) => ({ type: 'menu', index: i }) };
}

function scopePopup(view, cols, rows, G) {
  const scope = view.state.scope;
  const items = [];
  const hits = [];
  (view.scopeItems ?? []).forEach((item, index) => {
    if (item.key && !view.scopeItems[index - 1]?.key) {
      items.push({ separator: true });
      hits.push(null);
    }
    const active = item.view === 'history' ? view.state.view === 'history' : item.repo === scope.repo && item.view === scope.view;
    items.push({ label: `${active ? '* ' : '  '}${item.key ? `${item.key} ` : ''}${item.label}`, hint: String(item.count), active });
    hits.push(index);
  });
  const cursor = hits.indexOf(view.state.popup.index);
  const width = Math.min(cols - 8, 48);
  const lines = listPopup(items, cursor, width, G, 'Scope');
  return {
    lines,
    top: Math.max(1, Math.floor((rows - lines.length) / 2)),
    left: Math.floor((cols - width) / 2),
    itemHit: (i) => (hits[i] === null || hits[i] === undefined ? { type: 'popup' } : { type: 'scope', index: hits[i] }),
  };
}

export function helpLines(version) {
  return [
    `Herdr Brain console ${version ?? ''}`.trim(),
    '',
    'j/k ↑/↓ PgUp/PgDn Home/End   move (or scroll a popup)',
    'Enter, left click            peek at the session here (Esc comes back)',
    '                             a question: its summary; a folded line: open it',
    'g                            go to the session in Herdr',
    '                             back: Ctrl+Alt+B, or Ctrl+B then `',
    's                            summary: 1/2/3 tabs, o opens the file, Esc closes',
    'm, right click               row menu',
    '',
    'What a session left behind:',
    '1-9, click a choice          pick it (a prompt: presses that key)',
    'y / n                        Claude\'s draft or the recommended choice / the no',
    'r                            reply in your own words',
    'l                            save for later      x  drop it, or clear a finished one',
    '',
    'A question filed in org:',
    'y / n                        approve / decline (n in history: overrule)',
    'd                            start a session to work it out; it comes back here',
    '',
    'n, Tab                       new task (comes in the next round)',
    'h                            today\'s history (h or Esc returns)',
    '/                            scope: a repository or a view',
    '! / w                        only what needs you / only working sessions',
    'o                            open the brief, memo or report',
    'p  R                         switch project, reload now',
    'Esc                          close the innermost thing',
    'q                            quit (from the list or history)',
    '',
    'Everything that sends, presses or drops asks first. The console never stops an agent.',
  ];
}

function helpPopup(view, cols, rows, G) {
  const text = helpLines(view.version);
  const width = Math.min(cols - 4, Math.max(...text.map((t) => cellWidth(t))) + 4);
  const lines = box(width, text.slice(0, Math.max(1, rows - 4)).map((t, i) => [span(clip(t, width - 4), i ? 'fg' : 'bright', 'panel', i === 0)]), { title: 'Help' }, G);
  return { lines, top: Math.max(1, Math.floor((rows - lines.length) / 2)), left: Math.floor((cols - width) / 2) };
}

function dim(spans) {
  return spans.map((s) => ({ ...s, fg: 'faint', bold: false }));
}

// ---- the frame ------------------------------------------------------------

// `termRows` is the terminal's height when the app draws fewer rows than it has.
export function renderFrame(view, cols, rows, { termRows = rows } = {}) {
  const G = glyphsFor(view.glyphs);
  const st = view.state ?? {};
  const finish = (lines, extra) => {
    const clean = lines.slice(0, rows).map((l) => ({
      spans: l.spans.map((s) => {
        const text = sanitize(s.text);
        return { ...s, text: view.glyphs === 'plain' ? asciiFold(text) : text };
      }),
    }));
    while (clean.length < rows) clean.push(blank(cols));
    return { lines: clean, ...extra };
  };

  if (cols < MIN_COLS || termRows < MIN_ROWS) {
    const lines = [...wrap(`Resize to at least ${MIN_COLS}×${MIN_ROWS} (now ${cols}×${termRows}).`, Math.max(1, cols - 1)), 'q quits.']
      .map((t) => line([span(` ${t}`)], cols));
    return finish(lines, { listOffset: st.listOffset ?? 0, popupMax: 0, hits: [] });
  }

  const hits = Array.from({ length: rows }, () => []);
  const out = [];
  const { left, right } = headerSegments(view, G);
  out.push({ spans: segmentRow(left, right, cols, G) });

  const launch = launchLines(view, cols, G);
  const bodyHeight = Math.max(1, rows - 1 - launch.length - 1);
  const rail = cols >= RAIL_COLS;
  const mainLeft = rail ? RAIL_WIDTH + 1 : 0;
  const mainWidth = cols - mainLeft;

  const body = listBody(view, mainWidth, G);
  const cursor = st.view === 'history' ? st.historyKey : st.selectedKey;
  const first = body.findIndex((l) => l.key && l.key === cursor);
  let last = first;
  while (first >= 0 && body[last + 1]?.key === cursor) last++;
  const listOffset = st.follow === false
    ? Math.min(Math.max(0, st.listOffset ?? 0), Math.max(0, body.length - bodyHeight))
    : scrollWindow(st.listOffset, first, bodyHeight, body.length, last);
  const shown = body.slice(listOffset, listOffset + bodyHeight);
  const more = (i, mark) => {
    if (shown[i]) shown[i] = { ...shown[i], spans: [span(mark, 'waitFg', shown[i].spans[0]?.bg ?? 'bg', true), ...cutSpans(shown[i].spans, 1, mainWidth)] };
  };
  if (listOffset > 0) more(0, '↑');
  if (listOffset + bodyHeight < body.length) more(shown.length - 1, '↓');
  const railBody = rail ? railLines(view, bodyHeight, G) : [];
  for (let i = 0; i < bodyHeight; i++) {
    const y = out.length;
    const main = shown[i] ? fit(shown[i].spans, mainWidth) : fit([], mainWidth);
    if (shown[i]?.hit) hits[y].push({ from: mainLeft, to: cols, target: shown[i].hit });
    else if (shown[i]?.key) hits[y].push({ from: mainLeft, to: cols, target: { type: 'row', key: shown[i].key } });
    if (rail) {
      const r = railBody[i];
      if (r?.hit) hits[y].push({ from: 0, to: RAIL_WIDTH, target: r.hit });
      out.push({ spans: [...fit(r?.spans ?? [], RAIL_WIDTH), span(' '), ...main] });
    } else {
      out.push({ spans: main });
    }
  }
  out.push(...launch);

  const row = view.selectedRow ?? null;
  const p = st.popup;
  const mode = view.prompt ? (st.mode?.kind === 'reply' ? 'REPLY' : 'ANSWER') : st.help ? 'HELP' : p ? p.kind.toUpperCase() : st.view === 'history' ? 'HISTORY' : 'LIST';
  out.push(footerLine(view, cols, G, mode, p ? view.popupRow : row));

  let popupMax = 0;
  let pop = null;
  if (st.help) pop = helpPopup(view, cols, rows, G);
  else if (p?.kind === 'summary') pop = summaryPopup(view, cols, rows, G);
  else if (p?.kind === 'peek') pop = peekPopup(view, cols, rows, G);
  else if (p?.kind === 'menu') pop = menuPopup(view, cols, rows, G, rows - 1 - launch.length);
  else if (p?.kind === 'scope') pop = scopePopup(view, cols, rows, G);
  if (pop) {
    popupMax = pop.popupMax ?? 0;
    const shade = p?.kind !== 'menu';
    for (let y = 0; y < rows - 1; y++) if (shade && out[y]) out[y] = { spans: dim(out[y].spans) };
    const width = spansWidth(pop.lines[0]);
    pop.lines.forEach((spans, i) => {
      const y = pop.top + i;
      if (y >= rows - 1 || !out[y]) return;
      out[y] = { spans: [...cutSpans(out[y].spans, 0, pop.left), ...spans, ...cutSpans(out[y].spans, pop.left + width, cols)] };
      const inside = { from: pop.left, to: pop.left + width, target: { type: 'popup' } };
      const item = pop.itemHit && i > 0 && i < pop.lines.length - 1 ? { ...inside, target: pop.itemHit(i - 1) } : inside;
      // The narrowest hit wins, so the popup covers what is under it and rows beside it still map.
      hits[y] = [item, ...(pop.tabHits && i === pop.tabLine ? pop.tabHits : []), ...hits[y]];
    });
  }

  return finish(out.map((l) => ({ spans: fit(l.spans, cols) })), { listOffset, popupMax, hits, popupScroll: pop?.scroll });
}

// The target under a click: the narrowest hit that covers x.
export function hitAt(hits, x, y) {
  const list = (hits[y] ?? []).filter((h) => x >= h.from && x < h.to);
  list.sort((a, b) => (a.to - a.from) - (b.to - b.from));
  return list[0]?.target ?? null;
}
