// Deterministic routing and denial-only fallback. Only action receipts live
// here; record status stays derived by the record. No model or approval keys.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFleet } from '../../lib/fleet.mjs';
import { gitProject } from '../../lib/project.mjs';
import { supervisorBinding } from '../../supervisor/session-binding.mjs';
import { enqueueSupervisor, readInbox, resumeInbox } from '../../supervisor/prompt-supervisor.mjs';
import { noticeLock } from '../../supervisor/notice-lock.mjs';
import { HOME } from './queue.mjs';
import { writeFileAtomic } from '../../lib/files.mjs';
import { permissionDecision } from './permission-policy.mjs';
import { fallbackRequest, declineObserved } from './permission-fallback.mjs';

const run = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const cut = (value, n = 1000) => String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, n);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const done = entry => ['sent', 'handled'].includes(entry.state);
const sessionKey = agent => hash(JSON.stringify([agent.name, agent.pane_id, agent.terminal_id, agent.agent_session]));

export function stewardConfig(home = HOME) {
  const file = path.join(home, 'steward.json');
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!object(raw)) throw Error('steward config must be an object');
  for (const key of Object.keys(raw)) if (!['enabled', 'projects', 'alert_command', 'stalled_seconds', 'debounce_seconds', 'alert_cap', 'imessage_command', 'imessage_recipient', 'key_fallback'].includes(key)) throw Error(`unknown steward setting: ${key}`);
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw Error('steward enabled must be boolean');
  const number = (key, fallback, min, max) => {
    const value = raw[key] ?? fallback;
    if (!Number.isFinite(value) || value < min || value > max) throw Error(`steward ${key} must be ${min}..${max}`);
    return value;
  };
  const config = { enabled: raw.enabled ?? true, projects: raw.projects ?? {},
    stalled_seconds: number('stalled_seconds', 300, 1, 86400),
    debounce_seconds: number('debounce_seconds', 300, 1, 86400),
    alert_cap: number('alert_cap', 3, 1, 10), alert_command: raw.alert_command ?? null, imessage_command: raw.imessage_command ?? null, imessage_recipient: raw.imessage_recipient ?? null, key_fallback: raw.key_fallback ?? true };
  if (typeof config.key_fallback !== 'boolean') throw Error('steward key_fallback must be boolean');
  if (!Number.isInteger(config.alert_cap)) throw Error('steward alert_cap must be an integer');
  if (!object(config.projects)) throw Error('steward projects must be an object');
  for (const [name, project] of Object.entries(config.projects)) {
    if (!object(project) || typeof project.supervisor !== 'string' || !project.supervisor.trim() || /[\x00-\x1f]/.test(project.supervisor)) throw Error(`steward ${name} needs a supervisor name`);
    for (const key of Object.keys(project)) if (!['supervisor', 'inbox'].includes(key)) throw Error(`unknown steward project setting: ${key}`);
    if (project.inbox !== undefined && (typeof project.inbox !== 'string' || !path.isAbsolute(project.inbox))) throw Error('steward inbox must be absolute');
  }
  for (const key of ['alert_command', 'imessage_command']) if (config[key] !== null && (!Array.isArray(config[key]) || !config[key].length || config[key].some(v => typeof v !== 'string' || !v || v.includes('\0')))) throw Error(`steward ${key} must be a nonempty argv array`);
  if (config.imessage_recipient !== null && (typeof config.imessage_recipient !== 'string' || !config.imessage_recipient.trim() || /[\x00-\x1f]/.test(config.imessage_recipient))) throw Error('steward imessage_recipient must be a nonempty address');
  if (config.imessage_command && !config.imessage_recipient) throw Error('imessage_command requires an operator-local imessage_recipient');
  return config;
}

