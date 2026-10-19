import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { publishProvingReservation, readProvingReservations, reservationState, waitForProvingHold, MAX_RESERVATION_MS } from '../reservations.mjs';
import { readTestSlotOccupancy, sharedOccupancy } from '../occupancy.mjs';
import { readSlot } from '../../board/facts.mjs';
import { render } from '../../board/render.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';
import { testSlotEnvironment } from '../../test/helpers/test-slot-env.mjs';

const library = new URL('../reservations.mjs', import.meta.url).href;
const support = new URL('../lock-support.mjs', import.meta.url).href;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const gone = () => { throw Object.assign(Error('gone'), { code: 'ESRCH' }); };
async function until(check) {
  const deadline = Date.now() + loadTimeout(8000);
  while (!check()) { assert.ok(Date.now() < deadline, 'reservation fixture became ready'); await sleep(20); }
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reservation-'))), lock = path.join(root, 'slot');
  const env = { ...testSlotEnvironment(), MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock };
  const owners = [], handles = [];
  t.after(async () => {
    for (const owner of owners) if (owner.child.exitCode === null && owner.child.signalCode === null) owner.child.kill('SIGKILL');
    await Promise.all(owners.map(owner => owner.done));
    for (const h of handles) { try { h.release(); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const start = source => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const owner = { child, stdout: '', stderr: '' };
    child.stdout.on('data', b => { owner.stdout += b; }); child.stderr.on('data', b => { owner.stderr += b; });
    owner.done = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    owners.push(owner); return owner;
  };
  const publish = (extra = {}) => {
    const h = publishProvingReservation({ lockPath: lock, label: 'proof', reason: 'ENG-424 R-601',
      expiresAt: new Date(Date.now() + 60000).toISOString(), ...extra });
    handles.push(h); return h;
  };
  return { root, lock, env, start, publish };
}

test('proving publication, renewal and release are atomic, bounded and owner-only', t => {
  const f = fixture(t), now = Date.now(), h = f.publish({ now: () => now, reserveGib: 17,
    expectedEnd: new Date(now + 1000).toISOString(), expiresAt: new Date(now + MAX_RESERVATION_MS * 2).toISOString() });
  const record = JSON.parse(fs.readFileSync(h.path));
  assert.equal(Object.keys(record)[0], 'schema'); assert.equal(record.class, 'proving');
  assert.equal(Date.parse(record.expiresAt), now + MAX_RESERVATION_MS);
  assert.equal(reservationState({ ...record, expiresAt: new Date(now + MAX_RESERVATION_MS * 2).toISOString() }, { now }).expiresAt, now + MAX_RESERVATION_MS, 'reader also caps foreign writers');
  assert.equal(fs.statSync(h.path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${f.lock}.occupancy`).mode & 0o777, 0o700);
  assert.equal(reservationState(record, { now: now + 2000 }).state, 'overdue');
  assert.equal(reservationState({ ...record, expectedEnd: new Date(now - 1000).toISOString() }, { now }).state, 'overdue', 'an estimate is advisory even when already overdue');
  h.renew({ expiresAt: new Date(now + MAX_RESERVATION_MS * 3).toISOString() });
  assert.equal(Date.parse(JSON.parse(fs.readFileSync(h.path)).expiresAt), now + MAX_RESERVATION_MS);
  fs.appendFileSync(h.path, ' ');
  assert.throws(() => h.setGroup(null, null), /no longer belongs/);
  assert.throws(() => h.release(), /no longer belongs/);
  assert.ok(fs.existsSync(h.path));
});

test('a child proving owner pauses a foreground launch wait and owner exit resumes it', async t => {
  const f = fixture(t), owner = f.start(`import {publishProvingReservation} from ${JSON.stringify(library)};
    publishProvingReservation({label:'proof',reason:'ENG-424 R-601',expiresAt:new Date(Date.now()+60000).toISOString()});console.log('ready');setInterval(()=>{},1000);`);
  await until(() => owner.stdout.includes('ready'));
  const waiter = f.start(`import {waitForProvingHold} from ${JSON.stringify(library)};waitForProvingHold({label:'launch',intervalMs:20});console.log('launched');`);
  await until(() => waiter.stderr.includes('waiting; proving'));
  assert.match(waiter.stderr, /ENG-424 R-601; expiry/); assert.equal(waiter.stdout, '');
  owner.child.kill('SIGKILL'); await owner.done;
  assert.equal((await waiter.done).code, 0, waiter.stderr);
  assert.match(waiter.stderr, /proving reservation ended; proceeding/); assert.match(waiter.stdout, /launched/);
  const row = readProvingReservations(f.lock, { prune: true })[0];
  assert.equal(row.state, 'gone'); assert.equal(fs.existsSync(row.path), false);
});

test('owner exit and release retain a surviving group; exact bytes alone permit gone pruning', async t => {
  const f = fixture(t), group = f.start('console.log("ready");setInterval(()=>{},1000);');
  await until(() => group.stdout.includes('ready'));
  const h = f.publish(); h.setGroup(group.child.pid, null, null);
  assert.equal(h.release(), false); assert.ok(fs.existsSync(h.path));
  // Model a dead owner and a surviving group without mutating any host process.
  const record = JSON.parse(fs.readFileSync(h.path));
  const kill = pid => { if (pid === record.pgid || pid === -record.pgid) return; gone(); };
  assert.equal(readProvingReservations(f.lock, { prune: true, kill })[0].state, 'live');
  assert.ok(fs.existsSync(h.path));
  group.child.kill('SIGKILL'); await group.done;
  assert.equal(h.release(), true); assert.equal(fs.existsSync(h.path), false);
  const old = f.publish(), bytes = fs.readFileSync(old.path, 'utf8');
  let changed = false;
  const mutate = () => { if (!changed) { changed = true; fs.writeFileSync(old.path, bytes + ' '); } gone(); };
  readProvingReservations(f.lock, { prune: true, kill: mutate });
  assert.ok(fs.existsSync(old.path), 'a changed record cannot be pruned');
});

test('a killed child owner keeps its live foreground group reserved until the group ends', async t => {
  const f = fixture(t), owner = f.start(`import {spawn} from 'node:child_process';
    import {publishProvingReservation} from ${JSON.stringify(library)};import {processStartRecord} from ${JSON.stringify(support)};
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    const identity=processStartRecord(child.pid),held=publishProvingReservation({label:'group proof',reason:'ENG-424 R-601',expiresAt:new Date(Date.now()+60000).toISOString()});
    held.setGroup(child.pid,identity.start,identity.birth);console.log(child.pid);setInterval(()=>{},1000);`);
  await until(() => /^\d+\n/.test(owner.stdout));
  const group = Number(owner.stdout.trim()); t.after(() => { try { process.kill(group, 'SIGKILL'); } catch {} });
  owner.child.kill('SIGKILL'); await owner.done;
  assert.equal(readProvingReservations(f.lock, { prune: true })[0].state, 'live');
  const waiter = f.start(`import {waitForProvingHold} from ${JSON.stringify(library)};waitForProvingHold({label:'group launch',intervalMs:20});console.log('launched');`);
  await until(() => waiter.stderr.includes('waiting; proving')); assert.equal(waiter.stdout, '');
  process.kill(group, 'SIGKILL');
  assert.equal((await waiter.done).code, 0, waiter.stderr); assert.match(waiter.stdout, /launched/);
});

test('live expired owners never pause, remain on disk, and are flagged on the board', t => {
  const f = fixture(t), now = Date.now(), h = f.publish({ now: () => now - 3000,
    expectedEnd: new Date(now - 2000).toISOString(), expiresAt: new Date(now - 1000).toISOString(), reserveGib: 17 });
  const lines = [];
  waitForProvingHold({ env: f.env, now: () => now, notify: line => lines.push(line), sleep: () => assert.fail('expired wait') });
  assert.equal(lines.length, 1); assert.match(lines[0], /^HOST_RESERVATION_EXPIRED:/);
  assert.equal(readProvingReservations(f.lock, { prune: true, now })[0].state, 'expired'); assert.ok(fs.existsSync(h.path));
  const slot = readSlot({ lockPath: f.lock, compatPath: f.lock, now });
  assert.equal(slot.reservations[0].state, 'expired'); assert.equal(slot.reservations[0].reserveGib, 17);
  assert.match(render({ slot, rows: [], memory: null, herdr: 'unavailable' }, { width: 500 }), /HOST_RESERVATION_EXPIRED:.*ENG-424 R-601.*17 GiB.*expiry/);
});

test('wait caps each sleep at expiry, flags unknown once, and STOP still cancels', t => {
  const f = fixture(t); let now = Date.now(); const lines = [], h = f.publish({ now: () => now, expiresAt: new Date(now + 25).toISOString() });
  const unknown = path.join(`${f.lock}.occupancy`, 'bad.json'); fs.writeFileSync(unknown, '{');
  const sleeps = [];
  waitForProvingHold({ env: f.env, now: () => now, intervalMs: 1000, sleep: ms => { sleeps.push(ms); now += ms; }, notify: line => lines.push(line) });
  assert.deepEqual(sleeps, [25]); assert.equal(lines.filter(s => s.startsWith('HOST_RESERVATION_UNKNOWN:')).length, 1);
  assert.match(lines.at(-1), /ended; proceeding/); assert.ok(fs.existsSync(h.path));
  assert.throws(() => waitForProvingHold({ env: f.env, check: () => { throw Error('STOP'); } }), /STOP/);
});

test('shared classes, legacy lock and ticket, missing expiry and unknown schemas never wait', t => {
  const f = fixture(t), shared = ['gate', 'build', 'test', 'review'].map(label => sharedOccupancy(f.lock, label, { reason: 'unprofiled' }));
  t.after(() => shared.forEach(h => h.release()));
  fs.writeFileSync(f.lock, JSON.stringify({ pid: process.pid, pgid: null, token: 'legacy' }));
  fs.mkdirSync(`${f.lock}.queue`); fs.writeFileSync(path.join(`${f.lock}.queue`, 'ticket.json'), '{}');
  const h = f.publish(), record = JSON.parse(fs.readFileSync(h.path)); delete record.expiresAt;
  fs.writeFileSync(h.path, JSON.stringify(record));
  fs.writeFileSync(path.join(`${f.lock}.occupancy`, 'future.json'), JSON.stringify({ schema: 'host-reservation/v2' }));
  const lines = [];
  waitForProvingHold({ env: f.env, notify: line => lines.push(line), sleep: () => assert.fail('non-proving waited') });
  assert.equal(lines.length, 1); assert.match(lines[0], /^HOST_RESERVATION_UNKNOWN:/);
  readProvingReservations(f.lock, { prune: true, kill: gone }); assert.ok(fs.existsSync(h.path));
  assert.equal(readTestSlotOccupancy(f.lock).length, 4);
});

test('readers skip other schemas and refuse symlinks, nonregular and oversized records without pruning', t => {
  const f = fixture(t), h = f.publish(), dir = `${f.lock}.occupancy`;
  fs.symlinkSync(h.path, path.join(dir, 'symlink')); fs.mkdirSync(path.join(dir, 'directory'));
  fs.writeFileSync(path.join(dir, 'huge'), 'x'.repeat(1024 * 1024 + 1));
  const rows = readProvingReservations(f.lock, { prune: true });
  assert.equal(rows.filter(r => r.state === 'unknown').length, 3);
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith('.')), []);
  assert.equal(readTestSlotOccupancy(f.lock, { prune: true }).some(r => r.path === h.path), false);
});

test('occupancy paths are deduplicated by realpath and a board without reservations is byte-identical', t => {
  const f = fixture(t), h = f.publish(), alias = path.join(f.root, 'alias');
  fs.symlinkSync(`${f.lock}.occupancy`, `${alias}.occupancy`);
  assert.equal(readSlot({ lockPath: alias, compatPath: f.lock }).reservations.length, 1);
  h.release();
  const slot = readSlot({ lockPath: f.lock, compatPath: f.lock }); assert.equal('reservations' in slot, false);
  const snapshot = { slot, rows: [], memory: null, herdr: 'unavailable' };
  assert.equal(render(snapshot), 'Promotion board | memory available unknown | Herdr unavailable\nSlot free | held ? | queue 0 | shared 0\nNo promotions in the selected window.');
});
