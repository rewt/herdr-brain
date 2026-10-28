// Metadata only. Never serialize caller objects, errors, memory probes or screens.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Companion diagnostic, like the dispatch/admission timing sidecars below.
// One ordinary lock acquisition produces one line; never append to events.jsonl.
export const recordLockTimingJournal = dir => path.join(dir, 'record-lock.timings.jsonl');
export const recordLockRefusalJournal = dir => path.join(dir, 'record-lock.refusals.jsonl');
function appendLockDiagnostic(file, value) {
  const prior = fs.lstatSync(file, { throwIfNoEntry: false });
  if (prior && (!prior.isFile() || prior.nlink !== 1)) return;
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeSync(fd, JSON.stringify({ ...value, at: new Date().toISOString(), pid: process.pid,
      node: process.version, platform: process.platform, arch: process.arch,
      source: fileURLToPath(new URL('../', import.meta.url)) }) + '\n');
  } finally { fs.closeSync(fd); }
}
export function appendRecordLockTiming(dir, { label, actor, caller, outcome, wait_ms, hold_ms, source_version }) {
  appendLockDiagnostic(recordLockTimingJournal(dir), { schema: 'record-lock/v1',
    label, actor, ...(caller ? { caller } : {}), outcome, wait_ms, hold_ms, source_version });
}
export function appendRecordLockRefusal(dir, { label, actor, caller, reason, wait_ms, source_version }) {
  appendLockDiagnostic(recordLockRefusalJournal(dir), { schema: 'record-lock-refusal/v1',
    label, actor, ...(caller ? { caller } : {}), reason, wait_ms, source_version });
}
export function appendRecordConflict(dir, { label, caller, attempt, retry, code, reason, effects_started, record_effects, source_version }) {
  appendLockDiagnostic(path.join(dir, 'record-conflicts.jsonl'), { schema: 'record-conflict/v1',
    label, caller, attempt, retry, code, reason, effects_started, record_effects, source_version });
}

export const waitKinds = ['memory_open', 'memory_worker'];
export function timingEvent(value) {
  const { at, run = null, item, lane = null, kind, outcome } = value;
  if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at) || !Number.isFinite(Date.parse(at)) ||
      (run !== null && (typeof run !== 'string' || !/^R-\d+$/.test(run))) ||
      typeof item !== 'string' || !/^[A-Z][A-Z0-9]*-\d+$/.test(item) ||
      (lane !== null && (typeof lane !== 'string' || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(lane)))) throw Error('invalid run timing identity or timestamp');
  const outcomes = kind === 'process_end' ? ['idle', 'done', 'gone'] :
    waitKinds.includes(kind) ? ['entry', 'granted', 'stopped', 'failed'] : [];
  if (!outcomes.includes(outcome)) throw Error('invalid run timing kind or outcome');
  return { at, run, item, lane, kind, outcome };
}

// A companion to the dispatch request journal avoids watch overwriting dispatch's
// live recovery stages. Each synchronous append is one small, allowlisted line.
export const timingJournal = journal => `${journal}.events.jsonl`;
export function appendTiming(journal, value) {
  const event = timingEvent(value);
  fs.appendFileSync(timingJournal(journal), `${JSON.stringify(event)}\n`, { mode: 0o600 });
  return event;
}
export function readTiming(journal) {
  try {
    return fs.readFileSync(timingJournal(journal), 'utf8').split('\n').filter(Boolean).map(line => timingEvent(JSON.parse(line)));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export function timingMetadata(events, run) {
  return JSON.stringify(events.map(event => timingEvent({ ...event, run })));
}

// The existing journal and dispatch_waits have strict old readers. Admission
// clocks use their own companion and metadata field, which old readers ignore.
export const admissionTimingJournal = journal => `${journal}.admission.jsonl`;
export function admissionTimingEvent(value) {
  if (value.kind !== 'admission_lock') throw Error('invalid admission timing kind');
  return { ...timingEvent({ ...value, kind: 'memory_worker' }), kind: 'admission_lock' };
}
export function appendAdmissionTiming(journal, value) {
  const event = admissionTimingEvent(value);
  fs.appendFileSync(admissionTimingJournal(journal), `${JSON.stringify(event)}\n`, { mode: 0o600 });
  return event;
}
export function readAdmissionTiming(journal) {
  try {
    return fs.readFileSync(admissionTimingJournal(journal), 'utf8').split('\n').filter(Boolean).map(line => admissionTimingEvent(JSON.parse(line)));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export function admissionTimingMetadata(events, run) {
  return JSON.stringify(events.map(event => admissionTimingEvent({ ...event, run })));
}

export function timedMemoryWait({ journal, run = null, item, lane, kind, wait,
  persist = () => {}, now = () => new Date().toISOString(),
  onError = () => process.stderr.write('run timing could not be saved; continuing dispatch\n') }) {
  const append = kind === 'admission_lock' ? appendAdmissionTiming : appendTiming;
  const read = kind === 'admission_lock' ? readAdmissionTiming : readTiming;
  const attempt = (phase, action) => {
    try { return action(); }
    catch { try { onError(phase); } catch {} }
  };
  const emit = outcome => {
    attempt('append', () => append(journal, { at: now(), run, item, lane, kind, outcome }));
    attempt('persist', persist);
  };
  const prior = attempt('read', () => read(journal).filter(event => event.kind === kind).at(-1));
  // Resume an unfinished gate after a coordinator restart, retaining its entry.
  if (prior?.outcome !== 'entry') emit('entry');
  let result;
  try { result = wait(); }
  catch (error) { emit(error.code === 'DISPATCH_STOPPED' ? 'stopped' : 'failed'); throw error; }
  emit('granted');
  return result;
}

export function observeProcessEnd({ current, state, eligible, journal = current.meta?.dispatch_journal,
  record, lastWorkingAt, beforeWrite = () => {}, now = () => new Date().toISOString() }) {
  if (!eligible || !['idle', 'done', null].includes(state)) return;
  const thisAttempt = event => !lastWorkingAt || Date.parse(event.at) >= Date.parse(lastWorkingAt);
  if (current.meta?.process_end && thisAttempt(JSON.parse(current.meta.process_end))) return;
  // A lost record reply must replay the original journal timestamp on restart.
  // A terminal observation before the latest work belongs to an earlier attempt.
  const prior = journal && readTiming(journal).findLast(e => e.kind === 'process_end' && e.run === current.id && thisAttempt(e));
  let event = prior;
  event ??= timingEvent({ at: now(), run: current.id, item: current.item,
    lane: current.meta?.lane ?? null, kind: 'process_end', outcome: state ?? 'gone' });
  beforeWrite();
  if (journal && !prior) appendTiming(journal, event);
  record(['set', current.id, `process_end=${JSON.stringify(event)}`]);
}
