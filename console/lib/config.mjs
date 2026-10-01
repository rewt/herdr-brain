// Console configuration: ~/.config/herdr-org/console.json (HERDR_ORG_CONSOLE_CONFIG overrides).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class ConfigError extends Error {}

export function configPath(env = process.env) {
  return env.HERDR_ORG_CONSOLE_CONFIG || path.join(os.homedir(), '.config', 'herdr-org', 'console.json');
}

export const EXAMPLE = {
  '//': [
    'Herdr Monitor configuration. Edit the project below, then delete the "example" line.',
    'projects[].org          the record directory (what ORG_DIR would be)',
    'projects[].cwd          the checkout the executive sessions run in (finds their transcripts)',
    'projects[].ledger_dir   where settle-watch writes sessions-YYYY-MM-DD.log and the STOP file',
    'projects[].claude_config_dirs  Claude config dirs to search for session transcripts',
    'projects[].session_cap  the daily session limit shown in the header',
    'refresh_seconds         how often to re-read when nothing changed',
    'brain_bin               path to brain.mjs; its queue of stopped sessions joins Waiting on you',
    'glyphs                  "nerd" (a Nerd Font is set in Herdr) or "plain" (ASCII only)',
  ],
  example: true,
  projects: [
    {
      name: 'bch-cloak',
      org: '/Users/rewt/development/bastian/.org',
      cwd: '/Users/rewt/development/bastian/bch-cloak',
      ledger_dir: '/Users/rewt/development/bastian/bch-cloak/.lane/supervisor',
      claude_config_dirs: ['/Users/rewt/.claude', '/Users/rewt/.claude-personal'],
      session_cap: 30,
    },
  ],
  refresh_seconds: 5,
  brain_bin: '/Users/rewt/development/rewt/herdr-brain/brain/bin/brain.mjs',
  glyphs: 'nerd',
};

function expand(p) {
  if (typeof p !== 'string' || !p) return null;
  return path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
}

export function normalizeConfig(raw, file, { allowUnmanaged = false } = {}) {
  if (raw?.example) throw new ConfigError(`${file} is still the example: edit its project paths, then delete the "example" line`);
  const projects = Array.isArray(raw?.projects) ? raw.projects : [];
  if (!projects.length && !allowUnmanaged) throw new ConfigError(`${file} lists no projects`);
  const out = projects.map((p, i) => {
    if (!p?.name) throw new ConfigError(`${file}: projects[${i}] needs a name`);
    if (!p.org && !allowUnmanaged) throw new ConfigError(`${file}: project ${p.name} needs "org" (its record directory)`);
    return {
      name: String(p.name),
      org: expand(p.org),
      cwd: expand(p.cwd),
      ledger_dir: expand(p.ledger_dir),
      claude_config_dirs: (Array.isArray(p.claude_config_dirs) ? p.claude_config_dirs : [path.join(os.homedir(), '.claude')]).map(expand).filter(Boolean),
      session_cap: Number.isFinite(p.session_cap) ? p.session_cap : null,
    };
  });
  const refresh = Number(raw.refresh_seconds);
  const glyphs = raw.glyphs ?? 'nerd';
  if (!['nerd', 'plain'].includes(glyphs)) throw new ConfigError(`${file}: "glyphs" is "nerd" or "plain", not ${JSON.stringify(glyphs)}`);
  // Optional: with it, what stopped sessions left behind joins Waiting on you.
  const brainBin = expand(raw.brain_bin);
  if (raw.brain_bin && !brainBin) throw new ConfigError(`${file}: "brain_bin" must be a path`);
  // explain: false turns off the plain-words reading of org questions (one small model call each, cached).
  return { projects: out, refresh_seconds: Number.isFinite(refresh) && refresh >= 1 ? refresh : 5, glyphs, brain_bin: brainBin, explain: raw.explain !== false };
}

// Opening the live trial on a new installation must not create an example
// config or demand an organization before the operator can inspect a project.
export function loadModernConfig(file = configPath()) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return normalizeConfig({ projects: [], explain: false }, file, { allowUnmanaged: true });
    throw new ConfigError(`${file} cannot be read: ${error.message}`);
  }
  return normalizeConfig({ ...raw, explain: false }, file, { allowUnmanaged: true });
}

export function loadConfig(file = configPath()) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(EXAMPLE, null, 2) + '\n', { flag: 'wx' });
    throw new ConfigError(`wrote an example configuration to ${file}\nedit its project paths, delete the "example" line, then run record console again`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON: ${error.message}`);
  }
  return normalizeConfig(raw, file);
}
