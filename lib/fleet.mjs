// Machine facts only. Entry/join is the sole writer; every other consumer reads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitProject, ignoreRuntime } from './project.mjs';
import { writeFileAtomic } from './files.mjs';
import { withInstallationLock } from '../herdr/entry-lock.mjs';

export class FleetError extends Error {}
export function fleetPath(env = process.env) {
  return path.join(path.resolve(env.HERDR_MONITOR_FLEET || process.env.HERDR_MONITOR_FLEET || path.join(os.homedir(), '.herdr-monitor')), 'fleet.json');
}
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const absolute = v => typeof v === 'string' && path.isAbsolute(v) && !v.includes('\0');
function canonical(file) { try { return fs.realpathSync(file); } catch { return path.resolve(file); } }

export function readFleet(env = process.env) {
  const file = fleetPath(env);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new FleetError(`invalid fleet ${file}: ${error.message}`);
  }
  const invalid = reason => { throw new FleetError(`invalid fleet ${file}: ${reason}`); };
  if (!object(raw) || raw.version !== 1 || !object(raw.projects)) invalid('expected version 1 and a projects object');
  if (!Number.isSafeInteger(raw.session_limit) || raw.session_limit < 1) invalid('session_limit must be a positive integer');
  const identities = new Set(), records = new Set();
  for (const [name, p] of Object.entries(raw.projects)) {
    if (!name || !object(p)) invalid('each project needs a name and object');
    for (const key of ['identity', 'checkout', 'record', 'worktrees', 'temp']) if (!absolute(p[key])) invalid(`${name}.${key} must be an absolute path`);
    if (!Array.isArray(p.layers) || p.layers.some(v => !absolute(v))) invalid(`${name}.layers must be an array of absolute paths`);
    if (identities.has(p.identity) || records.has(canonical(p.record))) invalid('projects must have distinct Git identities and records');
    identities.add(p.identity); records.add(canonical(p.record));
  }
  return { ...raw, file };
}

export function staleProject(p) {
  try { const git = gitProject(p.checkout); return git.identity !== p.identity || git.canonical !== p.checkout; }
  catch { return true; }
}
export function fleetView(env = process.env) {
  const fleet = readFleet(env);
  return fleet && { ...fleet, projects: Object.fromEntries(Object.entries(fleet.projects).map(([name, p]) => [name, { ...p, stale: staleProject(p) }])) };
}

// Reading never registers a project or searches outside its checkout.
export function projectFleet(cwd = process.cwd(), env = process.env) {
  const fleet = readFleet(env);
  if (!fleet) return { fleet: null, project: null };
  let git;
  try { git = gitProject(cwd); } catch { return { fleet, project: null }; }
  const entry = Object.entries(fleet.projects).find(([, p]) => p.identity === git.identity);
  if (entry) {
    const [name, p] = entry;
    if (p.checkout !== git.canonical || staleProject(p)) throw new FleetError(`stale fleet project ${name}: ${p.checkout}; inspect its mapping before joining`);
    return { fleet, project: { ...p, name }, git };
  }
  if (Object.values(fleet.projects).some(p => p.checkout === git.canonical)) throw new FleetError(`stale fleet mapping for ${git.canonical}: Git identity changed`);
  return { fleet, project: null, git };
}

function legacyMapping(git, env) {
  const file = env.HERDR_ORG_CONSOLE_CONFIG || path.join(os.homedir(), '.config/herdr-org/console.json');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new FleetError(`cannot adopt console mapping ${file}: ${error.message}`); }
  const expand = v => typeof v === 'string' && v ? canonical(v.replace(/^~(?=$|\/)/u, os.homedir())) : null;
  if (!Array.isArray(raw.projects)) throw new FleetError(`cannot adopt console mapping ${file}: projects must be an array`);
  const matches = raw.projects.filter(p => p?.cwd && expand(p.cwd) === git.canonical);
  if (matches.length > 1) throw new FleetError(`ambiguous console mappings for ${git.canonical}; join with --record`);
  const record = expand(matches[0]?.org);
  if (!record || !fs.existsSync(path.join(record, 'events.jsonl'))) return null;
  // An operator mapping proves record ownership, and only its own parent layer.
  const layer = path.join(path.dirname(record), '.lane.json');
  return { record, layers: fs.existsSync(layer) && path.dirname(record) !== git.canonical ? [layer] : [] };
}