// Payload is one argument, never interpolated into a shell or AppleScript.
export async function operatorAlert(payload, config) {
  const publicPayload = { project: String(payload.project ?? 'unresolved'), session: String(payload.session ?? 'unresolved'), kind: String(payload.kind ?? 'steward') };
  const channels = [];
  if (config.alert_command) {
    const [bin, ...args] = config.alert_command;
    channels.push(run(bin, [...args, JSON.stringify(publicPayload)], { timeout: 10000, maxBuffer: 65536 }));
  } else if (process.platform === 'darwin') {
    channels.push(run('/usr/bin/osascript', ['-e', 'on run argv\ndisplay notification (item 1 of argv) with title "Herdr steward"\nend run', JSON.stringify(publicPayload)], { timeout: 10000, maxBuffer: 65536 }));
  } else channels.push(Promise.reject(Error('configure alert_command on this platform')));
  if (config.imessage_recipient) {
    const [bin, ...args] = config.imessage_command ?? [process.execPath, fileURLToPath(new URL('../bin/steward-imessage.mjs', import.meta.url))];
    channels.push(run(bin, [...args, config.imessage_recipient, JSON.stringify(publicPayload)], { timeout: 10000, maxBuffer: 65536 }));
  }
  const results = await Promise.allSettled(channels);
  const errors = results.filter(r => r.status === 'rejected');
  if (errors.length) throw Error(errors.map(r => r.reason.message).join('; '));
}

// Bounded event journal, atomically replaced and fsynced before effects. Keep
// current alert receipts across compaction, with bounded retired retention.
// Recent restores retain caps; older retired episodes expire after seven days.
const MAX_EVENTS = 2048, MAX_BYTES = 4 * 1024 * 1024;
export function readStewardJournal(file) {
  if (!fs.existsSync(file)) return [];
  if (fs.statSync(file).size > MAX_BYTES) throw Error('steward journal exceeds bound');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.version !== 1 || !Array.isArray(data.events) || data.events.length > MAX_EVENTS || data.events.some(e => !object(e) || typeof e.key !== 'string' || typeof e.type !== 'string' || !Number.isFinite(e.at))) throw Error('invalid steward journal');
  return data.events;
}
export function stewardJournal(file, active, now) {
  let events = readStewardJournal(file);
  const compact = () => {
    // Route attempts use stable IDs; the last intent/result suffices. Alerts
    // retain every intent (counting failures and lost acknowledgements).
    const latest = new Map();
    for (const event of events) if (event.type.startsWith('route-') || event.type === 'permission-result' || event.type === 'evidence') latest.set(`${event.key}:${event.type}`, event);
    const recent = new Set(events.filter(e => active.has(e.key) && e.type === 'alert-intent').slice(-256));
    const history = new Set(events.filter(e => active.has(e.key) && ['alert-result', 'permission-intent', 'permission-result'].includes(e.type)).slice(-128));
    const keep = events.filter(e => active.has(e.key) && (!['alert-result', 'permission-intent', 'permission-result'].includes(e.type) || history.has(e)) && (e.type !== 'alert-intent' || recent.has(e)) && (!e.type.startsWith('route-') && e.type !== 'permission-result' && e.type !== 'evidence' || latest.get(`${e.key}:${e.type}`) === e));
    const retired = events.filter(e => !active.has(e.key));
    const archived = retired.filter(e => e.type !== 'alert-intent').slice(-128);
    const caps = retired.filter(e => e.type === 'alert-intent' && now - e.at <= 7 * 86400000).slice(-256).map(e => ({
      type: e.type, key: e.key, id: e.id, at: e.at, project: e.project, session: e.session, episode: e.episode,
    }));
    events = [...archived, ...caps, ...keep].sort((a, b) => a.at - b.at);
  };
  compact();
  const save = () => {
    const bytes = JSON.stringify({ version: 1, events }) + '\n';
    if (events.length > MAX_EVENTS || Buffer.byteLength(bytes) > MAX_BYTES) throw Error('steward journal full; inspect active receipts before recovery');
    const temporary = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  };
  return { get events() { return events; }, add(event) { events.push({ ...event, at: now }); compact(); save(); } };
}

const gitCache = new Map();
export function routingProject(cwd, now = Date.now()) {
  const old = gitCache.get(cwd);
  if (old && now >= old.at && now - old.at < 30000) return old.value;
  const value = gitProject(cwd);
  if (gitCache.size >= 512) gitCache.delete(gitCache.keys().next().value);
  gitCache.set(cwd, { at: now, value });
  return value;
}

