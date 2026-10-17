#!/usr/bin/env node
// One durable, serialized delivery path for every supervisor notice. The inbox
// is a transport journal; it never stores record status or writes record events.
import { loadTimeout } from '../lib/deadline.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir } from '../lib/store.mjs';
import { noticeLock, ownerPid } from './notice-lock.mjs';
import { composerEmpty } from './composer.mjs';
import { autopilotNotice } from './autopilot.mjs';
import { bestEffort, mirrorNotice } from '../messages/mirror.mjs';
import { invokeHerdr as invoke } from './herdr-edge.mjs';
import { fixtureInboxEnrolled } from '../messages/fixture.mjs';

const SELF = fileURLToPath(import.meta.url);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const complete = entry => ['sent', 'handled'].includes(entry?.state);
function noticeProject(file, options) {
  try {
    const cwd = options.cwd ?? process.cwd(), project = gitProject(cwd);
    const candidate = path.basename(file) === 'inbox.log' && path.basename(path.dirname(file)) === 'supervisor' ? path.dirname(path.dirname(file)) : null;
    const org = options.org ?? (candidate && fs.existsSync(path.join(candidate, 'events.jsonl')) ? candidate : findOrgDir({ cwd }));
    if (!org || (!options.org && path.resolve(file) !== path.resolve(inboxPath({ org, cwd })))) return null;
    return { repo: project.canonical, identity: project.identity, org: fs.realpathSync(org) };
  } catch { return null; }
}
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
      if (event.type === 'autopilot') {
        entry.autopilot = event.result;
        delete entry.autopilot_owner;
        if (event.result.disposition === 'handled') entry.state = 'handled';
        else entry.delivery_message = event.result.summary;
      }
      if (event.type === 'autopilot-started') entry.autopilot_owner = event.pid;
      if (event.type === 'retry') entry.state = 'pending';
      if (event.type === 'notified') entry.notified = true;
      if (event.type === 'owned') entry.owner_pid = event.pid;
      if (event.type === 'waited') entry.waited_seconds = event.waited_seconds;
      if (event.error) entry.error = event.error;
    }
  }
  return [...entries.values()];
}

function transaction(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const release = noticeLock(`${file}.lock`, { waitMs: 5000 });
  try {
    const append = (event) => {
      const fd = fs.openSync(file, 'a', 0o600);
      try {
        const stored = { at: new Date().toISOString(), ...event };
        fs.writeFileSync(fd, JSON.stringify(stored) + '\n'); fs.fsyncSync(fd);
        return stored;
      }
      finally { fs.closeSync(fd); }
    };
    return fn(readInbox(file), append);
  } finally { release(); }
}
const record = (file, event) => transaction(file, (_entries, append) => append(event));
const snapshot = (file) => transaction(file, (entries) => entries);

function applyPolicy(file, id, options) {
  const entry = transaction(file, (entries, append) => {
    if (fixtureInboxEnrolled(file)) return null;
    const entry = entries.find(candidate => candidate.id === id);
    if (!entry || entry.autopilot || !entry.project || entry.state !== 'pending') return entry;
    if (entry.autopilot_owner) {
      try { process.kill(entry.autopilot_owner, 0); return null; }
      catch (error) { if (error.code !== 'ESRCH') return null; }
    }
    // Election belongs to this notice, independently of a busy chat's drain
    // lock. A dead policy owner is recovered through its action receipt.
    append({ type: 'autopilot-started', id, pid: process.pid });
    return entry;
  });
  if (!entry) return false;
  if (entry.autopilot || !entry.project || entry.state !== 'pending') return true;
  const policy = autopilotNotice(entry, { execute: options.executeAutopilot, nativeWorker: options.nativeAutopilotWorker });
  if (policy) record(file, { type: 'autopilot', id, result: policy });
  return true;
}

