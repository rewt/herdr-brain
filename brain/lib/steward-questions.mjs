// Read-only record observation. Cursor and pending deliveries are committed
// together before effects. Keep per-question receipts while open; the cursor
// preserves deduplication after answered questions are compacted away.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fold, extendFold, blockedBy, openRuns, itemStatus, isResolved } from '../../lib/state.mjs';
import { alertPayload, validateAlertPayload } from './steward-payload.mjs';

const MAX_BYTES = 4 * 1024 * 1024, MAX_PENDING = 2048, MAX_RECORDS = 512, MAX_SENDS = 8;
const snapshots = new Map();
const sameLog = (a, b) => a && b && ['size', 'mtimeMs', 'dev', 'ino'].every(key => a[key] === b[key]);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
function validate(state) {
  if (!object(state) || state.version !== 1 || !object(state.records) || Object.keys(state.records).length > MAX_RECORDS) throw Error('invalid steward journal question receipts');
  let pending = 0;
  for (const record of Object.values(state.records)) {
    if (!object(record) || !count(record.cursor) || !count(record.skipped) || !object(record.pending)) throw Error('invalid steward journal question cursor');
    if (record.log !== undefined && (!object(record.log) || !count(record.log.size) || !Number.isFinite(record.log.mtimeMs) || !count(record.log.dev) || !count(record.log.ino))) throw Error('invalid steward journal question log cursor');
    for (const [id, receipt] of Object.entries(record.pending)) {
      pending++;
      if (!object(receipt) || !count(receipt.attempts) || !Number.isFinite(receipt.last_at) || typeof receipt.ok !== 'boolean' || !Array.isArray(receipt.delivered) || receipt.delivered.some(v => !['notification', 'imessage'].includes(v))) throw Error('invalid steward journal question delivery');
      if (receipt.payload !== undefined) {
        try { validateAlertPayload(receipt.payload); }
        catch { throw Error('invalid steward journal question payload'); }
        if (receipt.payload.kind !== 'operator-question' || receipt.payload.question !== id) throw Error('invalid steward journal question payload');
      }
    }
  }
  if (pending > MAX_PENDING) throw Error('steward journal question pending bound exceeded');
}
function read(file) {
  if (!fs.existsSync(file)) return { version: 1, records: {} };
  if (fs.statSync(file).size > MAX_BYTES) throw Error('steward journal question receipts exceed bound');
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw Error('invalid steward journal question receipts'); }
  validate(state);
  return state;
}
function save(file, state) {
  validate(state);
  const bytes = JSON.stringify(state) + '\n';
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw Error('steward journal question receipts exceed bound');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { fs.rmSync(temporary, { force: true }); }
}
const waiting = (state, item) => item?.role === 'human' && !isResolved(itemStatus(state, item.id));