async function routingTick({ rows = [], agents = [], home = HOME, env = process.env,
  now = Date.now(), dryRun = false, alert = operatorAlert,
  enqueue = enqueueSupervisor, resume = resumeInbox, decline = declineObserved } = {}) {
  const config = stewardConfig(home);
  if (!config.enabled) return { disabled: true, actions: [] };
  const fleet = readFleet(env);
  if (!fleet) return { actions: [] };
  for (const name of Object.keys(config.projects)) if (!Object.hasOwn(fleet.projects, name)) throw Error(`unknown steward fleet project: ${name}`);
  const actions = [], projects = new Map(), live = new Map(), bindings = new Map();
  const file = path.join(home, 'steward', 'journal.json');
  const previous = readStewardJournal(file);
  for (const agent of agents ?? []) {
    if (!agent.name || !agent.pane_id) continue;
    const key = sessionKey(agent);
    try {
      const git = routingProject(agent.cwd, now);
      const match = Object.entries(fleet.projects).find(([, p]) => p.identity === git.identity && p.checkout === git.canonical);
      if (match) {
        const [name, p] = match;
        projects.set(agent.name, { ...p, name });
        const binding = supervisorBinding(git, agent.pane_id);
        if (binding && fs.realpathSync(p.record) === binding.org && (!binding.to || binding.to === agent.name)) bindings.set(agent.name, binding);
      }
    } catch { /* Unresolved sessions escalate; paths/names never guess a fleet. */ }
    live.set(agent.name, { agent, key });
  }
  const targetFor = p => {
    const explicit = config.projects[p.name]?.supervisor;
    if (explicit) return explicit;
    const candidates = [...bindings.keys()].filter(name => projects.get(name)?.identity === p.identity);
    return candidates.length === 1 ? candidates[0] : null;
  };
  const targetKey = (p, to) => live.get(to)?.key ?? [...previous].reverse().find(e => e.project === p.name && e.session === to)?.key ?? hash(`${p.identity}:${to ?? 'unresolved-supervisor'}`);
  const active = new Set([...live.values()].map(v => v.key));
  if (agents === null) for (const event of previous) active.add(event.key);
  const pending = [];
  for (const [name, p] of Object.entries(fleet.projects)) {
    p.name = name;
    const inbox = config.projects[name]?.inbox ?? path.join(p.record, 'supervisor/inbox.log');
    try {
      for (const entry of readInbox(inbox)) {
        if (done(entry)) continue;
        const key = targetKey(p, entry.to); active.add(key);
        pending.push({ key, project: name, session: entry.to, at: Date.parse(entry.at), source: inbox, id: entry.id, kind: 'inbox', message: cut(entry.message) });
      }
    } catch (error) {
      const to = targetFor(p), key = targetKey(p, to); active.add(key);
      pending.push({ key, project: name, session: to, at: 0, source: inbox, kind: 'unreadable-inbox', message: cut(error.message) });
    }
    // Legacy parked messages are observed only: no replay, removal, or RETRY.
    const outbox = path.join(p.checkout, '.lane/supervisor/outbox');
    try {
      const oldest = fs.readdirSync(outbox).filter(n => n.endsWith('.msg')).map(n => {
        const source = path.join(outbox, n), stat = fs.lstatSync(source);
        return stat.isFile() ? { source, at: stat.mtimeMs } : null;
      }).filter(Boolean).sort((a, b) => a.at - b.at)[0];
      if (oldest) {
        const to = targetFor(p), key = targetKey(p, to); active.add(key);
        pending.push({ ...oldest, key, project: name, session: to, kind: 'legacy-outbox', message: 'Legacy supervisor outbox delivery is stalled' });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const to = targetFor(p), key = targetKey(p, to); active.add(key);
        pending.push({ key, project: name, session: to, at: 0, source: outbox, kind: 'unreadable-outbox', message: cut(error.message) });
      }
    }
  }
  let release, receipts;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    release = noticeLock(`${file}.lock`);
    try { receipts = stewardJournal(file, active, now); }
    catch (error) { release(); throw error; }
  } else receipts = { events: [...previous], add(event) { this.events.push({ ...event, at: now }); } };
  const escalate = async (key, payload) => {
    const episode = hash(JSON.stringify([payload.kind, payload.source, payload.id, payload.at]));
    const all = receipts.events.filter(e => e.key === key && e.type === 'alert-intent');
    const attempts = all.filter(e => e.episode === episode);
    if (attempts.length >= config.alert_cap || all.length && now - all.at(-1).at < config.debounce_seconds * 1000) return;
    const action = { type: 'alert', ...payload, journal: file };
    actions.push(action);
    if (dryRun) { receipts.add({ ...payload, type: 'alert-intent', key, episode }); return; }
    const id = `${key}:${episode}:${attempts.length + 1}`;
    receipts.add({ ...payload, type: 'alert-intent', key, id, episode });
    try { await alert(action, config); receipts.add({ type: 'alert-result', key, id, ok: true }); }
    catch (error) { receipts.add({ type: 'alert-result', key, id, ok: false, error: cut(error.message) }); }
  };
  try {
    // Newest observation per session, including DONE, prevents stale blocks.
    const newest = new Map();
    for (const row of rows) if (!newest.has(row.session) || Date.parse(row.at) >= Date.parse(newest.get(row.session).at)) newest.set(row.session, row);
    for (const [name, row] of newest) {
      const current = live.get(name);
      if (!current || row.state !== 'blocked' || current.agent.agent_status !== 'blocked' || row.pane !== current.agent.pane_id ||
          row.terminal_id && row.terminal_id !== current.agent.terminal_id || row.agent_session && row.agent_session !== current.agent.agent_session ||
          ['acted', 'answered', 'dismissed', 'never'].includes(row.status)) continue;
      const { agent, key } = current, p = projects.get(name);
      // A captured project column is presentation, not routing evidence.
      let capturedIdentity;
      try { capturedIdentity = routingProject(row.where, now).identity; } catch {}
      if (p && capturedIdentity !== p.identity) continue;
      const payload = { project: p?.name ?? 'unresolved', session: name, pane: agent.pane_id,
        source: row.id, kind: 'blocked', message: cut(row.dialog?.question ?? row.unsent ?? row.headline ?? 'Session blocked'),
        screen_excerpt: cut(row.screen?.slice(-1600), 1600),
        options: row.dialog?.options?.slice(0, 10).map(o => ({ key: cut(o.key, 40), label: cut(o.label, 200) })) ?? [] };
      const to = p && targetFor(p);
      const fallback = config.key_fallback && p && fallbackRequest(row);
      const fallbackId = `permission:${hash(`${key}:${row.id}:${row.screen}`)}`;
      if (fallback && receipts.events.some(e => e.id === fallbackId && e.type === 'permission-result' && e.ok)) continue;
      const recentEffects = receipts.events.filter(e => e.key === key && e.type === 'permission-intent' && now - e.at < 300000);
      if (fallback && recentEffects.length < 3 && !receipts.events.some(e => e.id === fallbackId && e.type === 'permission-intent')) {
        actions.push({ type: 'permission', project: p.name, session: name, behavior: 'deny', source: row.id });
        if (!dryRun) {
          receipts.add({ type: 'permission-intent', key, id: fallbackId, source: row.id, behavior: 'deny' });
          try {
            const result = await decline(row, agent, { herdr: env.HERDR_BIN ?? 'herdr', beforeKey: () => {
              const nudgeId = `steward:nudge:${fallbackId}`;
              const message = `[steward-denied] ${fallback.message}`;
              return enqueue(name, message, { id: nudgeId, cwd: p.checkout, org: p.record, inbox: config.projects[p.name]?.inbox, herdr: env.HERDR_BIN ?? 'herdr' });
            } });
            receipts.add({ type: 'permission-result', key, id: fallbackId, ...result });
            if (result.ok) {
              const decision = permissionDecision({ hook_event_name: 'PermissionRequest', tool_name: 'Read', tool_input: { file_path: row.screen.match(/^\s*Read\(([^\n]+)\)\s*$/m)?.[1] }, cwd: agent.cwd }, { kind: 'claude', project: { ...p, workspace: agent.cwd } });
              if (decision.alert) await escalate(key, { ...payload, kind: decision.reason });
              continue;
            }
          } catch (error) { receipts.add({ type: 'permission-result', key, id: fallbackId, ok: false, error: cut(error.message) }); }
        }
      }
      if (!p && (!Number.isFinite(Date.parse(row.at)) || now - Date.parse(row.at) < config.stalled_seconds * 1000)) continue;
      if (!p || bindings.has(name) || to === name || !to || live.has(to) && projects.get(to)?.identity !== p.identity) {
        await escalate(key, { ...payload, kind: bindings.has(name) || to === name ? 'blocked-supervisor' : 'unresolved-route' });
        continue;
      }
      const id = `steward:blocked:${hash(`${p.identity}:${row.id}:${key}`)}`;
      if (receipts.events.some(e => e.key === key && e.id === id && e.type === 'route-result' && e.ok)) continue;
      const prior = receipts.events.filter(e => e.key === key && e.type === 'route-intent').at(-1);
      if (prior && now - prior.at < config.debounce_seconds * 1000) continue;
      const message = `[steward-blocked] ${JSON.stringify(payload)}`;
      actions.push({ type: 'route', to, id, project: p.name, message });
      if (dryRun) continue;
      receipts.add({ type: 'route-intent', key, id, to, source: row.id, message });
      try {
        const receipt = enqueue(to, message, { id, cwd: p.checkout, org: p.record,
          inbox: config.projects[p.name]?.inbox, herdr: env.HERDR_BIN ?? 'herdr' });
        receipts.add({ type: 'route-result', key, id, ok: true, inbox: receipt.inbox });
        // Startup is independent of enqueue acknowledgement. Dead owners are
        // recovered below on subsequent ticks; the notice is never lost.
      } catch (error) {
        receipts.add({ type: 'route-result', key, id, ok: false, error: cut(error.message) });
        await escalate(key, { ...payload, kind: 'route-failed', message: cut(error.message) });
      }
    }
    const resumed = new Set();
    for (const [name, p] of Object.entries(fleet.projects)) {
      const inbox = config.projects[name]?.inbox ?? path.join(p.record, 'supervisor/inbox.log');
      if (!dryRun && fs.existsSync(inbox) && !resumed.has(inbox)) {
        resumed.add(inbox);
        try {
          const git = routingProject(p.checkout, now);
          if (git.identity !== p.identity || git.canonical !== p.checkout) throw Error('stale fleet checkout; delivery owner not resumed');
          await resume(inbox);
        } catch (error) { actions.push({ type: 'delivery-error', inbox, error: cut(error.message) }); }
      }
    }
    for (const notice of pending) {
      if (!Number.isFinite(notice.at) || now - notice.at >= config.stalled_seconds * 1000) {
        await escalate(notice.key, { ...notice, kind: `stalled-${notice.kind}`, message: `Supervisor notice undelivered: ${notice.message}` });
      }
    }
    return { actions, journal: file };
  } finally { release?.(); }
}

// A damaged/full routing journal cannot silence the failure that stopped it.
// The separate, bounded receipt consumes the alert attempt before its effect.
export async function stewardTick(options = {}) {
  try { return await routingTick(options); }
  catch (error) {
    const home = options.home ?? HOME, now = options.now ?? Date.now();
    const journalFile = path.join(home, 'steward/journal.json');
    let journalFailure = /steward journal/.test(error.message);
    if (!journalFailure) try { readStewardJournal(journalFile); } catch { journalFailure = true; }
    if (journalFailure && !options.dryRun) {
      const file = path.join(home, 'steward/journal-failure.json');
      let release;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        release = noticeLock(`${file}.lock`);
        const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
        if (!previous || now - previous.at >= 86400000) {
          writeFileAtomic(file, JSON.stringify({ at: now }) + '\n', 0o600);
          const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          await (options.alert ?? operatorAlert)({ project: 'steward', session: 'watcher', kind: 'journal-refused' }, stewardConfig(home));
        }
      } catch (failure) { process.stderr.write(`Steward journal failure alert refused: ${failure.message}\n`); }
      finally { release?.(); }
    }
    throw error;
  }
}
