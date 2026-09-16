// Markdown to terminal lines: renderMarkdown(text, width) → [{ text, style }].
// A small built-in renderer for what memos, reports, briefs and session notes use:
// front matter, headings, paragraphs, lists, quotes, code blocks, tables and rules.
// Every line fits `width` cells. Styles are names the app maps to Ink props:
// heading, subheading, code, quote, rule, meta, table, text.
import { cellWidth, clip, pad, plainLine, wrap } from './text.mjs';

function inline(text) {
  return plainLine(text);
}

// Wrap text into width, prefixing the first line with `first` and the rest with `rest`.
function wrapPrefixed(text, width, first, rest) {
  const room = Math.max(4, width - Math.max(cellWidth(first), cellWidth(rest)));
  return wrap(text, room).map((l, k) => (k ? rest : first) + l);
}

function listMarker(line) {
  const m = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
  if (!m) return null;
  const depth = Math.floor(m[1].replace(/\t/g, '  ').length / 2);
  const box = m[3] ? (m[3].trim() === '[ ]' ? '[ ] ' : '[x] ') : '';
  const bullet = /\d/.test(m[2]) ? m[2].replace(')', '.') : '•';
  return { depth, bullet: `${bullet} ${box}`, text: m[4] };
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => inline(c.trim()));
}

function renderTable(rows, width) {
  const header = rows[0];
  const body = rows.slice(1);
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(3, ...rows.map((r) => cellWidth(r[i] ?? ''))));
  const total = widths.reduce((a, b) => a + b, 0) + (cols - 1) * 3;
  if (total <= width) {
    const line = (r) => widths.map((w, i) => pad(r[i] ?? '', w)).join(' │ ').trimEnd();
    return [
      { text: line(header), style: 'heading' },
      { text: widths.map((w) => '─'.repeat(w)).join('─┼─'), style: 'rule' },
      ...body.map((r) => ({ text: line(r), style: 'table' })),
    ];
  }
  // Too wide for the pane: one block per row, "column: value".
  const out = [];
  body.forEach((r, index) => {
    if (index) out.push({ text: '', style: 'text' });
    r.forEach((cell, i) => {
      const label = header[i] || `column ${i + 1}`;
      for (const text of wrap(`${label}: ${cell}`, width, '  ')) out.push({ text, style: 'table' });
    });
  });
  return out;
}

export function renderMarkdown(source, width) {
  const w = Math.max(10, width);
  const out = [];
  const push = (text, style = 'text') => out.push({ text: clip(text, w), style });
  const blank = () => {
    if (out.length && out.at(-1).text !== '') out.push({ text: '', style: 'text' });
  };
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n');
  let i = 0;

  // Front matter: shown as a quiet key/value block.
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start++;
  if (lines[start]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > start && ['---', '...'].includes(l.trim()));
    if (end > start) {
      for (const l of lines.slice(start + 1, end)) {
        if (!l.trim() || /^\s*#/.test(l)) continue;
        const lead = /^\s*/.exec(l)[0];
        for (const text of wrapPrefixed(l.replace(/\s+#\s.*$/, '').trim(), w, lead, `${lead}  `)) push(text, 'meta');
      }
      blank();
      i = end + 1;
    }
  }

  let paragraph = [];
  const flush = () => {
    if (!paragraph.length) return;
    for (const text of wrap(inline(paragraph.join(' ')), w)) push(text);
    paragraph = [];
    blank();
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') {
      flush();
      i++;
      continue;
    }
    const fence = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fence) {
      flush();
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) {
        push(`  ${lines[i]}`, 'code');
        i++;
      }
      i++;
      blank();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      blank();
      const text = inline(heading[2]);
      for (const l of wrap(heading[1].length <= 2 ? text.toUpperCase() : text, w)) push(l, heading[1].length <= 2 ? 'heading' : 'subheading');
      i++;
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) {
      flush();
      push('─'.repeat(Math.min(w, 40)), 'rule');
      i++;
      continue;
    }
    if (trimmed.startsWith('|') && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1].trim())) {
      flush();
      const rows = [splitRow(line)];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(splitRow(lines[i++]));
      for (const row of renderTable(rows, w)) push(row.text, row.style);
      blank();
      continue;
    }
    if (trimmed.startsWith('>')) {
      flush();
      const quoted = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) quoted.push(lines[i++].trim().replace(/^>\s?/, ''));
      for (const l of wrap(inline(quoted.join(' ')), w - 2)) push(`│ ${l}`, 'quote');
      blank();
      continue;
    }
    const item = listMarker(line);
    if (item) {
      flush();
      const indent = '  '.repeat(item.depth);
      let text = item.text;
      i++;
      // Continuation lines of the same item.
      while (i < lines.length && lines[i].trim() && !listMarker(lines[i]) && /^\s{2,}/.test(lines[i]) && !/^\s*(```|>|\|)/.test(lines[i])) {
        text += ` ${lines[i].trim()}`;
        i++;
      }
      const hang = indent + ' '.repeat(cellWidth(item.bullet));
      for (const l of wrapPrefixed(inline(text), w, indent + item.bullet, hang)) push(l);
      if (!lines[i]?.trim() || !listMarker(lines[i])) blank();
      continue;
    }
    paragraph.push(trimmed);
    i++;
  }
  flush();
  while (out.length && out.at(-1).text === '') out.pop();
  return out;
}
