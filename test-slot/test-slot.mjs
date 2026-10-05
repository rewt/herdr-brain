#!/usr/bin/env node
// Host-wide heavy-validation slot, ported from bch-cloak ENG-725 (ENG-118).
// Promotion and release commands share the existing bch-cloak lock by default.
// Workspace configuration selects one path for every participating project.
//
//   node test-slot/test-slot.mjs run <label> [--wait <seconds>] -- <command> [args...]
//   node test-slot/test-slot.mjs status
//
// `run` takes the slot, runs the command in its own process group, and releases
// the slot when the command ends. SIGINT, SIGTERM and SIGHUP are forwarded to
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

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { probe, processStartRecord, processState, removeStaleLock } from "./lock-support.mjs";
import { lookupProcess } from "../lib/processes.mjs";
import { writeFileAtomic } from "../lib/files.mjs";

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

const slotError = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const reasonOf = (error) => (error instanceof Error ? (error.code ?? error.message) : String(error));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  if (own.state !== "gone" || holder.pgid === null) return own;
  return groupState(holder.pgid, holder.groupStart, holder.groupBirth);
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
  token = randomBytes(16).toString("hex"), onWait = () => {}, deadline = Date.now() + waitSeconds * 1000 } = {}) {
  if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 0 || !Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error("invalid test slot wait/poll allowance");
  let ownStart;
  try { ownStart = processStartRecord(process.pid); }
  catch (error) { throw slotError(HOLDER_UNKNOWN_CODE, `${label} refused: cannot establish own process source identity: ${reasonOf(error)}`); }
  const started = Date.now();
  let takeovers = 0;
  let reported;
  for (;;) {
    const mine = { pid: process.pid, processStart: ownStart.start, processBirth: ownStart.birth, pgid: null, groupStart: null, groupBirth: null, token, label, cwd: process.cwd(), host: os.hostname(), acquiredAt: new Date().toISOString() };
    try {
      fs.writeFileSync(lockPath, `${JSON.stringify(mine)}\n`, { flag: "wx", mode: 0o644 });
      return held(lockPath, mine);
    } catch (error) {
      if (error?.code !== "EEXIST") throw slotError(HOLDER_UNKNOWN_CODE, `${label} refused: cannot create ${lockPath}: ${reasonOf(error)}.`);
    }
    let text;
    try { text = readText(lockPath); } catch (error) { throw slotError(HOLDER_UNKNOWN_CODE, `${label} refused: cannot read ${lockPath}: ${reasonOf(error)}. The lock is left in place.`); }
    if (text === null) continue;
    let holder = null;
    try { holder = JSON.parse(text); } catch { holder = null; }
    const inherited = env[TOKEN_ENV] ?? env[LEGACY_TOKEN_ENV];
    const { state, why } = holderState(holder);
    if (state === "live" && typeof inherited === "string" && inherited === holder.token) return nested(holder);
    if (state === "gone") {
      // Serialize stale removers, then recheck the record under the takeover guard.
      if (++takeovers > 5) throw slotError(HOLDER_UNKNOWN_CODE, `${label} refused: the stale lock at ${lockPath} kept reappearing`);
      try { removeStaleLock(lockPath, text); } catch (error) {
        throw slotError(HOLDER_UNKNOWN_CODE, `${label} refused: cannot safely remove the stale lock at ${lockPath}: ${reasonOf(error)}. Check its .takeover guard only after confirming the remover has exited.`);
      }
      continue;
    }
    if (state !== "live") {
      throw slotError(HOLDER_UNKNOWN_CODE, `${label} refused: cannot tell whether the holder of ${lockPath}, ${describeHolder(holder)}, still runs: ${String(why)}. The lock is left in place; remove it only after confirming that holder and its process group have exited.`);
    }
    let inside;
    try { inside = insideHolder(holder); } catch (error) {
      throw slotError(HOLDER_UNKNOWN_CODE, `${label} refused: cannot tell whether this process runs inside the live holder ${describeHolder(holder)}: ${reasonOf(error)}. The lock is left in place.`);
    }
    if (inside) return nested(holder);
    const waited = Date.now() - started;
    if (Date.now() >= deadline) {
      throw slotError(HELD_CODE, `${label} refused: ${describeHolder(holder)} has held the test slot ${lockPath} since ${String(holder.acquiredAt)}${waitSeconds > 0 ? ` (waited ${String(Math.round(waited / 1_000))} s)` : ""}. Heavy validation commands share one host slot; wait for it to finish, or set ${WAIT_ENV} to queue.`);
    }
    if (reported !== holder.token) {
      reported = holder.token;
      onWait({ lock_path: lockPath, label, holder: describeHolder(holder), acquired_at: holder.acquiredAt, wait_seconds: waitSeconds });
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

/** Workspace slot plus the legacy bridge, acquired in a fixed order. Taking
 * both locks closes the race with bch-cloak while workspace paths migrate. */
export async function acquireHostTestSlot(label, { env = process.env, lockPath = slotPathOf(env), compatPath = env[COMPAT_PATH_ENV] ?? TEST_SLOT_PATH,
  waitSeconds = waitSecondsOf(env), pollMs = 100, onWait = () => {} } = {}) {
  const started = Date.now();
  const deadline = started + waitSeconds * 1000;
  const slots = [];
  const paths = [...new Set([compatPath, lockPath])];
  for (const file of paths) slotPathOf({ [PATH_ENV]: file });
  try {
    for (const file of paths) {
      const remaining = Math.max(0, waitSeconds - Math.floor((Date.now() - started) / 1000));
      slots.push(await acquireTestSlot(label, { env, lockPath: file, waitSeconds: remaining, pollMs, deadline, onWait,
        ...(slots.length ? { token: slots[0].token } : {}) }));
    }
    return { nested: slots[0].nested, token: slots[0].token, holder: slots[0].holder,
      setGroup: (...args) => { for (const slot of slots) slot.setGroup(...args); },
      release: () => { for (const slot of [...slots].reverse()) slot.release(); } };
  } catch (error) {
    for (const slot of slots.reverse()) slot.release();
    throw error;
  }
}

function nested(holder) {
  return { nested: true, token: holder.token, holder, release: () => {}, setGroup: () => {} };
}

function held(lockPath, mine) {
  const ours = () => { try { return JSON.parse(readText(lockPath) ?? "null")?.token === mine.token; } catch { return false; } };
  return {
    nested: false,
    token: mine.token,
    holder: mine,
    /** Records the command's process group, atomically, so the slot stays live while it runs. */
    setGroup(pgid, groupStart, groupBirth = null) {
      if (!ours()) throw new Error(`the test slot at ${lockPath} is no longer this run's`);
      Object.assign(mine, { pgid, groupStart, groupBirth });
      const temporary = `${lockPath}.${String(process.pid)}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(mine)}\n`, { mode: 0o644 });
      fs.renameSync(temporary, lockPath);
    },
    /** Removes the lock only while it is still this run's. */
    release() {
      if (ours()) fs.rmSync(lockPath, { force: true });
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
    if (arg === "--wait") options.waitSeconds = waitSecondsOf({ [WAIT_ENV]: value() });
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

async function run({ positional, options, child }) {
  const [label] = positional;
  if (label === undefined || child.length === 0) throw new Error("usage: test-slot.mjs run <label> [--wait <seconds>] -- <command> [args...]");
  let slot;
  const wait = { schema: 'test-slot-wait/v1', state: 'waiting', started_at: new Date().toISOString(),
    wait_seconds: options.waitSeconds ?? waitSecondsOf(), waits: [] };
  const saveWait = changes => {
    Object.assign(wait, changes);
    if (options.waitReceipt) writeFileAtomic(options.waitReceipt, JSON.stringify(wait, null, 2) + '\n', 0o600);
  };
  saveWait({});
  try {
    slot = await acquireHostTestSlot(label, { lockPath: options.lockPath, compatPath: options.compatPath, pollMs: options.pollMs,
      onWait: entry => {
        saveWait({ waits: [...wait.waits, { ...entry, at: new Date().toISOString() }] });
        if (options.waitReceipt) process.stderr.write(`TEST_SLOT_WAIT: ${entry.holder}; ${entry.lock_path}; capped at ${wait.wait_seconds}s\n`);
      }, ...(options.waitSeconds === undefined ? {} : { waitSeconds: options.waitSeconds }) });
    saveWait({ state: 'acquired', finished_at: new Date().toISOString(), nested: slot.nested });
  } catch (error) {
    saveWait({ state: 'refused', finished_at: new Date().toISOString(), reason: error.message });
    if (error?.code === HELD_CODE || error?.code === HOLDER_UNKNOWN_CODE) {
      process.stderr.write(`${error.message}\n`);
      return REFUSED_EXIT;
    }
    throw error;
  }
  let received = null;
  let execution = {};
  const started = proc => {
    execution = { command_started: true, command_pid: proc.pid, started_at: new Date().toISOString() };
    if (options.resultPath) writeFileAtomic(options.resultPath, JSON.stringify(execution) + '\n', 0o600);
  };
  const retryTimeout = options.retryTimeout && process.env[RETRIED_ENV] !== "1";
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await executeCommand(child, slot, (signal) => { received ??= signal; }, retryTimeout, options.lockPath, options.compatPath, attempt > 0, started);
    if (options.resultPath) writeFileAtomic(options.resultPath, JSON.stringify({ ...execution, signal: received ?? result.signal,
      exit_code: result.status, attempts: attempt + 1, finished_at: new Date().toISOString() }) + '\n', 0o600);
    if (received !== null) { if (result.groupGone) slot.release(); return result.status === 0 ? exitOf(null, received) : result.status; }
    if (!result.groupGone) return result.status || 1;
    if (attempt === 0 && retryTimeout && shouldRetryTimeout(result)) {
      process.stderr.write(`TEST_SLOT_TIMEOUT_RETRY: ${label}: timeout under load; re-running once inside the held slot.\n`);
      continue;
    }
    slot.release();
    return result.status;
  }
}

/** Only recognized timeout evidence under measured load permits one retry. */
export function shouldRetryTimeout({ status, timeout, load, childRetried = false }) {
  return status !== 0 && status !== REFUSED_EXIT && timeout && load > 1 && !childRetried;
}

async function executeCommand(argv, slot, received, captureTimeout, lockPath, compatPath, retried, started) {
  const capacity = Math.max(1, Math.min(4, os.availableParallelism()));
  let load = os.loadavg()[0] / capacity;
  let timeout = false;
  let childRetried = false;
  // Keep a bounded tail for markers split across chunks; never buffer a suite log.
  let tail = "";
  const observe = (data) => {
    const text = tail + String(data);
    timeout ||= /ETIMEDOUT|testTimeoutFailure|Test (?:file|suite) exceeded \d+ms|ERR_TEST_FAILURE[^\n]*timeout|failureType: ['"]testTimeoutFailure/u.test(text);
    // A nested wrapper already spent this command's single retry. Its timeout
    // evidence must not make a containing promotion/release adapter replay it.
    childRetried ||= text.includes("TEST_SLOT_TIMEOUT_RETRY:");
    tail = text.slice(-1024);
  };
  const proc = spawn(argv[0], argv.slice(1), { stdio: captureTimeout ? ["inherit", "pipe", "pipe"] : "inherit", detached: !slot.nested,
    env: { ...process.env, [PATH_ENV]: lockPath, [COMPAT_PATH_ENV]: compatPath, [TOKEN_ENV]: slot.token, [LEGACY_TOKEN_ENV]: slot.token,
      ...(retried ? { [RETRIED_ENV]: "1" } : {}) } });
  const completion = new Promise((resolve) => {
    proc.once("error", (error) => { process.stderr.write(`test-slot: ${error.message}\n`); resolve({ status: 127, signal: null }); });
    proc.once("close", (code, signal) => resolve({ status: exitOf(code, signal), signal }));
  });
  if (proc.pid !== undefined) started(proc);
  if (captureTimeout) {
    proc.stdout.on("data", data => { observe(data); process.stdout.write(data); });
    proc.stderr.on("data", data => { observe(data); process.stderr.write(data); });
  }
  const forwarded = new Set();
  const forward = (signal) => {
    received(signal);
    // A nested command remains in the holder's group so orphan liveness still
    // protects the slot. Forward once: this group includes this wrapper too.
    if (forwarded.has(signal)) return;
    forwarded.add(signal);
    const target = slot.nested ? (slot.holder.pgid ? -slot.holder.pgid : proc.pid) : -proc.pid;
    try { process.kill(target, signal); } catch { /* already gone */ }
  };
  for (const signal of SIGNALS) process.on(signal, forward);
  try {
    if (!slot.nested && proc.pid !== undefined) {
      slot.setGroup(proc.pid, null);
      try {
        const identity = processStartRecord(proc.pid);
        slot.setGroup(proc.pid, identity.start, identity.birth);
      } catch { /* fail closed if start identity is unavailable */ }
    }
    const { status, signal } = await completion;
    load = Math.max(load, os.loadavg()[0] / capacity);
    timeout ||= status === 124;
    // Preserve the lock when a command has left background group members behind.
    // A subsequent taker checks their liveness even after this wrapper exits.
    let groupGone = true;
    if (!slot.nested && proc.pid !== undefined) {
      const deadline = Date.now() + 1000;
      while (probe(-proc.pid) !== false && Date.now() < deadline) await sleep(25);
      groupGone = probe(-proc.pid) === false;
      if (!groupGone) process.stderr.write("TEST_SLOT_GROUP_REMAINS: command group still exists; lock retained.\n");
    }
    // Signals are never retryable, including commands that swallow a signal.
    return { status, signal, timeout: signal ? false : timeout, load, childRetried, groupGone };
  } catch (error) {
    forward("SIGTERM");
    throw error;
  } finally {
    for (const signal of SIGNALS) process.off(signal, forward);
  }
}

function status({ options }) {
  const locks = [...new Set([options.compatPath, options.lockPath])].map(lockPath => {
    const text = readText(lockPath);
    if (text === null) return { state: "free", lockPath };
    let holder = null;
    try { holder = JSON.parse(text); } catch { /* unknown records stay in place */ }
    return { ...holderState(holder), lockPath, holder };
  });
  const state = locks.find(row => row.state === "unknown") ?? locks.find(row => row.state === "live") ?? locks[locks.length - 1];
  process.stdout.write(`${JSON.stringify(locks.length === 1 ? state : { ...state, locks })}\n`);
  return state.state === "live" ? 1 : state.state === "unknown" ? 2 : 0;
}

const invokedDirectly = () => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (invokedDirectly()) {
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
      // Unknown liveness never authorizes a signal; the slot remains protective.
      const checkCaller = () => {
        if (processState(caller.pid, caller.start, caller.birth).state === 'gone') {
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
