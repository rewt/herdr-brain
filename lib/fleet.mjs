// Machine facts only. Fleet join writes; every other consumer reads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitProject, ignoreRuntime } from './project.mjs';
import { writeFileAtomic } from './files.mjs';
import { withInstallationLock } from './install-lock.mjs';
import { homeBindings, homeProject } from './config-home.mjs';

export class FleetError extends Error {}
export function fleetPath(env = process.env) {
  return path.join(path.resolve(env.HERDR_MONITOR_FLEET || process.env.HERDR_MONITOR_FLEET || path.join(canonical(os.homedir()), '.herdr-monitor')), 'fleet.json');
}
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const absolute = v => typeof v === 'string' && path.isAbsolute(v) && !v.includes('\0');
export function canonical(file) { try { return fs.realpathSync(file); } catch { return path.resolve(file); } }
function contains(root, file) {
  const relative = path.relative(canonical(root), canonical(file));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
function invalidFleet(fleet, reason) { throw new FleetError(`invalid fleet ${fleet.file}: ${reason}`); }
function loadFleet(env) {
  const file = fleetPath(env);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new FleetError(`invalid fleet ${file}: ${error.message}`);
  }
  const invalid = reason => invalidFleet({ file }, reason);
  if (!object(raw) || raw.version !== 1 || !object(raw.projects)) invalid('expected version 1 and a projects object');
  if (!Number.isSafeInteger(raw.session_limit) || raw.session_limit < 1) invalid('session_limit must be a positive integer');
  return { ...raw, file };
}

function validateProject(fleet, name, p) {
  const invalid = reason => invalidFleet(fleet, reason);
  if (!name || !object(p)) invalid('each project needs a name and object');
  for (const key of ['identity', 'checkout', 'record', 'worktrees']) if (!absolute(p[key])) invalid(`${name}.${key} must be an absolute path`);
  if (!Array.isArray(p.layers) || p.layers.some(v => !absolute(v))) invalid(`${name}.layers must be an array of absolute paths`);
}

function validateFleet(fleet) {
  if (!fleet) return null;
  const identities = new Set(), records = new Set();
  for (const [name, p] of Object.entries(fleet.projects)) {
    validateProject(fleet, name, p);
    if (identities.has(p.identity) || records.has(canonical(p.record))) invalidFleet(fleet, 'projects must have distinct Git identities and records');
    identities.add(p.identity); records.add(canonical(p.record));
  }
  return fleet;
}

function withHome(fleet, env, selected) {
  const { bindings } = homeBindings(env, selected);
  if (!bindings.length) return fleet;
  const result = fleet ? { ...fleet, projects: { ...fleet.projects } } : { version: 1, session_limit: 6, file: fleetPath(env), projects: {} };
  for (const b of bindings) {
    const existing = Object.entries(result.projects).filter(([, p]) => p.identity === b.common || p.checkout === b.checkout || canonical(p.record) === b.record);
    if (existing.length > 1 || existing.some(([, p]) => p.identity !== b.common || p.checkout !== b.checkout || canonical(p.record) !== b.record))
      throw new FleetError(`${b.file}: home and legacy fleet ownership conflict`);
    const name = existing[0]?.[0] ?? `${b.identity}/${b.project}`;
    result.projects[name] = { identity: b.common, checkout: b.checkout, record: b.record, worktrees: b.worktrees,
      layers: [b.identityFile], config_home: b.directory };
  }
  return result;
}
export function readFleet(env = process.env) { return validateFleet(withHome(loadFleet(env), env)); }

