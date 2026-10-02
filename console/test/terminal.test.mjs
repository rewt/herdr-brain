import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createTerminalDecoder, observeTerminal, cropTerminalSpans } from '../modern/terminal.mjs';

const frame = (text, extra = {}) => ({ type: 'terminal.frame', encoding: 'ansi', full: true, width: 12, height: 3, seq: 1, bytes: Buffer.from(text).toString('base64'), ...extra });
const textLines = grid => grid.lines.map(line => line.spans.map(span => span.text).join(''));
const ESC = '\x1b';

test('observer frame preserves absolute positions, blank lines, padding and RGB harness styling', () => {
  const decoder = createTerminalDecoder();
  const grid = decoder.decode(frame(`${ESC}[?2026h${ESC}[?25l${ESC}[2J${ESC}]8;;${ESC}\\${ESC}[1;3H${ESC}[0;1;38;2;213;144;81;48;2;25;27;32mClaude${ESC}[0m${ESC}[3;2H> ${ESC}[?2026l`));
  assert.deepEqual(textLines(grid), ['  Claude    ', '            ', ' >          ']);
  const styled = grid.lines[0].spans.find(span => span.text === 'Claude');
  assert.equal(styled.fg, '#d59051'); assert.equal(styled.bg, '#191b20'); assert.equal(styled.bold, true);
  assert.equal(grid.lines[1].spans[0].fg, 'terminalFg');
  assert.equal(grid.lines[1].spans[0].bg, 'terminalBg');
  assert.equal(JSON.stringify(grid).includes('\\u001b'), false);
});

test('differential frames retain unaffected cells and do not mutate previously delivered grids', () => {
  const decoder = createTerminalDecoder();
  const first = decoder.decode(frame(`${ESC}[1;1HWorking${ESC}[2;1HKeep me`));
  const next = decoder.decode(frame(`${ESC}[1;1H${ESC}[32mDone${ESC}[0m${ESC}[K`, { full: false, seq: 2 }));
  assert.deepEqual(textLines(next), ['Done        ', 'Keep me     ', '            ']);
  assert.deepEqual(textLines(first), ['Working     ', 'Keep me     ', '            ']);
  assert.equal(next.lines[0].spans[0].fg, '#00cd00');
});

test('a differential gap or unexpected resize fails; a later full frame resynchronizes', () => {
  const decoder = createTerminalDecoder();
  assert.throws(() => decoder.decode(frame('missing baseline', { full: false })), /frame gap/);
  decoder.decode(frame('ready'));
  assert.throws(() => decoder.decode(frame('gap', { full: false, seq: 3 })), /frame gap/);
  assert.throws(() => decoder.decode(frame('resize', { full: false, seq: 2, width: 20 })), /frame gap/);
  const reset = decoder.decode(frame('new', { seq: 5, width: 5, height: 1 }));
  assert.deepEqual(textLines(reset), ['new  ']);
  assert.throws(() => decoder.decode(frame('old', { seq: 4 })), /Out-of-order/);
});

test('OSC clipboard/link/image strings and terminal modes never escape into visible spans', () => {
  const raw = `${ESC}]52;c;c2VjcmV0\x07${ESC}]8;;https://example.test${ESC}\\Safe${ESC}]8;;${ESC}\\${ESC}Pprivate-dcs${ESC}\\${ESC}_Gprivate-image${ESC}\\${ESC}[?1049h${ESC}[4 q`;
  const grid = createTerminalDecoder().decode(frame(raw));
  assert.deepEqual(textLines(grid), ['Safe        ', '            ', '            ']);
  assert.doesNotMatch(JSON.stringify(grid), /private|example|c2Vj|\\u001b/);
});

test('C1 controls, bidirectional overrides, invalid UTF8 and incomplete escapes are contained', () => {
  const grid = createTerminalDecoder().decode(frame('\x9b2;2H\x9d0;private\x9c\u202eok\u2066'));
  assert.deepEqual(textLines(grid), ['            ', ' ok         ', '            ']);
  assert.throws(() => createTerminalDecoder().decode(frame(`${ESC}[1;`)), /Incomplete/);
  assert.throws(() => createTerminalDecoder().decode(frame(`${ESC}]8;;unterminated`)), /Incomplete/);
  assert.throws(() => createTerminalDecoder().decode(frame('', { bytes: '/w==' })), /encoded data|encoding/i);
});