function quiet(entry, binding, call = invoke) {
  try {
    const occupant = (agent) => JSON.stringify([agent.pane_id, agent.terminal_id, agent.agent_session]);
    const agent = JSON.parse(call(entry.herdr, ['agent', 'get', entry.to])).result?.agent;
    if (!agent?.pane_id || agent.interactive_ready === false || !['idle', 'done'].includes(agent.agent_status)) return null;
    if (binding && (agent.name !== binding.name || agent.pane_id !== binding.pane || agent.terminal_id !== binding.terminal ||
        agent.agent_session?.value !== binding.nativeSession || agent.workspace_id !== binding.workspace || agent.cwd !== binding.cwd)) return null;
    const screen = call(entry.herdr, ['pane', 'read', agent.pane_id, '--lines', '14', '--format', 'ansi']);
    if (!composerEmpty(screen, agent.agent)) return null;
    // Keep pane read last: on the final check, prompt follows immediately.
    // Screen-based gating still has an inherent read-to-input race.
    return occupant(agent);
  } catch { return null; }
}

// Single attempt, shared quiet gate. Intent is durable before the final read.
// The receiver owns retries and holds; an uncertain offer is never replayed here.
export async function offerQuiet({ text, binding, beforePrompt }, { call = invoke, confirmSeconds = 3 } = {}) {
  if (!binding || ['name', 'pane', 'terminal', 'nativeSession', 'workspace', 'cwd', 'generation', 'herdr'].some(k => typeof binding[k] !== 'string' || !binding[k]))
    return { state: 'pending', reason: 'recipient binding needs re-resolution' };
  const entry = { herdr: binding.herdr, to: binding.name };
  const first = quiet(entry, binding, call);
  if (!first) return { state: 'pending', reason: 'recipient unavailable, changed or composer nonempty; re-resolve binding' };
  await delay(seconds(confirmSeconds, 3, 'confirmation seconds') * 1000);
  if (quiet(entry, binding, call) !== first) return { state: 'pending', reason: 'recipient changed during quiet confirmation' };
  beforePrompt();
  if (quiet(entry, binding, call) !== first) return { state: 'pending', reason: 'recipient changed before prompt; no input attempted' };
  try {
    const reply = JSON.parse(call(entry.herdr, ['agent', 'prompt', entry.to, text]));
    if (reply.error || reply.ok === false) {
      if (['agent_blocked', 'agent_not_found'].includes(reply.error?.code)) return { state: 'refused', reason: JSON.stringify(reply.error) };
      return { state: 'uncertain', reason: 'prompt returned an unrecognized negative acknowledgement' };
    }
    return { state: 'delivered', reason: 'Herdr acknowledged input; model consumption unknown' };
  } catch (error) {
    return { state: ['agent_blocked', 'agent_not_found'].includes(error.code) ? 'refused' : 'uncertain', reason: error.message };
  }
}