// A local read needs the selected mapping and enough ownership information to
// prove that no other entry claims it. Unidentifiable entries cannot be isolated.
// Fleet-wide reads and writes still validate every field of every project.
function scopedProjects(fleet, matches) {
  const entries = Object.entries(fleet.projects);
  for (const [name, p] of entries) {
    if (!name || !object(p)) invalidFleet(fleet, `cannot isolate project ${JSON.stringify(name)}: expected a named object`);
    if (!absolute(p.record)) invalidFleet(fleet, `cannot isolate project ${name}: record must be an absolute path`);
  }
  const selected = entries.filter(([, p]) => matches(p));
  for (const [name, p] of selected) {
    validateProject(fleet, name, p);
    for (const [other, q] of entries) {
      for (const key of ['identity', 'checkout']) if (!absolute(q[key]))
        invalidFleet(fleet, `cannot isolate project ${other}: ${key} must be an absolute path`);
      if (other !== name && (canonical(q.identity) === canonical(p.identity)
        || canonical(q.record) === canonical(p.record) || canonical(q.checkout) === canonical(p.checkout)))
        invalidFleet(fleet, `ambiguous projects ${name} and ${other}: overlapping Git identity, checkout or record`);
    }
  }
  return selected;
}

// Explicit record commands remain independent of Git availability. The record
// path selects its owner; an unrelated project's settings are never interpreted.
export function checkFleetRecord(record, env = process.env) {
  const fleet = withHome(loadFleet(env), env, { record });
  const selected = fleet && scopedProjects(fleet, p => canonical(p.record) === canonical(record));
  return selected?.length ? { ...selected[0][1], name: selected[0][0] } : null;
}

export function staleProject(p) {
  try { const git = gitProject(p.checkout); return git.identity !== p.identity || git.canonical !== p.checkout; }
  catch { return true; }
}
export function fleetView(env = process.env) {
  const fleet = readFleet(env);
  return fleet && { ...fleet, projects: Object.fromEntries(Object.entries(fleet.projects).map(([name, p]) => [name, { ...p, stale: staleProject(p) }])) };
}

