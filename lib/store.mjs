// Durable storage: an append-only JSONL event log plus immutable report copies.
// Only the org CLI writes here, under a directory lock. Agents never write the log.
import fs from './record-observation.mjs';
import path from 'node:path';
import { gitProject } from './project.mjs';
import { projectFleet, checkFleetRecord } from './fleet.mjs';
import { loadFactor, loadTimeout } from './deadline.mjs';
import { readRecord, logSignature, sameSignature, unchangedPrefix, subjectVersions, snapshotVersion } from './record-snapshot.mjs';
import { appendRecordLockTiming } from './run-timing.mjs';
import { captureReads } from './record-observation.mjs';

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
    }, { ...lockOptions, label: 'transact', actor });
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

// Explicit read-only planners run ONCE outside the lock. The entire record is
// their CAS dependency, including unknown events, global IDs, graph and claims.
// A conflict refuses rather than replaying a callback or an external effect.
// Read-only Git/queue/config helpers use the scoped observation facade; commit
// checks their identities/versions without subprocesses, parsing or hashing.
// Effectful/native callbacks continue to use transact/withLock.
export function planTransaction(dir, plan, options = {}) {
  // Only audited, effect-free derivations may opt into retry. Public callbacks
  // and native/effect checks never acquire replay authority through this flag.
  for (let attempt = 0; ; attempt++) {
    try { return plannedAppend(dir, plan, options); }
    catch (error) {
      if (!options.replaySafe || attempt >= 31 || !['RECORD_OBSERVATION_CONFLICT', 'RECORD_PLANNING_CONFLICT'].includes(error.code)) throw error;
    }
  }
}
function plannedAppend(dir, plan, { at = new Date(), actor = 'human', unattributed = false,
  strictTail = false, lockOptions } = {}) {
  const file = path.join(dir, LOG_FILE), prepared = loadRecord(dir);
  const { value, validate } = captureReads(() => plan(prepared.events, prepared.state));
  const out = value ?? {};
  let seq = prepared.events.at(-1)?.seq ?? 0;
  const stamp = at.toISOString();
  const added = (out.add ?? []).map(({ by, ...rest }) => ({ seq: ++seq, at: stamp,
    by: by ?? out.actor ?? actor, ...rest,
    ...(unattributed && !by && !out.actor ? { unattributed: true } : {}) }));
  const bytes = Buffer.from(added.map(event => JSON.stringify(event) + '\n').join(''));
  return withLock(dir, () => {
    if (!sameSignature(prepared.token.source, logSignature(file)))
      throw Object.assign(new UserError('record planning conflict: source changed; no append was made'), { code: 'RECORD_PLANNING_CONFLICT' });
    validate();
    if (strictTail && prepared.token.completeOffset !== prepared.token.source.size)
      throw new UserError('incomplete record tail; explicit control retains it without repair');
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

export function withLock(dir, fn, { timeoutMs = 10000, recover = true, label = 'withLock', actor = null } = {}) {
  const lock = path.join(dir, 'lock');
  const factor = loadFactor();
  const responseMs = loadTimeout(timeoutMs, factor);
  // Keep the missing-PID initialization grace longer than the ordinary wait;
  // expanding contention time must not make a fresh unidentified owner stale.
  const initializationMs = loadTimeout(30000, factor);
  const started = Date.now(), waitingAt = performance.now();
  let acquiredAt;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      acquiredAt = performance.now();
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (!recover) throw new UserError(`the record is locked (${lock}); explicit control will not probe or recover its owner`);
      if (lockIsStale(lock, initializationMs)) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > responseMs) {
        throw new UserError(`the record is locked (${lock}); if no record or org command is running, remove that directory`);
      }
      sleep(15);
    }
  }
  let returned = false;
  try {
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch {
    // The lock is held either way; the pid only helps detect a crashed holder.
  }
  try {
    const result = fn(); returned = true; return result;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
    const releasedAt = performance.now();
    // Diagnostic I/O is after release, best effort, and never a record event.
    try { appendRecordLockTiming(dir, { label, actor, outcome: returned ? 'returned' : 'threw',
      wait_ms: acquiredAt - waitingAt, hold_ms: releasedAt - acquiredAt, source_version: snapshotVersion }); } catch {}
  }
}

function lockIsStale(lock, initializationMs) {
  try {
    const pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
    if (pid) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (err) {
        return err.code === 'ESRCH';
      }
    }
  } catch {
    // No pid yet: either just created or its creator died before writing it.
  }
  try {
    return Date.now() - fs.statSync(lock).mtimeMs > initializationMs;
  } catch {
    return false;
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