function notify(file, entry, error) {
  if (entry.notified) return;
  try {
    invoke(entry.herdr, ['notification', 'show', entry.title, '--body', entry.delivery_message ?? entry.message, '--sound', entry.sound]);
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
  if (fixtureInboxEnrolled(file)) return { delivered: false, queued: true, id: options.id, inbox: file, delivery_error: 'offline fixture intake is fenced; use its foreground transport owner' };
  const cap = seconds(options.waitSeconds ?? process.env.SUPERVISOR_INPUT_WAIT_SECONDS, 7200, 'SUPERVISOR_INPUT_WAIT_SECONDS') * 1000;
  const confirm = seconds(options.confirmSeconds ?? process.env.SUPERVISOR_INPUT_CONFIRM_SECONDS, 3, 'SUPERVISOR_INPUT_CONFIRM_SECONDS') * 1000;
  const retry = seconds(options.pollSeconds ?? process.env.SUPERVISOR_INPUT_POLL_SECONDS, 10, 'SUPERVISOR_INPUT_POLL_SECONDS') * 1000;
  const started = Date.now(), deadline = started + cap;
  const own = () => options.id && snapshot(file).find((entry) => entry.id === options.id);
  const result = (error) => ({ delivered: complete(own()), ...(own()?.state === 'handled' ? { handled: true, autopilot: own().autopilot } : {}), id: options.id, inbox: file,
    delivery_error: error, queued: !complete(own()), owner_pid: ownerPid(`${file}.owner.lock`) });
  const retained = async (error) => {
    if (!options.owner) await resumeInbox(file, options);
    return result(error);
  };
  let release;
  for (;;) {
    if (complete(own())) return result();
    try { release = noticeLock(`${file}.drain.lock`); break; }
    catch (error) {
      if (!error.message.startsWith('locked:')) throw error;
      const entry = own();
      if (entry) notify(file, entry, 'another sender is draining the inbox');
      if (Date.now() >= deadline) return retained(error.message);
      await delay(Math.min(Math.max(retry, 10), deadline - Date.now()));
    }
  }
  try {
    // Enrollment may have won while this caller waited for the drain lock.
    if (fixtureInboxEnrolled(file)) return result('offline fixture intake is fenced; use its foreground transport owner');
    for (;;) {
      const entry = snapshot(file).find((candidate) => !complete(candidate));
      if (!entry) return { ...result(), delivered: options.id ? complete(own()) : true, queued: false };
      if (!entry.autopilot && entry.state === 'pending') {
        if (!applyPolicy(file, entry.id, options)) {
          if (Date.now() >= deadline) return await retained('notice policy is still running; retained');
          await delay(Math.min(Math.max(retry, 10), deadline - Date.now()));
          continue;
        }
        const current = snapshot(file).find(candidate => candidate.id === entry.id);
        if (current.autopilot) {
          entry.autopilot = current.autopilot;
          const policy = current.autopilot;
          if (policy.disposition === 'handled') {
            if (entry.id === options.id) return result();
            continue;
          }
          entry.delivery_message = policy.summary;
        }
      }
      const waiting = own();
      if (waiting && waiting.id !== entry.id && (waiting.autopilot || !waiting.project)) notify(file, waiting, 'older supervisor notices are awaiting delivery');
      if (entry.state === 'uncertain') {
        record(file, { type: 'retry', id: entry.id, error: 'unacknowledged attempt; replaying the same notice ID' });
      }
      let waited = Boolean(entry.notified), ready = false, readyOccupant;
      for (;;) {
        const first = quiet(entry);
        if (first && Date.now() + confirm <= deadline) {
          await delay(confirm);
          if (quiet(entry) === first) { ready = true; readyOccupant = first; break; }
        }
        waited = true;
        notify(file, entry, 'supervisor input is busy or unreadable; notice queued');
        if (Date.now() >= deadline) break;
        await delay(Math.min(Math.max(retry, 10), deadline - Date.now()));
      }
      if (!ready) {
        record(file, { type: 'capped', id: entry.id, waited_seconds: (Date.now() - started) / 1000 });
        return await retained(`input wait cap reached; notice ${entry.id} stays in ${file}`);
      }
      if (waited || snapshot(file).find((candidate) => candidate.id === entry.id)?.notified) {
        const waitedSeconds = (Date.now() - (Date.parse(entry.at) || started)) / 1000;
        record(file, { type: 'waited', id: entry.id, waited_seconds: waitedSeconds,
          message: `delivered after waiting ${waitedSeconds.toFixed(1)} s for an empty input box` });
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
          readyOccupant = first;
        }
        const deliveredText = `${entry.delivery_message ?? entry.message} notice-id=${entry.id}`;
        // Persist intent before the FINAL check, leaving no journal write or
        // agent lookup between the final pane read and prompt invocation.
        record(file, { type: 'sending', id: entry.id, delivered_text: deliveredText });
        if (quiet(entry) !== readyOccupant) {
          record(file, { type: 'retry', id: entry.id, error: 'input changed before sending' });
          break;
        }
        try {
          invoke(entry.herdr, ['agent', 'prompt', entry.to, deliveredText]);
          record(file, { type: 'sent', id: entry.id, delivered_text: deliveredText });
          sent = true; break;
        } catch (error) {
          record(file, { type: 'retry', id: entry.id, error: error.message,
            may_have_delivered: !['agent_blocked', 'agent_not_found'].includes(error.code) });
          if (attempt < attempts && Date.now() < deadline) await delay(Math.min(entry.retrySeconds * 1000, deadline - Date.now()));
        }
      }
      if (!sent) {
        notify(file, entry, 'prompt refused; notice retained');
        return await retained(`notice ${entry.id} undelivered; retained in ${file}`);
      }
      if (entry.id === options.id) return result();
    }
  } finally { release(); }
}

