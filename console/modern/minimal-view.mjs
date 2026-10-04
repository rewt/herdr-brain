import React from 'react';
import { Box, Text, renderToString } from 'ink';
import { stripVTControlCharacters } from 'node:util';
import { duration, startText, shortTitle, shortModel } from './minimal.mjs';
import { sanitize } from '../lib/text.mjs';
import { Panel, Table, Spans, cleanCell, fitCell } from './table.mjs';
import { sessionScreenRows } from './session-screen.mjs';
import { MODERN_PALETTES } from './frame.mjs';

const h = React.createElement;
const bad = /blocked|refused|interrupted|fail|invalid|needs_human|no report|unavailable/;
export const outcomeColor = value => bad.test(value ?? '') ? 'yellow' : /done|pass|promoted|landed/.test(value ?? '') ? 'green' : undefined;
const stageColor = stage => ({ engineering: 'cyan', review: 'magenta', fix: 'yellow', blocked: 'yellow', landed: 'green' })[stage];
const elapsed = (seconds, now) => Number.isFinite(seconds) ? duration(new Date(now - Math.max(0, seconds) * 1000).toISOString(), now) : '?';
const provider = r => `${/claude/i.test(r.provider ?? '') ? 'Claude' : /codex/i.test(r.provider ?? '') ? 'Codex' : cleanCell(r.provider) || '?'}${r.model ? ` ${shortModel(r.model)}` : ''}`;
const span = (text, color) => ({ text: sanitize(text), color });
const row = (id, lines, open) => ({ id, lines, open, cost: lines.length });

export function checkElapsed(check, now) {
  if (check.checkComplete) {
    if (Number.isFinite(check.checkDurationSeconds)) return elapsed(check.checkDurationSeconds, now);
    const finish = Date.parse(check.checkFinished);
    return Number.isFinite(finish) ? duration(check.checkStarted, finish) : '?';
  }
  return duration(check.checkStarted, now);
}

