// Shared validation and per-file selection. No policy command is executed here.
import path from 'node:path';
import { readConfigJSON, homeProject, policyLocation, present } from './config-home.mjs';
import { validateRoutesConfig } from '../lanes/routes.mjs';
import { validateValidation } from '../lanes/validation.mjs';
import { validateArchive } from './archive.mjs';
import { validateDeskSettings } from '../settle/config.mjs';
import { validateConfig as validateHousekeeping } from '../housekeeping/config.mjs';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function check(ok, message) { if (!ok) throw Error(message); }
export function validateLane(config, file = 'lane config', { references = false } = {}) {
  check(object(config), 'root must be an object');
  validateRoutesConfig(config, { references });
  validateArchive(config, file);
  if (config.validation !== undefined) validateValidation(config.validation);
  if (config.settle !== undefined) validateDeskSettings(config.settle, references ? config : undefined);
  for (const key of ['main', 'validate', 'registry', 'seams_doc', 'worktree_root']) if (config[key] !== undefined) check(typeof config[key] === 'string', `${key} must be a string`);
  if (config.prepare !== undefined) check(Array.isArray(config.prepare) && config.prepare.every(s => object(s) && typeof s.run === 'string' && (s.unless === undefined || typeof s.unless === 'string')), 'prepare requires run and optional unless strings');
  if (config.retirement !== undefined) {
    check(object(config.retirement), 'retirement must be an object');
    for (const key of ['archival_retirement', 'closeout_queue']) if (config.retirement[key] !== undefined) check(typeof config.retirement[key] === 'boolean', `retirement.${key} must be boolean`);
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
  if (gate.env !== undefined) check(object(gate.env) && Object.entries(gate.env).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(k) && typeof v === 'string' && !v.includes('\0') && !/^(?:MONITOR_PROMOTION_|MONITOR_TEST_SLOT_(?:PATH|COMPAT_PATH|TOKEN)|BCH_CLOAK_TEST_SLOT_TOKEN|HERDR_(?:PANE|TAB|WORKSPACE)_ID|NODE_OPTIONS$)/u.test(k)), 'invalid gate.env');
  if (gate.prepare !== undefined) check(Array.isArray(gate.prepare) && gate.prepare.every(s => object(s) && Object.keys(s).every(k => ['run', 'unless'].includes(k)) && typeof s.run === 'string' && s.run.trim() && (s.unless === undefined || typeof s.unless === 'string' && !path.isAbsolute(s.unless) && !s.unless.split(/[\\/]/u).includes('..'))), 'invalid gate.prepare');
  if (gate.external_lock !== undefined) check(typeof gate.external_lock === 'string' && path.isAbsolute(gate.external_lock) && !gate.external_lock.includes('\0'), 'gate.external_lock must be absolute');
  if (gate.refuse_processes !== undefined) { check(Array.isArray(gate.refuse_processes) && gate.refuse_processes.every(p => typeof p === 'string' && p.trim()), 'invalid gate.refuse_processes'); for (const p of gate.refuse_processes) new RegExp(p); }
  if (gate.wait_seconds !== undefined) check(Number.isSafeInteger(gate.wait_seconds) && gate.wait_seconds >= 0 && gate.wait_seconds <= 9999999, 'invalid gate.wait_seconds');
  for (const k of ['timeout_seconds', 'idle_timeout_seconds']) if (gate[k] !== undefined) validateValidation({ [k]: gate[k] });
}
export function validatePolicy(kind, config, file) {
  if (kind === 'lane' || kind === 'identity' || kind === 'routing') return validateLane(config, file);
  if (kind === 'validation') return validateValidation(config);
  if (kind === 'promote') return validatePromote(config);
  if (kind === 'housekeeping') return validateHousekeeping(config);
  if (kind === 'pin') {
    check(object(config) && Object.keys(config).length === 1 && Object.hasOwn(config, 'release') && (config.release === null || typeof config.release === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(config.release) && !config.release.includes('..')), 'pin requires exactly {release: TAG|null}');
    return config;
  }
  throw Error(`unknown config kind ${kind}`);
}
export function readPolicyFile(file, kind) {
  try { return validatePolicy(kind, readConfigJSON(file), file); }
  catch (e) { throw Error(`${file}: ${e.message}; this project is held. Fix the value and read the config again.`); }
}
export function readProjectPolicy(cwd, kind, env = process.env) {
  const selected = policyLocation(cwd, kind, env);
  return { ...selected, config: selected.file && present(selected.file) ? readPolicyFile(selected.file, kind) : {} };
}
export function homePolicyLayers(cwd, parents, env = process.env) {
  const binding = homeProject(cwd, env);
  const files = binding ? [binding.identityFile] : parents.filter(Boolean);
  const selected = policyLocation(cwd, 'lane', env, { binding });
  if (selected.file && present(selected.file)) files.push(selected.file);
  return files.map(file => ({ file, base: configBase(file, cwd, env), config: readPolicyFile(file, file === binding?.identityFile ? 'identity' : 'lane') }));
}
export function configBase(file, cwd, env = process.env) {
  const binding = homeProject(cwd, env);
  if (!binding) return path.dirname(file);
  if (file === binding.identityFile) return binding.defaults.defaults_origin?.base ?? binding.defaults.identity_root;
  for (const [kind, source] of Object.entries(binding.sources)) if (policyLocation(cwd, kind, env, { binding }).file === file) return source.base;
  return path.dirname(file);
}
