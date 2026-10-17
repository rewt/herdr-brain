#!/usr/bin/env node
// Host-wide heavy-validation slot, ported from bch-cloak ENG-725 (ENG-118).
// Ordinary work starts immediately; only declared proving takes the legacy lock.
// Workspace configuration selects one path for every participating project.
// Waiting takers publish protocol v1 tickets and acquire each path in arrival order.
//
//   node test-slot/test-slot.mjs run <label> [--wait <seconds>] -- <command> [args...]
//   node test-slot/test-slot.mjs status
//
// `run` publishes shared occupancy (or takes the slot for declared proving),
// runs the command in its own process group, and cleans up when it ends. SIGINT, SIGTERM and SIGHUP are forwarded to
// that group. A refusal exits 75 with one line on stderr that starts with its
// code. A command started inside a held slot (the holder's token in its
// environment, or the holder among its ancestors or process group) runs inside
// that slot instead of taking it again, so nested commands and each test
// file never wait on the run that contains them.
//
// Liveness is judged by pid and process start time, never by command-line
// pattern, so a waiter never matches itself. The holder counts as live while its
// own process runs, or, once that is gone, while any process of its command's
// group remains (a runner killed with SIGKILL leaves its command running). It is
// gone only when both are known gone. When liveness cannot be established (the kernel source
// fails, the record is unreadable or names no holder, a signal probe fails), the
// taker is refused with TEST_SLOT_HOLDER_UNKNOWN and the lock is left in place.
//
// This is an operational guard for one development host. It excludes only the
// runs that take it; unrelated host workloads remain outside this guard.

import { resolveGateLimits, projectCommon, recordHealthyGate, historyFile, gateHistoryKey, TIMEOUT_EXIT } from "./limits.mjs";
import { stopGateGroup } from "./watchdog.mjs";
import { spawn } from "node:child_process";
import path from "node:path";
import { resolveResource } from "./resources.mjs";
import { boundedTelemetry, measureFamily } from "./measurement.mjs";
import { EXECUTIONS_PER_PROFILE, RETENTION_SCHEMA, pruneExecutions } from './retention.mjs';
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { setTimeout as pollSleep } from 'node:timers/promises';

import { probe, processStartRecord, processState, removeStaleLock } from "./lock-support.mjs";
import { readTestSlotQueue, testSlotTicket } from './ticket-queue.mjs';
import { occupancyState, readTestSlotOccupancy, sharedOccupancy } from './occupancy.mjs';
import { lookupProcess } from "../lib/processes.mjs";
import { writeFileAtomic } from "../lib/files.mjs";
import { cliHelp, isMain } from '../lib/cli-help.mjs';
cliHelp(import.meta.url, "Usage: node test-slot/test-slot.mjs run LABEL [--wait SECONDS] [--timeout-seconds SECONDS] [--idle-timeout-seconds SECONDS] [--tier TIER] [--no-slot] -- COMMAND [ARGS...] | status");

export const TEST_SLOT_PATH = process.platform === "darwin" ? "/private/tmp/bch-cloak-test-slot.lock" : "/tmp/bch-cloak-test-slot.lock";
export const COMPAT_PATH_ENV = "MONITOR_TEST_SLOT_COMPAT_PATH";
export const PATH_ENV = "MONITOR_TEST_SLOT_PATH";
export const LEGACY_TOKEN_ENV = "BCH_CLOAK_TEST_SLOT_TOKEN";
export const LEGACY_WAIT_ENV = "BCH_CLOAK_TEST_SLOT_WAIT_SECONDS";
export const TOKEN_ENV = "MONITOR_TEST_SLOT_TOKEN";
export const WAIT_ENV = "MONITOR_TEST_SLOT_WAIT_SECONDS";
export const RETRIED_ENV = "MONITOR_TEST_SLOT_TIMEOUT_RETRIED";
export const HELD_CODE = "TEST_SLOT_HELD";
export const HOLDER_UNKNOWN_CODE = "TEST_SLOT_HOLDER_UNKNOWN";
export const REFUSED_EXIT = 75;
export const LEFTOVER_EXIT = 123;

const slotError = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const reasonOf = (error) => (error instanceof Error ? (error.code ?? error.message) : String(error));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitingTickets = new Set();
const removeWaitingTickets = () => { for (const ticket of waitingTickets) ticket.remove(); };

/**
 * The command's process group, once the holder process is gone. A pid is never issued while a process group of that
 * id exists, so a live process with the group's id but another start time means the whole group has exited.
 */
function groupState(pgid, leaderStart, leaderBirth) {
  const leader = probe(pgid);
  if (leader === true) {
    const state = processState(pgid, leaderStart, leaderBirth);
    return state.state === "live" ? { state: "live", why: `its command's group leader ${String(pgid)} still runs` } : state;
  }
  if (leader !== false) return { state: "unknown", why: `kill(${String(pgid)}, 0) failed: ${reasonOf(leader)}` };
  const members = probe(-pgid);
  if (members === true) return { state: "live", why: `its command's process group ${String(pgid)} still has members` };
  if (members === false) return { state: "gone" };
  return { state: "unknown", why: `kill(-${String(pgid)}, 0) failed: ${reasonOf(members)}` };
}

