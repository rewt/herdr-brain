// Durable storage: an append-only JSONL event log plus immutable report copies.
// Only the org CLI writes here, under a directory lock. Agents never write the log.
import fs from './record-observation.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { gitProject } from './project.mjs';
import { projectFleet, checkFleetRecord } from './fleet.mjs';
import { loadFactor, loadTimeout } from './deadline.mjs';
import { readRecord, logSignature, sameSignature, unchangedPrefix, subjectVersions, snapshotVersion } from './record-snapshot.mjs';
import { appendRecordLockTiming, appendRecordLockRefusal, appendRecordConflict } from './run-timing.mjs';
import { captureReads, noteRecordEffect, runRecordEffect, recordSourceConflict, isRecordSourceConflict } from './record-observation.mjs';

export const LOG_FILE = 'events.jsonl';
export const CONFIG_FILE = 'config.json';

export const DEFAULT_CONFIG = {
  // Advisory expectations. Exceeding them is surfaced in status, never refused.
  budget: { max_runs: 3, max_children: 4, max_depth: 3, escalation_budget: 1, max_unlanded: 8 },
  stale_run_hours: 24,
  // Which questions (org ask) wait for the operator ("ask") and which are answered
  // with their recommendation at once ("auto"). Relaxed by editing config.json.
  approvals: {
    default: 'ask',
    categories: {
      design: 'ask', security: 'ask', 'funds-and-chain': 'ask', prover: 'ask',
      publish: 'ask', licensing: 'ask', 'delete-data': 'ask', priorities: 'ask',
      goals: 'ask', tooling: 'ask', other: 'ask',
    },
  },
};

export class UserError extends Error {}

// Diagnostic attribution only, computed before acquisition. Keep labels/schema
// compatible with existing timing readers; never use a callsite as authority.
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
function recordCaller() {
  const frame = new Error().stack?.split('\n').find(line => line.includes(`file://${sourceRoot}`) && !line.includes('/lib/store.mjs:'));
  const match = frame && /file:\/\/([^()]+):(\d+):\d+\)?$/.exec(frame.trim());
  return match ? `${path.relative(sourceRoot, fileURLToPath(`file://${match[1]}`))}:${match[2]}` : null;
}

export function now(env = process.env) {
  if (env.ORG_NOW) {
    const d = new Date(env.ORG_NOW);
    if (Number.isNaN(d.getTime())) throw new UserError(`ORG_NOW is not a valid date: ${env.ORG_NOW}`);
    return d;
  }
  return new Date();
}

