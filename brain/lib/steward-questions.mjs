// Read-only record observation. Cursor and pending deliveries are committed
// together before effects. Keep per-question receipts while open; the cursor
// preserves deduplication after answered questions are compacted away.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { loadEvents } from '../../lib/store.mjs';
import { fold, blockedBy, openRuns, itemStatus, isResolved } from '../../lib/state.mjs';
import { alertPayload } from './steward-payload.mjs';

const MAX_BYTES = 4 * 1024 * 1024, MAX_PENDING = 2048, MAX_RECORDS = 512;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
function validate(state) {
  if (!object(state) || state.version !== 1 || !object(state.records) || Object.keys(state.records).length > MAX_RECORDS) throw Error('invalid steward journal question receipts');
  let pending = 0;
  for (const record of Object.values(state.records)) {
    if (!object(record) || !count(record.cursor) || !count(record.skipped) || !object(record.pending)) throw Error('invalid steward journal question cursor');
    for (const receipt of Object.values(record.pending)) {
      pending++;
      if (!object(receipt) || !count(receipt.attempts) || !Number.isFinite(receipt.last_at) || typeof receipt.ok !== 'boolean' || !Array.isArray(receipt.delivered) || receipt.delivered.some(v => !['notification', 'imessage'].includes(v))) throw Error('invalid steward journal question delivery');
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
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
const waiting = (state, item) => item?.role === 'human' && !isResolved(itemStatus(state, item.id));

// Caller holds the steward journal lock, including across channel results.
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
  const result = { skipped: 0, discovered: 0, pending: 0, errors: [] };
  for (const [project, mapping] of Object.entries(fleet.projects)) {
    let state, cursor, key;
    try {
      const git = routingProject(mapping.checkout, now);
      if (git.identity !== mapping.identity || git.canonical !== mapping.checkout) throw Error('stale fleet project');
      const record = fs.realpathSync(mapping.record);
      key = createHash('sha256').update(JSON.stringify([mapping.identity, record])).digest('hex');
      const { events } = loadEvents(record);
      cursor = events.at(-1)?.seq ?? 0;
      if (!count(cursor) || receipts.records[key] && cursor < receipts.records[key].cursor) throw Error('record cursor regressed');
      state = fold(events);
    } catch (error) {
      result.errors.push({ project, error: error.message });
      continue; // Never baseline or advance an unreadable/stale record.
    }
    const observed = receipts.records[key];
    if (!observed) {
      const skipped = [...state.items.values()].filter(item => waiting(state, item)).length;
      result.skipped += skipped;
      receipts.records[key] = { cursor, skipped, pending: {} };
      persist();
      continue;
    }
    for (const id of Object.keys(observed.pending)) if (!waiting(state, state.items.get(id))) delete observed.pending[id];
    for (const item of state.items.values()) {
      if (item.created.seq > observed.cursor && waiting(state, item)) {
        observed.pending[item.id] = { attempts: 0, last_at: 0, delivered: [], ok: false };
        result.discovered++;
      }
    }
    observed.cursor = cursor;
    // Store discoveries with the cursor before any alert, including when a
    // restart resumes an interrupted or failed delivery.
    persist();
    for (const [id, receipt] of Object.entries(observed.pending)) {
      const item = state.items.get(id);
      if (receipt.ok) continue;
      const channels = ['notification', ...(config.imessage_recipient ? ['imessage'] : [])];
      if (channels.every(channel => receipt.delivered.includes(channel))) { receipt.ok = true; continue; }
      if (receipt.attempts >= config.alert_cap || receipt.attempts && now - receipt.last_at < config.debounce_seconds * 1000) continue;
      const blocked = blockedBy(state, id).filter(target => !isResolved(itemStatus(state, target)));
      const payload = alertPayload({ project, question: id, kind: 'operator-question', category: item.meta.category,
        blocked_items: blocked.length, blocked_runs: blocked.reduce((total, target) => total + openRuns(state, target).length, 0),
        text: item.title, recommendation: item.meta.recommend }, config);
      actions.push({ type: 'alert', ...payload });
      if (dryRun) continue;
      receipt.attempts++;
      receipt.last_at = now;
      persist();
      try {
        await alert(payload, config, { delivered: receipt.delivered });
        receipt.delivered = channels;
        receipt.ok = true;
        delete receipt.error;
      } catch (error) {
        receipt.delivered = [...new Set([...receipt.delivered, ...(error.delivered ?? [])])];
        receipt.error = String(error.message).slice(0, 1000);
      }
      persist();
    }
    result.pending += Object.values(observed.pending).filter(receipt => !receipt.ok).length;
    persist();
  }
  return result;
}