const positive = (v) => Number.isSafeInteger(v) && v > 0;
const isHolder = (h) => h !== null && typeof h === "object" && positive(h.pid) && typeof h.token === "string" && h.token.length > 0 && (h.pgid === null || positive(h.pgid));

/** The recorded holder's state: "live", "gone", or "unknown" with the reason. Only "gone" permits a takeover. */
export function holderState(holder) {
  if (!isHolder(holder)) return { state: "unknown", why: "the lock file does not name a holder process" };
  const own = processState(holder.pid, holder.processStart, holder.processBirth);
  if (own.state !== "gone") return own;
  const groups = [...(holder.pgid === null ? [] : [{ pgid: holder.pgid, start: holder.groupStart, birth: holder.groupBirth }]), ...Object.values(holder.groups ?? {})];
  for (const group of groups) {
    const state = groupState(group.pgid, group.start, group.birth);
    if (state.state !== 'gone') return state;
  }
  return { state: 'gone' };
}

/** Whether this process runs inside the holder's run, using a complete kernel snapshot. */
function insideHolder(holder) {
  const result = lookupProcess(undefined, { identityOnly: true });
  if (!result.ok) throw Error(result.error);
  const rows = result.value;
  const own = rows.get(process.pid);
  if (own === undefined) throw new Error("process source did not list this process");
  if (holder.pid === process.pid) return true;
  if (holder.pgid !== null && own.pgid === holder.pgid) return true;
  const seen = new Set();
  for (let pid = process.pid; rows.has(pid) && !seen.has(pid); pid = rows.get(pid).ppid) {
    if (rows.get(pid).ppid === holder.pid) return true;
    seen.add(pid);
  }
  return false;
}

const describeHolder = (h) => (isHolder(h) ? `${String(h.label)} (pid ${String(h.pid)}${h.pgid === null ? "" : `, group ${String(h.pgid)}`}, ${String(h.cwd)})` : "an unreadable record");

