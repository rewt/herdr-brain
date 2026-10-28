#!/usr/bin/env node
// One durable delivery path with independent recipient heads. The inbox
// is a transport journal; it never stores record status or writes record events.
import { loadTimeout } from '../lib/deadline.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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
import { inboxPath, readInbox } from '../messages/inbox-read.mjs';
export { inboxPath, readInbox } from '../messages/inbox-read.mjs';

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
export function inboxTransaction(file, fn, lockOptions = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const release = noticeLock(`${file}.lock`, { waitMs: 5000, ...lockOptions });
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
const transaction = inboxTransaction;
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
  // A queue or inbox owner can outlive a fast-forward of this product. Load
  // the policy and its transitive imports in a fresh process for each notice.
  // Function adapters are used only by foreground offline fixtures.
  let policy;
  if (options.executeAutopilot || options.nativeAutopilotWorker) {
    policy = autopilotNotice(entry, { execute: options.executeAutopilot, nativeWorker: options.nativeAutopilotWorker });
  } else {
    const reply = spawnSync(process.execPath, [path.join(path.dirname(SELF), 'autopilot.mjs'), '--notice'], {
      input: JSON.stringify(entry), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    if (reply.error || reply.status !== 0) throw new Error(`notice policy failed: ${reply.error?.message ?? reply.stderr ?? reply.signal ?? reply.status}`);
    policy = JSON.parse(reply.stdout);
  }
  if (policy) record(file, { type: 'autopilot', id, result: policy });
  return true;
}

const occupant = agent => agent?.pane_id && agent?.terminal_id ? JSON.stringify([
  agent.pane_id, agent.terminal_id, agent.agent_session?.value ?? null, agent.workspace_id, agent.cwd,
]) : null;
function occupantIdentity(value) {
  try {
    const tuple = JSON.parse(value);
    return Array.isArray(tuple) && typeof tuple[0] === 'string' && tuple[0] && typeof tuple[1] === 'string' && tuple[1] &&
      (tuple[2] === null || typeof tuple[2] === 'string') ? tuple : null;
  } catch { return null; }
}
function sameOccupant(a, b) {
  const x = occupantIdentity(a), y = occupantIdentity(b);
  // Pane movement/cwd changes do not erase a terminal/session dependency.
  return Boolean(x && y && x[1] === y[1] && (!x[2] || !y[2] || x[2] === y[2]));
}
function recipient(entry, call = invoke) {
  try {
    const agent = JSON.parse(call(entry.herdr, ['agent', 'get', entry.to])).result?.agent;
    return { agent, occupant: occupant(agent), error: agent ? undefined : 'recipient binding missing' };
  } catch (error) { return { error: `${error.code ?? 'UNKNOWN'}: ${error.message}` }; }
}
function quiet(entry, binding, call = invoke, failed = () => {}) {
  try {
    const { agent, occupant: current, error } = recipient(entry, call);
    if (!current) { if (error) failed(error); return null; }
    if (agent.interactive_ready === false || !['idle', 'done'].includes(agent.agent_status)) return null;
    if (binding && (agent.name !== binding.name || agent.pane_id !== binding.pane || agent.terminal_id !== binding.terminal ||
        agent.agent_session?.value !== binding.nativeSession || agent.workspace_id !== binding.workspace || agent.cwd !== binding.cwd)) return null;
    const screen = call(entry.herdr, ['pane', 'read', agent.pane_id, '--lines', '14', '--format', 'ansi']);
    if (!composerEmpty(screen, agent.agent)) return null;
    // Keep pane read last: on the final check, prompt follows immediately.
    // Screen-based gating still has an inherent read-to-input race.
    return current;
  } catch (error) { failed(`${error.code ?? 'UNKNOWN'}: ${error.message}`); return null; }
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

// Correlation orders transport only; it grants no record or native authority.
function correlation(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['run', 'record', 'project'].includes(key)) ||
      !/^R-\d+$/.test(value.run ?? '') ||
      ![value.record, value.project].every(v => typeof v === 'string' && path.isAbsolute(v)))
    throw new Error('notice correlation needs run, absolute record and project');
  return { run: value.run, record: fs.realpathSync(value.record), project: fs.realpathSync(value.project) };
}
const runKey = entry => /^R-\d+$/.test(entry.correlation?.run ?? '') &&
  [entry.correlation?.project, entry.correlation?.record].every(v => typeof v === 'string' && path.isAbsolute(v))
  ? JSON.stringify([entry.correlation.project, entry.correlation.record, entry.correlation.run]) : null;
function dependent(prior, entry, current, lookup) {
  // Missing run metadata does not make a pending legacy callback a global
  // head. Keep its recipient/alias FIFO without inventing a run from prose or
  // IDs. An ambiguous attempt without a saved occupant still holds globally.
  const priorRun = runKey(prior), currentRun = runKey(entry);
  return prior.to === entry.to || Boolean(priorRun && priorRun === currentRun) ||
    prior.state === 'uncertain' && !occupantIdentity(prior.attempt_occupant) ||
    Boolean(current && (sameOccupant(lookup(prior).occupant, current) ||
      prior.state === 'uncertain' && sameOccupant(prior.attempt_occupant, current)));
}

export async function drainInbox(file, options = {}) {
  if (fixtureInboxEnrolled(file)) return { delivered: false, queued: true, id: options.id, inbox: file, delivery_error: 'offline fixture intake is fenced; use its foreground transport owner' };
  const cap = seconds(options.waitSeconds ?? process.env.SUPERVISOR_INPUT_WAIT_SECONDS, 7200, 'SUPERVISOR_INPUT_WAIT_SECONDS') * 1000;
  const confirm = seconds(options.confirmSeconds ?? process.env.SUPERVISOR_INPUT_CONFIRM_SECONDS, 3, 'SUPERVISOR_INPUT_CONFIRM_SECONDS') * 1000;
  const retry = seconds(options.pollSeconds ?? process.env.SUPERVISOR_INPUT_POLL_SECONDS, 10, 'SUPERVISOR_INPUT_POLL_SECONDS') * 1000;
  const started = Date.now(), deadline = started + cap, confirmations = new Map(), attempts = new Map();
  const own = () => options.id && snapshot(file).find(entry => entry.id === options.id);
  const result = error => {
    const entry = own(), delivered = complete(entry);
    return { delivered, ...(entry?.state === 'handled' ? { handled: true, autopilot: entry.autopilot } : {}),
      id: options.id, inbox: file, delivery_error: error, queued: !delivered, owner_pid: ownerPid(`${file}.owner.lock`) };
  };
  const retained = async error => {
    if (!options.owner) await resumeInbox(file, options);
    return result(error);
  };
  let reason = 'notices awaiting eligible quiet recipients';
  for (;;) {
    if (complete(own())) return result();
    let release;
    try { release = noticeLock(`${file}.drain.lock`); }
    catch (error) {
      if (!error.message.startsWith('locked:')) throw error;
      reason = error.message; // Also honours an old owner's long-held lock.
      const entry = own();
      if (entry?.state === 'pending') notify(file, entry, reason);
    }
    if (release) try {
      if (fixtureInboxEnrolled(file)) return result('offline fixture intake is fenced; use its foreground transport owner');
      const entries = snapshot(file).filter(entry => !complete(entry));
      if (!entries.length) return { ...result(), delivered: true, queued: false };
      const resolved = new Map();
      const lookup = entry => {
        const key = JSON.stringify([entry.herdr, entry.to]);
        if (!resolved.has(key)) resolved.set(key, recipient(entry));
        return resolved.get(key);
      };
      const earlier = [];
      for (const entry of entries) {
        const current = lookup(entry);
        const predecessors = earlier.filter(prior => !complete(prior));
        earlier.push(entry);
        if (predecessors.some(prior => dependent(prior, entry, current.occupant, lookup))) {
          confirmations.delete(entry.id);
          notify(file, entry, 'older dependent notice awaiting delivery or explicit recovery');
          continue;
        }
        if (entry.state === 'uncertain') {
          reason = `notice ${entry.id} uncertain: ${entry.error ?? 'unacknowledged input'}; inspect and --resolve before dependent delivery`;
          notify(file, entry, reason);
          continue;
        }
        if (!applyPolicy(file, entry.id, options)) { reason = `notice ${entry.id} policy still running`; continue; }
        Object.assign(entry, snapshot(file).find(candidate => candidate.id === entry.id));
        if (complete(entry)) continue;
        const tried = attempts.get(entry.id);
        if (tried && (tried.count >= (entry.attempts ?? 5) || Date.now() < tried.after)) continue;
        let prior = confirmations.get(entry.id);
        if (prior && prior.generation !== (entry.attempt_generation ?? 0)) {
          confirmations.delete(entry.id); prior = undefined;
        }
        if (prior && prior.occupant === current.occupant && Date.now() < prior.at + confirm) continue;
        let quietError;
        const first = quiet(entry, undefined, invoke, error => { quietError = error; });
        if (!first || first !== current.occupant) {
          confirmations.delete(entry.id);
          reason = quietError ?? current.error ?? `notice ${entry.id}: recipient busy, changed, unreadable or composer nonempty`;
          notify(file, entry, reason);
          continue;
        }
        if (!prior || prior.occupant !== first) {
          confirmations.set(entry.id, { occupant: first, at: Date.now(), generation: entry.attempt_generation ?? 0 });
          if (confirm > 0) continue;
        }
        if (Date.now() - confirmations.get(entry.id).at < confirm || Date.now() > deadline) continue;
        // Re-resolve older aliases at the input boundary, under the SAME lock
        // all old/new senders use. No wait or confirmation delay holds it.
        if (predecessors.some(prior => dependent(prior, entry, first, candidate => recipient(candidate)))) {
          confirmations.delete(entry.id); continue;
        }
        if (entry.notified) {
          const waitedSeconds = (Date.now() - (Date.parse(entry.at) || started)) / 1000;
          record(file, { type: 'waited', id: entry.id, waited_seconds: waitedSeconds,
            message: `delivered after waiting ${waitedSeconds.toFixed(1)} s for an empty input box` });
        }
        const deliveredText = `${entry.delivery_message ?? entry.message} notice-id=${entry.id}`;
        record(file, { type: 'sending', id: entry.id, delivered_text: deliveredText, occupant: first });
        // Intent precedes the FINAL binding/status/composer read. Nothing is
        // written or looked up between that pane read and native input.
        if (quiet(entry, undefined, invoke, error => { quietError = error; }) !== first) {
          record(file, { type: 'retry', id: entry.id, may_have_delivered: false,
            error: `${quietError ?? 'input changed before sending'}; no input attempted` });
          confirmations.delete(entry.id); continue;
        }
        attempts.set(entry.id, { count: (tried?.count ?? 0) + 1, after: Date.now() + entry.retrySeconds * 1000 });
        confirmations.delete(entry.id);
        try {
          const reply = JSON.parse(invoke(entry.herdr, ['agent', 'prompt', entry.to, deliveredText]));
          if (reply.error || reply.ok === false) throw Object.assign(new Error(JSON.stringify(reply.error ?? reply)), { code: reply.error?.code });
          record(file, { type: 'sent', id: entry.id, delivered_text: deliveredText });
          entry.state = 'sent';
          if (entry.id === options.id) return result();
        } catch (error) {
          const refused = ['agent_blocked', 'agent_not_found'].includes(error.code);
          reason = `notice ${entry.id}: ${error.code ?? 'UNKNOWN'}: ${error.message}`;
          record(file, { type: refused ? 'retry' : 'attempt-error', id: entry.id,
            error: reason, may_have_delivered: !refused });
          entry.state = refused ? 'pending' : 'uncertain';
          entry.attempt_occupant = first;
          notify(file, entry, reason);
        }
      }
      // Cap evidence belongs to this drain pass too. A losing/capped caller
      // must not append over another sender's durable final-input intent.
      const pending = snapshot(file).filter(entry => !complete(entry));
      if (pending.length && Date.now() >= deadline)
        record(file, { type: 'capped', id: own()?.id ?? pending[0].id, waited_seconds: (Date.now() - started) / 1000 });
    } finally { release(); }
    // Busy A never owns the global lock while waiting for its next quiet read.
    if (complete(own())) return result();
    const pending = snapshot(file).filter(entry => !complete(entry));
    if (!pending.length) return { ...result(), delivered: true, queued: false };
    if (Date.now() >= deadline) return retained(reason);
    const nextConfirmation = Math.min(...[...confirmations.values()].map(value => Math.max(10, value.at + confirm - Date.now())));
    await delay(Math.min(Math.max(retry, 10), nextConfirmation, Math.max(1, deadline - Date.now())));
  }
}

// Durable enqueue only; fleet routing must not wait behind a busy composer.
// resumeInbox owns policy and delivery through the existing input gate.
export function enqueueSupervisor(to, message, options = {}) {
  const file = path.resolve(options.inbox ?? inboxPath(options));
  const id = options.id ?? randomUUID();
  const ordering = correlation(options.correlation);
  const project = noticeProject(file, options);
  if (ordering && project && (ordering.record !== project.org || ordering.project !== project.identity))
    throw new Error('notice correlation differs from actual project/record binding');
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
      if (ordering && prior.correlation && runKey({ correlation: ordering }) !== runKey(prior) ||
          options.herdr !== undefined && prior.herdr !== options.herdr)
        throw new Error(`notice ${id} has different correlation or transport`);
      // Old callers adopt new metadata; new callers adopt legacy barriers.
      // Never rewrite an already journalled notice to invent independence.
      observed = prior; sequence = entries.indexOf(prior) + 1;
      return;
    }
    observed = append({ type: 'notice', id, to, message, correlation: ordering, project, owner: 'supervisor-inbox', herdr: options.herdr ?? 'herdr', attempts, retrySeconds,
      title: options.title ?? 'Supervisor notice queued', sound: options.sound ?? 'request' });
    sequence = entries.length + 1;
  }, options.lockOptions);
  bestEffort(() => (options.mirror ?? mirrorNotice)({ ...observed, sequence, inbox: file, cwd: options.cwd, evidence: options.shadowEvidence }, options.shadow), options.shadow);
  return { id, inbox: file };
}

