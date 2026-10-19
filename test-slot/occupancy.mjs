// Shared work publishes presence, never admission authority or a queue ticket.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { processStartRecord } from './lock-support.mjs';
import { readRecordBytes, publishRecord, removeUnchanged } from './record-file.mjs';

const projects = new Map();
// Informational identity only: never spawn Git on the occupancy write path.
export function occupancyProject(cwd = process.cwd()) {
  if (projects.has(cwd)) return projects.get(cwd);
  let project = path.basename(cwd);
  try {
    const text = file => {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 65536) throw Error('unreadable Git metadata');
      const value = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
      if (!value || /[\0\r\n]/.test(value)) throw Error('malformed Git metadata');
      return value;
    };
    let directory = fs.realpathSync(cwd);
    for (;;) {
      const marker = path.join(directory, '.git');
      if (fs.lstatSync(marker, { throwIfNoEntry: false })) {
        let gitdir = marker;
        if (!fs.statSync(marker).isDirectory()) {
          const match = /^gitdir: (.+)$/.exec(text(marker));
          if (!match) throw Error('malformed Git marker');
          gitdir = path.resolve(directory, match[1]);
        }
        gitdir = fs.realpathSync(gitdir);
        const commonFile = path.join(gitdir, 'commondir');
        const common = fs.realpathSync(fs.lstatSync(commonFile, { throwIfNoEntry: false })
          ? path.resolve(gitdir, text(commonFile)) : gitdir);
        if (!fs.statSync(path.join(gitdir, 'HEAD')).isFile() || !fs.statSync(path.join(common, 'objects')).isDirectory())
          throw Error('incomplete Git directory');
        project = common;
        break;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch { /* Uncertain metadata retains the legacy directory label. */ }
  projects.set(cwd, project);
  return project;
}

const positive = value => Number.isSafeInteger(value) && value > 0;
export function occupancyState(record, { kill = process.kill, startRecord = processStartRecord, ignoreOwner = false } = {}) {
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
  if (!ignoreOwner && owner(record.pid, record.processStart, record.processBirth) !== 'gone') return { state: 'live' };
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
      const bytes = readRecordBytes(file), record = JSON.parse(bytes);
      if (record?.schema !== 'occupancy/v1') return []; // Unknown versions are never deletion authority.
      const state = occupancyState(record, liveness);
      if (prune && state.state === 'gone') removeUnchanged(file, bytes);
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
  const file = path.join(directory, `${name}.json`);
  const cwd = process.cwd();
  const holder = { schema: 'occupancy/v1', pid: process.pid, processStart: identity.start, processBirth: identity.birth,
    pgid: null, groupStart: null, groupBirth: null, label, cwd, host: os.hostname(),
    project: occupancyProject(cwd), acquiredAt: new Date().toISOString(), class: 'shared', reason: resource.reason,
    ...(resource.profile ? { profile_id: resource.profile.id } : {}) };
  holder.startedAt = holder.acquiredAt;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let bytes = publishRecord(file, holder);
  const owner = process.pid;
  const release = () => {
    if (process.pid !== owner) throw Error('occupancy belongs to another owner');
    if (occupancyState(holder, { ignoreOwner: true }).state !== 'gone') return false;
    const removed = removeUnchanged(file, bytes);
    process.off('exit', release); return removed;
  };
  process.on('exit', release);
  return { class: 'shared', nested: false, token: null, holder, occupancyPath: file, release,
    setGroup(pgid, groupStart, groupBirth = null) {
      Object.assign(holder, { pgid, groupStart, groupBirth });
      if (process.pid !== owner || readRecordBytes(file) !== bytes) throw Error('occupancy no longer belongs to this owner');
      bytes = publishRecord(file, holder);
    } };
}
