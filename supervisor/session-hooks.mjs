// Native lifecycle transport, shared by the two existing launch adapters.
import path from 'node:path';
import fs from 'node:fs';
import { quote } from '../discovery/runtime.mjs';
import { rememberSupervisor } from './session-binding.mjs';
import { sanitizeTerminal } from '../lib/sanitize.mjs';
// A native utility/headless invocation can inherit a supervisor's shell and
// pane. Suppress entry for that child without revoking the interactive receipt.
export function passthroughEnvironment(env = process.env) {
  const result = { ...env, MONITOR_SESSION_ROLE: 'worker', MONITOR_ENTRY_BYPASS: '1' };
  for (const key of Object.keys(result)) if (key.startsWith('MONITOR_SUPERVISOR_')) delete result[key];
  return result;
}
export function sessionEnvironment(context, root, env = process.env) {
  const result = { ...env, MONITOR_SESSION_ROLE: context.role, MONITOR_ENTRY_BYPASS: context.role === 'supervisor' ? '0' : '1',
    MONITOR_SUPERVISOR_REPO: context.role === 'supervisor' ? context.canonical : '',
    MONITOR_SUPERVISOR_IDENTITY: context.role === 'supervisor' ? context.identity : '',
    MONITOR_SUPERVISOR_ORG: context.role === 'supervisor' ? context.org : '',
    MONITOR_SUPERVISOR_AGENT: context.role === 'supervisor' ? (context.agent || env.MONITOR_SUPERVISOR_AGENT || env.HERDR_AGENT_NAME || '') : '',
    MONITOR_SUPERVISOR_ENTRY: context.role === 'supervisor' ? path.join(root, 'supervisor/session-start.mjs') : '' };
  try { rememberSupervisor(context, result); }
  catch (e) { process.stderr.write(sanitizeTerminal(`Supervisor entry binding: ${e.message}; session may continue.\n`)); }
  return result;
}
export function sessionHookArguments(kind, context, root) {
  if (context.role !== 'supervisor') return [];
  const settings = path.join(context.canonical, kind === 'claude' ? '.claude/settings.json' : '.codex/hooks.json');
  try {
    const groups = JSON.parse(fs.readFileSync(settings, 'utf8')).hooks?.SessionStart ?? [];
    if (['startup', 'resume', 'clear', 'compact'].every(source => groups.some(group =>
      (!group.matcher || new RegExp(group.matcher).test(source)) && group.hooks?.some(hook =>
        hook.type === 'command' && hook.command?.includes('supervisor/session-start.mjs'))))) return [];
  } catch (e) {
    if (e.code !== 'ENOENT') process.stderr.write(sanitizeTerminal(`Supervisor entry project hooks: ${e.message}; using adapter hook.\n`));
  }
  const command = `${quote(process.execPath)} ${quote(path.join(root, 'supervisor/session-start.mjs'))}`;
  const matcher = '^(startup|resume|clear|compact)$';
  if (kind === 'claude') return ['--settings', JSON.stringify({ hooks: { SessionStart: [{ matcher, hooks: [{ type: 'command', command, timeout: 30 }] }] } })];
  return ['-c', `hooks.SessionStart=[{matcher=${JSON.stringify(matcher)},hooks=[{type="command",command=${JSON.stringify(command)},timeout=30}]}]`];
}
