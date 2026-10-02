import { spawnSync } from 'node:child_process';

export const RELEASE_DEFAULTS = { base: 'main', max_load_per_cpu: 1, gate: ['npm', 'test'], prepare: null, prepare_env: {}, ship: null, parent: null };
const command = value => value === null || (Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'string' && !v.includes('\0')) && value[0].trim());

// Resolve the declaration from the exact commit, never an untracked local file.
export function releaseSettings(cwd, ref = 'HEAD') {
  const exists = spawnSync('git', ['-C', cwd, 'cat-file', '-e', `${ref}:.release.json`], { encoding: 'utf8' });
  if (exists.error) throw exists.error;
  const raw = exists.status === 0 ? spawnSync('git', ['-C', cwd, 'show', `${ref}:.release.json`], { encoding: 'utf8' }) : null;
  if (raw && (raw.error || raw.status !== 0)) throw new Error('cannot read tracked release declaration');
  const own = raw ? JSON.parse(raw.stdout) : {};
  if (!own || Array.isArray(own) || typeof own !== 'object' || Object.keys(own).some(k => !Object.hasOwn(RELEASE_DEFAULTS, k))) throw new Error('unknown release setting');
  const config = { ...RELEASE_DEFAULTS, ...own };
  if (typeof config.base !== 'string' || !config.base.trim() || !Number.isFinite(config.max_load_per_cpu) || config.max_load_per_cpu <= 0 ||
      config.gate === null || !command(config.gate) || !command(config.prepare) || !command(config.ship) ||
      !(config.parent === null || typeof config.parent === 'string') || !config.prepare_env || Array.isArray(config.prepare_env) || typeof config.prepare_env !== 'object' ||
      Object.entries(config.prepare_env).some(([k, v]) => !/^[A-Z][A-Z0-9_]*$/.test(k) || typeof v !== 'string' || v.includes('\0') || /^(ORG_|GIT_|HERDR_)/.test(k))) throw new Error('invalid release declaration');
  return { config, source: raw ? `${ref}:.release.json` : 'installed defaults' };
}

export function releaseArgv(command, values) {
  return command === null ? null : command.map(arg => arg.replace(/\{(tag|candidate|commit|repo)\}/g, (_, key) => values[key]));
}
