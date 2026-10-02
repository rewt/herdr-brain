// Entry preferences belong to the canonical project's .lane.json. Parent route
// configuration and harness environment do not select a project's entry mode.
import fs from 'node:fs';
import path from 'node:path';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export function projectEntrySettings(project) {
  const file = path.join(project.canonical, '.lane.json');
  const defaults = { enabled: true, mode: 'worker', policy: '', source: null };
  if (!fs.existsSync(file)) return defaults;
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`cannot read entry config ${file}: ${error.message}`); }
  const invalid = (reason) => { throw new Error(`invalid entry config ${file}: ${reason}`); };
  if (!object(config)) invalid('top level must be an object');
  if (!Object.hasOwn(config, 'entry')) return defaults;
  const entry = config.entry;
  if (!object(entry)) invalid('entry must be an object');
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') invalid('entry.enabled must be a boolean');
  // Opt-out precedes validation of unused settings and all entry mutations.
  if (entry.enabled === false) return { ...defaults, enabled: false, source: file };
  if (Object.keys(entry).some((key) => !['enabled', 'mode', 'policy'].includes(key))) invalid('unknown entry setting');
  if (entry.mode !== undefined && !['worker', 'main'].includes(entry.mode)) invalid('entry.mode must be worker or main');
  if (entry.policy !== undefined && (typeof entry.policy !== 'string' || entry.policy.includes('\0'))) invalid('entry.policy must be text without NUL');
  return { ...defaults, ...entry, source: file };
}
