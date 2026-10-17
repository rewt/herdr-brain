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
import { brainSource, discoverProject } from '../board/brain.mjs';
import { brainFixture, boardFixture } from './helpers/board-fixture.mjs';

const emptySlot = () => ({ state: 'free', label: null, project: null, heldSeconds: null, queueLength: 0, sharedCount: 0, holderWorktree: null, queueWorktrees: [] });
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
test('board ticks count shared occupancy without writing, pruning or changing the slot, queue or occupancy', async t => {
  const f = brainFixture(t), now = f.now, lockPath = f.write('slot.lock', { pid: process.pid, pgid: null, processStart: '', token: 'PLANTED', label: 'gate running', cwd: f.root + '/active/sub', acquiredAt: '2026-10-16T12:00:00Z' });
  fs.mkdirSync(f.root + '/active/sub');
  const ticket = { v: 1, pid: process.pid, processStart: '', token: 'PLANTED', label: 'gate queue', cwd: f.root + '/waiting/sub', arrivedAt: '2026-10-16T12:01:00Z', expiresAt: '2026-10-16T15:00:00Z' };
  fs.mkdirSync(f.root + '/waiting/sub');
  f.write('slot.lock.queue/0000000000000001-fixture.json', ticket);
  f.write('slot.lock.queue/0000000000000002-expired.json', { ...ticket, expiresAt: '2026-10-14T00:00:00Z' });
  f.write('slot.lock.queue/0000000000000003-malformed.json', '{');
  const shared = { schema: 'occupancy/v1', class: 'shared', pid: process.pid, processStart: null, pgid: null, acquiredAt: '2026-10-16T12:00:00Z', project: 'PLANTED', label: 'PLANTED' };
  f.write('slot.lock.occupancy/one.json', shared);
  f.write('slot.lock.occupancy/two.json', shared);
  f.write('slot.lock.occupancy/gone.json', { ...shared, pid: 2147483647 });
  f.write('slot.lock.occupancy/future.json', { ...shared, schema: 'occupancy/v2' });
  const protectedPath = file => typeof file === 'string' && (file === lockPath || ['.queue', '.occupancy'].some(suffix => file === lockPath + suffix || file.startsWith(lockPath + suffix + '/')));
  let mutations = 0, readOpens = 0; const undo = [], descriptors = new Set();
  function intercept(object, method, wrapper) {
    const original = object[method]; if (!original) return;
    object[method] = wrapper(original); undo.push(() => { object[method] = original; });
  }
  for (const object of [fs, fs.promises]) {
    for (const method of ['readFile', 'readFileSync', 'createReadStream']) intercept(object, method, original => function(file, options, ...args) {
      // Node's optimized readFileSync can bypass the public openSync hook.
      const flags = typeof options === 'object' ? options?.flag ?? options?.flags ?? 'r' : 'r';
      if (protectedPath(file) && flags !== 'r' && flags !== fs.constants.O_RDONLY) { mutations++; throw Error('intercepted writable read'); }
      return original.call(this, file, options, ...args);
    });
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
      discover: () => f.project, refresh: p => p, brain: p => import('../board/brain.mjs').then(m => m.brainSource(p, { now, show: f.show })),
      memory: async () => null, panes: async () => ({ state: 'unavailable', panes: new Set() }), slot: ({ projects }) => readSlot({ lockPath, projects, now }),
    });
    const a = await collect(), b = await collect(); assert.deepEqual(a, b);
    assert.equal(a.slot.label, 'gate running'); assert.equal(a.slot.project, 'herdr-brain'); assert.equal(a.slot.heldSeconds, 3600); assert.equal(a.slot.queueLength, 1);
    assert.equal(a.slot.sharedCount, 2);
    assert.match(render(a, { width: 160 }), /shared 2/);
    assert.equal(a.rows.find(r => r.id === 'job-active').slot, 'holder');
    assert.equal(a.rows.find(r => r.id === 'job-queued').slot, '#1 in queue');
    assert.equal(rowSlot(f.root + '/wait', readSlot({ lockPath, now })), '');
    assert.equal(JSON.stringify(a).includes('PLANTED'), false); assert.equal('holderWorktree' in a.slot, false);
    assert.equal(a.rows.some(r => 'worktree' in r), false);
    assert.equal(mutations, 0); assert.ok(readOpens > 0);
  } finally { for (const restore of undo.reverse()) restore(); }
  assert.equal(fs.readdirSync(lockPath + '.queue').length, 3);
  assert.equal(fs.readdirSync(lockPath + '.occupancy').length, 4, 'gone and unknown-schema records remain untouched');
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
  assert.ok(render({ ...data, rows: [{ ...data.rows[0], stage: null }] }).includes('stage'));
});
test('a signal exits a fake TTY promptly even with a never-resolving collection and restores default signal handling', async () => {
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const signals = new EventEmitter(), chunks = []; let entered, exits = 0, deadline;
    const started = new Promise(resolve => { entered = resolve; });
    const output = { isTTY: true, columns: 80, rows: 24, write: text => chunks.push(text) };
    const pending = live({ output, signals, noColor: false, collect: () => { entered(); return new Promise(() => {}); }, exit: () => { exits++; } });
    await started;
    signals.emit(name);
    assert.equal(exits, 1);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(signals.listenerCount(signal), 0, 'handlers removed during restoration');
    assert.equal(signals.emit(name), false, 'repeated signal has no board handler');
    assert.equal(exits, 1); assert.ok(chunks.join('').endsWith('\x1b[?25h\x1b[?1049l'));
    try { await Promise.race([pending, new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('signal waited for collect')), 1000); })]); }
    finally { clearTimeout(deadline); }
  }
});
test('board-scoped record cache reads finished rows once and refreshes active rows no faster than five seconds', async t => {
  const f = brainFixture(t), calls = []; let now = f.now;
  const options = { projects: [f.root], sources: [], roots: [] };
  const dependencies = { discover: () => f.project, refresh: p => p, memory: async () => null,
    panes: async () => ({ state: 'available', panes: f.options.panes }), slot: emptySlot,
    brain: (p, cache) => brainSource(p, { ...cache, now, show: async (...args) => { calls.push(args[2]); return f.show(...args); } }) };
  const collect = createBoard(options, dependencies);
  await collect(); assert.deepEqual(calls.slice().sort(), ['ENG-1', 'ENG-2', 'ENG-3', 'R-1', 'R-2', 'R-3']);
  const first = calls.length;
  await collect(); now += 4999; await collect(); assert.equal(calls.length, first, 'unchanged second ticks perform no record reads');
  now++; await collect(); assert.deepEqual(calls.slice(first).sort(), ['ENG-1', 'ENG-3', 'R-1', 'R-3']);
  now += 50000; await collect(); assert.equal(calls.filter(id => id === 'R-2').length, 1, 'finished run remains cached');
  assert.equal(calls.filter(id => id === 'ENG-2').length, 1, 'finished item remains cached');
  const queued = f.queue.pending.pop(); f.queue.results.push({ ...queued, outcome: 'refused', finished: new Date(now).toISOString() }); f.save();
  const beforeFinish = calls.filter(id => id === 'R-3').length;
  assert.equal((await collect()).rows.find(r => r.id === queued.id).phase, 'failed');
  assert.equal(calls.filter(id => id === 'R-3').length, beforeFinish + 1, 'terminal transition is captured once');
  now += 5000; await collect(); assert.equal(calls.filter(id => id === 'R-3').length, beforeFinish + 1);
  await createBoard(options, dependencies)(); assert.equal(calls.filter(id => id === 'R-2').length, 2, 'a different board owns a fresh cache');
});
test('a worktree created after board startup joins row and project slot matching on the next tick', async t => {
  const f = boardFixture(t), repo = path.join(f.root, 'repo'), late = path.join(f.root, 'lane-late');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 10000 });
  git('init', '-qb', 'main'); git('config', 'user.name', 'Board fixture'); git('config', 'user.email', 'board@example.invalid'); git('config', 'commit.gpgsign', 'false');
  f.write('repo/README', 'fixture'); git('add', 'README'); git('commit', '-qm', 'fixture');
  const common = fs.realpathSync(path.join(repo, '.git'));
  f.write('repo/.git/promote/queue.json', { identity: common, pending: [{ id: 'late', topic: 'late' }], results: [] });
  const lockPath = f.write('late-slot.lock', { pid: process.pid, pgid: null, token: 'PLANTED', cwd: late, label: 'fixture gate' });
  let resolutions = 0;
  const collect = createBoard({ projects: [repo], sources: [], roots: [] }, {
    discover: cwd => { resolutions++; return discoverProject(cwd); }, memory: async () => null,
    panes: async () => ({ state: 'unavailable', panes: new Set() }), slot: ({ projects }) => readSlot({ lockPath, projects }),
  });
  const before = await collect(); assert.equal(before.rows[0].slot, ''); assert.equal(before.slot.project, null);
  git('worktree', 'add', '-qb', 'lane/late', late);
  const after = await collect(); assert.equal(after.rows[0].slot, 'holder'); assert.equal(after.slot.project, 'repo');
  assert.equal(resolutions, 1, 'identity resolution remains static');
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
  const collect = createBoard({ projects: [f.root], sources: [], roots: [f.root] }, { discover: () => ({ identity: f.root, paths: [f.root] }), refresh: p => p, brain: async () => raw,
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
