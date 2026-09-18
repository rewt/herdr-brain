// The results queue: an append-only log of what came out of sessions, folded
// into a current view. No database, no daemon state beyond this file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.BRAIN_STATE
  ?? path.join(os.homedir(), '.local', 'state', 'herdr-brain');
export const LOG = path.join(HOME, 'queue.jsonl');
const SEEN = path.join(HOME, 'watch.json');

function ensure() {
  fs.mkdirSync(HOME, { recursive: true });
}

export function append(event) {
  ensure();
  fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

export function events() {
  try {
    return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// Current state of every captured result, newest first.
export function fold() {
  const byId = new Map();
  for (const e of events()) {
    if (e.type === 'result') {
      byId.set(e.id, { ...e, status: 'new', digest: null, answer: null });
      continue;
    }
    const row = byId.get(e.id);
    if (!row) continue;
    if (e.type === 'status') row.status = e.status;
    if (e.type === 'digest') { row.digest = e.digest; if (row.status === 'new') row.status = 'digested'; }
    if (e.type === 'answer') { row.answer = { text: e.text, at: e.at }; row.status = 'answered'; }
  }
  return [...byId.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
}

export function open() {
  const GONE = new Set(['answered', 'dismissed', 'never', 'acted']);
  return fold().filter((r) => !GONE.has(r.status));
}

// A short, stable, unique handle for typing at the shell. The id starts with a
// timestamp, so two sessions captured in the same tick share its first
// characters — printing that prefix pointed commands at the wrong row.
export function handleOf(entry) {
  return String(entry.session ?? entry.id).replace(/^(settle|lane|exec)-/, '').slice(0, 22);
}

export function get(query) {
  if (!query) return null;
  const all = fold();
  const q = String(query).toLowerCase();
  const by = (fn) => all.find(fn);
  return by((r) => r.id === query)
    ?? by((r) => r.session === query)
    ?? by((r) => handleOf(r).toLowerCase() === q)
    ?? by((r) => String(r.session ?? '').toLowerCase().includes(q))
    ?? by((r) => r.id.startsWith(query))
    ?? null;
}

// The watcher's memory of what each session was doing last tick, so a restart
// does not re-capture everything that is already sitting in `done`.
export function loadSeen() {
  try {
    return JSON.parse(fs.readFileSync(SEEN, 'utf8'));
  } catch {
    return { states: {}, started: null };
  }
}

export function saveSeen(seen) {
  ensure();
  const tmp = `${SEEN}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(seen, null, 2));
  fs.renameSync(tmp, SEEN);
}
