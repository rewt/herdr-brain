#!/usr/bin/env node
// One durable, serialized delivery path for every supervisor notice. The inbox
// is a transport journal; it never stores record status or writes record events.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir } from '../lib/store.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { composerEmpty } from './composer.mjs';

const SELF = fileURLToPath(import.meta.url);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
      if (event.type === 'sending') entry.state = 'uncertain';
      if (event.type === 'sent') entry.state = 'sent';
      if (event.type === 'retry') entry.state = 'pending';
      if (event.type === 'notified') entry.notified = true;
      if (event.error) entry.error = event.error;
    }
  }
  return [...entries.values()];
}

function transaction(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const release = acquireLock(`${file}.lock`, { waitMs: 5000 });
  try {
    const append = (event) => {
      const fd = fs.openSync(file, 'a', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    };
    return fn(readInbox(file), append);
  } finally { release(); }
}
const record = (file, event) => transaction(file, (_entries, append) => append(event));
const snapshot = (file) => transaction(file, (entries) => entries);

function invoke(herdr, args) {
  const result = spawnSync(herdr, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const error = new Error((result.stderr || result.stdout || result.error?.message || `Herdr exited ${result.status}`).trim());
    // Only a documented pre-input refusal proves that retry cannot duplicate
    // text. Lost acknowledgements and stalled prompts require inspection.
    try { error.code = JSON.parse(result.stderr || result.stdout).error?.code; } catch {}
    throw error;
  }
  return result.stdout;
}

function quiet(entry) {
  try {
    const occupant = (agent) => JSON.stringify([agent.pane_id, agent.terminal_id, agent.agent_session]);
    const agent = JSON.parse(invoke(entry.herdr, ['agent', 'get', entry.to])).result?.agent;
    if (!agent?.pane_id || agent.interactive_ready === false || !['idle', 'done'].includes(agent.agent_status)) return null;
    const screen = invoke(entry.herdr, ['pane', 'read', agent.pane_id, '--lines', '14', '--format', 'ansi']);
    if (!composerEmpty(screen, agent.agent)) return null;
    const after = JSON.parse(invoke(entry.herdr, ['agent', 'get', entry.to])).result?.agent;
    if (!after || !['idle', 'done'].includes(after.agent_status) || occupant(after) !== occupant(agent)) return null;
    // Occupant identity must also match across the two empty reads.
    return occupant(agent);
  } catch { return null; }
}

function notify(file, entry, error) {
  if (entry.notified) return;
  try {
    invoke(entry.herdr, ['notification', 'show', entry.title, '--body', entry.message, '--sound', entry.sound]);
    record(file, { type: 'notified', id: entry.id, error });
    entry.notified = true;
  } catch { /* Notice is already durable; notification failure changes nothing. */ }
}

function seconds(value, fallback, name) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be a finite number >= 0`);
  return number;
}

export async function drainInbox(file, options = {}) {
  const cap = seconds(options.waitSeconds ?? process.env.SUPERVISOR_INPUT_WAIT_SECONDS, 7200, 'SUPERVISOR_INPUT_WAIT_SECONDS') * 1000;
  const confirm = seconds(options.confirmSeconds ?? process.env.SUPERVISOR_INPUT_CONFIRM_SECONDS, 3, 'SUPERVISOR_INPUT_CONFIRM_SECONDS') * 1000;
  const retry = seconds(options.pollSeconds ?? process.env.SUPERVISOR_INPUT_POLL_SECONDS, 10, 'SUPERVISOR_INPUT_POLL_SECONDS') * 1000;
  const started = Date.now(), deadline = started + cap;
  const own = () => options.id && snapshot(file).find((entry) => entry.id === options.id);
  const result = (error) => ({ delivered: own()?.state === 'sent', id: options.id, inbox: file,
    delivery_error: error, queued: own()?.state !== 'sent' });
  let release;
  for (;;) {
    if (own()?.state === 'sent') return result();
    try { release = acquireLock(`${file}.drain.lock`); break; }
    catch (error) {
      if (!error.message.startsWith('locked:')) throw error;
      const entry = own();
      if (entry) notify(file, entry, 'another sender is draining the inbox');
      if (Date.now() >= deadline) return result(error.message);
      await delay(Math.min(Math.max(retry, 10), deadline - Date.now()));
    }
  }
  try {
    for (;;) {
      const entry = snapshot(file).find((candidate) => candidate.state !== 'sent');
      if (!entry) return { ...result(), delivered: options.id ? own()?.state === 'sent' : true, queued: false };
      const waiting = own();
      if (waiting && waiting.id !== entry.id) notify(file, waiting, 'older supervisor notices are awaiting delivery');
      if (entry.state === 'uncertain') {
        notify(file, entry, 'prompt outcome is uncertain; inspect before acknowledging or resending');
        return result(`uncertain notice ${entry.id}; retained in ${file}; later notices wait`);
      }
      let waited = false, ready = false;
      for (;;) {
        const first = quiet(entry);
        if (first && Date.now() + confirm <= deadline) {
          await delay(confirm);
          if (quiet(entry) === first) { ready = true; break; }
        }
        waited = true;
        notify(file, entry, 'supervisor input is busy or unreadable; notice queued');
        if (Date.now() >= deadline) break;
        await delay(Math.min(Math.max(retry, 10), deadline - Date.now()));
      }
      if (!ready) {
        record(file, { type: 'capped', id: entry.id, waited_seconds: (Date.now() - started) / 1000 });
        return result(`input wait cap reached; notice ${entry.id} stays in ${file}`);
      }
      if (waited) {
        const waitedSeconds = (Date.now() - started) / 1000;
        record(file, { type: 'waited', id: entry.id, waited_seconds: waitedSeconds,
          message: `delivered after waiting ${waitedSeconds.toFixed(1)} s for an empty input box` });
        options.log?.(`delivered after waiting ${waitedSeconds.toFixed(1)} s for an empty input box`);
      }
      const attempts = entry.attempts ?? 5;
      let sent = false;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        // Recheck after each refused prompt, rather than typing into a changed
        // composer merely because a previous attempt had a quiet window.
        if (attempt > 1) {
          const first = quiet(entry);
          if (!first || Date.now() + confirm > deadline) break;
          await delay(confirm);
          if (quiet(entry) !== first) break;
        }
        record(file, { type: 'sending', id: entry.id });
        try {
          invoke(entry.herdr, ['agent', 'prompt', entry.to, entry.message]);
          record(file, { type: 'sent', id: entry.id });
          sent = true; break;
        } catch (error) {
          if (!['agent_blocked', 'agent_not_found'].includes(error.code)) {
            record(file, { type: 'uncertain', id: entry.id, error: error.message });
            notify(file, entry, error.message);
            return result(`uncertain notice ${entry.id}: ${error.message}; inspect before retry`);
          }
          record(file, { type: 'retry', id: entry.id, error: error.message });
          if (attempt < attempts && Date.now() < deadline) await delay(Math.min(entry.retrySeconds * 1000, deadline - Date.now()));
        }
      }
      if (!sent) {
        notify(file, entry, 'prompt refused; notice retained');
        return result(`notice ${entry.id} undelivered; retained in ${file}`);
      }
      if (entry.id === options.id) return result();
    }
  } finally { release(); }
}

export async function promptSupervisor(to, message, options = {}) {
  const file = path.resolve(options.inbox ?? inboxPath(options));
  const id = options.id ?? randomUUID();
  const attempts = options.attempts ?? 5;
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('delivery attempts must be a positive integer');
  const retrySeconds = seconds(options.retrySeconds, 10, 'retry seconds');
  // Validate settings before appending; each accepted notice gets one entry.
  seconds(options.waitSeconds ?? process.env.SUPERVISOR_INPUT_WAIT_SECONDS, 7200, 'SUPERVISOR_INPUT_WAIT_SECONDS');
  transaction(file, (entries, append) => {
    const prior = entries.find((entry) => entry.id === id);
    if (prior) {
      if (prior.to !== to || prior.message !== message) throw new Error(`notice ${id} has different content or target`);
      return;
    }
    append({ type: 'notice', id, to, message, herdr: options.herdr ?? 'herdr', attempts, retrySeconds,
      title: options.title ?? 'Supervisor notice queued', sound: options.sound ?? 'request' });
  });
  return { ...await drainInbox(file, { ...options, retrySeconds, id }), message };
}

export function resolveNotice(file, id, sent) {
  // Explicit recovery after inspecting the target. Never infer prompt outcome.
  const release = acquireLock(`${file}.drain.lock`);
  try {
    transaction(file, (entries, append) => {
      if (entries.find((entry) => entry.id === id)?.state !== 'uncertain') throw new Error(`notice ${id} is not uncertain`);
      append({ type: sent ? 'sent' : 'retry', id, recovery: 'caller inspected delivery' });
    });
  } finally { release(); }
}

async function main() {
  const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: {
    inbox: { type: 'string' }, org: { type: 'string' }, herdr: { type: 'string' }, id: { type: 'string' },
    drain: { type: 'boolean' }, resolve: { type: 'string' }, sent: { type: 'boolean' }, resend: { type: 'boolean' },
  } });
  const file = path.resolve(opt.inbox ?? inboxPath(opt));
  if (opt.resolve) {
    if (Boolean(opt.sent) === Boolean(opt.resend)) throw new Error('--resolve ID needs exactly one of --sent or --resend');
    resolveNotice(file, opt.resolve, opt.sent); return;
  }
  if (!opt.drain && positionals.length !== 2) throw new Error('usage: prompt-supervisor.mjs TARGET MESSAGE [--inbox FILE] [--id ID] | --drain');
  const result = opt.drain ? await drainInbox(file) : await promptSupervisor(...positionals, { ...opt, inbox: file });
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.delivered) process.exitCode = /uncertain/.test(result.delivery_error ?? '') ? 1 : 3;
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main().catch((error) => { console.error(`prompt-supervisor: ${error.message}`); process.exitCode = 1; });