// Durable enqueue only; fleet routing must not wait behind a busy composer.
// resumeInbox owns policy and delivery through the existing input gate.
export function enqueueSupervisor(to, message, options = {}) {
  const file = path.resolve(options.inbox ?? inboxPath(options));
  const id = options.id ?? randomUUID();
  if (typeof id !== 'string' || !id || /\s|[\x00-\x1f\x7f]/.test(id)) throw new Error('notice id must be nonempty without whitespace or control characters');
  const attempts = options.attempts ?? 5;
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('delivery attempts must be a positive integer');
  const retrySeconds = seconds(options.retrySeconds, 10, 'retry seconds');
  // Validate settings before appending; each accepted notice gets one entry.
  seconds(options.waitSeconds ?? process.env.SUPERVISOR_INPUT_WAIT_SECONDS, 7200, 'SUPERVISOR_INPUT_WAIT_SECONDS');
  seconds(options.confirmSeconds ?? process.env.SUPERVISOR_INPUT_CONFIRM_SECONDS, 3, 'SUPERVISOR_INPUT_CONFIRM_SECONDS');
  seconds(options.pollSeconds ?? process.env.SUPERVISOR_INPUT_POLL_SECONDS, 10, 'SUPERVISOR_INPUT_POLL_SECONDS');
  let observed, sequence;
  transaction(file, (entries, append) => {
    const prior = entries.find((entry) => entry.id === id);
    if (prior) {
      if (prior.to !== to || prior.message !== message) throw new Error(`notice ${id} has different content or target`);
      observed = prior; sequence = entries.indexOf(prior) + 1;
      return;
    }
    observed = append({ type: 'notice', id, to, message, project: noticeProject(file, options), owner: 'supervisor-inbox', herdr: options.herdr ?? 'herdr', attempts, retrySeconds,
      title: options.title ?? 'Supervisor notice queued', sound: options.sound ?? 'request' });
    sequence = entries.length + 1;
  });
  bestEffort(() => (options.mirror ?? mirrorNotice)({ ...observed, sequence, inbox: file, cwd: options.cwd, evidence: options.shadowEvidence }, options.shadow), options.shadow);
  return { id, inbox: file };
}

export async function promptSupervisor(to, message, options = {}) {
  const { id, inbox: file } = enqueueSupervisor(to, message, options);
  if (fixtureInboxEnrolled(file)) return { delivered: complete(readInbox(file).find(entry => entry.id === id)), queued: !complete(readInbox(file).find(entry => entry.id === id)), id, inbox: file, message };
  const retrySeconds = seconds(options.retrySeconds, 10, 'retry seconds');
  // Acknowledged ownership precedes input. The worker survives this caller,
  // including a crash between the prompt side effect and its acknowledgement.
  // Routine policy never waits behind older exception delivery or busy input.
  applyPolicy(file, id, options);
  const owner = await resumeInbox(file, options);
  // A zero-wait caller hands delivery to the acknowledged owner. Racing that
  // owner with an already-expired drain deadline would create a false alert.
  if (owner && seconds(options.waitSeconds ?? process.env.SUPERVISOR_INPUT_WAIT_SECONDS, 7200, 'SUPERVISOR_INPUT_WAIT_SECONDS') === 0) {
    const entry = snapshot(file).find((candidate) => candidate.id === id);
    const delivered = complete(entry);
    return { delivered, ...(entry?.state === 'handled' ? { handled: true, autopilot: entry.autopilot } : {}), id, inbox: file, queued: !delivered, owner_pid: owner, message };
  }
  const receipt = await drainInbox(file, { ...options, retrySeconds, id });
  const entry = snapshot(file).find((candidate) => candidate.id === id);
  if (receipt.delivered && entry?.waited_seconds !== undefined)
    options.log?.(`delivered after waiting ${entry.waited_seconds.toFixed(1)} s for an empty input box`);
  return { ...receipt, message };
}

