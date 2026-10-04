// Inspect local native choices for diagnostics, without rewriting their files
// or replacing either harness's configuration loader.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function option(args, names) {
  let value;
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i])) value = args[++i];
    else for (const name of names) if (args[i].startsWith(`${name}=`)) value = args[i].slice(name.length + 1);
  }
  return value;
}

// Only the scalar selectors are needed here. Leave TOML validation and policy
// resolution to Codex; this is not a second native configuration parser.
function selectors(text, section = '') {
  const selected = {};
  let table = '';
  for (const line of text.split('\n')) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/u);
    if (header) { table = header[1].replace(/["']/gu, '').trim(); continue; }
    if (table !== section) continue;
    const entry = line.match(/^\s*["']?(sandbox_mode|default_permissions|profile)["']?\s*=\s*(["'])(.*?)\2\s*(?:#.*)?$/u);
    if (entry) selected[entry[1]] = entry[3];
  }
  return selected;
}

export function codexPermissionChoice(context, args, env) {
  const home = env.CODEX_HOME || process.env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex');
  const files = ['/etc/codex/config.toml', path.join(home, 'config.toml')];
  const base = read(files[1]);
  const profile = option(args, ['--profile', '-p']) ?? selectors(base ?? '').profile;
  if (profile) files.push(path.join(home, `${profile}.config.toml`));
  // A worktree has its own project layer; subdirectory layers override it.
  const workspace = path.resolve(context.workspace);
  let current = workspace;
  const projectFiles = [];
  while (true) {
    projectFiles.unshift(path.join(current, '.codex/config.toml'));
    if (fs.existsSync(path.join(current, '.git')) || path.dirname(current) === current) break;
    current = path.dirname(current);
  }
  files.push(...projectFiles);
  const values = {};
  for (const file of files) {
    const text = read(file);
    if (text === null) continue;
    const settings = { ...selectors(text), ...(file === files[1] && profile ? selectors(text, `profiles.${profile}`) : {}) };
    for (const key of ['sandbox_mode', 'default_permissions']) if (settings[key] !== undefined) values[key] = { setting: key, value: settings[key], source: file };
  }
  let flag;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let config;
    if (['-c', '--config'].includes(arg)) config = args[++i];
    else if (arg.startsWith('--config=')) config = arg.slice(9);
    else if (arg.startsWith('-c') && arg.length > 2) config = arg.slice(2);
    // Codex also accepts bare CLI string values when TOML parsing fails.
    const bare = config?.match(/^\s*(sandbox_mode|default_permissions)\s*=\s*([\w:-]+)\s*$/u);
    if (config) for (const [setting, value] of Object.entries(bare ? { [bare[1]]: bare[2] } : selectors(config))) {
      if (setting !== 'profile') values[setting] = { setting, value, source: `CLI ${arg}` };
    }
    if (['-s', '--sandbox'].includes(arg)) flag = { setting: 'sandbox_mode', value: args[++i], source: `CLI ${arg}` };
    else if (arg.startsWith('--sandbox=')) flag = { setting: 'sandbox_mode', value: arg.slice(10), source: `CLI ${arg}` };
    else if (arg.startsWith('-s') && arg.length > 2) flag = { setting: 'sandbox_mode', value: arg.slice(2), source: `CLI ${arg}` };
    else if (['--yolo', '--dangerously-bypass-approvals-and-sandbox'].includes(arg)) return { setting: 'sandbox_mode', value: 'danger-full-access', source: `CLI ${arg}` };
    else if (arg === '--full-auto') flag = { setting: 'sandbox_mode', value: 'workspace-write', source: 'CLI --full-auto' };
  }
  return flag ?? values.sandbox_mode ?? values.default_permissions;
}

export function claudeSettingsSources(context, args, env) {
  const home = env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  const enabled = new Set((option(args, ['--setting-sources']) ?? 'user,project,local').split(','));
  const files = [
    ...(enabled.has('user') ? [path.join(home, 'settings.json')] : []),
    ...(enabled.has('project') ? [path.join(context.workspace, '.claude/settings.json')] : []),
    ...(enabled.has('local') ? [path.join(context.workspace, '.claude/settings.local.json')] : []),
  ];
  const sources = [];
  for (const file of files) {
    const text = read(file);
    if (text !== null) sources.push({ source: file, settings: JSON.parse(text) });
  }
  // Managed settings have precedence over CLI; native enforcement stays with
  // Claude. Include locally inspectable managed files in the warning.
  const managed = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code';
  let fragments = [];
  try { fragments = fs.readdirSync(path.join(managed, 'managed-settings.d')).filter(name => name.endsWith('.json')).map(name => path.join(managed, 'managed-settings.d', name)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const file of [path.join(managed, 'managed-settings.json'), ...fragments]) {
    const text = read(file);
    if (text !== null) sources.push({ source: file, settings: JSON.parse(text), managed: true });
  }
  return sources;
}
