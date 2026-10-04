import { inkTest as test, React, ink, minimalView } from './optional-ink.mjs';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
const { render, renderToString } = ink ?? {};
const { Table, columnWidths } = ink ? await import('../modern/table.mjs') : {};
const { minimalTree, minimalLayout } = minimalView;
import { cellWidth } from '../lib/text.mjs';

const h = React?.createElement;
const columns = [{ label: 'Run', width: 6 }, { label: 'Work', flex: 1, min: 1 }, { label: 'Elapsed', width: 7, align: 'right' }];
const rows = [{ id: 'a', cells: [{ text: 'R-242' }, { text: '会話\x1b[2J and a long title' }, { text: '20m' }] },
  { id: 'b', cells: [{ text: 'R-2' }, { text: 'Cafe\u0301' }, { text: '1h 2m' }] }];

test('Ink Table has bounded borders, aligned columns, header rules and cell truncation', () => {
  for (const width of [24, 40, 100]) {
    const output = renderToString(h(Table, { columns, rows, width, noColor: true }), { columns: width });
    const lines = output.split('\n');
    assert.ok(lines.every(line => cellWidth(line) === width), output);
    assert.ok(lines[0].startsWith('┌') && lines.at(-1).endsWith('┘'));
    assert.match(lines[2], /─┼─/); assert.match(lines[1], /Run/);
    assert.doesNotMatch(output, /\x1b/);
    const separators = line => [...line].reduce((acc, c) => { if (c === '│') acc.positions.push(acc.width); acc.width += cellWidth(c); return acc; }, { positions: [], width: 0 }).positions;
    assert.deepEqual(separators(lines[1]), separators(lines[3])); assert.deepEqual(separators(lines[3]), separators(lines[4]));
    assert.match(lines[3], /20m │$/); assert.match(lines[4], /1h 2m │$/);
    if (width === 24) assert.match(lines[3], /…/);
    const sizes = columnWidths(columns, width);
    assert.equal(sizes.reduce((a, b) => a + b, 0) + 2 + 2 + 6, width);
  }
});

test('Ink Table handles empty rows and strips controls from labels and cells', () => {
  const output = renderToString(h(Table, { width: 30, title: 'Runs\x1b]0;bad\x07', columns, rows: [] }), { columns: 30 });
  assert.equal(output.split('\n').length, 5); assert.doesNotMatch(output, /bad|\x1b|\x07/); assert.match(output, /Runs/);
});

test('Ink rendering writes nothing for unchanged facts and resizes between narrow and wide tables', async () => {
  const writes = [];
  const stdout = new Writable({ write(chunk, encoding, done) { writes.push(String(chunk)); done(); } });
  stdout.isTTY = true; stdout.columns = 100; stdout.rows = 25;
  const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => {};
  const data = { project: { name: 'Live' }, now: Date.parse('2026-10-04T17:00:00Z'), runs: [
    { run: 'R-242', item: 'ENG-188', title: 'Console', stage: 'engineering', provider: 'codex', started: '2026-10-04T16:40:00Z', running_seconds: 1200 },
  ] };
  const instance = render(minimalTree(data, 100, 24, { noColor: true }).tree, { stdout, stdin, stderr: stdout, patchConsole: false,
    incrementalRendering: true, maxFps: 100, exitOnCtrlC: false });
  try {
    await delay(40); const before = writes.length;
    instance.rerender(minimalTree({ ...data }, 100, 24, { noColor: true }).tree); await delay(40);
    assert.equal(writes.length, before, 'unchanged output must issue no terminal write');
    instance.rerender(minimalTree({ ...data, runs: [{ ...data.runs[0], running_seconds: 1260 }] }, 100, 24, { noColor: true }).tree); await delay(40);
    assert.match(writes.slice(before).join(''), /21m/); assert.doesNotMatch(writes.slice(before).join(''), /Live|Reports|Train/);
    stdout.columns = 40; stdout.emit('resize');
    instance.rerender(minimalTree(data, 40, 24, { noColor: true }).tree); await delay(40);
    assert.match(writes.join(''), /Codex ·/);
    stdout.columns = 100; stdout.emit('resize');
    instance.rerender(minimalTree(data, 100, 24, { noColor: true }).tree); await delay(40);
    assert.match(writes.join(''), /Provider/);
  } finally { instance.unmount(); instance.cleanup(); stdin.destroy(); stdout.destroy(); }
});

test('short panes allocate whole entries, retain panel headings and keep selected history visible', () => {
  const runs = Array.from({ length: 20 }, (_, i) => ({ run: `R-${i}`, item: `ENG-${i}`, title: 'Console', stage: 'review', provider: 'codex', running_seconds: 600 }));
  for (const width of [20, 40, 80, 100, 140]) for (const height of [12, 18, 24, 40]) {
    const data = { runs, selected: 'run:R-19' }, layout = minimalLayout(data, width, height);
    const output = renderToString(minimalTree(data, width, height, { noColor: true }).tree, { columns: width });
    assert.equal(output.split('\n').length, height); assert.ok(output.split('\n').every(line => cellWidth(line) <= width));
    assert.match(output, /Runs/); assert.match(output, /Reports/); assert.match(output, /Train/); assert.match(output, /q quit/);
    if (layout.visible[0].length) assert.ok(layout.visible[0].some(r => r.id === 'run:R-19'));
  }
});

test('table truncation preserves joined emoji, flags and combining glyphs as whole cells', async () => {
  const { fitCell, tableCellWidth } = await import('../modern/table.mjs');
  for (const value of ['👩🏽‍💻 work', '🇺🇸 flags', '1️⃣ keycap', 'e\u0301 accent', '会話']) for (const width of [0, 1, 2, 3, 6, 20]) {
    assert.equal(tableCellWidth(fitCell(value, width)), width, `${value} at ${width}`);
  }
  assert.equal(fitCell('👩🏽‍💻x', 2), '… ');
  const output = renderToString(h(Table, { columns, width: 40, rows: [{ id: 'emoji', cells: ['R-1', '👩🏽‍💻 🇺🇸 e\u0301', '20m'] }] }), { columns: 40 });
  assert.ok(output.split('\n').every(line => tableCellWidth(line) === 40));
});