export function joinFleet({ cwd = process.cwd(), env = process.env, record, worktrees, temp, layers, sessionLimit } = {}) {
  // Validate before any lock, record creation or Git runtime write.
  readFleet(env);
  if (sessionLimit !== undefined && (!Number.isSafeInteger(sessionLimit) || sessionLimit < 1)) throw new FleetError('fleet session limit must be a positive integer');
  const git = gitProject(cwd), file = fleetPath(env), home = path.dirname(file);
  return withInstallationLock(path.join(home, 'fleet.lock'), () => {
    const current = projectFleet(cwd, env);
    const fleet = current.fleet ?? { version: 1, session_limit: 6, projects: {} };
    let name = current.project?.name, p = current.project;
    if (p) {
      for (const [key, value] of Object.entries({ record, worktrees, temp })) {
        if (value !== undefined && canonical(path.resolve(cwd, value)) !== canonical(p[key])) throw new FleetError(`fleet project ${name} already has ${key}: ${p[key]}`);
      }
      if (layers !== undefined && JSON.stringify(layers.map(v => canonical(path.resolve(cwd, v)))) !== JSON.stringify(p.layers)) throw new FleetError(`fleet project ${name} already has different layers`);
    } else {
      const hash = createHash('sha256').update(git.identity).digest('hex').slice(0, 16);
      name = path.basename(git.canonical);
      if (Object.hasOwn(fleet.projects, name)) name += `-${hash}`;
      const area = path.join(home, 'p', hash);
      const local = path.join(git.canonical, '.org');
      const adopted = record === undefined && !fs.existsSync(path.join(local, 'events.jsonl')) ? legacyMapping(git, env) : null;
      const selectedLayers = layers?.map(v => canonical(path.resolve(cwd, v))) ?? adopted?.layers ?? [];
      const recordPath = record !== undefined ? canonical(path.resolve(cwd, record)) : fs.existsSync(path.join(local, 'events.jsonl')) ? canonical(local) : adopted?.record ?? local;
      if (Object.values(fleet.projects).some(p => canonical(p.record) === canonical(recordPath))) throw new FleetError(`fleet record already belongs to another project: ${recordPath}`);
      let worktreePath = path.join(area, 'worktrees');
      for (const layer of [...selectedLayers, path.join(git.canonical, '.lane.json')]) {
        if (!fs.existsSync(layer)) continue;
        let config;
        try { config = JSON.parse(fs.readFileSync(layer, 'utf8')); } catch (e) { throw new FleetError(`cannot map fleet settings ${layer}: ${e.message}`); }
        if (typeof config.worktree_root === 'string') worktreePath = path.join(path.resolve(path.dirname(layer), config.worktree_root), path.basename(git.canonical));
        else if (selectedLayers.includes(layer)) worktreePath = path.join(path.dirname(layer), '.worktrees', path.basename(git.canonical));
      }
      p = { identity: git.identity, checkout: git.canonical, record: recordPath,
        worktrees: worktrees === undefined ? worktreePath : canonical(path.resolve(cwd, worktrees)),
        temp: temp === undefined ? path.join(home, 't', hash) : canonical(path.resolve(cwd, temp)), layers: selectedLayers };
      if (p.record === local) ignoreRuntime(git);
      // Every record operation goes through the dependency-free record CLI.
      if (!fs.existsSync(path.join(p.record, 'events.jsonl'))) execFileSync(process.execPath,
        [fileURLToPath(new URL('../bin/org.mjs', import.meta.url)), 'init', p.record],
        { cwd: git.canonical, env: { ...env, ORG_DIR: p.record }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
      fs.mkdirSync(p.temp, { recursive: true });
      fs.mkdirSync(p.worktrees, { recursive: true });
    }
    const changed = !current.project || (sessionLimit !== undefined && fleet.session_limit !== sessionLimit);
    if (changed) {
      const { file: _file, ...data } = fleet;
      data.projects = { ...data.projects, [name]: Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'name')) };
      if (sessionLimit !== undefined) data.session_limit = sessionLimit;
      writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n', 0o600);
    }
    return { file, name, project: Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'name')), session_limit: sessionLimit ?? fleet.session_limit, advisory: true };
  });
}