test('wide glyphs, combining accents and joined emoji keep their cell positions through updates', () => {
  const decoder = createTerminalDecoder();
  const first = decoder.decode(frame(`A界e\u0301👩‍💻!`));
  assert.equal(textLines(first)[0], 'A界é👩‍💻!     ');
  const second = decoder.decode(frame(`${ESC}[1;3HX${ESC}[1;5HQ`, { seq: 2, full: false }));
  assert.equal(textLines(second)[0], 'A XéQ !     ');
  const third = decoder.decode(frame(`${ESC}[1;12H界`, { seq: 3, full: false }));
  assert.deepEqual(textLines(third), textLines(second));
});

test('terminal styles use resets, inverse, conceal, indexed colors and colon RGB', () => {
  const grid = createTerminalDecoder().decode(frame(`${ESC}[1;2;3;4:3;7;38;5;196mA${ESC}[22;23;24;27;38:2::1:2:3;48:5:232mB${ESC}[8mSECRET${ESC}[28;9mZ${ESC}[0m!`));
  const spans = grid.lines[0].spans;
  assert.deepEqual([spans[0].bold, spans[0].dim, spans[0].italic, spans[0].underline, spans[0].inverse], [true, true, true, true, true]);
  assert.equal(spans[0].fg, '#ff0000');
  assert.equal(spans[1].fg, '#010203'); assert.equal(spans[1].bg, '#080808');
  assert.deepEqual([spans[1].bold, spans[1].dim, spans[1].italic, spans[1].underline, spans[1].inverse], [false, false, false, false, false]);
  assert.doesNotMatch(textLines(grid)[0], /SECRET/);
  assert.equal(spans.find(span => span.text === 'Z').strikethrough, true);
});

test('cursor moves, erase, CR/LF and tab act on the bounded grid', () => {
  const grid = createTerminalDecoder().decode(frame(`abc\rZ\n\tT${ESC}[1;2HQ${ESC}[1BX${ESC}[1D!${ESC}[3;1Hend${ESC}[2D${ESC}[X`));
  assert.deepEqual(textLines(grid), ['ZQc         ', '  !     T   ', 'e d         ']);
});

test('invalid dimensions, colors, record formats and unsupported controls fail honestly', () => {
  for (const bad of [{ width: 401 }, { height: 0 }, { seq: 0 }, { encoding: 'raw' }, { full: 'yes' }, { bytes: '**' }]) {
    assert.throws(() => createTerminalDecoder().decode(frame('', bad)), /Unsupported/);
  }
  assert.throws(() => createTerminalDecoder().decode(frame(`${ESC}[38;2;900;1;2m`)), /Invalid terminal color/);
  assert.throws(() => createTerminalDecoder().decode(frame(`${ESC}[1L`)), /Unsupported terminal control/);
  assert.throws(() => createTerminalDecoder().decode(frame(`${ESC}[999m`)), /Unsupported terminal style/);
});

function fakeProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.signals = [];
  child.kill = signal => { child.signals.push(signal); child.emit('close', null, signal); return true; };
  return child;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('observer owns an exact read-only argv with closed stdin and decodes split NDJSON chunks', async () => {
  const child = fakeProcess(), frames = [], errors = [], calls = [];
  const observer = observeTerminal({ pane: 'w12:p34', cols: 90, rows: 24, env: { HERDR_BIN_PATH: '/host/herdr' },
    onFrame: value => frames.push(value), onError: value => errors.push(value), spawnImpl: (...args) => { calls.push(args); return child; } });
  const encoded = JSON.stringify(frame('hello')) + '\n';
  child.stdout.write(encoded.slice(0, 25)); child.stdout.write(encoded.slice(25)); await tick();
  assert.deepEqual(calls[0][0], '/host/herdr');
  assert.deepEqual(calls[0][1], ['terminal', 'session', 'observe', 'w12:p34', '--cols', '90', '--rows', '24']);
  assert.deepEqual(calls[0][2].stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(frames.length, 1); assert.equal(errors.length, 0);
  observer.stop(); observer.stop();
  child.stdout.write(JSON.stringify(frame('late', { seq: 2 })) + '\n'); await tick();
  assert.deepEqual(child.signals, ['SIGTERM']); assert.equal(frames.length, 1); assert.equal(errors.length, 0);
});

test('observer protocol failure stops its own subprocess once and suppresses later callbacks', async () => {
  const child = fakeProcess(), frames = [], errors = [];
  observeTerminal({ pane: 'w1:p2', cols: 80, rows: 20, onFrame: value => frames.push(value), onError: value => errors.push(value), spawnImpl: () => child });
  child.stdout.write('{not-json}\n'); child.stdout.write(JSON.stringify(frame('later')) + '\n'); await tick();
  assert.equal(errors.length, 1); assert.equal(frames.length, 0); assert.deepEqual(child.signals, ['SIGTERM']);
});

test('server terminal.closed and unexpected EOF are visible; stopping never closes target panes', async () => {
  for (const kind of ['closed', 'eof']) {
    const child = fakeProcess(), errors = [];
    observeTerminal({ pane: 'w1:p2', cols: 80, rows: 20, onError: value => errors.push(value), spawnImpl: () => child });
    if (kind === 'closed') child.stdout.write(JSON.stringify({ type: 'terminal.closed', reason: 'session ended' }) + '\n');
    else { child.stderr.write('socket unavailable\n'); child.emit('close', 1, null); }
    await tick(); assert.equal(errors.length, 1); assert.match(errors[0], kind === 'closed' ? /session ended/ : /socket unavailable/);
    assert.deepEqual(child.signals, kind === 'closed' ? ['SIGTERM'] : []);
  }
});

test('observer rejects non-pane targets before spawning and reports spawn errors', () => {
  let spawned = false; const errors = [];
  observeTerminal({ pane: '--takeover', cols: 80, rows: 24, onError: value => errors.push(value), spawnImpl: () => { spawned = true; } });
  assert.equal(spawned, false); assert.match(errors[0], /exact Herdr pane/);
  observeTerminal({ pane: 'w1:p1', cols: 80, rows: 24, onError: value => errors.push(value), spawnImpl: () => { throw Error('binary missing'); } });
  assert.match(errors[1], /binary missing/);
});

test('observer times out a silent initial connection but an idle delivered frame stays valid', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const silent = fakeProcess(), errors = [];
  observeTerminal({ pane: 'w1:p1', cols: 80, rows: 24, onError: value => errors.push(value), spawnImpl: () => silent });
  t.mock.timers.tick(8000); assert.match(errors[0], /did not provide a frame/); assert.deepEqual(silent.signals, ['SIGTERM']);
  const idle = fakeProcess(), idleErrors = [];
  const observer = observeTerminal({ pane: 'w1:p1', cols: 80, rows: 24, onError: value => idleErrors.push(value), spawnImpl: () => idle });
  idle.stdout.write(JSON.stringify(frame('idle')) + '\n'); await tick();
  t.mock.timers.tick(60000); assert.deepEqual(idleErrors, []); assert.deepEqual(idle.signals, []); observer.stop();
});

test('a stubborn observer is killed after a bounded grace period, with no repeated cancellation', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeProcess();
  child.kill = signal => { child.signals.push(signal); return true; };
  const observer = observeTerminal({ pane: 'w1:p1', cols: 80, rows: 24, spawnImpl: () => child });
  observer.stop(); observer.stop(); assert.deepEqual(child.signals, ['SIGTERM']);
  t.mock.timers.tick(999); assert.deepEqual(child.signals, ['SIGTERM']);
  t.mock.timers.tick(1); assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  child.emit('close', null, 'SIGKILL'); t.mock.timers.tick(10000);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});

test('local horizontal crop preserves grapheme cells and styles, replacing clipped wide halves with spaces', () => {
  const spans = [{ text: 'A界é', fg: '#ffffff', bg: '#000000', bold: true }, { text: '👩‍💻!', fg: '#abcdef', bg: '#123456' }];
  const crop = cropTerminalSpans(spans, 2, 4);
  assert.equal(crop.map(s => s.text).join(''), ' é👩‍💻');
  assert.equal(crop[0].bold, true); assert.equal(crop.at(-1).fg, '#abcdef');
  assert.equal(cropTerminalSpans(spans, 0, 2).map(s => s.text).join(''), 'A ');
  assert.equal(cropTerminalSpans(spans, 4, 1).map(s => s.text).join(''), ' ');
  assert.equal(cropTerminalSpans(spans, 6, 4).map(s => s.text).join(''), '!   ');
});

