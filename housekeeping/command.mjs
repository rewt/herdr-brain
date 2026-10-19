// Read module bookkeeping and validate tracked overrides. Never start a timer,
// signal a process, mutate a pane, or write record events from this command.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { ownerAlive, readOwnerProcess } from '../lib/process-owner.mjs';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir, UserError } from '../lib/store.mjs';
import { renderHousekeeping } from '../lib/render.mjs';
import { DEFAULTS, FIELDS, validateConfig, parseOverride } from './config.mjs';

function safeTarget(target) {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('project .housekeeping.json must be a regular, unlinked file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// Logs can grow indefinitely. Read only a bounded tail and ignore an unfinished
// append; distinguish damaged complete entries from an empty successful scan.
function actionTail(file, warnings) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - 512 * 1024);
    const buffer = Buffer.alloc(size - start);
    const count = fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, count).toString('utf8');
    if (start) { text = text.slice(text.indexOf('\n') + 1); warnings.push('Activity is a bounded log tail; earlier entries are omitted.'); }
    const lines = text.split('\n'); lines.pop();
    const entries = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (!entry || typeof entry.action !== 'string' || typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))) throw Error('invalid entry');
        entries.push(entry);
      } catch { if (!warnings.includes('Some complete activity entries are unreadable.')) warnings.push('Some complete activity entries are unreadable.'); }
    }
    return entries;
  } catch (error) { if (error.code !== 'ENOENT') warnings.push(`Activity unavailable: ${error.message}`); return []; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function housekeepingSnapshot({ cwd = process.cwd(), org, env = process.env, readProcess = readOwnerProcess } = {}) {
  const project = gitProject(cwd), target = path.join(project.canonical, '.housekeeping.json');
  safeTarget(target);
  const bytes = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  const revision = crypto.createHash('sha256').update(JSON.stringify([project.identity, target, bytes])).digest('hex');
  let overrides = {}, configError = null;
  try { overrides = validateConfig(bytes === null ? {} : JSON.parse(bytes)); }
  catch (error) { configError = error.message; }
  const config = configError ? null : { ...DEFAULTS, ...overrides };
  const record = org || findOrgDir({ cwd, env }) || findOrgDir({ cwd: project.canonical, env });
  const key = crypto.createHash('sha256').update(project.identity).digest('hex');
  const stateDir = record ? path.join(fs.realpathSync(record), 'housekeeping', key) : null;
  const warnings = [], actions = stateDir ? actionTail(path.join(stateDir, 'actions.jsonl'), warnings) : [];
  let processState = 'stopped', owner = null, editable = !configError;
  if (!record) processState = 'no record';
  else {
    const lock = path.join(stateDir, 'lock');
    if (fs.existsSync(lock)) {
      try {
        owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
        if (!Number.isInteger(owner.pid) || owner.pid < 1 || owner.cwd !== project.canonical ||
            fs.realpathSync(owner.org) !== fs.realpathSync(record) || owner.config !== target ||
            typeof owner.script !== 'string' || !Array.isArray(owner.record_cli) || !owner.record_cli.length ||
            [owner.script, ...owner.record_cli].some(file => typeof file !== 'string' || !fs.existsSync(file))) {
          throw Error('lock identity or runtime does not match this project, record and default config');
        }
        processState = ownerAlive(owner, readProcess) ? 'running' : 'stale lock';
      } catch (error) { processState = 'unknown'; editable = false; warnings.push(`Schedule unavailable: ${error.message}`); }
    }
  }
  const live = actions.filter(a => !a.dryRun && !a.action.startsWith('would-'));
  const lastScan = live.findLast(a => a.action === 'scan') ?? null;
  const lastAttempt = live.findLast(a => ['scan', 'error', 'disabled'].includes(a.action)) ?? null;
  return { target, revision, editable, overrides: configError ? null : overrides, config, configError,
    record: record ?? null, stateDir, process: processState, pid: owner?.pid ?? null,
    lastScan, lastAttempt, actions: actions.slice(-200).reverse(), warnings };
}

export function setHousekeeping(patch, { cwd = process.cwd(), org, env = process.env, expect, unset = [] } = {}) {
  validateConfig(patch);
  if (unset.some(key => !FIELDS.includes(key))) throw Error('unknown housekeeping override to unset');
  if (unset.some(key => Object.hasOwn(patch, key))) throw Error('cannot set and unset the same override');
  const before = housekeepingSnapshot({ cwd, org, env });
  if (!before.editable) throw Error(before.configError ?? 'refresh and inspect the schedule identity before editing');
  const lock = `${before.target}.lock`;
  try { fs.mkdirSync(lock); } catch (error) { if (error.code === 'EEXIST') throw Error('housekeeping config is locked'); throw error; }
  let temporary;
  try {
    const current = housekeepingSnapshot({ cwd, org, env });
    if (!current.editable) throw Error('housekeeping configuration or schedule became unavailable');
    if (expect !== undefined && current.revision !== expect) throw Error('housekeeping changed since you opened the editor; refresh and review again');
    const next = { ...current.overrides, ...patch };
    for (const key of unset) delete next[key];
    validateConfig(next);
    temporary = `${current.target}.tmp-${crypto.randomUUID()}`;
    const mode = fs.existsSync(current.target) ? fs.statSync(current.target).mode & 0o777 : 0o644;
    const fd = fs.openSync(temporary, 'wx', mode);
    try { fs.writeFileSync(fd, JSON.stringify(next, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const latest = housekeepingSnapshot({ cwd, org, env });
    if (!latest.editable || latest.revision !== current.revision) throw Error('housekeeping changed while saving; refresh and review again');
    safeTarget(current.target);
    fs.renameSync(temporary, current.target); temporary = null;
    return housekeepingSnapshot({ cwd, org, env });
  } finally {
    if (temporary) fs.rmSync(temporary, { force: true });
    fs.rmdirSync(lock);
  }
}

export function housekeepingCommand(argv) {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      json: { type: 'boolean' }, expect: { type: 'string' }, unset: { type: 'string', multiple: true },
      ...Object.fromEntries(FIELDS.map(key => [key.replaceAll('_', '-'), { type: 'string' }])),
    } });
    const patch = Object.fromEntries(FIELDS.filter(key => values[key.replaceAll('_', '-')] !== undefined)
      .map(key => [key, parseOverride(key, values[key.replaceAll('_', '-')])]));
    let result;
    if (!positionals.length && !Object.keys(patch).length && !values.unset && values.expect === undefined) result = housekeepingSnapshot();
    else if (positionals.length === 1 && positionals[0] === 'pause' && !Object.keys(patch).length && !values.unset) result = setHousekeeping({ enabled: false }, { expect: values.expect });
    else if (positionals.length === 1 && positionals[0] === 'set' && (Object.keys(patch).length || values.unset?.length)) result = setHousekeeping(patch, { expect: values.expect, unset: values.unset });
    else throw Error('usage: record housekeeping [--json] | pause [--expect REV] | set --enabled true|false --resume true|false --release-sessions true|false --tick-seconds N --cleanup-seconds N [--unset KEY] [--expect REV]');
    process.stdout.write(values.json ? JSON.stringify(result, null, 2) + '\n' : renderHousekeeping(result));
    return 0;
  } catch (error) { throw new UserError(error.message); }
}