export function findOrgDir({ cwd = process.cwd(), env = process.env } = {}) {
  if (env.ORG_DIR) {
    checkFleetRecord(env.ORG_DIR, env);
    return path.resolve(env.ORG_DIR);
  }
  const boundary = projectFleet(cwd, env);
  if (boundary.fleet) {
    if (boundary.project) return boundary.project.record;
    // Respect local records before an unclaimed legacy ancestor layout.
    if (boundary.git) {
      let local = fs.realpathSync(cwd);
      const relative = path.relative(boundary.git.checkout, local);
      const inside = relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
      while (inside) {
        const candidate = path.join(local, '.org');
        if (isOrgDir(candidate)) return candidate;
        if (local === boundary.git.checkout) break;
        const parent = path.dirname(local);
        if (parent === local) break;
        local = parent;
      }
    }
    const candidate = path.join(boundary.git?.canonical ?? path.resolve(cwd), '.org');
    return isOrgDir(candidate) ? candidate : boundary.legacy?.record ?? null;
  }
  // Respect a nested record before falling back to the canonical shared record.
  try {
    const { checkout, canonical } = gitProject(cwd, { env });
    let local = fs.realpathSync(cwd);
    for (;;) {
      const candidate = path.join(local, '.org');
      if (isOrgDir(candidate)) return candidate;
      if (local === checkout) break;
      const parent = path.dirname(local);
      if (parent === local) break;
      local = parent;
    }
    const candidate = path.join(canonical, '.org');
    if (isOrgDir(candidate)) return candidate;
    cwd = canonical;
  } catch {}
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, '.org');
    if (fs.existsSync(path.join(candidate, LOG_FILE))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function isOrgDir(dir) {
  return Boolean(dir) && fs.existsSync(path.join(dir, LOG_FILE));
}

export function initOrg(dir) {
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  const log = path.join(dir, LOG_FILE);
  try { fs.writeFileSync(log, '', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const config = path.join(dir, CONFIG_FILE);
  withLock(dir, () => {
    if (!fs.existsSync(config)) writeFileAtomic(config, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  });
}

export function readConfig(dir) {
  const file = path.join(dir, CONFIG_FILE);
  let raw = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new UserError(`${file} is not valid JSON: ${err.message}`);
    }
  }
  const approvals = raw.approvals ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    budget: { ...DEFAULT_CONFIG.budget, ...(raw.budget ?? {}) },
    approvals: {
      default: approvals.default ?? DEFAULT_CONFIG.approvals.default,
      categories: { ...DEFAULT_CONFIG.approvals.categories, ...(approvals.categories ?? {}) },
    },
  };
}

// Returns every complete event. An incomplete final line (an interrupted write) is
// reported as tornTail and ignored; any other unparseable line is a hard error.
export function loadEvents(dir) {
  const { events, tornTail } = loadRecord(dir);
  return { events, tornTail };
}

export function loadRecord(dir, options = {}) {
  return readRecord(path.join(dir, LOG_FILE), { ...options,
    invalidJSON: line => new UserError(`${LOG_FILE} line ${line} is not valid JSON; the record needs manual repair`) });
}

// Who is writing. ORG_ACTOR names a session; without it the write is the
// operator's. A write with neither ORG_ACTOR nor a terminal is almost always an
// agent that forgot to name itself: it is still recorded (as human) but flagged
// `unattributed`, and the CLI says how to name itself. Nothing is refused for it.
export function writer(env = process.env, stdin = process.stdin) {
  const named = Boolean(env.ORG_ACTOR);
  return { actor: env.ORG_ACTOR || 'human', unattributed: !named && !stdin?.isTTY };
}

// Prepare parsing/folding outside the lock; fn(events, state, observation) still
// runs ONCE under it, preserving side-effectful public callbacks. A concurrent
// append refreshes outside the lock before any callback, never by replaying fn.
// Optional prepare(state, events) runs once outside the lock. With no subjects,
// any intervening event conflicts. Declared subjects permit unrelated appends;
// callers still check all current invariants/native authority in fn.
// fn returns { add: [partialEvent], result, actor }.
// `unattributed` marks events written by the default actor with nobody at a
// terminal (see bin/org.mjs writer); older folds ignore the extra field.
export function transact(dir, fn, { at = new Date(), actor = 'human', unattributed = false, strictTail = false, lockOptions,
  prepare, subjects } = {}) {
  noteRecordEffect();
  const caller = recordCaller();
  const file = path.join(dir, LOG_FILE), changed = Symbol('refresh outside lock');
  if (prepare !== undefined && typeof prepare !== 'function') throw new UserError('transaction prepare must be a function');
  if (subjects !== undefined && (!Array.isArray(subjects) || !subjects.length || subjects.some(id => typeof id !== 'string' || !/^[A-Z][A-Z0-9]*-\d+$/.test(id)))) throw new UserError('transaction subjects must be a nonempty array of IDs');
  let prepared = loadRecord(dir);
  const original = prepared.token, originalCount = prepared.events.length;
  const expected = prepare && subjects ? subjectVersions(prepared.events, subjects) : null;
  // Preparation gets its own view: mutating it cannot alter commit authority.
  const observation = prepare?.(structuredClone(prepared.state), structuredClone(prepared.events));
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = withLock(dir, () => {
      // An append or replacement requires a fresh, fully verified prefix. Do
      // not hash/replay the old log while blocking every compatible writer.
      if (!sameSignature(prepared.token.source, logSignature(file))) return changed;
      if (strictTail && prepared.token.completeOffset !== prepared.token.source.size) throw new UserError('incomplete record tail; explicit control retains it without repair');
      const repaired = strictTail ? false : prepareTail(file, prepared.token);
      const { events, state } = prepared;
      const out = fn(events, state, observation) ?? {};
      let seq = events.length ? events.at(-1).seq : 0;
      const stamp = at.toISOString();
      const added = (out.add ?? []).map(({ by, ...rest }) => ({
        seq: ++seq,
        at: stamp,
        by: by ?? out.actor ?? actor,
        ...rest,
        ...(unattributed && !by && !out.actor ? { unattributed: true } : {}),
      }));
      if (added.length) {
        const fd = fs.openSync(file, 'a');
        try {
          const bytes = Buffer.from(added.map((e) => JSON.stringify(e) + '\n').join(''));
          for (let offset = 0; offset < bytes.length;) {
            const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
            if (!written) throw new UserError('record append made no progress; retain the tail for inspection');
            offset += written;
          }
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
      return { added, result: out.result, repaired };
    }, { caller, ...lockOptions, label: 'transact', actor });
    if (result !== changed) return result;
    prepared = loadRecord(dir);
    if (prepare) {
      const versions = expected && subjectVersions(prepared.events, subjects);
      if (!unchangedPrefix(file, original, prepared.token) ||
          (expected ? [...expected].some(([id, version]) => versions.get(id) !== version) : prepared.events.length !== originalCount)) {
        throw new UserError('record preparation conflict: source or relevant subject/claim changed; no commit callback was run');
      }
    }
  }
  throw new UserError('record changed repeatedly before commit; no commit callback was run');
}

// Explicit read-only planners run outside the lock. The entire record is
// their CAS dependency, including unknown events, global IDs, graph and claims.
// Audited planners may re-prepare on a pre-effect source conflict, never replay
// a commit callback, nested record effect or genuine guard/native refusal.
// Read-only Git/queue/config helpers use the scoped observation facade; commit
// checks their identities/versions without subprocesses, parsing or hashing.
// Effectful/native callbacks continue to use transact/withLock.
export function planTransaction(dir, plan, options = {}) {
  noteRecordEffect();
  return retryRecordPreparation(dir, 'planTransaction', options.replaySafe, effects => plannedAppend(dir, plan, options, effects));
}

function retryRecordPreparation(dir, label, enabled, prepare) {
  const caller = recordCaller(), attempts = 32;
  for (let attempt = 1; ; attempt++) {
    const effects = { started: false };
    try { return prepare(effects); }
    catch (error) {
      if (!isRecordSourceConflict(error)) throw error;
      const retry = Boolean(enabled && !effects.started && !error.recordEffectsObserved && attempt < attempts);
      // Diagnostic only, after release. Old loaded writers are not covered by
      // this journal; absence of rows alone is never whole-product acceptance.
      try { appendRecordConflict(dir, {
        source_version: snapshotVersion,
        caller, label, attempt, retry, code: error.code, reason: error.message,
        effects_started: effects.started, record_effects: Boolean(error.recordEffectsObserved),
      }); } catch {}
      if (!retry) throw error;
    }
  }
}
function plannedAppend(dir, plan, { at = new Date(), actor = 'human', unattributed = false,
  strictTail = false, lockOptions } = {}, effects) {
  const file = path.join(dir, LOG_FILE), prepared = loadRecord(dir);
  const { value, validate, recordEffects } = captureReads(() => plan(prepared.events, prepared.state));
  effects.started = recordEffects;
  const out = value ?? {};
  if (out.commit !== undefined && typeof out.commit !== 'function') throw new UserError('record commit effect must be a function');
  let seq = prepared.events.at(-1)?.seq ?? 0;
  const stamp = at.toISOString();
  const added = (out.add ?? []).map(({ by, ...rest }) => ({ seq: ++seq, at: stamp,
    by: by ?? out.actor ?? actor, ...rest,
    ...(unattributed && !by && !out.actor ? { unattributed: true } : {}) }));
  const bytes = Buffer.from(added.map(event => JSON.stringify(event) + '\n').join(''));
  return withLock(dir, () => {
    if (!sameSignature(prepared.token.source, logSignature(file)))
      throw recordSourceConflict('record planning conflict: source changed; no append was made', 'RECORD_PLANNING_CONFLICT', UserError);
    validate();
    if (strictTail && prepared.token.completeOffset !== prepared.token.source.size)
      throw new UserError('incomplete record tail; explicit control retains it without repair');
    // Irreversible/native checks and immutable publication run exactly once,
    // after both CAS checks, while no other record writer can change authority.
    if (out.commit) effects.started = true;
    // A slow native authorization can use validate immediately before its
    // immutable publication, closing the observation gap without replaying it.
    const effect = out.commit?.(validate);
    if (effect && typeof effect.then === 'function') throw new UserError('record commit effects must be synchronous');
    const repaired = strictTail ? false : prepareTail(file, prepared.token);
    if (bytes.length) {
      const fd = fs.openSync(file, 'a');
      try {
        for (let offset = 0; offset < bytes.length;) {
          const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
          if (!written) throw new UserError('record append made no progress; retain the tail for inspection');
          offset += written;
        }
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    }
    return { added, result: out.result, repaired };
  }, { ...lockOptions, label: 'planTransaction', actor });
}

// Makes sure the log ends with a newline before appending: a complete final event
// without one gets its newline; an incomplete final line is truncated away. The
// parse/byte boundary was prepared outside and its exact source rechecked inside.
function prepareTail(file, { source, completeOffset, finalComplete }) {
  if (completeOffset === source.size) return false;
  const fd = fs.openSync(file, 'r+');
  try {
    if (finalComplete) {
      fs.writeSync(fd, '\n', source.size);
      return false;
    }
    fs.ftruncateSync(fd, completeOffset);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

export function withLock(dir, fn, options = {}) {
  const caller = options.caller ?? recordCaller();
  return runRecordEffect(() => locked(dir, fn, { ...options, caller }));
}

// Prepare read-only authority checks without monopolizing the record. The
// returned fence is single-use, never refreshes/replays a native lookup, and
// checks the exact source plus observed files while all required locks are held.
// The effect itself retains its original operation/lane/queue lock ordering.
export function prepareRecordGuard(dir, check, options = {}) {
  const prepared = loadRecord(dir), file = path.join(dir, LOG_FILE);
  if (prepared.tornTail) throw new UserError('incomplete record event; no guarded effect was run');
  const { value, validate: inputs, recordEffects } = captureReads(() => check(prepared.events, prepared.state));
  let used = false;
  const validate = () => {
    try {
      if (!sameSignature(prepared.token.source, logSignature(file)))
        throw recordSourceConflict('record guard conflict: source changed; no guarded effect was run', 'RECORD_GUARD_CONFLICT', UserError);
      inputs();
    } catch (error) { if (recordEffects) error.recordEffectsObserved = true; throw error; }
  };
  return { validate, run(operation = () => {}) {
    if (used) throw new UserError('record guard was already used; no guarded effect was run');
    used = true;
    return withLock(dir, () => { validate(); return operation(value); }, { label: 'recordGuard', ...options });
  } };
}
export function withRecordGuard(dir, check, operation = () => {}, options) {
  // `check` is read-only authority preparation. Repeat every check from the
  // fresh snapshot; the operation and any nested effect remain single-shot.
  return retryRecordPreparation(dir, 'recordGuard', true, effects =>
    prepareRecordGuard(dir, check, options).run(value => {
      effects.started = true;
      return operation(value);
    }));
}

function locked(dir, fn, { timeoutMs = 10000, recover = true, label = 'withLock', actor = null, caller = null } = {}) {
  const lock = path.join(dir, 'lock');
  const factor = loadFactor();
  const responseMs = loadTimeout(timeoutMs, factor);
  const started = Date.now(), waitingAt = performance.now();
  const refuse = (reason, message) => {
    // Failed attempts are not acquisitions. Keep their diagnostic separate,
    // best effort, without inspecting/recovering an explicit-control owner.
    try { appendRecordLockRefusal(dir, { label, actor, caller, reason,
      wait_ms: performance.now() - waitingAt, source_version: snapshotVersion }); } catch {}
    throw new UserError(message);
  };
  let acquiredAt;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      acquiredAt = performance.now();
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (!recover) refuse('explicit-control', `the record is locked (${lock}); explicit control will not probe or recover its owner`);
      if (reclaimDeadLock(lock)) continue;
      if (Date.now() - started > responseMs) {
        refuse('owner-unconfirmed', `the record is locked (${lock}); owner death is not confirmed; retain it for inspection`);
      }
      sleep(15);
    }
  }
  const identity = lockIdentity(lock);
  let returned = false;
  try {
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid), { flag: 'wx', mode: 0o600 });
    const result = fn(); returned = true; return result;
  } finally {
    if (lockIdentity(lock) === identity) fs.rmSync(lock, { recursive: true, force: true });
    const releasedAt = performance.now();
    // Diagnostic I/O is after release, best effort, and never a record event.
    try { appendRecordLockTiming(dir, { label, actor, caller, outcome: returned ? 'returned' : 'threw',
      wait_ms: acquiredAt - waitingAt, hold_ms: releasedAt - acquiredAt, source_version: snapshotVersion }); } catch {}
  }
}

function lockIdentity(lock) {
  try { const s = fs.lstatSync(lock, { bigint: true }); return s.isDirectory() && [s.dev, s.ino, s.birthtimeNs].join(':'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function deadOwner(lock) {
  try {
    const text = fs.readFileSync(path.join(lock, 'pid'), 'utf8');
    const pid = Number(text);
    if (/^[1-9]\d*$/.test(text) && Number.isSafeInteger(pid)) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (err) {
        return err.code === 'ESRCH';
      }
    }
  } catch {} // Missing/malformed PID or refused probe is UNKNOWN, never death.
  return false;
}
function reclaimDeadLock(lock, depth = 0) {
  const identity = lockIdentity(lock);
  if (!identity || !deadOwner(lock) || depth >= 4) return false;
  // Serialize reclaimers INSIDE this exact dead directory. A second waiter
  // must not rm a new owner's directory using a stale death observation.
  const reap = path.join(lock, 'reap');
  let reaper;
  try {
    try { fs.mkdirSync(reap); }
    catch (error) {
      if (error.code === 'EEXIST') reclaimDeadLock(reap, depth + 1);
      else if (error.code !== 'ENOENT') throw error;
      return false;
    }
    reaper = lockIdentity(reap);
    fs.writeFileSync(path.join(reap, 'pid'), String(process.pid), { flag: 'wx', mode: 0o600 });
    if (lockIdentity(lock) !== identity || !deadOwner(lock)) return false;
    const retired = `${lock}.dead-${process.pid}-${randomUUID()}`;
    fs.renameSync(lock, retired);
    // Only the detached directory is removed; the canonical path is free for
    // a new owner even if deletion of the old contents is interrupted.
    fs.rmSync(retired, { recursive: true, force: true });
    return true;
  } finally {
    if (reaper && lockIdentity(lock) === identity && lockIdentity(reap) === reaper)
      fs.rmSync(reap, { recursive: true, force: true });
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Operator-selected record paths retain ordinary filesystem symlink semantics.
// Privileged entry writes into agent-writable paths use lib/files.mjs instead.
export function writeFileAtomic(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content, { mode });
  fs.renameSync(temporary, file);
}
