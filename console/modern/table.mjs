// Small in-house Ink table. cli-boxes is already supplied by Ink.
import React from 'react';
import { Box, Text } from 'ink';
import boxes from 'cli-boxes';
import { charWidth, sanitize } from '../lib/text.mjs';

const h = React.createElement;
export const single = boxes.single;
export const cleanCell = value => sanitize(value).replace(/\s+/g, ' ').trim();
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const graphemes = value => [...segmenter.segment(sanitize(value))].map(({ segment }) => ({ text: segment,
  width: /\p{Emoji_Presentation}|\p{Regional_Indicator}|\ufe0f|\u20e3/u.test(segment) ? 2 : Math.max(0, ...[...segment].map(charWidth)) }));
export const tableCellWidth = value => graphemes(value).reduce((sum, part) => sum + part.width, 0);

export function fitCell(value, width, align = 'left') {
  const parts = graphemes(value), size = parts.reduce((sum, part) => sum + part.width, 0);
  let text = '', used = 0;
  for (const part of parts) {
    if (used + part.width > width - Number(size > width)) break;
    text += part.text; used += part.width;
  }
  if (size > width && width > 0) { text += '…'; used++; }
  const space = ' '.repeat(Math.max(0, width - used));
  return align === 'right' ? space + text : text + space;
}

// Widths exclude cell padding, separators and the two outside borders.
export function columnWidths(columns, width, padding = 1) {
  const budget = Math.max(0, width - 2 - (columns.length - 1) - columns.length * padding * 2);
  const sizes = columns.map(c => Math.max(0, c.width ?? c.min ?? 1));
  while (sizes.reduce((a, b) => a + b, 0) > budget) {
    const largest = sizes.indexOf(Math.max(...sizes));
    sizes[largest]--;
  }
  let spare = budget - sizes.reduce((a, b) => a + b, 0);
  const flexible = columns.map((c, i) => c.flex ? i : -1).filter(i => i >= 0);
  const grow = flexible.length ? flexible : [Math.max(0, columns.length - 1)];
  for (let i = 0; spare > 0; i++, spare--) sizes[grow[i % grow.length]]++;
  return sizes;
}

export function Spans({ spans = [], width, selected = false, dim = false, noColor = false }) {
  return h(Box, { width, height: 1, flexShrink: 0, overflow: 'hidden' }, h(Text, { wrap: 'truncate-end', bold: selected, dimColor: dim },
    ...spans.map((s, i) => h(Text, { key: i, color: noColor ? undefined : s.color, inverse: s.inverse,
      bold: s.bold, dimColor: s.dim, italic: s.italic, underline: s.underline, strikethrough: s.strikethrough }, sanitize(s.text)))));
}

export function Panel({ title, width, children }) {
  return h(Box, { width, flexDirection: 'column', borderStyle: single, flexShrink: 0 },
    h(Spans, { width: Math.max(0, width - 2), spans: [{ text: fitCell(` ${cleanCell(title)}`, Math.max(0, width - 2)), bold: true }] }), children);
}

export function Table({ title, columns, rows = [], width, selected, noColor = false }) {
  const padding = width >= columns.length * 4 + 2 ? 1 : 0;
  const sizes = columnWidths(columns, width, padding);
  const inner = Math.max(0, width - 2);
  function row(cells, key, header = false, chosen = false, dim = false) {
    return h(Box, { key, width: inner, height: 1, flexShrink: 0 }, ...columns.flatMap((column, i) => {
      const cell = cells[i] ?? {};
      const value = typeof cell === 'object' ? cell : { text: cell };
      const marker = i === 0 && chosen ? '›' : ' ';
      const text = !padding && i === 0 && chosen && sizes[i] > 0 ? '›' + fitCell(cleanCell(value.text), sizes[i] - 1, column.align)
        : (padding ? (i === 0 ? marker : ' ') : '') + fitCell(cleanCell(value.text), sizes[i], column.align) + ' '.repeat(padding);
      return [...(i ? [h(Text, { key: `sep:${i}` }, single.left)] : []),
        h(Spans, { key: `cell:${i}`, width: sizes[i] + padding * 2, selected: chosen, dim, noColor,
          spans: [{ ...value, text, bold: header || chosen }] })];
    }));
  }
  const rule = sizes.map(size => single.top.repeat(size + padding * 2)).join('┼');
  const body = h(Box, { flexDirection: 'column', flexShrink: 0 },
    row(columns.map(c => c.label), 'header', true), h(Text, { wrap: 'truncate' }, rule),
    ...rows.flatMap(r => [row(r.cells, r.id, false, r.id === selected, r.dim),
      ...(r.details ? [h(Spans, { key: `${r.id}:details`, width: inner, selected: r.id === selected, dim: r.dim, noColor,
        spans: [{ text: ' ' }, ...r.details] })] : [])]));
  return title === undefined ? h(Box, { width, borderStyle: single, flexDirection: 'column', flexShrink: 0 }, body)
    : h(Panel, { title, width }, body);
}
