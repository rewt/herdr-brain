// The whole screen as lines: renderFrame(view, cols, rows[, { termRows }]) → { lines, listOffset, readerMax }.
// Every line fits `cols` cells and there are at most `rows` lines. Each line is
// { text, style }; the app maps styles to Ink props and drops color under NO_COLOR.
// Nothing here depends on Ink, so the layout is tested at any size.
import { renderMarkdown } from './markdown.mjs';
import { NO_PLAIN, contextPairs, summaryParagraphs } from './model.mjs';
import { cellWidth, clip, clipStart, pad, padStart, sanitize, wrap } from './text.mjs';

export const MIN_COLS = 80;
export const MIN_ROWS = 20;
const CHROME = 4; // header, reader title, status line, footer

export const TABS = ['Summary', 'Document', 'Context'];

export function columns(cols) {
  const tag = cols >= 100 ? 15 : 11;
  const right = cols >= 140 ? 30 : cols >= 100 ? 24 : 20;
  return { marker: 2, tag, right, headline: cols - 2 - tag - right - 2 };
}

export function heights(rows, expanded) {
  const body = rows >= 40 ? 10 : rows >= 30 ? 8 : 7;
  if (expanded) return { list: 0, reader: Math.max(1, rows - CHROME) };
  return { list: Math.max(1, rows - CHROME - body), reader: body };
}

function rightText(row) {
  return row.kind === 'question' || row.kind === 'run' || row.kind === 'executive' ? row.state : `${row.time}  ${row.state}`;
}

// The "no plain summary" mark survives clipping: the text before it is cut instead.
function headlineCell(headline, width) {
  if (!headline.endsWith(NO_PLAIN) || cellWidth(headline) <= width) return pad(headline, width);
  const mark = ` ${NO_PLAIN}`;
  return pad(clip(headline.slice(0, -mark.length), width - cellWidth(mark)) + mark, width);
}

export function rowLine(row, cols, marker = '  ') {
  const c = columns(cols);
  return `${pad(marker, c.marker)}${headlineCell(row.headline, c.headline)} ${pad(row.tag, c.tag)} ${padStart(rightText(row), c.right)}`;
}

function listLines(sections, cols, selectedKey, focus) {
  const lines = [];
  let selectedLine = -1;
  for (const s of sections) {
    lines.push({ text: clip(`${s.title} (${s.rows.length})`, cols), style: 'section' });
    for (const row of s.rows) {
      const selected = row.key === selectedKey;
      if (selected) selectedLine = lines.length;
      lines.push({ row, selected, text: rowLine(row, cols, selected ? (focus === 'list' ? '> ' : '› ') : '  '), style: selected ? 'selected' : 'row' });
    }
  }
  return { lines, selectedLine };
}

// Moves the window only as far as needed to keep the selection (and, when it fits,
// its section heading) in view.
export function scrollWindow(offset, selectedLine, height, total) {
  let o = Math.min(Math.max(0, offset ?? 0), Math.max(0, total - height));
  if (selectedLine < 0) return o;
  const top = Math.max(0, selectedLine - 1);
  if (top < o) o = top;
  if (selectedLine >= o + height) o = selectedLine - height + 1;
  return o;
}

export function readerLines(row, tab, width, document, project) {
  if (!row) return [{ text: 'Nothing selected.', style: 'dim' }];
  if (tab === 0) {
    return summaryParagraphs(row).flatMap((p, i) => wrap(p, width, '').map((text) => ({ text, style: i === 0 ? 'strong' : 'text' })));
  }
  if (tab === 1) {
    if (!document || document.status === 'loading') return [{ text: 'loading…', style: 'dim' }];
    if (document.status === 'missing') return wrap(document.message, width).map((text) => ({ text, style: 'warn' }));
    return renderMarkdown(document.text, width);
  }
  const pairs = contextPairs(row, project);
  const keyWidth = Math.min(20, Math.max(...pairs.map(([k]) => cellWidth(k))) + 1);
  return pairs.flatMap(([k, v]) => wrap(v, width - keyWidth - 1).map((text, i) => ({
    text: `${i ? ' '.repeat(keyWidth) : pad(`${k}:`, keyWidth)} ${text}`,
    style: 'text',
  })));
}

function tabsText(tab) {
  return TABS.map((name, i) => (i === tab ? `[${i + 1} ${name}]` : `${i + 1} ${name}`)).join(' ');
}

function readerTitle(row, tab, focus, cols, position) {
  const tabs = tabsText(tab);
  const lead = focus === 'reader' ? '> ' : '─ ';
  const pos = position ? ` ${position}` : '';
  const room = cols - cellWidth(lead) - cellWidth(tabs) - cellWidth(pos) - 3;
  const title = clip(row?.headline ?? 'nothing selected', Math.max(0, room));
  const fill = '─'.repeat(Math.max(1, cols - cellWidth(lead) - cellWidth(title) - cellWidth(pos) - cellWidth(tabs) - 2));
  return clip(`${lead}${title} ${fill}${pos} ${tabs}`, cols);
}

const ACTION_KEYS = { approve: 'y approve', decline: 'n decline', overrule: 'n overrule', focus: 'f go to agent' };

export function footerKeys(view, row) {
  const keys = [];
  for (const a of row?.actions ?? []) keys.push(ACTION_KEYS[a]);
  if (row?.doc?.path || row?.doc?.text) keys.push('o open');
  // Most important first: the footer drops keys from the end when the pane is narrow.
  keys.push(view.focus === 'list' ? 'Tab reader' : 'Tab list', '? help');
  keys.push(view.focus === 'list' && !view.expanded ? 'q quit' : 'Esc back');
  keys.push(view.expanded ? 'Enter shrink' : 'Enter expand', '1-3 tabs');
  if (view.projectCount > 1) keys.push('p project');
  keys.push('r reload');
  return keys;
}

