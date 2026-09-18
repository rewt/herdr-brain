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

export function get(idOrPrefix) {
  const all = fold();
  return all.find((r) => r.id === idOrPrefix)
    ?? all.find((r) => r.id.startsWith(idOrPrefix))
    ?? all.find((r) => r.session === idOrPrefix)
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
