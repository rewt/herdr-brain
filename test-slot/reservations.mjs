// Foreground proving-step presence. Only this schema may pause launch gates.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processStartRecord } from './lock-support.mjs';
import { occupancyProject, occupancyState } from './occupancy.mjs';
import { COMPAT_PATH_ENV, TEST_SLOT_PATH, occupancyPaths, validateSlotPath } from './paths.mjs';
import { readRecordBytes, publishRecord, removeUnchanged } from './record-file.mjs';

export const RESERVATION_SCHEMA = 'host-reservation/v1';
export const MAX_RESERVATION_MS = 6 * 60 * 60 * 1000;
const positive = value => Number.isSafeInteger(value) && value > 0;
const text = (value, bound) => typeof value === 'string' && value.length > 0 && value.length <= bound && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const time = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const start = value => value === null || (text(value, 256) && value.startsWith('ps-utc-c:'));
const birth = value => value === null || (typeof value === 'string' && /^(darwin:\d+:\d+|linux:[a-f0-9-]{36}:\d+)$/.test(value));

export function reservationState(record, { now = Date.now(), ...liveness } = {}) {
  if (record?.schema !== RESERVATION_SCHEMA || record.class !== 'proving' || !positive(record.pid) ||
      !start(record.processStart) || !start(record.groupStart) || !birth(record.processBirth) || !birth(record.groupBirth) ||
      !(record.pgid === null || positive(record.pgid)) || !time(record.acquiredAt) || !time(record.expectedEnd) || !time(record.expiresAt) ||
      Date.parse(record.expiresAt) <= Date.parse(record.acquiredAt) ||
      !['project', 'label', 'cwd', 'host'].every(key => text(record[key], 4096)) || !text(record.reason, 1024) ||
      (record.reserveGib !== undefined && !(Number.isFinite(record.reserveGib) && record.reserveGib >= 0)))
    return { state: 'unknown', why: 'malformed proving reservation or missing expiry' };
  const expiresAt = Math.min(Date.parse(record.expiresAt), Date.parse(record.acquiredAt) + MAX_RESERVATION_MS);
  const presence = occupancyState({ ...record, schema: 'occupancy/v1', class: 'shared' }, liveness);
  if (presence.state === 'gone') return { state: 'gone', expiresAt };
  return { state: now >= expiresAt ? 'expired' : now > Date.parse(record.expectedEnd) ? 'overdue' : 'live', expiresAt };
}

export function readProvingReservations(lockPath, { prune = false, ...options } = {}) {
  const directory = `${lockPath}.occupancy`;
  let names;
  try { names = fs.readdirSync(directory).filter(name => !name.startsWith('.')).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.flatMap(name => {
    const file = path.join(directory, name);
    try {
      const bytes = readRecordBytes(file), record = JSON.parse(bytes);
      if (record?.schema !== RESERVATION_SCHEMA) return [];
      const state = reservationState(record, options);
      if (prune && state.state === 'gone') removeUnchanged(file, bytes);
      return [{ path: file, record, ...state }];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      return [{ path: file, record: null, state: 'unknown', why: error.code ?? error.message }];
    }
  });
}

export function publishProvingReservation({ lockPath = process.env[COMPAT_PATH_ENV] ?? TEST_SLOT_PATH,
  label, reason = label, expectedEnd, expiresAt, reserveGib, cwd = process.cwd(), now = Date.now, provers } = {}) {
  validateSlotPath(lockPath, { compat: true, provers });
  const acquired = now();
  const identity = processStartRecord(process.pid);
  const record = { schema: RESERVATION_SCHEMA, class: 'proving', pid: process.pid,
    processStart: identity.start, processBirth: identity.birth, pgid: null, groupStart: null, groupBirth: null,
    acquiredAt: new Date(acquired).toISOString(), expectedEnd: expectedEnd ?? expiresAt,
    expiresAt: new Date(Math.min(Date.parse(expiresAt), acquired + MAX_RESERVATION_MS)).toISOString(),
    project: occupancyProject(cwd), label, cwd, host: os.hostname(), reason,
    ...(reserveGib === undefined ? {} : { reserveGib }) };
  if (reservationState(record, { now: acquired }).state === 'unknown') throw Error('invalid proving reservation');
  const directory = `${lockPath}.occupancy`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('reservation directory must be private and owned');
  const file = path.join(directory, `${randomUUID()}.json`), owner = process.pid;
  let bytes = publishRecord(file, record), released = false;
  const owned = () => {
    if (released || process.pid !== owner || readRecordBytes(file) !== bytes) throw Error('reservation no longer belongs to this owner');
  };
  const update = change => { owned(); const next = { ...record, ...change };
    if (reservationState(next, { now: now() }).state === 'unknown') throw Error('invalid proving reservation update');
    bytes = publishRecord(file, next); Object.assign(record, next); };
  const release = () => {
    if (released) return true;
    owned();
    if (occupancyState({ ...record, schema: 'occupancy/v1', class: 'shared' }, { ignoreOwner: true }).state !== 'gone') return false;
    const removed = removeUnchanged(file, bytes);
    if (removed) { released = true; process.off('exit', onExit); }
    return removed;
  };
  const onExit = () => { try { release(); } catch { /* Changed bytes are never deletion authority. */ } };
  process.on('exit', onExit);
  return { path: file, record,
    setGroup: (pgid, groupStart, groupBirth = null) => update({ pgid, groupStart, groupBirth }),
    renew: ({ expiresAt, expectedEnd = record.expectedEnd }) => update({ expectedEnd,
      expiresAt: new Date(Math.min(Date.parse(expiresAt), acquired + MAX_RESERVATION_MS)).toISOString() }),
    release };
}

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function waitForProvingHold({ label = 'cycle', check = () => {}, env = process.env,
  read = (file, options) => readProvingReservations(file, options), now = Date.now, sleep = pause, intervalMs = 1000,
  notify = line => process.stderr.write(`${line}\n`) } = {}) {
  if (!(Number.isFinite(intervalMs) && intervalMs > 0)) throw Error('invalid proving poll interval');
  const flagged = new Set(); let previous = '', waiting = false;
  for (;;) {
    check();
    const rows = occupancyPaths(env).flatMap(file => {
      try { return read(file, { now: now() }); }
      catch { return [{ path: `${file}.occupancy`, state: 'unknown' }]; }
    });
    for (const row of rows.filter(row => ['unknown', 'expired'].includes(row.state))) {
      const key = `${row.path}:${row.state}`;
      if (!flagged.has(key)) {
        notify(`${row.state === 'expired' ? 'HOST_RESERVATION_EXPIRED' : 'HOST_RESERVATION_UNKNOWN'}: ${JSON.stringify(row.path)}; ignored`);
        flagged.add(key);
      }
    }
    const live = rows.filter(row => ['live', 'overdue'].includes(row.state) && row.expiresAt > now());
    const description = live.map(row => `${row.record.project}: ${row.record.reason}; expiry ${new Date(row.expiresAt).toISOString()}${row.state === 'overdue' ? '; overdue' : ''}`).join(' | ');
    if (!live.length) {
      check();
      if (waiting) notify(`${label}: proving reservation ended; proceeding`);
      return;
    }
    if (description !== previous) notify(`${label}: waiting; proving ${description}`);
    previous = description; waiting = true; check();
    sleep(Math.max(0, Math.min(intervalMs, ...live.map(row => row.expiresAt - now()))));
  }
}