function readText(lockPath) {
  try { return fs.readFileSync(lockPath, "utf8"); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

/** The wait budget from the environment: a non-negative integer number of seconds, 0 when unset. */
export function waitSecondsOf(env = process.env) {
  const raw = env[WAIT_ENV] ?? env[LEGACY_WAIT_ENV];
  if (raw === undefined || raw === "") return 0;
  if (!/^(?:0|[1-9][0-9]{0,6})$/u.test(raw)) throw new Error(`${WAIT_ENV} must be a whole number of seconds`);
  return Number(raw);
}

/**
 * Takes the slot for `label`, or runs inside the slot this process already belongs to. Waits up to `waitSeconds` for
 * a live holder; refuses with TEST_SLOT_HELD when it still holds, or TEST_SLOT_HOLDER_UNKNOWN when liveness cannot be
 * established. Resolves to { nested, token, holder, release(), setGroup(pgid, groupStart) }.
 */
export async function acquireTestSlot(label, { env = process.env, lockPath = slotPathOf(env), waitSeconds = waitSecondsOf(env), pollMs = 2_000,
  token = randomBytes(16).toString("hex"), onWait = () => {}, deadline = Date.now() + waitSeconds * 1000, signal } = {}) {
  if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 0 || !Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error("invalid test slot wait/poll allowance");
  let ownStart;
  try { ownStart = processStartRecord(process.pid); }
  catch (error) { throw slotError(HOLDER_UNKNOWN_CODE, `${label} refused: cannot establish own process source identity: ${reasonOf(error)}`); }
  const started = Date.now();
  let takeovers = 0;
  let reported;
  let ticket;
  const publish = () => {
    if (!ticket) {
      ticket = testSlotTicket(lockPath, { token, label, identity: ownStart, waitSeconds });
      waitingTickets.add(ticket);
      if (waitingTickets.size === 1) process.on('exit', removeWaitingTickets);
    }
    try { ticket.publish(); }
    catch (error) { throw slotError(HOLDER_UNKNOWN_CODE, `${label} refused: cannot publish a ticket for ${lockPath}: ${reasonOf(error)}.`); }
  };
  const queueOf = () => {
    try { return readTestSlotQueue(lockPath, { prune: true }); }
    catch (error) { throw slotError(HOLDER_UNKNOWN_CODE, `${label} refused: cannot read the queue for ${lockPath}: ${reasonOf(error)}.`); }
  };
  try {
    for (;;) {
      signal?.throwIfAborted();
      let text;
      try { text = readText(lockPath); } catch (error) { throw slotError(HOLDER_UNKNOWN_CODE, `${label} refused: cannot read ${lockPath}: ${reasonOf(error)}. The lock is left in place.`); }
      let holder = null;
      try { holder = JSON.parse(text); } catch { holder = null; }
      const inherited = env[TOKEN_ENV] ?? env[LEGACY_TOKEN_ENV];
      const { state, why } = text === null ? { state: 'free' } : holderState(holder);
      if (state === "live" && typeof inherited === "string" && inherited === holder.token) return nested(holder, lockPath);
      if (state === 'live') {
        let inside;
        try { inside = insideHolder(holder); } catch (error) {
          throw slotError(HOLDER_UNKNOWN_CODE, `${label} refused: cannot tell whether this process runs inside the live holder ${describeHolder(holder)}: ${reasonOf(error)}. The lock is left in place.`);
        }
        if (inside) return nested(holder, lockPath);
      }
      // Nested checks precede publication, including republishing a deleted ticket.
      if (ticket) publish();
      if (state === "gone") {
        // Serialize stale removers, then recheck the record under the takeover guard.
        if (++takeovers > 5) throw slotError(HOLDER_UNKNOWN_CODE, `${label} refused: the stale lock at ${lockPath} kept reappearing`);
        try { removeStaleLock(lockPath, text); } catch (error) {
          throw slotError(HOLDER_UNKNOWN_CODE, `${label} refused: cannot safely remove the stale lock at ${lockPath}: ${reasonOf(error)}. Check its .takeover guard only after confirming the remover has exited.`);
        }
        continue;
      }
      if (state !== "live" && state !== 'free') {
        throw slotError(HOLDER_UNKNOWN_CODE, `${label} refused: cannot tell whether the holder of ${lockPath}, ${describeHolder(holder)}, still runs: ${String(why)}. The lock is left in place; remove it only after confirming that holder and its process group have exited.`);
      }
      let queue = queueOf();
      if (!ticket && waitSeconds > 0 && (state === 'live' || queue.head)) {
        publish();
        queue = queueOf();
      }
      const first = ticket ? queue.head?.name === ticket.name : queue.head === null;
      if (state === 'free' && first && (!ticket || Date.now() < deadline)) {
        const mine = { pid: process.pid, processStart: ownStart.start, processBirth: ownStart.birth, pgid: null, groupStart: null, groupBirth: null, token, label, cwd: process.cwd(), host: os.hostname(), acquiredAt: new Date().toISOString() };
        try {
          fs.writeFileSync(lockPath, `${JSON.stringify(mine)}\n`, { flag: "wx", mode: 0o644 });
          // The finally block removes the ticket only after the lock is published.
          return held(lockPath, mine);
        } catch (error) {
          if (error?.code !== "EEXIST") throw slotError(HOLDER_UNKNOWN_CODE, `${label} refused: cannot create ${lockPath}: ${reasonOf(error)}.`);
          // A competing creator may be our holder; recheck nesting before queuing.
          continue;
        }
      }
      const waited = Date.now() - started;
      if (Date.now() >= deadline) {
        const blocker = state === 'live' ? `${describeHolder(holder)} has held the test slot ${lockPath} since ${String(holder.acquiredAt)}`
          : `an earlier waiter ${String(queue.head?.ticket?.label ?? '')} is queued for the test slot ${lockPath}`;
        throw slotError(HELD_CODE, `${label} refused: ${blocker}${waitSeconds > 0 ? ` (waited ${String(Math.round(waited / 1_000))} s)` : ""}. Heavy validation commands share one host slot; wait for it to finish, or set ${WAIT_ENV} to queue.`);
      }
      const blocker = state === 'live' ? holder : queue.head?.ticket;
      if (reported !== blocker?.token) {
        reported = blocker?.token;
        onWait({ lock_path: lockPath, label, holder: state === 'live' ? describeHolder(holder) : `queued waiter ${String(blocker?.label)}`,
          acquired_at: blocker?.acquiredAt ?? blocker?.arrivedAt, wait_seconds: waitSeconds });
      }
      await pollSleep(Math.min(first ? Math.min(pollMs, 500) : pollMs, Math.max(0, deadline - Date.now())), undefined, { signal });
    }
  } finally {
    if (ticket) {
      try { ticket.remove(); }
      finally {
        waitingTickets.delete(ticket);
        if (waitingTickets.size === 0) process.off('exit', removeWaitingTickets);
      }
    }
  }
}

/** Workspace slot plus the legacy bridge, acquired in a fixed order. Taking
 * both locks closes the race with bch-cloak while workspace paths migrate. */
export async function acquireHostTestSlot(label, { env = process.env, lockPath = slotPathOf(env), compatPath = env[COMPAT_PATH_ENV] ?? TEST_SLOT_PATH,
  waitSeconds = waitSecondsOf(env), pollMs = 100, onWait = () => {}, signal } = {}) {
  const started = Date.now();
  const deadline = started + waitSeconds * 1000;
  const slots = [];
  const paths = [...new Set([compatPath, lockPath])];
  for (const file of paths) slotPathOf({ [PATH_ENV]: file });
  try {
    for (const file of paths) {
      const remaining = Math.max(0, waitSeconds - Math.floor((Date.now() - started) / 1000));
      slots.push(await acquireTestSlot(label, { env, lockPath: file, waitSeconds: remaining, pollMs, deadline, onWait, signal,
        ...(slots.length ? { token: slots[0].token } : {}) }));
    }
    return { nested: slots[0].nested, token: slots[0].token, holder: slots[0].holder,
      setGroup: (...args) => { for (const slot of slots) slot.setGroup(...args); },
      release: () => { let gone = true; for (const slot of [...slots].reverse()) gone = slot.release() !== false && gone; return gone; } };
  } catch (error) {
    for (const slot of slots.reverse()) slot.release();
    throw error;
  }
}

// Serialize holder group registration. Recover guards only after confirming their owner is gone.
function updateHolder(lockPath, token, change) {
  const guard = `${lockPath}.groups-lock`;
  const identity = processStartRecord(process.pid);
  const ownerFile = `${guard}.${process.pid}.${randomBytes(8).toString('hex')}`;
  // Publish complete owner bytes by an exclusive hard link, so SIGKILL cannot
  // leave an empty guard between exclusive creation and writing its identity.
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, ...identity }), { flag: 'wx', mode: 0o600 });
  const deadline = Date.now() + 1000;
  let acquired = false;
  try {
    for (;;) {
      try { fs.linkSync(ownerFile, guard); acquired = true; break; }
      catch (error) {
        if (error.code === 'EEXIST') {
          const text = readText(guard);
          if (text === null) continue;
          let owner;
          try { owner = JSON.parse(text); } catch { /* Unknown owner retains guard. */ }
          if (positive(owner?.pid) && typeof owner.start === 'string' && typeof owner.birth === 'string' &&
              processState(owner.pid, owner.start, owner.birth).state === 'gone') {
            try {
              removeStaleLock(guard, text);
              process.stderr.write(`TEST_SLOT_GUARD_RECOVERED: dead owner guard ${guard} removed.\n`);
            } catch (error) {
              throw slotError(HOLDER_UNKNOWN_CODE, `cannot recover group guard ${guard}: ${reasonOf(error)}`);
            }
            continue;
          }
        }
        if (error.code !== 'EEXIST' || Date.now() >= deadline)
          throw slotError(HOLDER_UNKNOWN_CODE, `cannot update group guard ${guard}: ${reasonOf(error)}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    const record = JSON.parse(readText(lockPath) ?? 'null');
    if (record?.token !== token) throw Error(`the test slot at ${lockPath} is no longer this run's`);
    change(record);
    writeFileAtomic(lockPath, JSON.stringify(record) + '\n', 0o644);
  } finally {
    if (acquired) fs.rmSync(guard);
    fs.rmSync(ownerFile);
  }
}

function nested(holder) {
  // Legacy readers know only holder.pid and holder.pgid. Nested commands must
  // remain in that group so an orphan still prevents takeover by those readers.
  return { nested: true, token: holder.token, holder, setGroup: () => {}, release: () => true };
}

// Read once for nesting, never poll, acquire or modify a lock/queue. Occupancy
// uses ancestry/group identity rather than tokens. This also preserves nesting
// under a legacy exclusive holder, including when its tokens were scrubbed.
function inheritedSlot(paths, { exclusive = false } = {}) {
  for (const file of paths) {
    let occupants = [];
    try { occupants = readTestSlotOccupancy(file); } catch { /* Presence is informational. */ }
    for (const row of occupants) {
      try {
        if (row.state === 'live' && insideHolder(row.record))
          return { ...nested(row.record), token: null, class: 'shared', occupancyPath: row.path };
      } catch { /* An unavailable ancestry source does not block shared work. */ }
    }
    if (exclusive) continue; // The unchanged exclusive path checks its locks.
    try {
      const holder = JSON.parse(readText(file));
      if (holderState(holder).state === 'live' &&
          ((process.env[TOKEN_ENV] ?? process.env[LEGACY_TOKEN_ENV]) === holder.token || insideHolder(holder)))
        return { ...nested(holder), class: 'exclusive' };
    } catch { /* An unrelated unreadable lock cannot block shared work. */ }
  }
  return null;
}

function held(lockPath, mine) {
  const ours = () => { try { return JSON.parse(readText(lockPath) ?? "null")?.token === mine.token; } catch { return false; } };
  return {
    nested: false,
    token: mine.token,
    holder: mine,
    /** Records the command's process group, atomically, so the slot stays live while it runs. */
    setGroup(pgid, groupStart, groupBirth = null, gate = {}) {
      if (!ours()) throw new Error(`the test slot at ${lockPath} is no longer this run's`);
      Object.assign(mine, { pgid, groupStart, groupBirth, ...gate });
      updateHolder(lockPath, mine.token, record => Object.assign(record, { pgid, groupStart, groupBirth, ...gate }));
    },
    /** Removes the lock only while it is still this run's. */
    release() {
      if (!ours()) return true;
      const record = JSON.parse(readText(lockPath));
      for (const group of Object.values(record.groups ?? {})) {
        if (groupState(group.pgid, group.start, group.birth).state !== 'gone') return false;
      }
      fs.rmSync(lockPath, { force: true });
      return true;
    },
  };
}

// ---- command line ---------------------------------------------------------------

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

export function slotPathOf(env = process.env) {
  const value = env[PATH_ENV] ?? TEST_SLOT_PATH;
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0") || value.length === 1) throw new Error(`${PATH_ENV} must be an absolute lock file path`);
  return value;
}

function parse(argv) {
  const [command, ...rest] = argv;
  const options = { lockPath: slotPathOf(), compatPath: process.env[COMPAT_PATH_ENV] ?? TEST_SLOT_PATH, waitSeconds: undefined, pollMs: 100, retryTimeout: false };
  const positional = [];
  let i = 0;
  for (; i < rest.length && rest[i] !== "--"; i += 1) {
    const arg = rest[i];
    const value = () => { const v = rest[++i]; if (v === undefined) throw new Error(`${arg} needs a value`); return v; };
    if (arg === "--no-slot") options.noSlot = true;
    else if (arg === "--wait") options.waitSeconds = waitSecondsOf({ [WAIT_ENV]: value() });
    else if (arg === "--timeout-seconds") options.timeoutSeconds = Number(value());
    else if (arg === "--idle-timeout-seconds") options.idleTimeoutSeconds = Number(value());
    else if (arg === "--project-common") options.common = value();
    else if (arg === "--history-key") options.historyKey = JSON.parse(value());
    else if (arg === "--tier") options.tier = value();
    else if (arg === "--resource") options.resource = JSON.parse(value());
    else if (arg === "--measurement-notes") options.measurementNotes = value();
    else if (arg === "--result-path") options.resultPath = value();
    else if (arg === '--caller') {
      options.caller = JSON.parse(value());
      if (!options.caller || !Number.isSafeInteger(options.caller.pid) || options.caller.pid < 1 ||
          typeof options.caller.start !== 'string' || typeof options.caller.birth !== 'string') throw Error('invalid test-slot caller identity');
    }
    else if (arg === "--wait-receipt-path") options.waitReceipt = value();
    else if (arg === "--lock-path") options.compatPath = options.lockPath = value();
    else if (arg === "--poll-ms") options.pollMs = Number(value());
    else if (arg === "--retry-timeout-under-load") options.retryTimeout = true;
    else positional.push(arg);
  }
  return { command, positional, options, child: rest.slice(i + 1) };
}

const exitOf = (code, signal) => (code ?? 128 + (os.constants.signals[signal] ?? 0));

export async function run({ positional, options, child }) {
  const [label] = positional;
  if (label === undefined || child.length === 0) throw new Error("usage: test-slot.mjs run <label> [--wait <seconds>] -- <command> [args...]");
  const common = options.common ?? projectCommon();
  const tier = options.tier ?? label;
  const historyKey = options.historyKey ?? gateHistoryKey(tier, child);
  const limits = resolveGateLimits({ ...options, common, tier, historyKey, command: child });
  const historyPath = historyFile(common, tier, child, historyKey);
  const resource = resolveResource(child, { resource: options.resource });
  let slot;
  const waiting = new AbortController();
  const cancelWait = signal => { waiting.abort(signal); removeWaitingTickets(); };
  for (const signal of SIGNALS) process.on(signal, cancelWait);
  const wait = { schema: 'test-slot-wait/v1', state: 'waiting', started_at: new Date().toISOString(),
    wait_seconds: options.waitSeconds ?? waitSecondsOf(), waits: [] };
  try {
    const exclusive = resource.admission_class === 'EXCLUSIVE';
    slot = options.noSlot ? { nested: false, token: null, setGroup: () => {}, release: () => {} }
      : inheritedSlot([...new Set([options.lockPath, options.compatPath])], { exclusive })
      ?? (exclusive ? await acquireHostTestSlot(label, { lockPath: options.lockPath, compatPath: options.compatPath, pollMs: options.pollMs, signal: waiting.signal,
      onWait: entry => {
        wait.waits.push({ ...entry, at: new Date().toISOString() });
        if (options.waitReceipt) process.stderr.write(`TEST_SLOT_WAIT: ${entry.holder}; ${entry.lock_path}; capped at ${wait.wait_seconds}s\n`);
      }, ...(options.waitSeconds === undefined ? {} : { waitSeconds: options.waitSeconds }) })
        : sharedOccupancy(options.lockPath, label, resource));
    slot.class ??= options.noSlot ? 'unslotted' : 'exclusive';
    const acquiredAt = new Date().toISOString();
    Object.assign(wait, { state: 'acquired', acquired_at: acquiredAt, finished_at: acquiredAt, nested: slot.nested,
      class: slot.class, occupancy_path: slot.occupancyPath });
    // This sidecar proves a grant. Queue/log evidence records refusals instead.
    if (options.waitReceipt) writeFileAtomic(options.waitReceipt, JSON.stringify(wait, null, 2) + '\n', 0o600);
  } catch (error) {
    if (slot?.class === 'shared') slot.release();
    if (waiting.signal.aborted) return exitOf(null, waiting.signal.reason);
    if (error?.code === HELD_CODE || error?.code === HOLDER_UNKNOWN_CODE) {
      process.stderr.write(`${error.message}\n`);
      return REFUSED_EXIT;
    }
    throw error;
  } finally {
    for (const signal of SIGNALS) process.off(signal, cancelWait);
  }
  try {
    let automaticReceipt = false;
    // CLI recipes (not just synchronous adapters) retain execution evidence.
    // These sidecars are outside the wire protocol and healthy-clock history.
    if (resource.profile && !slot.nested && !options.noSlot && !options.resultPath) {
      try {
        const directory = historyPath ? path.join(path.dirname(historyPath), 'executions') : path.resolve('.test-slot-executions');
        fs.mkdirSync(directory, { recursive: true });
        automaticReceipt = true;
        options.resultPath = path.join(directory, `${Date.now()}-${randomBytes(8).toString('hex')}.execution.json`);
      } catch { /* Evidence storage cannot change execution. */ }
    }
    const saveExecution = value => {
      if (!options.resultPath) return;
      try {
        const retention = automaticReceipt ? { schema: RETENTION_SCHEMA, newest_per_profile: EXECUTIONS_PER_PROFILE,
          holder: slot.holder, lock_paths: slot.occupancyPath ? [slot.occupancyPath] : [...new Set([options.lockPath, options.compatPath])] } : undefined;
        writeFileAtomic(options.resultPath, JSON.stringify({ ...value, ...(retention ? { retention } : {}) }) + '\n', 0o600);
        if (automaticReceipt) {
          try { pruneExecutions(options.resultPath, resource.profile.id, holder => holder?.class === 'shared' ? occupancyState(holder) : holderState(holder)); }
          catch { /* Pruning cannot change execution. */ }
        }
      }
      catch (error) { if (!automaticReceipt) throw error; }
    };
    const telemetry = resource.profile && !slot.nested && !options.noSlot && options.resultPath
      ? boundedTelemetry(`${options.resultPath}.samples.jsonl`) : null;
    const measurementAttempts = [];
    let received = null;
    let execution = { resource, class: slot.class, occupancy_path: slot.occupancyPath };
    const started = proc => {
      execution = { resource, class: slot.class, occupancy_path: slot.occupancyPath,
        command_started: true, command_pid: proc.pid, started_at: new Date().toISOString() };
      saveExecution(execution);
    };
    const retryTimeout = options.retryTimeout && process.env[RETRIED_ENV] !== "1";
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await executeCommand(child, slot, (signal) => { received ??= signal; }, options.lockPath, options.compatPath, attempt > 0, started, limits, options.onCapture, resource.profile && !slot.nested && !options.noSlot ? {
        telemetryPath: options.resultPath ? `${options.resultPath}.samples.jsonl` : undefined, telemetry, notes: options.measurementNotes,
      } : null);
      if (result.measurement) measurementAttempts.push({ attempt: attempt + 1, ...result.measurement });
      saveExecution({ ...execution, signal: received ?? result.signal,
        measurement: result.measurement ?? { status: slot.nested ? 'nested; sampling owned by top-level holder if profiled' : options.noSlot ? 'unslotted' : 'unprofiled' }, measurement_attempts: measurementAttempts,
        history_key: historyKey, exit_code: result.status, attempts: attempt + 1, limits, gate_timeout: result.gateTimeout, duration_s: result.duration_s, longest_silence_s: result.longest_silence_s, cleanup_error: result.cleanup_error, finished_at: new Date().toISOString() });
      if (received !== null) { if (result.groupGone) slot.release(); return result.status === 0 ? exitOf(null, received) : result.status; }
      if (!result.groupGone) return result.status || 1;
      if (attempt === 0 && retryTimeout && shouldRetryTimeout(result)) {
        process.stderr.write(`TEST_SLOT_TIMEOUT_RETRY: ${label}: timeout under load; re-running once inside the held slot.\n`);
        continue;
      }
      const released = slot.release();
      if (released !== false && result.status === 0 && received === null && !result.gateTimeout) {
        try { recordHealthyGate({ common, tier, historyKey, file: historyPath, command: child, duration_s: result.duration_s, longest_silence_s: result.longest_silence_s }); }
        catch (error) { process.stderr.write(`GATE_HISTORY_WARNING: ${error.message}\n`); }
      }
      if (released === false) process.stderr.write('TEST_SLOT_GROUP_REMAINS: nested command group still exists; lock retained.\n');
      return released === false ? result.status || 1 : result.status;
    }
  } finally {
    // Informational presence always follows its owner, even on setup/storage
    // failure or an uncertain watchdog cleanup. Exclusive retention is unchanged.
    if (slot.class === 'shared') slot.release();
  }
}

/** Only recognized timeout evidence under measured load permits one retry. */
export function shouldRetryTimeout({ status, timeout, load, childRetried = false, gateTimeout = null }) {
  return status !== 0 && status !== REFUSED_EXIT && !gateTimeout && timeout && load > 1 && !childRetried;
}

async function executeCommand(argv, slot, received, lockPath, compatPath, retried, started, limits, onCapture, measurementOptions) {
  const capacity = Math.max(1, Math.min(4, os.availableParallelism()));
  let load = os.loadavg()[0] / capacity;
  let timeout = false;
  let childRetried = false;
  // Keep a bounded tail for markers split across chunks; never buffer a suite log.
  let gateTimeout = null, descendantTimeout = null;
  const clock = () => Number(process.hrtime.bigint()) / 1e9;
  const commandStart = clock();
  let lastOutput = commandStart, longestSilence = 0;
  let stopping, stopError, failWatchdog, rootIdentity, measurement;
  const ownsGroup = !slot.nested;
  let leftover = false;
  const failure = new Promise(resolve => { failWatchdog = error => resolve({ error }); });
  const tracked = new Map();
  let tail = "";
  const observe = (data) => {
    const now = clock();
    longestSilence = Math.max(longestSilence, now - lastOutput);
    lastOutput = now;
    const text = tail + String(data);
    const overrun = text.match(/(?:^|\n)GATE_TIMEOUT: (wall|idle) limit ([0-9.]+)s exceeded; elapsed ([0-9.]+)s/u);
    if (overrun) descendantTimeout ??= { kind: overrun[1], limit_seconds: Number(overrun[2]), elapsed_s: Number(overrun[3]), descendant: true };
    timeout ||= /ETIMEDOUT|testTimeoutFailure|Test (?:file|suite) exceeded \d+ms|ERR_TEST_FAILURE[^\n]*timeout|failureType: ['"]testTimeoutFailure/u.test(text);
    // A nested wrapper already spent this command's single retry. Its timeout
    // evidence must not make a containing promotion/release adapter replay it.
    childRetried ||= text.includes("TEST_SLOT_TIMEOUT_RETRY:");
    tail = text.slice(-1024);
  };
  const proc = spawn(argv[0], argv.slice(1), { stdio: ["inherit", "pipe", "pipe"], detached: !slot.nested,
    env: { ...process.env, [PATH_ENV]: lockPath, [COMPAT_PATH_ENV]: compatPath, ...(slot.token === null ? {} : { [TOKEN_ENV]: slot.token, [LEGACY_TOKEN_ENV]: slot.token }),
      ...(retried ? { [RETRIED_ENV]: "1" } : {}) } });
  const closed = new Promise(resolve => proc.once("close", resolve));
  let leaderExited = false;
  const completion = new Promise((resolve) => {
    proc.once("error", (error) => { process.stderr.write(`test-slot: ${error.message}\n`); resolve({ status: 127, signal: null }); });
    proc.once("exit", (code, signal) => { leaderExited = true; resolve({ status: exitOf(code, signal), signal }); });
  });
  if (proc.pid !== undefined) started(proc);
  {
    proc.stdout.on("data", data => { observe(data); process.stdout.write(data); });
    proc.stderr.on("data", data => { observe(data); process.stderr.write(data); });
  }
  const watcher = setInterval(() => {
    if (proc.pid === undefined || stopping) return;
    const elapsed = clock() - commandStart, idle = clock() - lastOutput;
    const kind = elapsed >= limits.wall_seconds ? 'wall' : limits.idle_seconds > 0 && idle >= limits.idle_seconds ? 'idle' : null;
    if (!kind) return;
    gateTimeout = { kind, limit_seconds: kind === 'wall' ? limits.wall_seconds : limits.idle_seconds, elapsed_s: elapsed };
    process.stderr.write(`GATE_TIMEOUT: ${kind} limit ${gateTimeout.limit_seconds}s exceeded; elapsed ${elapsed.toFixed(3)}s\n`);
    stopping = stopGateGroup(proc.pid, { tracked, rootIdentity, ownsGroup, ownedChild: ownsGroup && !leaderExited, onCapture }).catch(error => { stopError = error; failWatchdog(error); });
  }, 50);
  const forwarded = new Set();
  const forward = (signal) => {
    received(signal);
    // Nested gates share the holder group; cancel only their descendants.
    if (forwarded.has(signal)) return;
    forwarded.add(signal);
    stopping ??= stopGateGroup(proc.pid, { tracked, rootIdentity, ownsGroup, ownedChild: ownsGroup && !leaderExited, firstSignal: signal, onCapture }).catch(error => { stopError = error; failWatchdog(error); });
  };
  for (const signal of SIGNALS) process.on(signal, forward);
  try {
    if (proc.pid !== undefined) {
      slot.setGroup(proc.pid, null, null, { gate_started_at: new Date().toISOString(), gate_limits: limits });
      let startRecord;
      try {
        const identity = processStartRecord(proc.pid);
        const root = lookupProcess(proc.pid, { identityOnly: true });
        if (root.ok && root.value) rootIdentity = root.value.identity;
        startRecord = identity;
      } catch { /* The unreaped detached child still proves group ownership. */ }
      if (startRecord) slot.setGroup(proc.pid, startRecord.start, startRecord.birth);
    }
    if (measurementOptions && proc.pid !== undefined) {
      try { measurement = measureFamily({ pid: proc.pid, identity: rootIdentity, ...measurementOptions }); }
      catch (error) { measurement = { finish: () => ({ status: 'unavailable', failures: [{ component: 'sampling-start', message: error.message }] }) }; }
    }
    const completed = await Promise.race([completion, failure]);
    if (completed.error) throw completed.error;
    const { status, signal } = completed;
    if (stopping) await stopping;
    if (stopError) throw stopError;
    load = Math.max(load, os.loadavg()[0] / capacity);
    timeout ||= status === 124;
    // A successful leader can leave pipes/group members alive. Give them a
    // short grace, then clean up as a distinct failure rather than an overrun.
    clearInterval(watcher);
    let groupGone = true;
    if (proc.pid !== undefined) {
      const remains = () => ownsGroup ? probe(-proc.pid) !== false : [...tracked.values()].some(saved => {
        const now = lookupProcess(saved.pid, { identityOnly: true });
        return !now.ok || now.value?.identity === saved.identity;
      });
      const deadline = Date.now() + 1000;
      while (remains() && !stopping && Date.now() < deadline) await sleep(25);
      if (remains() && !stopping) {
        leftover = true;
        process.stderr.write('GATE_LEFTOVER_GROUP: command exited with background descendants; stopping owned processes.\n');
        await stopGateGroup(proc.pid, { tracked, rootIdentity, ownsGroup, onCapture });
      }
      if (stopping) await stopping;
      if (stopError) throw stopError;
      groupGone = !remains();
    }
    clearInterval(watcher);
    // Cleanup is confirmed; close inherited pipes even if an unobserved daemon
    // retained them outside the supported parent-walk boundary.
    let drainTimer;
    await Promise.race([closed, new Promise(resolve => { drainTimer = setTimeout(resolve, 1000); })]);
    clearTimeout(drainTimer);
    proc.stdout.destroy(); proc.stderr.destroy();
    const ended = clock(), duration_s = ended - commandStart;
    longestSilence = Math.max(longestSilence, ended - lastOutput);
    if (status === TIMEOUT_EXIT) gateTimeout ??= descendantTimeout;
    // Signals are never retryable, including commands that swallow a signal.
    return { status: gateTimeout ? TIMEOUT_EXIT : leftover ? LEFTOVER_EXIT : status, signal: gateTimeout ? null : signal, gateTimeout, duration_s, longest_silence_s: longestSilence, timeout: signal ? false : timeout, load, childRetried, groupGone, measurement: measurement?.finish() };
  } catch (error) {
    if (gateTimeout || leftover) {
      process.stderr.write(`${gateTimeout ? 'GATE_TIMEOUT_CLEANUP_FAILED' : 'GATE_LEFTOVER_GROUP_CLEANUP_FAILED'}: ${error.message}; slot retained.\n`);
      proc.stdout.destroy(); proc.stderr.destroy(); proc.unref();
      return { status: gateTimeout ? TIMEOUT_EXIT : LEFTOVER_EXIT, signal: null, gateTimeout, groupGone: false,
        duration_s: clock() - commandStart, longest_silence_s: clock() - lastOutput, cleanup_error: error.message, measurement: measurement?.finish() };
    }
    forward("SIGTERM");
    throw error;
  } finally {
    measurement?.stop?.();
    clearInterval(watcher);
    for (const signal of SIGNALS) process.off(signal, forward);
  }
}

function status({ options }) {
  const locks = [...new Set([options.compatPath, options.lockPath])].map(lockPath => {
    const { tickets, head } = readTestSlotQueue(lockPath);
    const queue = (head ? [head, ...tickets.filter(row => row !== head)] : tickets)
      .map(row => ({ ...row, head: row === head }));
    const text = readText(lockPath);
    if (text === null) return { state: "free", lockPath, queue };
    let holder = null;
    try { holder = JSON.parse(text); } catch { /* unknown records stay in place */ }
    return { ...holderState(holder), lockPath, holder, queue };
  });
  const state = locks.find(row => row.state === "unknown") ?? locks.find(row => row.state === "live") ?? locks[locks.length - 1];
  const occupancy = [...new Set([options.lockPath, options.compatPath])].flatMap(file => readTestSlotOccupancy(file));
  process.stdout.write(`${JSON.stringify({ ...(locks.length === 1 ? state : { ...state, locks }), occupancy })}\n`);
  return state.state === "live" ? 1 : state.state === "unknown" ? 2 : 0;
}

if (isMain(import.meta.url)) {
  let callerWatch;
  try {
    const parsed = parse(process.argv.slice(2));
    const main = parsed.command === "run" ? run : parsed.command === "status" ? status : null;
    if (main === null) {
      process.stderr.write("usage: test-slot.mjs run <label> [--wait <seconds>] -- <command> [args...] | status\n");
      process.exit(2);
    }
    if (parsed.command === 'run' && parsed.options.caller) {
      const caller = parsed.options.caller;
      // spawnSync blocks its caller's JS signal handlers. If that exact caller
      // dies (including a timeout), the async wrapper cancels the command group.
      // This wrapper is the caller's direct spawnSync child. A parent cannot be
      // replaced by a reused PID without first reparenting this child. The
      // recorded start/birth is taken once by the adapter; polling needs only
      // getppid and kill-zero, never a source lookup or bundled-helper hash.
      // Unknown signal-probe errors alone do not authorize cancellation.
      const checkCaller = () => {
        if (process.ppid !== caller.pid || probe(caller.pid) === false) {
          clearInterval(callerWatch); process.kill(process.pid, 'SIGTERM');
        }
      };
      checkCaller();
      callerWatch = setInterval(checkCaller, 100);
      callerWatch.unref();
    }
    process.exitCode = await main(parsed);
  } catch (error) { process.stderr.write(`test-slot: ${error.message}\n`); process.exitCode = 2; }
  finally { clearInterval(callerWatch); }
}
