// Opt-in project launch plumbing. Never changes native permissions or trust.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gitProject } from '../lib/project.mjs';
import { readPlainFile, plainDirectory, writeFileAtomic } from '../lib/files.mjs';
import { quote } from '../lib/shell.mjs';
import { addressKey } from './receiver.mjs';

const script = fileURLToPath(new URL('./hook-pull.mjs', import.meta.url));
export function hookLaunchArguments({ cwd, kind, role, args }) {
  // Only the canonical project's own file opts in. No parent/global config.
  const project = gitProject(cwd), file = path.join(project.canonical, '.hook-pull.json');
  let config;
  try { config = JSON.parse(readPlainFile(file)); }
  catch (e) { if (e.code === 'ENOENT') return args; throw e; }
  if (config.enabled !== true) return args;
  if (Object.keys(config).some(k => !['enabled', 'rendering'].includes(k)) ||
      config.rendering !== undefined && !['plain', 'teammate'].includes(config.rendering)) throw Error('invalid hook-pull project config');
  // Codex trust is keyed by absolute source path. Leave its lane argv alone.
  if (kind !== 'claude' || role === 'chat') return args;
  if (args.some(a => a === '--settings' || a.startsWith('--settings='))) throw Error('hook-pull cannot replace existing Claude --settings');
  const token = randomUUID(), directory = path.join(project.identity, 'sessions/hook-pull', token);
  plainDirectory(directory);
  const sessionFile = path.join(directory, 'session.json'), settings = path.join(directory, 'claude-settings.json');
  const address = { identity: project.identity, projectRef: project.identity, session: { uid: token, incarnation: token } };
  const session = { schema: 'brain.hook-session/v1', root: path.join(project.identity, 'sessions/receiver'),
    common: project.identity, cwd: project.checkout, kind, role, humanTyped: ['chat', 'supervisor'].includes(role),
    recipient: addressKey(address), address, consumer: token, rendering: config.rendering ?? 'plain' };
  writeFileAtomic(sessionFile, JSON.stringify(session) + '\n', 0o600);
  writeFileAtomic(settings, JSON.stringify(hookSettings(sessionFile)) + '\n', 0o600);
  return [...args, '--settings', settings];
}
export function hookSettings(sessionFile) {
  if (!path.isAbsolute(sessionFile)) throw Error('absolute hook session file required');
  const command = [process.execPath, script, '--session', sessionFile].map(quote).join(' ');
  return { hooks: Object.fromEntries(['Stop', 'UserPromptSubmit'].map(event => [event,
    [{ hooks: [{ type: 'command', command, timeout: 10 }] }]])) };
}
export function readHookSession(file) {
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file || (fs.lstatSync(file).mode & 0o077)) throw Error('private canonical hook session required');
  const session = JSON.parse(readPlainFile(file));
  if (session.schema !== 'brain.hook-session/v1' || !['claude', 'codex'].includes(session.kind) ||
      !['plain', 'teammate'].includes(session.rendering) || session.kind !== 'claude' && session.rendering !== 'plain' ||
      typeof session.humanTyped !== 'boolean' || !session.consumer || !path.isAbsolute(session.root ?? '') ||
      !path.isAbsolute(session.cwd ?? '') || !path.isAbsolute(session.common ?? '') || session.address?.projectRef !== session.common ||
      addressKey(session.address) !== session.recipient) throw Error('invalid hook session');
  return session;
}