// Only cache derived state in memory. Durable log metadata lets a fresh process
// skip unchanged records too; pending payloads support retries without refolding.
function observe(record, cacheKey, observed, scans) {
  const fd = fs.openSync(path.join(record, 'events.jsonl'), 'r');
  try {
    const stat = fs.fstatSync(fd);
    const log = { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
    const legacyPayload = Object.values(observed?.pending ?? {}).some(r => !r.ok && !r.payload);
    if (sameLog(observed?.log, log) && !legacyPayload) {
      scans.skipped++;
      return { cursor: observed.cursor, log };
    }
    const cached = snapshots.get(cacheKey);
    const append = cached && cached.terminated && cached.cursor === observed?.cursor && sameLog(cached.log, observed?.log) &&
      log.dev === cached.log.dev && log.ino === cached.log.ino && log.size > cached.log.size;
    const offset = append ? cached.log.size : 0;
    const buffer = Buffer.alloc(log.size - offset);
    let read = 0;
    while (read < buffer.length) {
      const n = fs.readSync(fd, buffer, read, buffer.length - read, offset + read);
      if (!n) throw Error('record changed during question scan');
      read += n;
    }
    scans.bytes += read;
    scans[append ? 'tail' : 'full']++;
    if (!sameLog(log, fs.fstatSync(fd))) throw Error('record changed during question scan');
    const text = buffer.toString('utf8');
    const terminated = !text || text.endsWith('\n');
    // A complete final event without a newline is valid, but cannot seed a tail
    // read: the CLI will first add its newline. Partial events never advance.
    if (!terminated) {
      try { JSON.parse(text.slice(text.lastIndexOf('\n') + 1)); }
      catch { throw Error('record has an incomplete event tail'); }
    }
    const events = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    let cursor = append ? cached.cursor : 0;
    for (const event of events) {
      if (!count(event.seq) || event.seq <= cursor) throw Error('invalid record event sequence');
      cursor = event.seq;
    }
    if (observed && cursor < observed.cursor) throw Error('record cursor regressed');
    const state = append ? extendFold(cached.state, events) : fold(events);
    if (snapshots.size >= MAX_RECORDS && !snapshots.has(cacheKey)) snapshots.delete(snapshots.keys().next().value);
    snapshots.set(cacheKey, { state, cursor, log, terminated });
    return { state, cursor, log };
  } catch (error) {
    snapshots.delete(cacheKey);
    throw error;
  } finally { fs.closeSync(fd); }
}

function questionPayload(state, item, project, config) {
  const blocked = blockedBy(state, item.id).filter(target => !isResolved(itemStatus(state, target)));
  return alertPayload({ project, question: item.id, kind: 'operator-question', category: item.meta.category,
    blocked_items: blocked.length, blocked_runs: blocked.reduce((total, target) => total + openRuns(state, target).length, 0),
    text: item.title, recommendation: item.meta.recommend }, config);
}

// Caller holds the steward journal lock, including across channel results.
// Routing effects run first; question sends share one bounded parallel batch.
export async function questionAlerts({ fleet, home, config, now, dryRun, alert, actions, routingProject }) {
  const file = path.join(home, 'steward/questions.json'), receipts = read(file);
  let saved = JSON.stringify(receipts);
  const persist = () => {
    if (dryRun) return;
    const next = JSON.stringify(receipts);
    if (next === saved) return;
    save(file, receipts);
    saved = next;
  };
  const result = { skipped: 0, discovered: 0, pending: 0, errors: [], scans: { skipped: 0, full: 0, tail: 0, bytes: 0 } };
  const sends = [];
  for (const [project, mapping] of Object.entries(fleet.projects)) {
    let state, cursor, key, log;
    try {
      const git = routingProject(mapping.checkout, now);
      if (git.identity !== mapping.identity || git.canonical !== mapping.checkout) throw Error('stale fleet project');
      const record = fs.realpathSync(mapping.record);
      key = createHash('sha256').update(JSON.stringify([mapping.identity, record])).digest('hex');
      ({ state, cursor, log } = observe(record, `${home}:${key}`, receipts.records[key], result.scans));
    } catch (error) {
      result.errors.push({ project, error: error.message });
      continue; // Never baseline or advance an unreadable/stale record.
    }
    const observed = receipts.records[key];
    if (!observed) {
      const skipped = [...state.items.values()].filter(item => waiting(state, item)).length;
      result.skipped += skipped;
      receipts.records[key] = { cursor, log, skipped, pending: {} };
      persist();
      continue;
    }
    if (state) {
      for (const id of Object.keys(observed.pending)) if (!waiting(state, state.items.get(id))) delete observed.pending[id];
      for (const item of state.items.values()) {
        if (item.created.seq > observed.cursor && waiting(state, item)) {
          observed.pending[item.id] = { attempts: 0, last_at: 0, delivered: [], ok: false };
          result.discovered++;
        }
      }
      for (const [id, receipt] of Object.entries(observed.pending)) {
        if (!receipt.ok) receipt.payload = questionPayload(state, state.items.get(id), project, config);
      }
    }
    observed.cursor = cursor;
    observed.log = log;
    // Store discoveries with the cursor before any alert, including when a
    // restart resumes an interrupted or failed delivery.
    persist();
    for (const receipt of Object.values(observed.pending)) {
      if (receipt.ok) continue;
      const channels = ['notification', ...(config.imessage_recipient ? ['imessage'] : [])];
      if (channels.every(channel => receipt.delivered.includes(channel))) {
        receipt.ok = true;
        delete receipt.error;
        delete receipt.payload;
        continue;
      }
      if (sends.length >= MAX_SENDS || receipt.attempts >= config.alert_cap || receipt.attempts && now - receipt.last_at < config.debounce_seconds * 1000) continue;
      // Reapply current local privacy settings when retrying a stored payload.
      const payload = alertPayload({ ...receipt.payload, project }, config);
      actions.push({ type: 'alert', ...payload });
      sends.push({ payload, receipt, channels });
    }
    persist();
  }
  if (!dryRun) {
    // Commit every intent before starting any of the parallel external effects.
    for (const { receipt } of sends) { receipt.attempts++; receipt.last_at = now; }
    persist();
    const outcomes = await Promise.allSettled(sends.map(async ({ payload, receipt, channels }) => {
      try {
        await alert(payload, config, { delivered: receipt.delivered });
        receipt.delivered = channels;
        receipt.ok = true;
        delete receipt.error;
        delete receipt.payload;
      } catch (error) {
        receipt.delivered = [...new Set([...receipt.delivered, ...(error.delivered ?? [])])];
        receipt.error = String(error.message).slice(0, 1000);
      }
      // Save each acknowledgement promptly, even while another send is slow.
      persist();
    }));
    const refused = outcomes.find(outcome => outcome.status === 'rejected');
    if (refused) throw refused.reason; // All sends settled before releasing the lock.
    persist();
  }
  result.pending = Object.values(receipts.records).reduce((n, record) => n + Object.values(record.pending).filter(r => !r.ok).length, 0);
  return result;
}