export async function promptSupervisor(to, message, options = {}) {
  const { id, inbox: file } = enqueueSupervisor(to, message, options);
  if (fixtureInboxEnrolled(file)) return { delivered: complete(readInbox(file).find(entry => entry.id === id)), queued: !complete(readInbox(file).find(entry => entry.id === id)), id, inbox: file, message };
  const retrySeconds = seconds(options.retrySeconds, 10, 'retry seconds');
  // Acknowledged ownership precedes input. The worker survives this caller,
  // including a crash between the prompt side effect and its acknowledgement.
  // Policy is applied by eligible heads, preserving recipient/run ordering.
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
  const release = noticeLock(`${file}.drain.lock`, { waitMs: 5000 });
  try {
    transaction(file, (entries, append) => {
      if (entries.find((entry) => entry.id === id)?.state !== 'uncertain') throw new Error(`notice ${id} is not uncertain`);
      append({ type: sent ? 'sent' : 'retry', id, recovery: 'caller inspected delivery' });
    });
  } finally { release(); }
}

async function main() {
  const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: {
    inbox: { type: 'string' }, org: { type: 'string' }, herdr: { type: 'string' }, id: { type: 'string' }, run: { type: 'string' },
    drain: { type: 'boolean' }, resolve: { type: 'string' }, sent: { type: 'boolean' }, resend: { type: 'boolean' },
    'owner-worker': { type: 'boolean' }, settings: { type: 'string' },
    'handle-pending-line': { type: 'boolean' },
  } });
  if (opt['handle-pending-line']) {
    if (positionals.length || Object.keys(opt).some(key => !['handle-pending-line', 'org', 'inbox', 'id', 'herdr'].includes(key))) throw Error('--handle-pending-line accepts only --org, --inbox, --id and --herdr');
    const { handlePendingLineNotices } = await import('./line-notice-aggregate.mjs');
    const result=handlePendingLineNotices(opt);
    process.stdout.write(JSON.stringify(result) + '\n');
    if(result.result==='pending-line-inflight-held'||result.pending_after?.length) process.exitCode=3;
    return;
  }
  const file = path.resolve(opt.inbox ?? inboxPath(opt));
  if (opt.run) {
    const project = noticeProject(file, opt);
    if (!project) throw new Error('--run needs an actual project/record binding');
    opt.correlation = { run: opt.run, record: project.org, project: project.identity };
  }
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
