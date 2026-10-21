import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gitProject } from './project.mjs';
import { findOrgDir } from './store.mjs';
import { homeProject, policyLocation, configDrift, contentDigest, present, projectIdentity, configHome, readConfigJSON } from './config-home.mjs';
import { readPolicyFile, readProjectPolicy, validatePolicy, configBase } from './config-policy.mjs';
import { auditEvents, writeAuditedConfig, pendingConfigWrite } from './config-audit.mjs';
import { DEFAULTS as HOUSEKEEPING_DEFAULTS } from '../housekeeping/config.mjs';
import { resolveValidation } from '../lanes/validation.mjs';
import { loadDiscoveredRoutes, mergeRoutesConfig } from '../lanes/routes.mjs';
import { validateIdentity } from './config-home.mjs';

// One reference supplies command descriptions and the inspectable type/default
// catalog. Domain references document nested fields without renaming them.
export const CONFIG_REFERENCE = Object.freeze({
  main: ['string', 'main', 'Integration branch.'], worktree_root: ['string', null, 'Lane root, relative to its original declaring directory.'],
  prepare: ['array', [], 'Preparation commands in the lane directory.'], validate: ['string', 'npm test', 'Legacy validation command.'],
  validation: ['object', {}, 'Declared commands, planner, environment salt and watchdogs.'],
  registry: ['string', '.lane/sessions.json', 'Session display metadata, relative to the checkout.'], seams_doc: ['string', null, 'Topic map in the project.'],
  archive: ['object', null, 'Durable display locations, relative to their declaring directory; [] opts out.'],
  dispatch: ['object', {}, 'Launch defaults and project admission settings.'], routes: ['object', {}, 'Named launch routes.'],
  selection_policy: ['object', null, 'Task class and pool route selection.'], settle: ['object', {}, 'Review desks and correction bounds.'],
  retirement: ['object', {}, 'Project-only retirement opt-ins and protected paths.'],
  promote: ['object', {}, 'Queue delivery, batch settings and host gate declaration.'], housekeeping: ['object', {}, 'Foreground schedule overrides; editing never starts a schedule.'],
  pin: ['object', { release: null }, 'Accepted release or global current; READY home-aware bundle required.'],
  launch: ['array', null, 'Literal owner launcher prefix.'], project_access: ['array', [], 'Canonical source-to-target project write grants.'], brain_write: ['object', {}, 'Per-project Brain consent; native sandbox grants remain operator-owned.'],
  entry: ['object', null, 'No effect (legacy compatibility).'], chat: ['object', null, 'No effect (legacy compatibility).'], always_args: ['object', {}, 'No effect (legacy compatibility).'],
});
function description(key) {
  if (/^validation\.(?:host_suites|tier_suites)(?:\.|$)/u.test(key)) return 'No effect (legacy compatibility).';
  return CONFIG_REFERENCE[key.split('.')[0]]?.[2] ?? 'Project declaration; see the configuration reference.';
}
export function withConfigLock(binding, scope, fn) {
  const directories = scope === 'identity' ? [path.dirname(binding.identityFile)] : [...new Set([binding.identityFile && path.dirname(binding.identityFile), binding.directory].filter(Boolean))];
  const held = [];
  try {
    for (const directory of directories) { const lock = path.join(directory, '.config.lock'); fs.mkdirSync(lock); held.push(lock); }
    return fn();
  } finally { for (const lock of held.reverse()) fs.rmdirSync(lock); }
}
function flatten(value, prefix, source, scope) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) return Object.entries(value).flatMap(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key, source, scope));
  return [{ key: prefix, value, source, source_key: prefix, scope, effect: description(prefix) }];
}
export function configSnapshot({ cwd = process.cwd(), env = process.env } = {}) {
  const git = gitProject(cwd, { env }), binding = homeProject(cwd, env);
  const loaded = loadDiscoveredRoutes({ cwd, env: { ...env, LANE_CONFIG: undefined } });
  const values = new Map();
  const raw = {}, sources = {};
  for (const [key, [, value]] of Object.entries(CONFIG_REFERENCE)) if (!['promote', 'housekeeping', 'pin', 'launch', 'project_access', 'brain_write'].includes(key))
    for (const row of flatten(value, key, 'default', 'default')) values.set(row.key, row);
  for (const file of loaded.files) {
    const config = readPolicyFile(file, file === binding?.identityFile ? 'identity' : 'lane', { cwd, env });
    Object.assign(raw, config);
    for (const key of Object.keys(config)) sources[key] = file;
    for (const [key, value] of Object.entries(config)) {
      if (['identity_root', 'defaults_origin', 'project_access', 'brain_write', 'launch'].includes(key)) continue;
      // Whole objects replace defaults and prior layers, except per-route merge.
      if (key !== 'routes') { for (const name of values.keys()) if (name === key || name.startsWith(`${key}.`)) values.delete(name); }
      else { for (const route of Object.keys(value)) for (const name of values.keys()) if (name === `routes.${route}` || name.startsWith(`routes.${route}.`)) values.delete(name); }
      for (const row of flatten(value, key, file, file === binding?.identityFile ? 'identity' : 'project')) values.set(row.key, row);
    }
  }
  if (loaded.suggested) for (const key of ['dispatch', 'routes', 'selection_policy']) for (const row of flatten(loaded.config[key], key, 'default', 'default')) values.set(row.key, row);
  for (const kind of ['validation', 'promote', 'housekeeping', 'pin']) {
    const selected = readProjectPolicy(cwd, kind, env);
    const defaults = kind === 'housekeeping' ? HOUSEKEEPING_DEFAULTS : kind === 'pin' ? { release: null } : kind === 'promote' ? { to: 'supervisor-herdr', delivery_attempts: 5, retry_seconds: 10 } : {};
    for (const row of flatten(defaults, kind, 'default', 'default')) values.set(row.key, row);
    for (const row of flatten(selected.config, kind, Object.keys(selected.config).length ? selected.file : 'default', Object.keys(selected.config).length ? 'project' : 'default')) if (row.key !== kind || Object.keys(selected.config).length) values.set(row.key, { ...row, ...(selected.source_commit ? { source_commit: selected.source_commit } : {}) });
  }
  const validation = resolveValidation({ root: git.canonical, config: raw, sources, env });
  for (const tier of ['fast', 'promotion', 'release']) values.set(`validation.${tier}`, { key: `validation.${tier}`, value: validation.tiers[tier].command, source: validation.tiers[tier].source, source_key: tier,
    scope: validation.tiers[tier].source === 'default' ? 'default' : validation.tiers[tier].source === binding?.identityFile ? 'identity' : 'project', effect: description('validation') });
  for (const row of values.values()) if (row.source !== 'default' && ['worktree_root', 'archive.dirs'].includes(row.key)) {
    row.base = configBase(row.source, cwd, env, row.key.split('.')[0]);
    row.resolved = row.key === 'archive.dirs' ? row.value.map(v => path.resolve(row.base, v)) : path.join(path.resolve(row.base, row.value), path.basename(git.canonical));
  }
  return { schema: 'config-view/v1', project: git.canonical, common: git.identity, record: binding?.record ?? findOrgDir({ cwd, env }),
    binding: binding?.file ?? null, identity: binding?.identity ?? null, values: [...values.values()], reference: CONFIG_REFERENCE,
    ...(env.LANE_CONFIG ? { invocation_override: { file: path.resolve(cwd, env.LANE_CONFIG), effective: !binding } } : {}),
    warnings: configDrift(binding).map(d => d.warning) };
}
function keyTarget(key, scope, binding) {
  const parts = key.split('.');
  if (parts.some(p => !p || ['__proto__', 'constructor', 'prototype'].includes(p))) throw Error('invalid config key');
  if (scope === 'identity') return { kind: 'identity', parts: parts[0] === 'identity' ? parts.slice(1) : parts, file: binding.identityFile };
  let kind = ['validation', 'promote', 'housekeeping', 'pin', 'routing', 'lane'].includes(parts[0]) ? parts.shift() : 'lane';
  if (kind === 'lane' && ['routes', 'dispatch', 'selection_policy'].includes(parts[0]) && binding.sources.routing) kind = 'routing';
  return { kind, parts };
}
export function setConfig(key, rawValue, { cwd = process.cwd(), env = process.env, scope = 'project', expect, who, releaseCheck, afterReplace, afterIntent, unset = false } = {}) {
  if (!['project', 'identity'].includes(scope)) throw Error('scope must be project or identity');
  // Draft inspection lets the original identity command repair an unresolved
  // intent. Ordinary readers still hold until the file/audit pair is complete.
  const home = homeProject(cwd, env, { inspection: scope === 'identity' }), git = gitProject(cwd, { env }), owner = projectIdentity(git, env);
  const binding = home ?? { identity: owner.name, common: git.identity, checkout: git.canonical, directory: git.canonical, defaults: { identity_root: owner.root },
    record: findOrgDir({ cwd, env }), sources: {} };
  if (!binding.record) throw Error('config set requires the existing owning record');
  if (scope === 'identity' && !home) throw Error('adopt the project before editing its shared home identity defaults');
  const target = keyTarget(key, scope, binding);
  const selected = target.kind === 'identity' ? { file: binding.identityFile } : policyLocation(cwd, target.kind, env);
  const file = target.file ?? policyLocation(cwd, target.kind, env, { write: true }).file;
  const rootKey = target.parts[0];
  const allowed = scope === 'identity' ? [...Object.keys(CONFIG_REFERENCE), 'schema', 'authority'] : target.kind === 'lane' ? Object.keys(CONFIG_REFERENCE).filter(k => !['launch', 'project_access', 'brain_write', 'promote', 'housekeeping', 'pin'].includes(k)).concat(['schema', 'authority']) : null;
  if (allowed && !allowed.includes(rootKey)) throw Error(`${key}: unknown policy key or binding metadata; inspect adoption metadata separately`);
  let value;
  try { value = JSON.parse(rawValue); } catch { value = rawValue; }
  return withConfigLock(binding, scope, () => {
    const record = scope === 'identity' ? path.join(path.dirname(binding.identityFile), '.org') : binding.record;
    const pending = pendingConfigWrite(record, file);
    const own = selected.file && present(selected.file) ? readPolicyFile(selected.file, target.kind, { cwd, env, audit: pending.length === 0 }) : {};
    const next = structuredClone(own);
    let parent = next;
    for (const part of target.parts.slice(0, -1)) {
      if (parent[part] === undefined) parent[part] = {};
      if (!parent[part] || typeof parent[part] !== 'object' || Array.isArray(parent[part])) throw Error(`${key}: parent is not an object`);
      parent = parent[part];
    }
    if (!target.parts.length) throw Error('a policy key is required');
    if (unset) delete parent[target.parts.at(-1)]; else parent[target.parts.at(-1)] = value;
    if (!pending.length && JSON.stringify(next) === JSON.stringify(own)) return { changed: false, file, warnings: [] };
    const validate = config => {
      validatePolicy(target.kind, config, file);
      if (scope === 'identity') validateIdentity(config, file, binding.identity);
      if (['lane', 'routing', 'identity'].includes(target.kind)) {
        const defaults = home ? readPolicyFile(binding.identityFile, 'identity', { cwd, env, audit: scope !== 'identity' }) : {};
        const projectFile = policyLocation(cwd, 'lane', env, { binding: home }).file;
        const project = present(projectFile) ? readPolicyFile(projectFile, 'lane', { cwd, env, audit: target.kind === 'identity' }) : {};
        mergeRoutesConfig(target.kind === 'identity' ? [config, project] : target.kind === 'routing' ? [config] : [defaults, config]);
      }
    };
    if (target.kind === 'pin') {
      if (!releaseCheck) throw Error('pin edits require the release admission validator');
      releaseCheck(next.release, binding);
    }
    const result = writeAuditedConfig({ file, value: next, kind: target.kind, binding, cwd, env, scope, who, validate, expectDigest: expect, afterReplace, afterIntent });
    return { ...result, warnings: result.changed ? [`Warning: repo-reading project scripts will not see this change to ${file}${selected.legacy ? `; they still read ${selected.legacy}` : ''}.`, ...configDrift(binding).map(d => d.warning)] : [] };
  });
}
export async function configCommand(argv, options = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean' }, unset: { type: 'boolean' }, scope: { type: 'string' }, expect: { type: 'string' }, 'who-asked': { type: 'string' } } });
  const [verb, key, value] = positionals, scope = values.scope ?? 'project';
  let result;
  const warned = new Set();
  if (!(verb === 'set' && scope === 'identity')) for (const drift of configDrift(homeProject(options.cwd ?? process.cwd(), options.env ?? process.env))) { process.stderr.write(`${drift.warning}\n`); warned.add(drift.warning); }
  if (!verb && !positionals.length) result = configSnapshot(options);
  else if (verb === 'history' && positionals.length === 1) {
    const binding = homeProject(options.cwd ?? process.cwd(), options.env ?? process.env);
    const record = scope === 'identity' ? binding && path.join(path.dirname(binding.identityFile), '.org') : binding?.record ?? findOrgDir(options);
    if (!record) throw Error('config history requires the existing owning record');
    result = { record, scope, entries: auditEvents(record).filter(e => e.type === 'config.changed' && e.scope === scope) };
  } else if (verb === 'set' && (positionals.length === 3 && !values.unset || positionals.length === 2 && values.unset)) {
    const releases = await import('./releases.mjs');
    result = setConfig(key, value, { ...options, scope, unset: values.unset, expect: values.expect, who: values['who-asked'], releaseCheck(id, binding) {
      return binding.adoption ? releases.requireHomeRelease(id, binding) : id ? releases.requireReadyAcceptance(releases.checkRelease(releases.releaseHome(), id), releases.releaseHome()) : null;
    } });
  } else throw Error('usage: record config [--json] | config set KEY VALUE [--scope project|identity] [--expect DIGEST] [--who-asked REF] | config history [--scope identity]');
  for (const warning of result.warnings ?? []) if (!warned.has(warning)) process.stderr.write(`${warning}\n`);
  process.stdout.write(values.json || verb === 'history' ? JSON.stringify(result, null, 2) + '\n' : verb === 'set' ? `${result.changed ? 'Saved' : 'Unchanged'} ${result.file}\n`
    : [`Project: ${result.project}`, `Record: ${result.record}`, ...result.values.map(v => `${v.key} = ${JSON.stringify(v.value)} (${v.scope}: ${v.source}#${v.source_key}${v.base ? `; base ${v.base}` : ''}) — ${v.effect}`)].join('\n') + '\n');
  return 0;
}
