import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createBoard, parseOptions } from '../board/board.mjs';
import { parseMemory, readSlot, rowSlot, paneState } from '../board/facts.mjs';
import { render, live } from '../board/render.mjs';
import { validateDocument } from '../board/rows.mjs';
import { brainFixture, boardFixture } from './helpers/board-fixture.mjs';

const emptySlot = () => ({ state: 'free', label: null, project: null, heldSeconds: null, queueLength: 0, holderWorktree: null, queueWorktrees: [] });
const snapshot = f => ({ memory: 6 * 1024 ** 3, herdr: 'available', slot: emptySlot(), rows: validateDocument(f.document(), f.options).rows.map(r => ({ ...r, slot: '#2 in queue' })) });
test('memory parsers honor page size and exact available fields; Herdr validates pane handles and absence', async t => {
  const f = boardFixture(t);
  assert.equal(parseMemory('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.\nPages speculative: 3.\nPages wired down: 900.\n', 'darwin'), 33 * 16384);
  assert.equal(parseMemory('MemFree: 100 kB\nMemAvailable: 1234 kB\nCached: 999 kB\n', 'linux'), 1234 * 1024);
  for (const platform of ['linux', 'darwin', 'other']) assert.equal(parseMemory('unrelated', platform), null);
  assert.equal((await paneState({ command: path.join(f.root, 'absent') })).state, 'unavailable');
  const fake = f.write('herdr', '#!/bin/sh\nprintf \'%s\\n\' \'{"result":{"agents":[{"pane_id":"w2XS:p4"},{"pane_id":"w2XS:p4\\u001b"}]}}\'\n'); fs.chmodSync(fake, 0o755);
  const state = await paneState({ command: fake }); assert.equal(state.state, 'available'); assert.deepEqual([...state.panes], ['w2XS:p4']);
  fs.writeFileSync(fake, '#!/bin/sh\necho PLANTED\n'); assert.equal((await paneState({ command: fake })).state, 'unavailable');
});
test('board ticks never write, open for write, prune, rename or unlink the slot or queue', async t => {
  const f = brainFixture(t), now = f.now, lockPath = f.write('slot.lock', { pid: process.pid, pgid: null, processStart: '', token: 'PLANTED', label: 'gate running', cwd: f.root + '/active/sub', acquiredAt: '2026-10-16T12:00:00Z' });
  fs.mkdirSync(f.root + '/active/sub');
  const ticket = { v: 1, pid: process.pid, processStart: '', token: 'PLANTED', label: 'gate queue', cwd: f.root + '/waiting/sub', arrivedAt: '2026-10-16T12:01:00Z', expiresAt: '2026-10-16T15:00:00Z' };
  fs.mkdirSync(f.root + '/waiting/sub');
  f.write('slot.lock.queue/0000000000000001-fixture.json', ticket);
  f.write('slot.lock.queue/0000000000000002-expired.json', { ...ticket, expiresAt: '2026-10-14T00:00:00Z' });
  f.write('slot.lock.queue/0000000000000003-malformed.json', '{');
  const protectedPath = file => typeof file === 'string' && (file === lockPath || file === lockPath + '.queue' || file.startsWith(lockPath + '.queue/'));
  let mutations = 0, readOpens = 0; const undo = [], descriptors = new Set();
  function intercept(object, method, wrapper) {
    const original = object[method]; if (!original) return;
    object[method] = wrapper(original); undo.push(() => { object[method] = original; });
  }
  for (const object of [fs, fs.promises]) {
    for (const method of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'rename', 'renameSync', 'unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'mkdir', 'mkdirSync', 'truncate', 'truncateSync', 'link', 'linkSync', 'symlink', 'symlinkSync', 'createWriteStream', 'copyFile', 'copyFileSync', 'chmod', 'chmodSync', 'chown', 'chownSync', 'utimes', 'utimesSync']) intercept(object, method, original => function(...args) {
      if (args.slice(0, 2).some(protectedPath)) { mutations++; throw Error('intercepted slot mutation'); }
      return original.apply(this, args);
    });
    for (const method of ['open', 'openSync']) intercept(object, method, original => function(file, flags, ...args) {
      const protectedFile = protectedPath(file);
      if (protectedFile && flags !== 'r' && flags !== fs.constants.O_RDONLY) { mutations++; throw Error('intercepted writable open'); }
      if (protectedFile) readOpens++;
      const result = original.call(this, file, flags, ...args);
      if (protectedFile && typeof result === 'number') descriptors.add(result);
      return result;
    });
    for (const method of ['write', 'writeSync', 'ftruncate', 'ftruncateSync', 'fchmod', 'fchmodSync']) intercept(object, method, original => function(fd, ...args) {
      if (descriptors.has(fd)) { mutations++; throw Error('intercepted descriptor mutation'); }
      return original.call(this, fd, ...args);
    });
  }
  try {
    // Positive control proves the interceptor fires before an actual mutation.
    assert.throws(() => fs.openSync(lockPath, 'a'), /intercepted/); assert.equal(mutations, 1); mutations = 0;
    const collect = createBoard({ projects: [f.root], roots: [], sources: [] }, {
      discover: () => f.project, brain: p => import('../board/brain.mjs').then(m => m.brainSource(p, { now, show: f.show })),
      memory: async () => null, panes: async () => ({ state: 'unavailable', panes: new Set() }), slot: ({ projects }) => readSlot({ lockPath, projects, now }),
    });
    const a = await collect(), b = await collect(); assert.deepEqual(a, b);
    assert.equal(a.slot.label, 'gate running'); assert.equal(a.slot.project, 'herdr-brain'); assert.equal(a.slot.heldSeconds, 3600); assert.equal(a.slot.queueLength, 1);
    assert.equal(a.rows.find(r => r.id === 'job-active').slot, 'holder');
    assert.equal(a.rows.find(r => r.id === 'job-queued').slot, '#1 in queue');
    assert.equal(rowSlot(f.root + '/wait', readSlot({ lockPath, now })), '');
    assert.equal(JSON.stringify(a).includes('PLANTED'), false); assert.equal('holderWorktree' in a.slot, false);
    assert.equal(a.rows.some(r => 'worktree' in r), false);
    assert.equal(mutations, 0); assert.ok(readOpens > 0);
  } finally { for (const restore of undo.reverse()) restore(); }
  assert.equal(fs.readdirSync(lockPath + '.queue').length, 3);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, pgid: null, token: 'PLANTED', label: 'token=PLANTED', cwd: f.root, acquiredAt: 'invalid' }));
  const withheld = readSlot({ lockPath }); assert.equal(withheld.label, 'withheld'); assert.equal(withheld.heldSeconds, null);
});
test('renderer fits 80 and 160 columns, preserves fields at wide widths, and restores every signal', async t => {
  const f = boardFixture(t), data = snapshot(f);
  for (const width of [8, 80, 160]) {
    const text = render(data, { width, now: Date.parse('2026-10-16T12:10:00Z') });
    assert.ok(text.split('\n').every(line => line.length <= width)); assert.equal(text.includes('\x1b'), false);
    if (width === 160) for (const title of ['RESULT / MAIN', 'WHERE', 'CLOCKS']) assert.ok(text.includes(title));
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) for (const noColor of [false, true]) {
    const signals = new EventEmitter(), chunks = []; let frames = 0;
    const output = { isTTY: true, columns: 80, rows: 24, write(s) { chunks.push(s); if (s.includes('Promotion board') && ++frames === 1) queueMicrotask(() => signals.emit(signal)); } };
    await live({ output, signals, noColor, collect: async () => data, interval: 1 });
    const text = chunks.join('');
    if (noColor) assert.equal(text.includes('\x1b'), false);
    else { assert.ok(text.startsWith('\x1b[?1049h\x1b[?25l')); assert.ok(text.endsWith('\x1b[?25h\x1b[?1049l')); }
    assert.equal(signals.listenerCount(signal), 0);
  }
  assert.ok(render(data, { height: 3 }).split('\n').length <= 3);
});
test('CLI validates options, independent snapshots survive closure, and all sources pass through the privacy filter', async t => {
  const f = boardFixture(t), raw = f.document(); raw.rows[0].status.text = 'PLANTED_token_123'; raw.rows[0].where.pane = 'wGone:p9';
  const script = f.write('rows.mjs', `console.log(${JSON.stringify(JSON.stringify(raw))});`);
  const args = ['--project', f.root, '--source', 'bch=rows.mjs', '--log-root', f.root, '--once'];
  const parsed = parseOptions([...args, '--interval', '0.5']); assert.equal(parsed.interval, 500); assert.equal(parsed.sources[0].script, script);
  assert.equal(parseOptions(['--project', f.root, '--source', 'one=a.mjs', '--project', f.root + '/logs', '--source', 'two=b.mjs']).sources[1].project, f.root + '/logs');
  for (const invalid of [['--interval', '0'], ['--interval', 'NaN'], ['--source', 'Bad=a'], ['--project'], ['--bogus']]) assert.throws(() => parseOptions(invalid));
  const cli = new URL('../board/board.mjs', import.meta.url);
  const run = (extra, width = 80) => spawnSync(process.execPath, [cli.pathname, ...args, ...extra], { env: { ...process.env, NO_COLOR: '1', COLUMNS: String(width) }, encoding: 'utf8', timeout: 15000 });
  for (const width of [80, 160]) { const r = run([], width); assert.equal(r.status, 0, r.stderr); assert.ok(r.stdout.split('\n').every(l => l.length <= width)); assert.equal(r.stdout.includes('\x1b'), false); assert.equal(r.stdout.includes('PLANTED'), false); }
  const a = run(['--json']), b = run(['--json']); assert.equal(a.status, 0, a.stderr); assert.equal(b.status, 0, b.stderr);
  assert.deepEqual(JSON.parse(a.stdout).rows, JSON.parse(b.stdout).rows);
  const row = JSON.parse(a.stdout).rows.find(r => r.project === 'bch-cloak');
  assert.equal(row.status.text, 'withheld'); assert.equal(row.where.pane, 'withheld'); assert.equal(row.where.log, f.log); assert.equal('worktree' in row, false);
  const collect = createBoard({ projects: [f.root], sources: [], roots: [f.root] }, { discover: () => ({ identity: f.root, paths: [f.root] }), brain: async () => raw,
    memory: async () => null, panes: async () => ({ state: 'unavailable', panes: new Set() }), slot: emptySlot });
  assert.equal((await collect()).rows[0].status.text, 'withheld');
  assert.ok(render({ ...snapshot(f), rows: [row] }, { width: 240 }).includes('job.log'));
});
test('the release archive includes the board and its dependency closure', t => {
  if (!fs.existsSync(new URL('../.git', import.meta.url))) { t.skip('git-archive snapshot has no repository metadata'); return; }
  const archive = execFileSync('git', ['archive', 'HEAD'], { maxBuffer: 32 * 1024 * 1024 });
  // tar reads archive bytes on stdin; no release activation, tag or live gate.
  const listing = execFileSync('tar', ['-tf', '-'], { input: archive, encoding: 'utf8' });
  for (const name of ['board/board.mjs', 'board/rows.mjs', 'board/brain.mjs', 'contrib/settle-watch.mjs', 'lib/cli-help.mjs']) assert.ok(listing.split('\n').includes(name), name);
});
