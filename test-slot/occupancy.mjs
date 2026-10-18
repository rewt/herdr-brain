// Shared work publishes presence, never admission authority or a queue ticket.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { processStartRecord } from './lock-support.mjs';
import { projectCommon } from './limits.mjs';
import { writeFileAtomic } from '../lib/files.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
export function occupancyState(record, { kill = process.kill, startRecord = processStartRecord } = {}) {
  if (record?.schema !== 'occupancy/v1' || record.class !== 'shared' || !positive(record.pid))
    return { state: 'unknown', why: 'occupancy does not name a shared owner' };
  const exists = target => {
    try { kill(target, 0); return 'present'; }
    catch (error) { return error.code === 'ESRCH' ? 'gone' : 'reserved'; }
  };
  const owner = (pid, start, birth) => {
    const state = exists(pid);
    if (state !== 'present') return state;
    if (typeof start !== 'string' || !start.startsWith('ps-utc-c:')) return 'reserved';
    if (birth != null && (typeof birth !== 'string' || !/^(darwin:\d+:\d+|linux:[a-f0-9-]{36}:\d+)$/.test(birth))) return 'reserved';
    try {
      // A successful kernel identity read is the ps-independent equivalent of
      // a successful start-time read. A denied source never proves PID reuse.
      const now = startRecord(pid);
      return (birth ? now.birth === birth : now.start === start) ? 'present' : 'gone';
    } catch { return exists(pid) === 'gone' ? 'gone' : 'reserved'; }
  };
  if (owner(record.pid, record.processStart, record.processBirth) !== 'gone') return { state: 'live' };
  const groups = [...(record.pgid == null ? [] : [{ pgid: record.pgid, start: record.groupStart, birth: record.groupBirth }]),
    ...Object.values(record.groups ?? {})];
  for (const group of groups) {
    if (!positive(group?.pgid)) return { state: 'live', why: 'unreadable group identity is reserved' };
    const leader = exists(group.pgid);
    if (leader === 'reserved' || (leader === 'present' && owner(group.pgid, group.start, group.birth) !== 'gone') ||
        (leader === 'gone' && exists(-group.pgid) !== 'gone')) return { state: 'live' };
  }
  return { state: 'gone' };
}

export function readTestSlotOccupancy(lockPath, { prune = false, ...liveness } = {}) {
  const directory = `${lockPath}.occupancy`;
  let names;
  try { names = fs.readdirSync(directory).filter(name => !name.startsWith('.')).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.flatMap(name => {
    const file = path.join(directory, name);
    try {
      const bytes = fs.readFileSync(file, 'utf8'), record = JSON.parse(bytes);
      if (record?.schema !== 'occupancy/v1') return []; // Unknown versions are never deletion authority.
      const state = occupancyState(record, liveness);
      if (prune && state.state === 'gone' && fs.readFileSync(file, 'utf8') === bytes) fs.rmSync(file, { force: true });
      return [{ path: file, record, ...state }];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      return [{ path: file, record: null, state: 'unknown', why: error.code ?? error.message }];
    }
  });
}

export function sharedOccupancy(lockPath, label, resource) {
  let identity;
  try { identity = processStartRecord(process.pid); } catch { identity = { start: null, birth: null }; }
  const directory = `${lockPath}.occupancy`;
  const name = `${process.pid}-${randomBytes(16).toString('hex')}`;
  const file = path.join(directory, `${name}.json`), temporary = path.join(directory, `.${name}.tmp`);
  const cwd = process.cwd();
  const holder = { schema: 'occupancy/v1', pid: process.pid, processStart: identity.start, processBirth: identity.birth,
    pgid: null, groupStart: null, groupBirth: null, label, cwd, host: os.hostname(),
    project: projectCommon(cwd) ?? path.basename(cwd), acquiredAt: new Date().toISOString(), class: 'shared', reason: resource.reason,
    ...(resource.profile ? { profile_id: resource.profile.id } : {}) };
  holder.startedAt = holder.acquiredAt;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temporary, JSON.stringify(holder) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file); // Readers can only see complete identity bytes.
  } finally { fs.rmSync(temporary, { force: true }); }
  const release = () => { fs.rmSync(file, { force: true }); process.off('exit', release); return true; };
  process.on('exit', release);
  return { class: 'shared', nested: false, token: null, holder, occupancyPath: file, release,
    setGroup(pgid, groupStart, groupBirth = null) {
      Object.assign(holder, { pgid, groupStart, groupBirth });
      writeFileAtomic(file, JSON.stringify(holder) + '\n', 0o600);
    } };
}
