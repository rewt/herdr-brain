import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { controlTerminal, splitInput, BACK_KEY } from '../modern/control.mjs';
import { createTerminalDecoder } from '../modern/terminal.mjs';

const ESC = '\x1b';
const frame = (text, extra = {}) => ({ type: 'terminal.frame', encoding: 'ansi', full: true, width: 12, height: 3, seq: 1, bytes: Buffer.from(text).toString('base64'), ...extra });
function fakeProcess() {
  const child = new EventEmitter(), written = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new PassThrough(); child.stdin.on('data', d => written.push(...String(d).trim().split('\n').map(l => JSON.parse(l))));
  child.kill = signal => { child.killed = signal; };
  return { child, written };
}
const tick = () => new Promise(r => setImmediate(r));

test('the controller streams frames and sends input, resize, scroll and release as Herdr commands', async () => {
  const { child, written } = fakeProcess(), calls = [], frames = [];
  const c = controlTerminal({ pane: 'w1:p2', cols: 80, rows: 20, onFrame: f => frames.push(f), spawnImpl: (...args) => { calls.push(args); return child; } });
  assert.deepEqual(calls[0][1], ['terminal', 'session', 'control', 'w1:p2', '--cols', '80', '--rows', '20']);
  child.stdout.write(JSON.stringify(frame(`${ESC}[1;1H> hi${ESC}[1;5H`)) + '\n'); await tick();
  assert.equal(frames.length, 1); assert.deepEqual(frames[0].cursor, { x: 4, y: 0, visible: true });
  c.input(Buffer.from('\x1b[A\x03é')); c.resize(100, 30); c.resize(0, 30); c.scroll('up', 3); c.release(); c.input(Buffer.from('late')); await tick();
  assert.deepEqual(written.map(w => w.type), ['terminal.input', 'terminal.resize', 'terminal.scroll', 'terminal.release']);
  assert.equal(Buffer.from(written[0].bytes, 'base64').toString(), '\x1b[A\x03é');
  assert.deepEqual([written[1].cols, written[1].rows], [100, 30]); assert.equal(written[2].direction, 'up');
});

test('the controller refuses non-pane targets and reports a closed terminal once', async () => {
  const errors = []; let spawned = false;
  controlTerminal({ pane: '--takeover', cols: 80, rows: 24, onError: e => errors.push(e), spawnImpl: () => { spawned = true; } });
  assert.equal(spawned, false); assert.match(errors[0], /exact Herdr pane/);
  const { child } = fakeProcess(), closed = [], failed = [];
  controlTerminal({ pane: 'w1:p2', cols: 80, rows: 20, onClose: r => closed.push(r), onError: e => failed.push(e), spawnImpl: () => child });
  child.stdout.write('{"type":"terminal.closed","reason":"detached"}\n'); await tick(); child.emit('close', 0);
  assert.deepEqual(closed, ['detached']); assert.deepEqual(failed, []);
});

test('typed input goes to the session except mouse reports and everything from Ctrl+] on', () => {
  assert.deepEqual(splitInput('ab\x1b[<0;10;5Mc'), { back: false, bytes: Buffer.from('abc') });
  assert.deepEqual(splitInput(`x${BACK_KEY}y`), { back: true, bytes: Buffer.from('x') });
  assert.equal(splitInput('héllo ✓').bytes.toString(), 'héllo ✓');
  assert.deepEqual([...splitInput(Buffer.from([0xc3, 0xa9, 0x1b])).bytes], [0xc3, 0xa9, 0x1b]);
});

test('the decoder follows cursor visibility', () => {
  const d = createTerminalDecoder();
  assert.equal(d.decode(frame(`${ESC}[?25l${ESC}[2;3H`)).cursor.visible, false);
  assert.deepEqual(d.decode(frame(`${ESC}[?25h`, { full: false, seq: 2 })).cursor, { x: 2, y: 1, visible: true });
});