// One transport-only worker per inbox, never a project housekeeping schedule.
// Housekeeping's existing tick and every sender call this recovery entry point.
export async function resumeInbox(file, options = {}) {
  file = path.resolve(file);
  if (fixtureInboxEnrolled(file)) return null;
  if (!fs.existsSync(file) || snapshot(file).every(complete)) return null;
  const pid = ownerPid(`${file}.owner.lock`);
  if (pid) {
    try { process.kill(pid, 0); return pid; }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const settings = {};
  for (const key of ['waitSeconds', 'confirmSeconds', 'pollSeconds']) if (options[key] !== undefined) settings[key] = options[key];
  const output = fs.openSync(`${file}.worker.log`, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [SELF, '--inbox', file, '--owner-worker', '--settings', JSON.stringify(settings)], {
      cwd: path.dirname(file), detached: true, stdio: ['ignore', output, output, 'ipc'],
      env: { ...process.env, HERDR_PANE_ID: '', HERDR_TAB_ID: '', HERDR_WORKSPACE_ID: '' },
    });
  } finally { fs.closeSync(output); }
  return await new Promise((resolve, reject) => {
    const finish = (error, pid) => {
      clearTimeout(timer);
      child.removeAllListeners();
      if (child.connected) child.disconnect();
      child.unref();
      if (error) reject(error); else resolve(pid);
    };
    const timer = setTimeout(() => finish(new Error(`inbox worker startup unconfirmed; inspect ${file}.worker.log`)), loadTimeout(5000));
    child.once('message', (message) => message?.ready ? finish(null, message.pid) : finish(new Error(message?.error ?? 'inbox worker failed')));
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(new Error(`inbox worker exited ${code}; inspect ${file}.worker.log`)));
  });
}

async function ownInbox(file, options) {
  let release;
  try { release = noticeLock(`${file}.owner.lock`); }
  catch (error) {
    if (!error.message.startsWith('locked:')) throw error;
    const pid = ownerPid(`${file}.owner.lock`);
    if (!pid) throw error;
    process.send?.({ ready: true, pid }); return;
  }
  try {
    if (fixtureInboxEnrolled(file)) { process.send?.({ ready: true, pid: null }); return; }
    transaction(file, (entries, append) => {
      for (const entry of entries.filter((entry) => !complete(entry))) append({ type: 'owned', id: entry.id, pid: process.pid });
    });
    process.send?.({ ready: true, pid: process.pid });
    if (process.connected) process.disconnect();
    const confirmSeconds = seconds(options.confirmSeconds ?? process.env.SUPERVISOR_INPUT_CONFIRM_SECONDS, 3, 'confirmation seconds');
    const pollSeconds = seconds(options.pollSeconds ?? process.env.SUPERVISOR_INPUT_POLL_SECONDS, 10, 'poll seconds');
    // The caller's cap limits its wait. The owner continues in bounded windows,
    // long enough for two reads even when the caller requested a zero-second cap.
    const requestedWait = seconds(options.waitSeconds ?? process.env.SUPERVISOR_INPUT_WAIT_SECONDS, 7200, 'wait seconds');
    const waitSeconds = Math.max(confirmSeconds + 1, requestedWait === 0 ? 7200 : requestedWait);
    for (;;) {
      await drainInbox(file, { ...options, waitSeconds, owner: true });
      const done = transaction(file, (entries) => {
        if (entries.some((entry) => !complete(entry))) return false;
        // Release under the journal lock so an enqueue cannot adopt an owner
        // already committed to exiting before that notice exists.
        release(); return true;
      });
      if (done) return;
      await delay(Math.max(pollSeconds * 1000, 10));
    }
  } finally { release(); }
}

export function resolveNotice(file, id, sent) {
  // Explicit recovery after inspecting the target. Never infer prompt outcome.
  const release = noticeLock(`${file}.drain.lock`);
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
    'owner-worker': { type: 'boolean' }, settings: { type: 'string' },
  } });
  const file = path.resolve(opt.inbox ?? inboxPath(opt));
  if (opt['owner-worker']) { await ownInbox(file, JSON.parse(opt.settings ?? '{}')); return; }
  if (opt.resolve) {
    if (Boolean(opt.sent) === Boolean(opt.resend)) throw new Error('--resolve ID needs exactly one of --sent or --resend');
    resolveNotice(file, opt.resolve, opt.sent); return;
  }
  if (!opt.drain && positionals.length !== 2) throw new Error('usage: prompt-supervisor.mjs TARGET MESSAGE [--inbox FILE] [--id ID] | --drain');
  const result = opt.drain ? await drainInbox(file) : await promptSupervisor(...positionals, { ...opt, inbox: file });
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.delivered) process.exitCode = /uncertain/.test(result.delivery_error ?? '') ? 1 : 3;
}
if (isMain(import.meta.url)) main().catch((error) => { console.error(`prompt-supervisor: ${error.message}`); process.exitCode = 1; });