function fitKeys(keys, cols) {
  const out = [];
  for (const k of keys) {
    const next = [...out, k].join('   ');
    if (cellWidth(next) > cols) break;
    out.push(k);
  }
  return out.join('   ');
}

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

export const HELP = [
  'KEYS',
  '↑/↓ j/k  PgUp/PgDn  Home/End   move in the list (or scroll the reader)',
  'Tab                            switch between the list and the reader',
  '1 / 2 / 3                      reader tab: Summary, Document, Context',
  'Enter                          expand or shrink the reader',
  'y                              approve the selected question (then Enter to confirm)',
  'n                              decline, or overrule an agent\'s answer to its opposite (reason, then Enter)',
  'o                              open the document in $VISUAL, $EDITOR or macOS open',
  'f                              go to the agent\'s Herdr tab',
  'p                              switch project        r   reload now',
  'Esc                            close the innermost thing (never quits)',
  'q                              quit (from the list)   ?   close this help',
  '',
  'Answers are only recorded; the next executive pass acts on them.',
  'The console never starts, stops or messages agents.',
];

export function headerText(view, cols) {
  const h = view.header ?? {};
  const parts = [h.project ?? 'no project', h.clock ?? '--:--'];
  if (h.sessions) parts.push(h.sessions);
  if (h.stop) parts.push('STOP file present');
  if (h.alerts) parts.push(`${h.alerts} alert${h.alerts === 1 ? '' : 's'}`);
  if (h.herdr) parts.push(h.herdr);
  if (h.age) parts.push(h.age);
  const right = '? help';
  const left = clip(parts.join(' · '), cols - cellWidth(right) - 1);
  return left + ' '.repeat(Math.max(1, cols - cellWidth(left) - cellWidth(right))) + right;
}

// `termRows` is the terminal's height when the app draws fewer rows than it has.
export function renderFrame(view, cols, rows, { termRows = rows } = {}) {
  const lines = [];
  if (cols < MIN_COLS || termRows < MIN_ROWS) {
    const row = view.selected;
    for (const text of [
      clip(`${view.header?.project ?? 'console'} · ${view.header?.clock ?? ''}`, cols),
      ...wrap(`Resize to at least ${MIN_COLS}×${MIN_ROWS} (now ${cols}×${termRows}).`, cols),
      row ? clip(`Selected: ${row.headline}`, cols) : '',
      ...wrap(view.message ?? '', cols),
      clip('q quit   Esc close', cols),
    ].slice(0, rows)) lines.push({ text, style: 'text' });
    return { lines, listOffset: view.listOffset ?? 0, readerMax: 0 };
  }

  const h = heights(rows, view.expanded);
  lines.push({ text: headerText(view, cols), style: 'header' });

  let listOffset = view.listOffset ?? 0;
  let readerMax = 0;
  if (view.help) {
    const help = HELP.map((text, i) => ({ text: clip(text, cols), style: i === 0 ? 'section' : 'text' }));
    const area = h.list + h.reader + 1;
    for (let i = 0; i < area; i++) lines.push(help[i] ?? { text: '', style: 'text' });
  } else {
    if (h.list > 0) {
      const { lines: list, selectedLine } = listLines(view.sections, cols, view.selected?.key, view.focus);
      listOffset = scrollWindow(listOffset, selectedLine, h.list, list.length);
      const shown = list.slice(listOffset, listOffset + h.list);
      // More above or below: an arrow in the first or last line's gutter (a heading gets it appended).
      const arrow = (i, mark) => {
        const line = shown[i];
        if (line.selected) return;
        shown[i] = line.row
          ? { ...line, text: rowLine(line.row, cols, `${mark} `) }
          : { ...line, text: clip(`${line.text}  ${mark} more`, cols) };
      };
      if (listOffset > 0) arrow(0, '↑');
      if (listOffset + h.list < list.length) arrow(shown.length - 1, '↓');
      while (shown.length < h.list) shown.push({ text: '', style: 'text' });
      lines.push(...shown.map(({ text, style }) => ({ text, style })));
    }
    const body = readerLines(view.selected, view.tab, cols - 2, view.document, view.project);
    readerMax = Math.max(0, body.length - h.reader);
    const scroll = Math.min(view.readerScroll ?? 0, readerMax);
    const position = body.length > h.reader ? `${scroll + 1}-${Math.min(body.length, scroll + h.reader)}/${body.length}` : '';
    lines.push({ text: readerTitle(view.selected, view.tab, view.focus, cols, position), style: view.focus === 'reader' ? 'titleFocus' : 'title' });
    const shown = body.slice(scroll, scroll + h.reader).map((l) => ({ ...l, text: clip(`  ${l.text}`, cols) }));
    while (shown.length < h.reader) shown.push({ text: '', style: 'text' });
    lines.push(...shown);
  }

  lines.push({ text: clip(view.message ?? '', cols), style: view.messageStyle ?? 'status' });
  const footer = view.prompt ? promptLine(view.prompt, cols) : fitKeys(footerKeys(view, view.selected), cols);
  lines.push({ text: footer, style: view.prompt ? 'prompt' : 'footer' });
  // Every piece above is already clean; this keeps it so for any future line.
  return { lines: lines.map((l) => ({ ...l, text: sanitize(l.text) })), listOffset, readerMax };
}
