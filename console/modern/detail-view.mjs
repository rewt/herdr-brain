import React from 'react';
import { Box } from 'ink';
import { renderMarkdown } from '../lib/markdown.mjs';
import { wrap } from '../lib/text.mjs';
import { Panel, Spans } from './table.mjs';
import { detailDuration } from './details.mjs';

const h = React.createElement;

export function detailLayout(document, cols, rows, now = Date.now()) {
  const width = Math.max(1, Math.min(cols, 116)), height = Math.max(1, rows), inner = Math.max(1, width - 4);
  const lines = [], sections = [];
  for (const section of document.sections) {
    if (lines.length) lines.push({ text: '' });
    const index = lines.length;
    sections.push({ id: section.id, index });
    lines.push({ id: section.id, text: section.title, bold: true, open: section.open });
    for (const entry of section.entries ?? []) {
      lines.push({ ...entry, text: entry.label, link: true, section: section.id });
    }
    let source = section.content;
    if (section.clock) {
      const c = section.clock, start = Date.parse(c.started), end = c.complete ? Date.parse(c.finished) : now;
      const duration = Number.isFinite(c.duration) ? c.duration : Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, (end - start) / 1000) : null;
      source = source.replace(/^Elapsed:.*$/m, `Elapsed: ${detailDuration(duration)}${c.complete ? ' · finished' : ''}`);
    }
    const content = section.log || section.code ? source.trimEnd().split('\n').flatMap(line => {
      const indent = ' '.repeat(Math.min(inner - 1, /^ */.exec(line)[0].length));
      return wrap(line.trimStart(), Math.max(1, inner - indent.length)).map(text => ({ text: indent + text, style: 'code' }));
    })
      : renderMarkdown(source, inner);
    lines.push(...content.map(line => ({ ...line, dim: line.style === 'meta', bold: ['heading', 'subheading'].includes(line.style) })));
  }
  return { width, height, lines, sections, capacity: Math.max(1, height - 5) };
}

export function detailTree(document, state, cols, rows, { noColor = false, now } = {}) {
  const layout = detailLayout(document, cols, rows, now), { width, height, lines, capacity } = layout;
  const max = Math.max(0, lines.length - capacity);
  const scroll = Math.max(0, Math.min(state.detailScroll ?? 0, max));
  const visible = lines.slice(scroll, scroll + capacity);
  while (visible.length < capacity) visible.push({ text: '' });
  const hits = [[{ id: 'back', from: 0, to: Math.min(13, width) }]];
  const controls = [{ id: 'back' }];
  visible.forEach((line, i) => {
    if (line.open) { hits[i + 3] = [{ id: line.id, from: 1, to: width - 1 }]; controls.push({ id: line.id }); }
  });
  const tree = h(Box, { width, height, flexDirection: 'column', overflow: 'hidden' },
    h(Spans, { width, spans: [{ text: '‹ Back  Esc', bold: true }] }),
    h(Panel, { width, title: document.title }, ...visible.map((line, i) => h(Spans, { key: i, width: Math.max(0, width - 2), noColor,
      selected: line.id && line.id === state.detailFocus, dim: line.dim,
      spans: [{ text: line.id === state.detailFocus ? '› ' : '  ' }, { text: line.text, bold: line.bold, underline: Boolean(line.open) }] }))),
    h(Spans, { width, dim: true, spans: [{ text: `↑↓ scroll · Tab section · ${scroll + 1}–${Math.min(lines.length, scroll + capacity)}/${lines.length}` }] }));
  return { tree, ...layout, scroll, hits, controls };
}
