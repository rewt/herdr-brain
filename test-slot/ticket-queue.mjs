import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processState } from './lock-support.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Tickets use both interoperable start times and exact births, when present. */
function ticketState(ticket, now) {
  if (now >= Date.parse(ticket.expiresAt)) return { state: 'expired' };
  if (!Number.isSafeInteger(ticket.pid) || ticket.pid < 1)
    return { state: 'unknown', why: 'ticket does not name a positive pid' };
  const state = processState(ticket.pid, ticket.processStart);
  return state.state === 'live' && ticket.processBirth != null
    ? processState(ticket.pid, ticket.processStart, ticket.processBirth) : state;
}

/** Name order is the wire protocol's arrival order. Status reads without pruning. */
export function readTestSlotQueue(lockPath, { prune = false, now = Date.now() } = {}) {
  const directory = `${lockPath}.queue`;
  let names;
  try { names = fs.readdirSync(directory).filter(name => !name.startsWith('.')).sort(); }
  catch (error) { if (error.code === 'ENOENT') return { tickets: [], head: null }; throw error; }
  const tickets = [];
  for (const name of names) {
    const file = path.join(directory, name);
    let ticket, classification;
    try {
      ticket = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (ticket?.v !== 1) throw Error('ticket version is not 1');
      classification = ticketState(ticket, now);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      classification = { state: 'unreadable', why: String(error.code ?? error.message) };
    }
    const row = { name, ...classification, ticket: ticket ?? null };
    tickets.push(row);
    const arrived = /^(\d{16})-/.exec(name);
    if (prune && (row.state === 'gone' || row.state === 'expired' ||
        (row.state === 'unreadable' && arrived && now - Number(arrived[1]) > DAY_MS))) {
      fs.rmSync(file, { force: true });
    }
  }
  const head = tickets.find(row => row.state === 'live' || row.state === 'unknown') ?? null;
  return { tickets, head };
}

/** Publish complete bytes by link; deletion of the directory retains original arrival. */
export function testSlotTicket(lockPath, { token, label, identity, waitSeconds }) {
  const arrivedMs = Date.now();
  const directory = `${lockPath}.queue`;
  const name = `${String(arrivedMs).padStart(16, '0')}-${String(process.pid).padStart(10, '0')}-${token}.json`;
  const file = path.join(directory, name), temporary = path.join(directory, `.${token}.tmp`);
  const record = { v: 1, token, pid: process.pid, processStart: identity.start, processBirth: identity.birth ?? null,
    label, cwd: process.cwd(), host: os.hostname(), arrivedAt: new Date(arrivedMs).toISOString(),
    expiresAt: new Date(arrivedMs + waitSeconds * 1000).toISOString() };
  return {
    name,
    publish() {
      for (;;) {
        try {
          if (fs.existsSync(file)) return;
          fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
          fs.writeFileSync(temporary, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
          try { fs.linkSync(temporary, file); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
          return;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          // The directory can disappear between any two publication operations.
        } finally {
          fs.rmSync(temporary, { force: true });
        }
      }
    },
    remove() { fs.rmSync(file, { force: true }); },
  };
}
