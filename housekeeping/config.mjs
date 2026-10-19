import fs from 'node:fs';

export const DEFAULTS = Object.freeze({ enabled: true, resume: true, tick_seconds: 60, cleanup_seconds: 600, release_sessions: true });
export const FIELDS = Object.keys(DEFAULTS);

export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('housekeeping config must be an object');
  for (const [key, value] of Object.entries(config)) {
    if (!FIELDS.includes(key)) throw new Error(`unknown housekeeping override: ${key}`);
    if (typeof DEFAULTS[key] === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`${key} must be true|false`);
    } else if (!Number.isFinite(value) || value < 1) throw new Error(`${key} must be >= 1`);
  }
  return config;
}

export function readConfig(file) {
  const config = validateConfig(file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
  // Preserve the scheduler's public projection; absent resume means enabled.
  return { enabled: true, tick_seconds: 60, cleanup_seconds: 600, ...config };
}

export function parseOverride(key, text) {
  if (!FIELDS.includes(key)) throw new Error(`unknown housekeeping override: ${key}`);
  if (typeof DEFAULTS[key] === 'boolean' && !['true', 'false'].includes(text)) throw new Error(`${key} must be true|false`);
  if (typeof DEFAULTS[key] === 'number' && !text.trim()) throw new Error(`${key} must be >= 1`);
  const value = typeof DEFAULTS[key] === 'boolean' ? text === 'true' : Number(text);
  validateConfig({ [key]: value });
  return value;
}
