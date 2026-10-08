// Metadata only. Never serialize caller objects, errors, memory probes or screens.
import fs from 'node:fs';

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

export function timedMemoryWait({ journal, run = null, item, lane, kind, wait,
  persist = () => {}, now = () => new Date().toISOString() }) {
  const emit = outcome => {
    appendTiming(journal, { at: now(), run, item, lane, kind, outcome });
    persist();
  };
  const prior = readTiming(journal).filter(event => event.kind === kind).at(-1);
  // Resume an unfinished gate after a coordinator restart, retaining its entry.
  if (prior?.outcome !== 'entry') emit('entry');
  let result;
  try { result = wait(); }
  catch (error) { emit(error.code === 'DISPATCH_STOPPED' ? 'stopped' : 'failed'); throw error; }
  emit('granted');
  return result;
}

export function observeProcessEnd({ current, state, eligible, journal = current.meta?.dispatch_journal,
  record, now = () => new Date().toISOString() }) {
  if (!eligible || !['idle', 'done', null].includes(state) || current.meta?.process_end) return;
  // A lost record reply must replay the original journal timestamp on restart.
  const prior = journal && readTiming(journal).find(e => e.kind === 'process_end' && e.run === current.id);
  let event = prior;
  event ??= timingEvent({ at: now(), run: current.id, item: current.item,
    lane: current.meta?.lane ?? null, kind: 'process_end', outcome: state ?? 'gone' });
  if (journal && !prior) appendTiming(journal, event);
  record(['set', current.id, `process_end=${JSON.stringify(event)}`]);
}