function existingLayout(git, fleet, env) {
  // Preserve explicit external records and pre-fleet ancestor discovery only
  // while the record and parent settings remain unclaimed. This is discovery,
  // not proof that an inherited ORG_DIR belongs to the entered project.
  let directory = git.canonical, record = env.ORG_DIR ? path.resolve(env.ORG_DIR) : undefined;
  if (record) {
    if (!fs.existsSync(path.join(record, 'events.jsonl'))) return null;
  } else {
    for (;;) {
      const candidate = path.join(directory, '.org');
      if (fs.existsSync(path.join(candidate, 'events.jsonl'))) { record = candidate; break; }
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
  }
  if (Object.values(fleet?.projects ?? {}).some(p => canonical(p.record) === canonical(record))) return null;
  const home = path.resolve(os.homedir());
  directory = path.dirname(git.canonical);
  const layers = [];
  while (path.dirname(directory) !== directory && git.canonical !== home) {
    if (contains(home, git.canonical) && (!contains(home, directory) || directory === home)) break;
    const candidate = path.join(directory, '.lane.json');
    if (fs.existsSync(candidate)) {
      if (Object.values(fleet.projects).some(p => p.layers.some(layer => canonical(layer) === canonical(candidate)))) return null;
      layers.push(candidate); break;
    }
    directory = path.dirname(directory);
  }
  let worktrees = layers.length ? path.join(path.dirname(layers[0]), '.worktrees', path.basename(git.canonical))
    : path.join(os.homedir(), '.herdr', 'worktrees', path.basename(git.canonical));
  for (const layer of [...layers, path.join(git.canonical, '.lane.json')]) {
    if (!fs.existsSync(layer)) continue;
    let config;
    try { config = JSON.parse(fs.readFileSync(layer, 'utf8')); }
    catch { continue; } // Route/lane readers report bad settings; record discovery remains independent.
    if (config && typeof config.worktree_root === 'string') worktrees = path.join(path.resolve(path.dirname(layer), config.worktree_root), path.basename(git.canonical));
  }
  return { record, layers, worktrees };
}

const prompted = new Set();
function layoutPrompt(git, fleet, layout) {
  const key = `${fleet.file}\0${git.identity}`;
  if (prompted.has(key)) return;
  prompted.add(key);
  console.error(`monitor: preserving existing project discovery; join from ${shellQuote(git.canonical)} with monitor fleet join --record ${shellQuote(layout.record)} --worktrees ${shellQuote(layout.worktrees)}${layout.layers.map(layer => ` --layer ${shellQuote(layer)}`).join('')}`);
}

// Reading never registers a project. Unclaimed legacy records retain discovery
// until explicit adoption; joined records never leak to neighbouring projects.
// Mapping is independent of harness settings.
export function projectFleet(cwd = process.cwd(), env = process.env) {
  const home = homeProject(cwd, env);
  let fleet = withHome(loadFleet(env), env, home && { common: home.common, checkout: home.checkout, record: home.record });
  if (!fleet) return { fleet: null, project: null };
  let git;
  try { git = gitProject(cwd, { env }); } catch { return { fleet: validateFleet(fleet), project: null }; }
  const selected = scopedProjects(fleet, p => p.identity === git.identity || (absolute(p.checkout) && canonical(p.checkout) === git.canonical));
  const entry = selected.find(([, p]) => p.identity === git.identity);
  if (entry) {
    const [name, p] = entry;
    // The lookup already verified this identity against fresh Git facts.
    if (p.checkout !== git.canonical) throw new FleetError(`stale fleet project ${name}: ${p.checkout}; inspect its mapping before joining`);
    return { fleet, project: { ...p, name }, git };
  }
  if (selected.length) throw new FleetError(`stale fleet mapping for ${git.canonical}: Git identity changed`);
  // Without a binding, legacy discovery considers other projects' records and
  // layers. It still requires the complete registry to be valid.
  fleet = validateFleet(fleet);
  const legacy = existingLayout(git, fleet, env);
  if (legacy) layoutPrompt(git, fleet, legacy);
  return { fleet, project: null, git, legacy };
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

export function joinFleet({ cwd = process.cwd(), env = process.env, record, worktrees, layers, sessionLimit, replace } = {}) {
  // Validate before any lock, record creation or Git runtime write.
  readFleet(env);
  if (sessionLimit !== undefined && (!Number.isSafeInteger(sessionLimit) || sessionLimit < 1)) throw new FleetError('fleet session limit must be a positive integer');
  if (replace !== undefined && (typeof replace !== 'string' || !replace)) throw new FleetError('fleet replacement needs a project name');
  const git = gitProject(cwd), file = fleetPath(env), home = path.dirname(file);
  return withInstallationLock(path.join(home, 'fleet.lock'), () => {
    readFleet(env); // A writer must validate the whole registry under its lock.
    let current, remapped = false, duplicate;
    if (replace !== undefined) {
      const fleet = readFleet(env), previous = fleet && Object.hasOwn(fleet.projects, replace) ? fleet.projects[replace] : null;
      if (!previous) throw new FleetError(`unknown fleet project to replace: ${replace}`);
      remapped = previous.identity !== git.identity || previous.checkout !== git.canonical;
      if (remapped && !staleProject(previous)) throw new FleetError(`fleet project ${replace} is not stale; cannot replace a live mapping`);
      const relative = path.relative(previous.checkout, previous.record);
      const localRecord = contains(previous.checkout, previous.record);
      const previousRecordExists = fs.existsSync(path.join(previous.record, 'events.jsonl'));
      // Only explicit replacement carries a checkout-owned record to a new path.
      // A re-clone at the same Git path can select a restored record if the old one is gone.
      const selectedRecord = record !== undefined && (remapped || !previousRecordExists) ? canonical(path.resolve(cwd, record))
        : remapped && localRecord ? canonical(path.join(git.canonical, relative)) : previous.record;
      if (!fs.existsSync(path.join(selectedRecord, 'events.jsonl'))) throw new FleetError(`cannot replace ${replace}: existing record is missing at ${selectedRecord}`);
      if (Object.entries(fleet.projects).some(([name, p]) => name !== replace && canonical(p.record) === canonical(selectedRecord)))
        throw new FleetError(`fleet record already belongs to another project: ${selectedRecord}`);
      const hash = createHash('sha256').update(git.identity).digest('hex').slice(0, 16);
      for (const [name, p] of Object.entries(fleet.projects)) {
        if (name === replace) continue;
        if (p.identity === git.identity || p.checkout === git.canonical) {
          // An older automatic join may have left an empty hash-named entry.
          // Explicit repair can remove that mapping, but never its record data.
          if (!remapped || name !== `${path.basename(git.canonical)}-${hash}` || p.identity !== git.identity
            || p.checkout !== git.canonical || canonical(p.record) !== canonical(path.join(git.canonical, '.org'))
            || !fs.existsSync(path.join(p.record, 'events.jsonl')) || fs.statSync(path.join(p.record, 'events.jsonl')).size !== 0)
            throw new FleetError(`replacement checkout already belongs to another fleet project: ${git.canonical}`);
          duplicate = name;
        }
      }
      remapped ||= canonical(selectedRecord) !== canonical(previous.record);
      current = { fleet, project: { ...previous, name: replace, identity: git.identity, checkout: git.canonical, record: selectedRecord } };
    } else current = projectFleet(cwd, env);
    const fleet = current.fleet ?? { version: 1, session_limit: 6, projects: {} };
    let name = current.project?.name, p = current.project;
    if (!p && current.legacy && record === undefined
      && (current.legacy.record !== canonical(path.join(git.canonical, '.org')) || current.legacy.layers.length))
      throw new FleetError('existing project layout needs explicit adoption; use the printed monitor fleet join command');
    if (p) {
      for (const [key, value] of Object.entries({ record, worktrees })) {
        if (value !== undefined && canonical(path.resolve(cwd, value)) !== canonical(p[key])) throw new FleetError(`fleet project ${name} already has ${key}: ${p[key]}`);
      }
      if (layers !== undefined && JSON.stringify(layers.map(v => canonical(path.resolve(cwd, v)))) !== JSON.stringify(p.layers)) throw new FleetError(`fleet project ${name} already has different layers`);
      if (replace !== undefined && p.record === path.join(git.canonical, '.org')) ignoreRuntime(git);
    } else {
      // A missing same-directory checkout with an external record is a repair
      // suggestion only. Never bind its record or create an empty replacement.
      if (record === undefined) {
        const candidates = Object.entries(fleet.projects).filter(([, p]) => !fs.existsSync(p.checkout)
          && !contains(p.checkout, p.record) && path.basename(p.checkout) === path.basename(git.canonical));
        if (candidates.length) throw new FleetError(candidates.map(([name, p]) =>
          `stale fleet project ${name}: ${p.checkout}; from this checkout run monitor fleet join --replace ${shellQuote(name)} --record ${shellQuote(p.record)}`).join('\n'));
      }
      // Names never prove ownership. Join by fresh Git facts after suggesting repair.
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
        layers: selectedLayers };
      if (p.record === local) ignoreRuntime(git);
      // Every record operation goes through the dependency-free record CLI.
      if (!fs.existsSync(path.join(p.record, 'events.jsonl'))) execFileSync(process.execPath,
        [fileURLToPath(new URL('../bin/org.mjs', import.meta.url)), 'init', p.record],
        { cwd: git.canonical, env: { ...env, ORG_DIR: p.record }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
      fs.mkdirSync(p.worktrees, { recursive: true });
    }
    const changed = remapped || !current.project || (sessionLimit !== undefined && fleet.session_limit !== sessionLimit);
    if (changed) {
      const { file: _file, ...data } = fleet;
      data.projects = { ...data.projects, [name]: Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'name')) };
      if (duplicate !== undefined) delete data.projects[duplicate];
      if (sessionLimit !== undefined) data.session_limit = sessionLimit;
      writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n', 0o600);
    }
    return { file, name, project: Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'name')), session_limit: sessionLimit ?? fleet.session_limit, advisory: true };
  });
}