export function minimalLayout({ project, sessions = [], runs = [], reports = [], train = {}, errors = {}, loading = false,
  now = Date.now(), selected, message = '', panelOffsets }, cols, height) {
  const width = Math.max(1, Math.min(cols, 116)), rows = Math.max(1, height), inner = Math.max(0, width - 2), compact = width < 90;
  const context = sessions.filter(s => ['supervisor', 'chat'].includes(s.stage));
  const contextText = context.length ? `Context · ${[
    ...context.filter(s => s.stage === 'supervisor').map(s => `supervisor ${provider(s)}`),
    context.some(s => s.stage === 'chat') ? `${context.filter(s => s.stage === 'chat').length} chats` : null,
  ].filter(Boolean).join(' · ')}` : '';
  const runColumns = compact ? (width < 28 ? [{ label: 'Run / Work', flex: 1 }] : [
    { label: 'Run', width: 6 }, { label: 'Work', min: 1, flex: 1 }, { label: 'Stage', width: 11 },
  ]) : [{ label: 'Run', width: 6 }, { label: 'Work', min: 8, flex: 1 }, { label: 'Stage', width: 11 },
    { label: 'Provider', width: 12 }, { label: 'Start', width: runs.some(r => startText(r.started, now).length > 5) ? 11 : 5 }, { label: 'Elapsed', width: 7, align: 'right' }];
  const work = runs.map(r => {
    const title = `${r.item ?? '?'} ${shortTitle(r.title)}`, stage = span(r.stage, stageColor(r.stage));
    const cells = compact ? (width < 28 ? [span(`${r.run} ${title}`)] : [span(r.run), span(title), stage])
      : [span(r.run), span(title), stage, span(provider(r)), span(startText(r.started, now)), span(elapsed(r.running_seconds, now))];
    cells[0].underline = true;
    const details = compact ? [span(`${width < 28 ? r.stage + ' · ' : ''}${provider(r)} · ${startText(r.started, now)} · ${elapsed(r.running_seconds, now)}`)] : null;
    return { id: `run:${r.run}`, cells, details, target: r.target,
      open: r.target && !['landed', 'blocked', 'finished'].includes(r.stage) ? { kind: 'session', target: r.target } : { kind: 'run', run: r.run },
      cost: compact ? 2 : 1, dim: r.stage === 'landed' };
  });
  const recent = reports.map(r => {
    const result = `${r.outcome} / ${r.check}`, meta = `${startText(r.at, now)}  ${r.run ?? '?'} ${r.item ?? '?'}`;
    const lines = compact ? [[span(`${meta}  `), span(result, outcomeColor(result))], [span(` ${r.headline}`)]]
      : [[span(`${meta}  `), span(result, outcomeColor(result)), span(`  ${r.headline}`)]];
    return row(`report:${r.id ?? r.run}`, lines, { kind: 'report', run: r.run, report: r.id });
  });
  const trainRows = [];
  const c = train.current;
  if (c) {
    const open = { kind: 'batch', batch: c.id };
    trainRows.push(row('train:current', [[span(`Batch · ${c.lanes.join(', ')} · `), span(c.phase, stageColor(c.phase))]], open));
    trainRows.push(row('train:clock', [[span(`${startText(c.started, now)} · ${duration(c.started, now)} · ${c.command ?? 'CI unknown'}`)]], open));
    if (c.command) trainRows.push(row('train:check', [[span(`Check ${startText(c.checkStarted, now)} · ${checkElapsed(c, now)}${c.checkComplete ? ' · finished' : ''}`)]], open));
  } else trainRows.push(row('train:idle', [[span('No batch running')]], { kind: 'idle' }));
  trainRows.push(row('train:waiting', [[span(`Waiting · ${train.waiting?.map(j => j.topic).join(', ') || 'none'}`)]], { kind: 'waiting' }));
  for (const j of train.waiting ?? []) trainRows.push(row(`train:member:${j.id ?? j.topic}`, [[span(j.topic)]], { kind: 'queued', job: j.id, topic: j.topic }));
  for (const b of train.interrupted ?? []) trainRows.push(row(`train:interrupted:${b.id}`, [[span('interrupted', 'yellow'), span(` · ${(b.jobs ?? []).map(j => j.topic).join(', ')}`)]], { kind: 'batch', batch: b.id }));
  for (const r of train.results ?? []) {
    const lines = [[span(`${startText(r.at, now)}  ${r.topic ?? '?'}  `), span(r.outcome, outcomeColor(r.outcome)),
      span(r.outcome === 'promoted' || compact ? '' : ` · ${r.reason ?? ''}`)]];
    if (compact && r.outcome !== 'promoted' && r.reason) lines.push([span(` ${r.reason}`)]);
    trainRows.push(row(`train:result:${r.id ?? r.topic}`, lines, { kind: 'result', job: r.id }));
  }
  const messages = [...Object.keys(errors).map(source => `${source} unavailable · last known data`), ...(message ? [message] : [])];
  const groups = [work, recent, trainRows], costs = [work.length ? 5 : 3, 3, 3];
  const caps = [0, 0, 0];
  let left = Math.max(0, rows - 1 - Number(Boolean(contextText)) - 1 - messages.length - costs.reduce((a, b) => a + b, 0));
  const offsets = groups.map((group, panel) => {
    const i = group.findIndex(r => r.id === selected);
    return Math.max(0, Math.min(group.length - 1, panelOffsets?.[panel] ?? (i >= 0 ? i : 0)));
  });
  // One whole row per panel before adding history. Never split a run/report.
  let progress = true;
  while (left && progress) {
    progress = false;
    for (const i of [0, 1, 2]) {
      const candidate = groups[i][offsets[i] + caps[i]] ?? (offsets[i] > 0 ? groups[i][offsets[i] - 1] : null);
      if (candidate && candidate.cost <= left) {
        if (!groups[i][offsets[i] + caps[i]]) offsets[i]--;
        caps[i]++; left -= candidate.cost; progress = true;
      }
    }
  }
  const visible = groups.map((group, i) => {
    const selection = group.findIndex(r => r.id === selected);
    if (selection >= 0 && caps[i] && (selection < offsets[i] || selection >= offsets[i] + caps[i])) offsets[i] = Math.max(0, selection - caps[i] + 1);
    return group.slice(offsets[i], offsets[i] + caps[i]);
  });
  const titles = [`Runs · ${runs.filter(r => r.stage !== 'landed').length} open${runs.some(r => r.stage === 'landed') ? ` · ${runs.filter(r => r.stage === 'landed').length} landed` : ''}`, `Reports · ${reports.length} recent`, 'Train']
    .map((title, i) => `${title}${groups[i].length > caps[i] ? ` · +${groups[i].length - caps[i]}` : ''}`);
  // Empty panels still explain their state if there is room.
  const empties = [loading ? 'Reading runs…' : 'No open runs', loading ? 'Reading reports…' : 'No recent reports'];
  for (const i of [0, 1]) if (!groups[i].length && left) { visible[i] = [row(`empty:${i}`, [[span(empties[i])]])]; left--; }
  let y = 1 + Number(Boolean(contextText));
  const hits = [], controls = [];
  if (contextText) { hits[1] = [{ id: 'context', from: 0, to: width }]; controls.push({ id: 'context' }); }
  visible.forEach((group, i) => {
    let at = y + 2 + (i === 0 && work.length ? 2 : 0);
    for (const r of group) {
      if (r.open) { controls.push({ id: r.id }); for (let n = 0; n < r.cost; n++) hits[at + n] = [{ from: 1, to: width - 1, id: r.id }]; }
      at += r.cost;
    }
    y += costs[i] + group.reduce((sum, r) => sum + r.cost, 0);
  });
  return { width, rows, inner, contextText, visible, groups, titles, runColumns, hits, controls, messages, offsets,
    header: `${project?.name ?? 'Project'} · ${reports.filter(r => r.attention).length} need attention`, selected };
}

