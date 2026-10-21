// Ownership and source locations only. Reads never enroll or repair a project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gitProject } from './project.mjs';
import { readPlainFile } from './files.mjs';
import { parseUniqueJson } from '../sessions/json.mjs';
import { auditPolicyRead } from './config-audit.mjs';
import { validatePolicy } from './config-policy.mjs';

export const POLICY_FILES = Object.freeze({ lane: ['lane.json', '.lane.json'], validation: ['lane.validation.json', '.lane.validation.json'],
  promote: ['promote.json', '.promote.json'], routing: ['routing.json', null], housekeeping: ['housekeeping.json', '.housekeeping.json'], pin: ['pin', '.herdr-release.json'] });
export const contentDigest = bytes => createHash('sha256').update(bytes).digest('hex');
export const present = file => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
export const canonicalPath = file => { try { return fs.realpathSync(file); } catch (e) { if (e.code === 'ENOENT') return path.resolve(file); throw e; } };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const absolute = v => typeof v === 'string' && path.isAbsolute(v) && path.normalize(v) === v && !/[\0\r\n]/u.test(v);
export function component(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value) || value.includes('..') || value === 'brain')
    throw Error(`invalid or reserved config-home name: ${value}`);
  return value;
}
export function configHome(env = process.env) { return path.join(canonicalPath(env.HOME || os.homedir()), '.herdr-monitor'); }
export function readConfigJSON(file) {
  try {
    const bytes = readPlainFile(file, null);
    if (bytes.length > 1024 * 1024) throw Error('root: JSON exceeds 1 MiB');
    return parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (e) { throw Object.assign(Error(`${file}: ${e.message}; this project is held. Fix the file and read the config again.`), { code: e.code }); }
}
export function markerRoot(start) {
  for (let directory = fs.realpathSync(start); ; directory = path.dirname(directory)) {
    const marker = path.join(directory, '.identity-root');
    if (present(marker)) {
      const stat = fs.lstatSync(marker);
      if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) throw Error(`${marker}: identity root requires a regular marker and canonical directory`);
      return directory;
    }
    if (directory === path.dirname(directory)) return null;
  }
}
export function projectIdentity(git, env = process.env) {
  const roots = new Set([markerRoot(git.canonical), markerRoot(git.identity)].filter(Boolean));
  if (roots.size > 1) throw Error('conflicting identity roots above canonical checkout and common directory');
  const root = [...roots][0];
  return { name: component(root ? path.basename(root) : os.userInfo().username), root: root ?? canonicalPath(env.HOME || os.homedir()), custom: Boolean(root) };
}
export function validateIdentity(config, file, name) {
  if (!object(config) || !absolute(config.identity_root) || canonicalPath(config.identity_root) !== config.identity_root) throw Error(`${file}: identity_root must be a canonical absolute directory`);
  if (config.launch !== undefined && (!Array.isArray(config.launch) || !config.launch.length || config.launch.some(v => typeof v !== 'string' || !v.length || /\0/u.test(v)))) throw Error(`${file}: launch must be a nonempty array of literal argv words`);
  if (config.defaults_origin !== undefined && (!object(config.defaults_origin) || !absolute(config.defaults_origin.path) || !absolute(config.defaults_origin.base))) throw Error(`${file}: invalid defaults_origin`);
  if (config.brain_write !== undefined && (!object(config.brain_write) || Object.entries(config.brain_write).some(([key, v]) => !absolute(key) || typeof v !== 'boolean'))) throw Error(`${file}: brain_write must map canonical common directories to boolean consent`);
  if (config.project_access !== undefined && (!Array.isArray(config.project_access) || config.project_access.some(g => !object(g) || Object.keys(g).some(k => !['source', 'target'].includes(k)) || !absolute(g.source) || !absolute(g.target)))) throw Error(`${file}: project_access requires canonical source and target common directories`);
  component(name);
  return config;
}
export function validateProjectBinding(p, file, identityName, projectName) {
  const keys = ['schema', 'identity', 'project', 'common', 'checkout', 'record', 'worktrees', 'sources', 'published', 'adoption', 'compatible_release'];
  if (!object(p) || p.schema !== 'config-home-project/v1' || Object.keys(p).some(k => !keys.includes(k)) ||
      p.identity !== identityName || p.project !== projectName || !['common', 'checkout', 'record', 'worktrees'].every(k => absolute(p[k])) ||
      !object(p.sources) || !Array.isArray(p.published) || new Set(p.published).size !== p.published.length ||
      p.published.some(k => !Object.hasOwn(POLICY_FILES, k) || !p.sources[k]?.present) ||
      !object(p.adoption) || typeof p.adoption.id !== 'string' || !p.adoption.id ||
      !object(p.compatible_release) || p.compatible_release.config_home !== 1 || typeof p.compatible_release.commit !== 'string') throw Error(`${file}: invalid config-home-project/v1 binding`);
  for (const [key, source] of Object.entries(p.sources)) {
    if (!Object.hasOwn(POLICY_FILES, key) || !object(source) || !absolute(source.path) || !absolute(source.base) || typeof source.present !== 'boolean' ||
        (source.present && !/^[a-f0-9]{64}$/u.test(source.sha256 ?? ''))) throw Error(`${file}: invalid sources.${key}`);
  }
  component(identityName); component(projectName);
  return p;
}
function folders(directory) {
  if (!present(directory)) return [];
  if (!fs.lstatSync(directory).isDirectory()) throw Error(`${directory}: config-home directory must not be a symlink`);
  return fs.readdirSync(directory, { withFileTypes: true }).filter(d => !d.name.startsWith('.') && d.name !== 'brain' && d.name !== 'p' && d.name !== 'fleet.json');
}
// An unrelated damaged policy can be isolated only when all ownership paths
// prove non-overlap. Unidentifiable bindings hold even a local lookup.
export function homeBindings(env = process.env, selected) {
  const home = configHome(env), bindings = [], errors = [];
  for (const identity of folders(home)) {
    if (!identity.isDirectory() && !identity.isSymbolicLink()) continue;
    const directory = path.join(home, identity.name), identityFile = path.join(directory, 'identity.json');
    // Legacy installation directories are not identity folders.
    if (!present(identityFile)) {
      if (identity.isSymbolicLink() || present(path.join(directory, 'project.json'))) throw Error(`${directory}: missing identity.json`);
      continue;
    }
    let defaults, bytes;
    try {
      bytes = readPlainFile(identityFile, null);
      defaults = parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      validateIdentity(defaults, identityFile, identity.name);
      validatePolicy('identity', defaults, identityFile);
    } catch (error) {
      auditPolicyRead(identityFile, undefined, bytes, error.message, { env, cwd: selected?.checkout ?? process.cwd(), invalid: true });
      throw error;
    }
    auditPolicyRead(identityFile, defaults, bytes, undefined, { env, cwd: selected?.checkout ?? process.cwd() });
    for (const project of folders(directory)) {
      if (!project.isDirectory() && !project.isSymbolicLink()) continue;
      const area = path.join(directory, project.name), file = path.join(area, 'project.json');
      if (!present(file)) throw Error(`${file}: missing project binding`);
      const raw = readConfigJSON(file);
      try {
        validateProjectBinding(raw, file, identity.name, project.name);
        bindings.push({ ...raw, directory: area, file, identityFile, defaults });
      } catch (e) {
        const isolated = selected && ['common', 'checkout', 'record'].every(k => absolute(raw?.[k]) && canonicalPath(raw[k]) !== canonicalPath(selected[k] ?? selected.common));
        if (!isolated) throw e;
        errors.push({ file, error: e.message });
      }
    }
  }
  for (const [i, a] of bindings.entries()) for (const b of bindings.slice(i + 1)) {
    if (['common', 'checkout', 'record'].some(k => canonicalPath(a[k]) === canonicalPath(b[k]))) throw Error(`${a.file} and ${b.file}: conflicting config-home ownership`);
  }
  return { home, bindings, errors };
}
export function homeProject(cwd = process.cwd(), env = process.env, { git: supplied } = {}) {
  let git = supplied;
  if (!git) try { git = gitProject(cwd, { env: Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('GIT_'))) }); } catch (e) {
    // A broken canonical checkout/link is damage, not an unadopted project.
    if (present(path.join(cwd, '.brain'))) throw e;
    return null;
  }
  const { bindings } = homeBindings(env, { common: git.identity, checkout: git.canonical });
  const matches = bindings.filter(b => b.common === git.identity || b.checkout === git.canonical);
  const link = path.join(git.canonical, '.brain');
  if (matches.length > 1) throw Error(`${link}: ambiguous home binding`);
  const binding = matches[0];
  if (!binding) {
    if (present(link)) throw Error(`${link}: unrelated or damaged home link`);
    return null;
  }
  if (binding.common !== git.identity || binding.checkout !== git.canonical) throw Error(`${binding.file}: Git identity changed; owner repair required`);
  const detected = projectIdentity(git, env);
  if (detected.name !== binding.identity || detected.root !== binding.defaults.identity_root) throw Error(`${binding.identityFile}: owning identity differs from canonical identity detection`);
  if (!present(path.join(binding.record, 'events.jsonl'))) throw Error(`${binding.file}: previously bound record is missing at ${binding.record}`);
  if (present(link)) {
    if (!fs.lstatSync(link).isSymbolicLink() || fs.realpathSync(link) !== fs.realpathSync(binding.directory)) throw Error(`${link}: conflicting home link`);
    const tracked = execFileSync('git', ['-C', git.canonical, 'ls-files', '--', '.brain'], { encoding: 'utf8', env }).trim();
    if (tracked) throw Error(`${link}: a home link must not be tracked`);
  }
  return { ...binding, git, owner: detected };
}
export function policyLocation(cwd, kind, env = process.env, { binding = homeProject(cwd, env), write = false } = {}) {
  if (!Object.hasOwn(POLICY_FILES, kind)) throw Error(`unknown config file: ${kind}`);
  const [name, legacyName] = POLICY_FILES[kind];
  let root = binding?.checkout;
  if (!root) try { root = gitProject(cwd, { env }).canonical; } catch { root = canonicalPath(cwd); }
  const source = binding?.sources[kind];
  const legacy = source?.path ?? (legacyName && path.join(root, legacyName));
  const file = binding && path.join(binding.directory, name);
  if (binding && (write || present(file))) return { file, base: source?.base ?? root, scope: 'project', binding, legacy, home: true };
  if (binding?.published.includes(kind)) throw Error(`${file}: published home file is missing; owner repair required`);
  return { file: legacy, base: source?.base ?? root, scope: 'project', binding, legacy, home: false };
}
export function assertConfigWriter(target, { cwd = process.cwd(), env = process.env, scope = 'project' } = {}) {
  const sourceGit = gitProject(cwd, { env }), source = projectIdentity(sourceGit, env);
  if (source.name !== target.identity || source.root !== target.defaults.identity_root) throw Error('config writes require the owning identity; actor strings cannot authorize writes');
  if (scope === 'identity' || sourceGit.identity === target.common) return;
  const sourceBinding = homeProject(cwd, env);
  if (!sourceBinding || !target.defaults.project_access?.some(g => g.source === sourceBinding.common && g.target === target.common)) throw Error('sibling project config writes require an explicit canonical project_access grant');
}
export function configDrift(binding) {
  if (!binding) return [];
  return Object.entries(binding.sources).flatMap(([kind, source]) => {
    const file = path.join(binding.directory, POLICY_FILES[kind][0]);
    if (!source.present || !present(file)) return [];
    const repoDigest = present(source.path) ? contentDigest(readPlainFile(source.path, null)) : null;
    return contentDigest(readPlainFile(file, null)) === repoDigest ? [] : [{ home: file, repo: source.path,
      warning: `Warning: ${file} differs from retained repo copy ${source.path}; repo-reading project scripts use the repo copy.` }];
  });
}
