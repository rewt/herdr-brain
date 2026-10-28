// Read-only inbox projection, independent of delivery and supervisor services.
import fs from 'node:fs';
import path from 'node:path';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir } from '../lib/store.mjs';

export function inboxPath({ org, cwd = process.cwd() } = {}) {
  const record = org ?? findOrgDir({ cwd });
  return path.join(record ?? gitProject(cwd).identity, 'supervisor', 'inbox.log');
}

export function readInbox(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  if (text && !text.endsWith('\n')) throw new Error(`torn inbox tail: ${file}; inspect before recovery`);
  const entries = new Map();
  for (const line of text.split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type === 'notice') {
      if (entries.has(event.id)) throw new Error(`duplicate inbox id: ${event.id}`);
      entries.set(event.id, { ...event, state: 'pending' });
    } else {
      const entry = entries.get(event.id);
      if (!entry) throw new Error(`unknown inbox id: ${event.id}`);
      if (event.type === 'sending') {
        entry.state = 'uncertain';
        entry.attempt_occupant = event.occupant;
        entry.attempt_generation = (entry.attempt_generation ?? 0) + 1;
      }
      if (event.type === 'sent') entry.state = 'sent';
      if (event.type === 'autopilot') {
        entry.autopilot = event.result;
        delete entry.autopilot_owner;
        if (event.result.disposition === 'handled') entry.state = 'handled';
        else entry.delivery_message = event.result.summary;
      }
      if (event.type === 'autopilot-started') entry.autopilot_owner = event.pid;
      if (event.type === 'retry') entry.state = event.recovery || event.may_have_delivered === false ? 'pending'
        : entry.state === 'uncertain' || event.may_have_delivered ? 'uncertain' : 'pending';
      if (event.type === 'notified') entry.notified = true;
      if (event.type === 'owned') entry.owner_pid = event.pid;
      if (event.type === 'waited') entry.waited_seconds = event.waited_seconds;
      if (event.error) entry.error = event.error;
    }
  }
  return [...entries.values()];
}

