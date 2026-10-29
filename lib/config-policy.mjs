// Shared validation and per-file selection. No policy command is executed here.
import fs from './record-observation.mjs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readPlainFile } from './files.mjs';
import { parseUniqueJson } from '../sessions/json.mjs';
import { auditPolicyRead, assertNoSecrets } from './config-audit.mjs';
import { homeProject, policyLocation, present, POLICY_FILES, contentDigest } from './config-home.mjs';
import { validateRoutesConfig, loadDiscoveredRoutes } from '../lanes/routes.mjs';
import { validateValidation } from './validation-declaration.mjs';
import { validateArchive } from './archive.mjs';
import { validateDeskSettings } from '../settle/config.mjs';
import { validateConfig as validateHousekeeping } from '../housekeeping/config.mjs';
import { validateReviewAdmission } from './review-admission.mjs';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const IDENTITY_ONLY_KEYS = Object.freeze(['launch', 'identity_root', 'defaults_origin', 'project_access', 'brain_write']);
function check(ok, message) { if (!ok) throw Error(message); }
export function validateLane(config, file = 'lane config', { references = false } = {}) {
  check(object(config), 'root must be an object');
  validateRoutesConfig(config, { references });
  validateArchive(config, file);
  if (config.validation !== undefined) validateValidation(config.validation);
  if (config.review_admission !== undefined) validateReviewAdmission(config.review_admission);
  if (config.settle !== undefined) validateDeskSettings(config.settle, references ? config : undefined);
  for (const key of ['main', 'validate', 'registry', 'seams_doc', 'worktree_root']) if (config[key] !== undefined) check(typeof config[key] === 'string', `${key} must be a string`);
  if (config.prepare !== undefined) {
    check(Array.isArray(config.prepare), 'prepare must be an array');
    check(config.prepare.every(s => object(s) && typeof s.run === 'string' && (s.unless === undefined || typeof s.unless === 'string')), 'prepare entries require run and optional unless strings');
  }
  if (config.retirement !== undefined) {
    check(object(config.retirement), 'retirement must be an object');
    for (const key of ['archival_retirement', 'closeout_queue', 'line_service_cleanup']) if (config.retirement[key] !== undefined) check(typeof config.retirement[key] === 'boolean', `retirement.${key} must be boolean`);
    if (config.retirement.line_service_cleanup === true) check(config.retirement.closeout_queue === false, 'retirement.line_service_cleanup requires closeout_queue=false');
    if (config.retirement.protected_paths !== undefined) check(Array.isArray(config.retirement.protected_paths) && config.retirement.protected_paths.every(g => typeof g === 'string' && g && !path.isAbsolute(g) && !/[\\\[\]{}!\0]/u.test(g) && !g.split('/').some(p => !p || p === '.' || p === '..' || p.includes('**') && p !== '**')), 'invalid retirement.protected_paths glob');
  }
  return config;
}
export function validatePromote(config) {
  check(object(config), 'promotion settings must be an object');
  for (const key of ['to', 'validate']) if (config[key] !== undefined) check(typeof config[key] === 'string' && config[key].trim(), `${key} must be a nonempty string`);
  for (const key of ['delivery_attempts', 'max_batch']) if (config[key] !== undefined) check(Number.isSafeInteger(config[key]) && config[key] > 0, `${key} must be a positive integer`);
  if (config.retry_seconds !== undefined) check(Number.isFinite(config.retry_seconds) && config.retry_seconds >= 0, 'retry_seconds must be nonnegative');
  // The gate resolver applies its existing closed nested validator. The pure
  // gate shape validator is shared below so inspecting config never probes Node.
  if (config.gate !== undefined) validateGateDeclaration(config.gate);
  return config;
}
export function validateGateDeclaration(gate) {
  check(object(gate), 'promote gate must be an object');
  const fields = ['node_version_file', 'env', 'prepare', 'external_lock', 'refuse_processes', 'wait_seconds', 'timeout_seconds', 'idle_timeout_seconds', 'resource'];
  for (const key of Object.keys(gate)) check(fields.includes(key), `unknown promote gate field: ${key}`);
  if (gate.node_version_file !== undefined) check(typeof gate.node_version_file === 'string' && gate.node_version_file && !path.isAbsolute(gate.node_version_file) && !gate.node_version_file.split(/[\\/]/u).includes('..'), 'gate.node_version_file must be project-relative');
  if (gate.env !== undefined) check(object(gate.env) && Object.entries(gate.env).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(k) && typeof v === 'string' && !v.includes('\0') && !/^(?:MONITOR_PROMOTION_|MONITOR_TEST_SLOT_(?:PATH|COMPAT_PATH|TOKEN)|BCH_CLOAK_TEST_SLOT_TOKEN|HERDR_(?:PANE|TAB|WORKSPACE)_ID|NODE_OPTIONS$)/u.test(k)), 'gate.env must map environment names to strings; slot paths/tokens, session transport and NODE_OPTIONS are host-owned');
  if (gate.prepare !== undefined) check(Array.isArray(gate.prepare) && gate.prepare.every(s => object(s) && Object.keys(s).every(k => ['run', 'unless'].includes(k)) && typeof s.run === 'string' && s.run.trim() && (s.unless === undefined || typeof s.unless === 'string' && !path.isAbsolute(s.unless) && !s.unless.split(/[\\/]/u).includes('..'))), 'invalid gate.prepare');
  if (gate.external_lock !== undefined) check(typeof gate.external_lock === 'string' && path.isAbsolute(gate.external_lock) && !gate.external_lock.includes('\0'), 'gate.external_lock must be absolute');
  if (gate.refuse_processes !== undefined) { check(Array.isArray(gate.refuse_processes) && gate.refuse_processes.every(p => typeof p === 'string' && p.trim()), 'invalid gate.refuse_processes'); for (const p of gate.refuse_processes) new RegExp(p); }
  if (gate.wait_seconds !== undefined) check(Number.isSafeInteger(gate.wait_seconds) && gate.wait_seconds >= 0 && gate.wait_seconds <= 9999999, 'invalid gate.wait_seconds');
  for (const k of ['timeout_seconds', 'idle_timeout_seconds']) if (gate[k] !== undefined) validateValidation({ [k]: gate[k] });
  if (gate.resource !== undefined) {
    const r = gate.resource;
    check(object(r) && typeof r.id === 'string' && /^[\w:./-]+$/u.test(r.id) && Number.isSafeInteger(r.revision) && r.revision > 0 &&
      (r.command === null || Array.isArray(r.command) && r.command.length > 0 && r.command.every(s => typeof s === 'string' && !s.includes('\0'))) && ['SHARED', 'EXCLUSIVE'].includes(r.admission_class) &&
      (r.M_bytes === null || Number.isSafeInteger(r.M_bytes) && r.M_bytes >= 0) && (r.C === null || Number.isSafeInteger(r.C) && r.C > 0) && object(r.worker_caps) &&
      Array.isArray(r.named_claims) && !r.named_claims.length && Array.isArray(r.evidence) &&
      (r.memory_floor_bytes === undefined || r.admission_class === 'EXCLUSIVE' && Number.isSafeInteger(r.memory_floor_bytes) && r.memory_floor_bytes >= 0), 'invalid gate.resource declaration');
  }
}
export function validatePolicy(kind, config, file) {
  if (['identity','routing'].includes(kind) && Object.hasOwn(config ?? {}, 'review_admission')) throw Error('review_admission belongs in project lane policy only');
  if (['lane', 'routing'].includes(kind) && Object.keys(config ?? {}).some(key => IDENTITY_ONLY_KEYS.includes(key))) throw Error('identity-only settings belong in identity.json');
  // Captured routing is an already admitted effective policy, including its
  // identity launcher. New project-file restrictions never apply to history.
  if (['lane', 'identity', 'routing', 'routing-snapshot'].includes(kind)) return validateLane(config, file);
  if (kind === 'validation') return validateValidation(config);
  if (kind === 'promote') return validatePromote(config);
  if (kind === 'housekeeping') return validateHousekeeping(config);
  if (kind === 'pin') {
    check(object(config) && Object.keys(config).length === 1 && Object.hasOwn(config, 'release') && (config.release === null || typeof config.release === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(config.release) && !config.release.endsWith('.partial')), 'pin requires exactly {release: TAG|null}');
    return config;
  }
  throw Error(`unknown config kind ${kind}`);
}
export function parsePolicyBytes(bytes, kind, file) {
  const value = validatePolicy(kind, parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bytes))), file);
  assertNoSecrets(value);
  return value;
}
export function readPolicySnapshot(file, kind, options = {}) {
  let bytes, value;
  try {
    // Existing operator-selected paths may use a directory alias. Pin its
    // canonical parent, while still refusing a redirected final policy file.
    bytes = readPlainFile(path.join(fs.realpathSync(path.dirname(file)), path.basename(file)), null);
    value = parsePolicyBytes(bytes, kind, file);
  } catch (e) {
    auditPolicyRead(file, undefined, bytes, e.message, { ...options, invalid: true });
    throw Object.assign(Error(`${bytes === undefined ? 'cannot read' : 'invalid'} ${kind === 'routing' ? 'route' : kind} config ${file}: ${e.message}; this project is held. Fix the value and read the config again.`), { code: e.code });
  }
  if (options.audit !== false) auditPolicyRead(file, value, bytes, undefined, options);
  return { config: value, bytes, digest: contentDigest(bytes) };
}
export function readPolicyFile(file, kind, options = {}) { return readPolicySnapshot(file, kind, options).config; }
export function readProjectPolicy(cwd, kind, env = process.env, { canonical } = {}) {
  const selected = policyLocation(cwd, kind, env, { canonical });
  if (!selected.home && ['promote', 'pin'].includes(kind)) {
    const root = selected.binding?.checkout ?? path.dirname(selected.file);
    const gitEnv = selected.binding ? Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('GIT_'))) : env;
    const git = (args, encoding = 'utf8') => execFileSync('git', ['-C', root, ...args], { env: gitEnv, encoding, stdio: ['ignore', 'pipe', 'pipe'] });
    let commit;
    try { commit = git(['rev-parse', '--verify', '--quiet', 'HEAD']).trim(); }
    catch (error) {
      if (error.status !== 1) throw error;
      const ref = git(['symbolic-ref', '--quiet', 'HEAD']).trim();
      try { git(['show-ref', '--verify', '--quiet', ref]); } catch (missing) { if (missing.status === 1) return { ...selected, config: {} }; throw missing; }
      throw error;
    }
    const name = POLICY_FILES[kind][1], entry = git(['ls-tree', commit, '--', name]).trim();
    if (!entry) return { ...selected, config: {}, source_commit: commit };
    if (!/^100(?:644|755) blob /u.test(entry)) throw Error(`${selected.file}: committed policy must be a regular file`);
    if (kind === 'pin' && !present(selected.file)) throw Error(`${selected.file}: committed pin is missing; restore it or commit an unpin`);
    const bytes = git(['show', `${commit}:${name}`], 'buffer');
    return { ...selected, config: parsePolicyBytes(bytes, kind, selected.file), source_commit: commit, source_digest: contentDigest(bytes) };
  }
  const snapshot = selected.file && present(selected.file) ? readPolicySnapshot(selected.file, kind, { cwd, env }) : null;
  // A project-only consumer still has to hold on an invalid effective policy.
  // References may come from identity defaults or the selected routing file;
  // caller overrides must never replace the canonical retirement policy.
  if (kind === 'lane') {
    try { loadDiscoveredRoutes({ cwd, env: { ...env, LANE_CONFIG: undefined },
      canonical: selected.binding?.checkout ?? path.dirname(selected.file),
      laneSnapshot: { file: selected.file, config: snapshot?.config ?? {}, present: Boolean(snapshot) } }); }
    catch (error) { throw Error(`invalid effective lane config ${selected.file}: ${error.message}; this project is held. Fix the value and read the config again.`); }
  }
  return { ...selected, config: snapshot?.config ?? {}, ...(snapshot ? { source_digest: snapshot.digest } : {}) };
}
export function homePolicyDigest(cwd, env = process.env) {
  const binding = homeProject(cwd, env);
  if (!binding) return null;
  const inputs = [[binding.file, contentDigest(readPlainFile(binding.file, null))], [binding.identityFile, contentDigest(readPlainFile(binding.identityFile, null))]];
  for (const kind of Object.keys(POLICY_FILES)) {
    if (kind === 'routing' && !binding.sources.routing) continue;
    const selected = readProjectPolicy(cwd, kind, env);
    inputs.push([kind, selected.file, selected.source_commit ?? null, selected.source_digest ?? contentDigest(JSON.stringify(selected.config))]);
  }
  return contentDigest(JSON.stringify(inputs));
}
export function homePolicyLayers(cwd, parents, env = process.env, { laneSnapshot, canonical } = {}) {
  const binding = homeProject(cwd, env);
  const files = binding ? [binding.identityFile] : parents.filter(Boolean);
  const selected = policyLocation(cwd, 'lane', env, { binding, canonical });
  if (laneSnapshot && selected.file !== laneSnapshot.file) throw Error('selected lane policy changed during read; refresh and read again');
  if (selected.file && (laneSnapshot ? laneSnapshot.present : present(selected.file))) files.push(selected.file);
  // Reuse the caller's parsed/audited snapshot. A later write may already have
  // a new intent by the time effective references are checked.
  // Eligible parent defaults have identity scope; the selected project layer
  // must never inherit that permission merely by sharing their file format.
  return files.map(file => ({ file, base: configBase(file, cwd, env), bases: { archive: configBase(file, cwd, env, 'archive') },
    config: file === laneSnapshot?.file ? laneSnapshot.config : readPolicyFile(file, file === selected.file ? 'lane' : 'identity', { cwd, env }) }));
}
export function configBase(file, cwd, env = process.env, key) {
  const binding = homeProject(cwd, env);
  if (!binding) return path.dirname(file);
  if (file === binding.identityFile) return binding.defaults.defaults_origin?.keys?.[key]?.base ?? (binding.defaults.defaults_origin?.keys ? binding.defaults.identity_root : binding.defaults.defaults_origin?.base ?? binding.defaults.identity_root);
  for (const [kind, source] of Object.entries(binding.sources)) if (policyLocation(cwd, kind, env, { binding }).file === file) return source.base;
  return path.dirname(file);
}