test('native-size observer reads exact pane geometry and follows real size without cropping at console dimensions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let geometry = { width: 177, height: 79 }; const children = [], frames = [], errors = [];
  const spawnImpl = (_binary, args) => {
    const child = fakeProcess(); children.push({ child, args });
    if (args[0] === 'pane') queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ result: { layout: { panes: [{ pane_id: 'w1:p1', rect: geometry }] } } }));
      child.emit('close', 0, null);
    });
    return child;
  };
  const observer = observeTerminal({ pane: 'w1:p1', cols: 80, rows: 20, followNativeSize: true, spawnImpl, onFrame: f => frames.push(f), onError: e => errors.push(e) });
  await tick();
  assert.deepEqual(children[0].args, ['pane', 'layout', '--pane', 'w1:p1']);
  assert.deepEqual(children[1].args, ['terminal', 'session', 'observe', 'w1:p1', '--cols', '177', '--rows', '79']);
  children[1].child.stdout.write(JSON.stringify(frame(`${ESC}[77;1H> `, { width: 177, height: 79 })) + '\n'); await tick();
  assert.equal(frames[0].height, 79); assert.match(textLines(frames[0])[76], /^> /);
  t.mock.timers.tick(3000); await tick(); assert.equal(children.length, 3); // same size: no replacement observer
  geometry = { width: 160, height: 70 }; t.mock.timers.tick(3000); await tick();
  assert.deepEqual(children[1].child.signals, ['SIGTERM']);
  assert.deepEqual(children[4].args.slice(-4), ['--cols', '160', '--rows', '70']);
  observer.stop(); await tick(); assert.deepEqual(children[4].child.signals, ['SIGTERM']); assert.deepEqual(errors, []);
});

test('native geometry lookup failure never falls back to a misleading cropped observer', async () => {
  const errors = [], calls = [];
  const observer = observeTerminal({ pane: 'w1:p1', cols: 80, rows: 20, followNativeSize: true, onError: e => errors.push(e), spawnImpl: (_binary, args) => {
    const child = fakeProcess(); calls.push(args);
    queueMicrotask(() => { child.stdout.write(JSON.stringify({ result: { layout: { panes: [{ pane_id: 'w2:p1', rect: { width: 177, height: 79 } }] } } })); child.emit('close', 0, null); }); return child;
  } });
  await tick(); assert.equal(calls.length, 1); assert.match(errors[0], /dimensions are unavailable/); observer.stop();
});

test('stopping during native geometry discovery cancels only the owned query and emits no later error', async () => {
  const child = fakeProcess(), errors = [];
  const observer = observeTerminal({ pane: 'w1:p1', cols: 80, rows: 20, followNativeSize: true, onError: e => errors.push(e), spawnImpl: () => child });
  observer.stop(); await tick(); assert.deepEqual(child.signals, ['SIGTERM']); assert.deepEqual(errors, []);
});

test('an established live screen survives transient geometry failures but not persistent ones', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let failing = false; const children = [], frames = [], errors = [];
  const spawnImpl = (_binary, args) => {
    const child = fakeProcess(); children.push({ child, args });
    if (args[0] === 'pane') queueMicrotask(() => {
      if (failing) { child.stderr.write('server busy'); child.emit('close', 1, null); return; }
      child.stdout.write(JSON.stringify({ result: { layout: { panes: [{ pane_id: 'w1:p1', rect: { width: 12, height: 3 } }] } } }));
      child.emit('close', 0, null);
    });
    return child;
  };
  const observer = observeTerminal({ pane: 'w1:p1', followNativeSize: true, spawnImpl, onFrame: f => frames.push(f), onError: e => errors.push(e) });
  await tick(); children[1].child.stdout.write(JSON.stringify(frame('live')) + '\n'); await tick();
  assert.equal(frames.length, 1);
  failing = true;
  t.mock.timers.tick(3000); await tick(); t.mock.timers.tick(3000); await tick();
  assert.deepEqual(errors, []); assert.deepEqual(children[1].child.signals, []);
  failing = false; t.mock.timers.tick(3000); await tick(); // a success resets the count
  failing = true;
  t.mock.timers.tick(3000); await tick(); t.mock.timers.tick(3000); await tick();
  assert.deepEqual(errors, []);
  t.mock.timers.tick(3000); await tick();
  assert.equal(errors.length, 1); assert.match(errors[0], /server busy/); assert.deepEqual(children[1].child.signals, ['SIGTERM']);
  observer.stop();
});

test('a geometry failure before the first live screen still fails at once', async () => {
  const errors = [];
  const observer = observeTerminal({ pane: 'w1:p1', followNativeSize: true, onError: e => errors.push(e), spawnImpl: () => {
    const child = fakeProcess(); queueMicrotask(() => { child.stderr.write('no such pane'); child.emit('close', 1, null); }); return child;
  } });
  await tick(); assert.equal(errors.length, 1); observer.stop();
});