function Dashboard({ layout, noColor }) {
  const l = layout;
  const rows = group => group.flatMap(r => r.lines.map((spans, i) => h(Spans, { key: `${r.id}:${i}`, spans: [{ text: r.id === l.selected ? '›' : ' ' }, ...spans], width: l.inner, selected: r.id === l.selected, noColor })));
  return h(Box, { width: l.width, height: l.rows, flexDirection: 'column', overflow: 'hidden' },
    h(Box, { width: l.width, height: Math.max(0, l.rows - 1), flexDirection: 'column', overflow: 'hidden', flexShrink: 0 },
    h(Spans, { width: l.width, spans: [{ text: l.header, bold: true }] }),
    ...(l.contextText ? [h(Spans, { key: 'context', width: l.width, dim: true, selected: l.selected === 'context', spans: [{ text: (l.selected === 'context' ? '› ' : '') + l.contextText, underline: true }] })] : []),
    l.groups[0].length ? h(Table, { title: l.titles[0], width: l.width, columns: l.runColumns, rows: l.visible[0], selected: l.selected, noColor })
      : h(Panel, { title: l.titles[0], width: l.width }, ...rows(l.visible[0])),
    h(Panel, { title: l.titles[1], width: l.width }, ...rows(l.visible[1])),
    h(Panel, { title: l.titles[2], width: l.width }, ...rows(l.visible[2])),
    ...l.messages.map((text, i) => h(Spans, { key: `error:${i}`, width: l.width, dim: true, spans: [span(text)] }))),
    h(Spans, { width: l.width, dim: true, spans: [span(l.width >= 40 ? '↑↓ rows · Tab panels · Enter · q quit' : 'Tab · Enter · q quit')] }));
}

export function SessionView({ state, cols, rows, noColor }) {
  const width = Math.max(1, Math.min(cols, 400)), height = Math.max(1, rows), available = Math.max(1, Math.min(160, height - 2 - Number(Boolean(state.outputError))));
  state.screenViewport = { cols: width, rows: available };
  const palette = MODERN_PALETTES[state.appearance];
  const grid = sessionScreenRows(state.terminalFrame, width, available);
  return h(Box, { width, height, flexDirection: 'column', overflow: 'hidden' },
    h(Spans, { width, spans: [{ text: `‹ Back  Esc   ${cleanCell(state.active?.name ?? state.pane)}`, bold: true }] }),
    ...(state.outputError ? [h(Spans, { width, spans: [span(state.outputError)] })] : []),
    ...(grid.length ? grid.map((spans, i) => h(Box, { key: i, width, height: 1, flexShrink: 0 }, h(Text, { wrap: 'truncate-end' },
      ...spans.map((s, j) => h(Text, { key: j, color: noColor ? undefined : s.fg === 'terminalFg' ? '#e4e4e4' : palette[s.fg] ?? s.fg,
        backgroundColor: noColor ? undefined : s.bg === 'terminalBg' ? '#101216' : palette[s.bg] ?? s.bg,
        bold: s.bold, dimColor: s.dim, inverse: s.inverse, underline: s.underline, italic: s.italic, strikethrough: s.strikethrough }, s.text)))))
      : [h(Spans, { key: 'connecting', width, spans: [span(state.interactive ? 'Connecting to session…' : 'Session unavailable · Esc back')] })]),
    h(Box, { flexGrow: 1 }),
    h(Spans, { width, spans: [span('Esc back · Ctrl+\\ interrupt (Esc)')] }));
}

export function minimalTree(data, cols, rows, { noColor = Boolean(process.env.NO_COLOR) } = {}) {
  const layout = minimalLayout(data, cols, rows);
  return { tree: h(Dashboard, { layout, noColor }), ...layout };
}

export function inkFrame(tree, cols, rows, metadata = {}) {
  const output = stripVTControlCharacters(renderToString(tree, { columns: cols }));
  const lines = output.split('\n').slice(0, rows).map(text => ({ spans: [{ text: fitCell(text, cols) }] }));
  while (lines.length < rows) lines.push({ spans: [{ text: ' '.repeat(cols) }] });
  return { ...metadata, tree, lines };
}

export function minimalFrame(data, cols, rows) {
  const view = minimalTree(data, cols, rows, { noColor: true });
  return inkFrame(view.tree, cols, rows, { hits: view.hits, controls: view.controls });
}
