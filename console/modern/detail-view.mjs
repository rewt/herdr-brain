import React from 'react';
import { Box } from 'ink';
import { renderMarkdown } from '../lib/markdown.mjs';
import { wrap } from '../lib/text.mjs';
import { Panel, Spans, fitCell, tableCellWidth } from './table.mjs';
import { detailDuration } from './details.mjs';
import { PIPELINE_MARKS, pipelineDuration } from './pipelines.mjs';

const h = React.createElement;
const colors = { done: 'green', running: 'cyan', failed: 'yellow' };

function chainLines(links, inner, now) {
  const lines = [];
  if (inner < 86) {
    for (const [i, link] of links.entries()) {
      if (i) lines.push({ text: '│', dim: true });
      const value = `${PIPELINE_MARKS[link.status]} ${link.label} · ${link.status} · ${pipelineDuration(link, now)}`;
      for (const text of wrap(value, inner)) lines.push({ ...link, text, link: true, section: 'pipeline', color: colors[link.status] });
    }
  } else {
    const sizes = links.map(link => Math.max(tableCellWidth(link.label) + 3, link.status.length + 1, pipelineDuration(link, now).length + 1));
    for (let offset = 0; offset < links.length;) {
      let end = offset, used = 0;
      while (end < links.length && used + sizes[end] + (end > offset ? 3 : 0) <= inner) {
        used += sizes[end] + (end > offset ? 3 : 0); end++;
      }
      if (end === offset) end++;
      if (offset) lines.push({ text: '↓', dim: true });
      for (let row = 0; row < 3; row++) {
        const cells = []; let x = 0;
        for (let i = offset; i < end; i++) {
          if (i > offset) x += 3;
          const link = links[i], size = Math.min(inner, sizes[i]);
          cells.push({ ...link, from: x, to: x + size, section: 'pipeline', link: true,
            labelRow: row === 0,
            text: fitCell(' ' + (row === 0 ? `${PIPELINE_MARKS[link.status]} ${link.label}` : row === 1 ? link.status : pipelineDuration(link, now)), size),
            color: colors[link.status] });
          x += size;
        }
        lines.push({ cells, connector: row === 0 ? ' → ' : '   ', text: cells.map(c => c.text).join(row === 0 ? ' → ' : '   ') });
      }
      offset = end;
    }
  }
  for (const link of links.filter(l => l.detail && (l.status === 'failed' || l.status === 'running')))
    lines.push(...wrap(`${PIPELINE_MARKS[link.status]} ${link.label}: ${link.detail}`, inner).map(text => ({ text, color: colors[link.status] })));
  return lines;
}

export function detailLayout(document, cols, rows, now = Date.now()) {
  const width = Math.max(1, Math.min(cols, 116)), height = Math.max(1, rows), inner = Math.max(1, width - 4);
  const lines = [], sections = [], links = [];
  for (const section of document.sections) {
    if (lines.length) lines.push({ text: '' });
    const index = lines.length;
    sections.push({ id: section.id, index });
    lines.push({ id: section.id, text: section.title, bold: true, open: section.open });
    if (section.pipeline) lines.push(...chainLines(section.pipeline, inner, now));
    for (const entry of section.entries ?? []) {
      lines.push({ ...entry, text: entry.label, link: true, section: section.id });
    }
    let source = section.content;
    if (section.clock) {
      const c = section.clock, start = Date.parse(c.started), end = c.complete || c.stopped ? Date.parse(c.finished) : now;
      const duration = Number.isFinite(c.duration) && c.duration >= 0 ? c.duration : Number.isFinite(start) && Number.isFinite(end) && end >= start ? (end - start) / 1000 : null;
      source = source.replace(/^Elapsed:.*$/m, `Elapsed: ${section.id === 'link' ? pipelineDuration({ status: c.complete ? 'done' : 'running', duration_s: duration }, now) : detailDuration(duration)}${c.complete && section.id !== 'link' ? ' · finished' : ''}`);
    }
    const content = section.log || section.code ? source.trimEnd().split('\n').flatMap(line => {
      const indent = ' '.repeat(Math.min(inner - 1, /^ */.exec(line)[0].length));
      return wrap(line.trimStart(), Math.max(1, inner - indent.length)).map(text => ({ text: indent + text, style: 'code' }));
    })
      : renderMarkdown(source, inner);
    lines.push(...content.map(line => ({ ...line, dim: line.style === 'meta', bold: ['heading', 'subheading'].includes(line.style) })));
  }
  const seen = new Set();
  lines.forEach((line, index) => {
    for (const control of line.cells ?? [line]) if (control.open && !seen.has(control.id)) {
      links.push({ ...control, index }); seen.add(control.id);
    }
  });
  return { width, height, lines, sections, links, capacity: Math.max(1, height - 5) };
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
    for (const control of line.cells ?? [line]) if (control.open) {
      (hits[i + 3] ??= []).push({ id: control.id, from: line.cells ? control.from + 3 : 1, to: line.cells ? control.to + 3 : width - 1 });
      if (!controls.some(c => c.id === control.id)) controls.push({ id: control.id });
    }
  });
  const tree = h(Box, { width, height, flexDirection: 'column', overflow: 'hidden' },
    h(Spans, { width, spans: [{ text: '‹ Back  Esc', bold: true }] }),
    h(Panel, { width, title: document.title }, ...visible.map((line, i) => h(Spans, { key: i, width: Math.max(0, width - 2), noColor,
      selected: line.id && line.id === state.detailFocus, dim: line.dim,
      spans: line.cells ? [{ text: '  ' }, ...line.cells.flatMap((cell, j) => [
        ...(j ? [{ text: line.connector, dim: true }] : []), { text: (cell.id === state.detailFocus && cell.labelRow ? '›' : ' ') + cell.text.slice(1), color: cell.color, underline: true, bold: cell.id === state.detailFocus,
          inverse: cell.id === state.detailFocus },
      ])] : [{ text: line.id === state.detailFocus ? '› ' : '  ' }, { text: line.text, color: line.color, bold: line.bold, underline: Boolean(line.open) }] }))),
    h(Spans, { width, dim: true, spans: [{ text: `↑↓ scroll/links · ←→ links · Tab · Enter · ${scroll + 1}–${Math.min(lines.length, scroll + capacity)}/${lines.length}` }] }));
  return { tree, ...layout, scroll, hits, controls };
}
