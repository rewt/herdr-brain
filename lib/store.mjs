// Durable storage: an append-only JSONL event log plus immutable report copies.
// Only the org CLI writes here, under a directory lock. Agents never write the log.
import fs from 'node:fs';
import path from 'node:path';
import { gitProject } from './project.mjs';
import { loadFactor, loadTimeout } from './deadline.mjs';

export const LOG_FILE = 'events.jsonl';
export const CONFIG_FILE = 'config.json';

export const DEFAULT_CONFIG = {
  // Advisory expectations. Exceeding them is surfaced in status, never refused.
  budget: { max_runs: 3, max_children: 4, max_depth: 3, escalation_budget: 1 },
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
  if (env.ORG_DIR) return path.resolve(env.ORG_DIR);
  // Respect a nested record before falling back to the canonical shared record.
  try {
    const { checkout, canonical } = gitProject(cwd);
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
  const text = fs.readFileSync(path.join(dir, LOG_FILE), 'utf8');
  const lines = text.split('\n');
  const tail = lines.pop();
  const events = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new UserError(`${LOG_FILE} line ${index + 1} is not valid JSON; the record needs manual repair`);
    }
  });
  let tornTail = false;
  if (tail.trim()) {
    try {
      events.push(JSON.parse(tail));
    } catch {
      tornTail = true;
    }
  }
  return { events, tornTail };
}

// Who is writing. ORG_ACTOR names a session; without it the write is the
// operator's. A write with neither ORG_ACTOR nor a terminal is almost always an
// agent that forgot to name itself: it is still recorded (as human) but flagged
// `unattributed`, and the CLI says how to name itself. Nothing is refused for it.
export function writer(env = process.env, stdin = process.stdin) {
  const named = Boolean(env.ORG_ACTOR);
  return { actor: env.ORG_ACTOR || 'human', unattributed: !named && !stdin?.isTTY };
}

// Runs fn(events) under the lock and appends the events it returns in one write.
// fn returns { add: [partialEvent], result, actor }.
// `unattributed` marks events written by the default actor with nobody at a
// terminal (see bin/org.mjs writer); older folds ignore the extra field.
export function transact(dir, fn, { at = new Date(), actor = 'human', unattributed = false } = {}) {
  return withLock(dir, () => {
    const file = path.join(dir, LOG_FILE);
    const repaired = prepareTail(file);
    const { events } = loadEvents(dir);
    const out = fn(events) ?? {};
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
        fs.writeSync(fd, added.map((e) => JSON.stringify(e) + '\n').join(''));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    return { added, result: out.result, repaired };
  });
}

// Makes sure the log ends with a newline before appending: a complete final event
// without one gets its newline; an incomplete final line is truncated away.
function prepareTail(file) {
  const fd = fs.openSync(file, 'r+');
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return false;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return false;
    const text = fs.readFileSync(fd, 'utf8');
    const cut = text.lastIndexOf('\n') + 1;
    try {
      JSON.parse(text.slice(cut));
      fs.writeSync(fd, '\n', size);
      return false;
    } catch {
      fs.ftruncateSync(fd, Buffer.byteLength(text.slice(0, cut)));
      return true;
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function withLock(dir, fn, { timeoutMs = 10000 } = {}) {
  const lock = path.join(dir, 'lock');
  const factor = loadFactor();
  const responseMs = loadTimeout(timeoutMs, factor);
  // Keep the missing-PID initialization grace longer than the ordinary wait;
  // expanding contention time must not make a fresh unidentified owner stale.
  const initializationMs = loadTimeout(30000, factor);
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
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
  try {
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch {
    // The lock is held either way; the pid only helps detect a crashed holder.
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
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
