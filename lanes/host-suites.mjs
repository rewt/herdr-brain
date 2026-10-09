// Host authority belongs to committed canonical declarations, never lane config.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gitProject } from '../lib/project.mjs';

const file = '.lane.validation.json';
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;
export const suiteName = name => typeof name === 'string' && namePattern.test(name);
const capabilities = ['localhost', 'unix_sockets', 'pty', 'temp'];
export const HOST_TCP_LIMIT = 'Wildcard binds can accept non-loopback inbound connections for the suite duration; suites must bind 127.0.0.1. External outbound traffic is denied.';
export const HOST_PTY_LIMIT = 'PTY access is limited to /dev/ptmx allocation and slaves allocated in the suite sandbox via com.apple.sandbox.pty; opening other existing terminal slaves and changing their terminal state are denied. Standard input is /dev/null; output goes to the validation log.';
export function validateHostDeclarations(value) {
  const suites = value.host_suites ?? {}, tiers = value.tier_suites ?? {};
  for (const [key, object] of [['host_suites', suites], ['tier_suites', tiers]])
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw Error(`${key} must be an object`);
  for (const [name, suite] of Object.entries(suites)) {
    if (!suiteName(name) || !suite || typeof suite !== 'object' || Array.isArray(suite)) throw Error('invalid host suite');
    if (typeof suite.command !== 'string' || !suite.command.trim() || suite.command.includes('\0')) throw Error(`invalid host suite command: ${name}`);
    for (const [key, need] of Object.entries(suite)) {
      if (key === 'command') continue;
      if (key === 'external_network') {
        if (!Array.isArray(need) || new Set(need).size !== need.length || need.some(endpoint => typeof endpoint !== 'string' ||
            !/^(?:[a-zA-Z0-9][a-zA-Z0-9.-]*|\[[a-fA-F0-9:]+\]):[0-9]{1,5}$/u.test(endpoint) || Number(endpoint.slice(endpoint.lastIndexOf(':') + 1)) < 1 || Number(endpoint.slice(endpoint.lastIndexOf(':') + 1)) > 65535))
          throw Error('external_network must be a host:port allowlist');
        continue;
      }
      if (!capabilities.includes(key) || typeof need !== 'boolean') throw Error(`invalid host suite capability: ${key}`);
    }
  }
  for (const [tier, names] of Object.entries(tiers)) {
    if (!['fast', 'promotion'].includes(tier) || !Array.isArray(names) || new Set(names).size !== names.length ||
        names.some(name => !suiteName(name) || !Object.hasOwn(suites, name))) throw Error(`invalid tier_suites.${tier}`);
  }
  return { host_suites: suites, tier_suites: tiers };
}
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function committed(root) {
  try { git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']); }
  catch (error) {
    // An unborn repository has no committed declarations. Other Git failures
    // still propagate (including non-repositories handled by legacy callers).
    if (error.status === 1 && !String(error.stderr).trim()) return {};
    throw error;
  }
  if (!git(root, ['ls-tree', 'HEAD', '--', file])) return {};
  return JSON.parse(git(root, ['show', `HEAD:${file}`]));
}
export function canonicalHostSuites(root) {
  const local = fs.existsSync(path.join(root, file)) ? validateHostDeclarations(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))) : validateHostDeclarations({});
  let declared;
  try { declared = validateHostDeclarations(committed(root)); }
  catch (error) {
    // Legacy watchdog/configuration callers can inspect non-Git directories.
    // They have no host authority; declarations always require a Git commit.
    if (!Object.keys(local.host_suites).length && !Object.keys(local.tier_suites).length && /not a git repository/u.test(String(error.stderr))) return local;
    throw error;
  }
  if (JSON.stringify(local) !== JSON.stringify(declared)) throw Error('host declarations must match committed canonical content');
  return declared;
}
export function hostSuitePlan(cwd, names) {
  const project = gitProject(cwd), declaration = canonicalHostSuites(project.canonical);
  if (JSON.stringify(validateHostDeclarations(committed(cwd))) !== JSON.stringify(declaration))
    throw Error('lane-edited host declarations are refused; rebase onto the canonical declaration');
  return names.map(name => {
    if (!suiteName(name) || !Object.hasOwn(declaration.host_suites, name)) throw Error(`undeclared host suite: ${name}`);
    const suite = { command: declaration.host_suites[name].command, ...Object.fromEntries(capabilities.map(key => [key, declaration.host_suites[name][key] ?? false])), external_network: declaration.host_suites[name].external_network ?? [] };
    return { name, ...suite, profile: 'host-validation/v1', tcp_listener_limit: HOST_TCP_LIMIT, ...(suite.pty ? { pty_limit: HOST_PTY_LIMIT } : {}), declaration_hash: createHash('sha256').update(JSON.stringify(suite)).digest('hex') };
  });
}
export function assertHostSuiteSupport(plan) {
  if (!plan.length) return;
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) throw Error('HOST_PROFILE_UNAVAILABLE: macOS sandbox-exec required');
  if (plan.some(suite => suite.external_network.length)) throw Error('HOST_PROFILE_UNAVAILABLE: Seatbelt cannot enforce external host:port addresses; refusing the declared allowlist');
}
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function hostSuiteCommand(cwd, plan, { sharedPaths = [], tempRoot } = {}) {
  const runner = fileURLToPath(new URL('../discovery/host-validate.mjs', import.meta.url));
  const tree = git(cwd, ['rev-parse', 'HEAD^{tree}']);
  return plan.map(suite => [process.execPath, runner, cwd, suite.name, suite.declaration_hash, tree, JSON.stringify(sharedPaths), tempRoot ?? ''].map(quote).join(' ')).join(' && ');
}
