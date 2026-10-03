// Native lifecycle transport, shared by the two existing launch adapters.
import path from 'node:path';
import { quote } from '../discovery/runtime.mjs';
export function sessionEnvironment(context, root, env = process.env) {
  return { ...env, MONITOR_SESSION_ROLE: context.role, MONITOR_ENTRY_BYPASS: context.role === 'supervisor' ? '0' : '1',
    MONITOR_SUPERVISOR_REPO: context.role === 'supervisor' ? context.canonical : '',
    MONITOR_SUPERVISOR_IDENTITY: context.role === 'supervisor' ? context.identity : '',
    MONITOR_SUPERVISOR_ORG: context.role === 'supervisor' ? context.org : '',
    MONITOR_SUPERVISOR_ENTRY: context.role === 'supervisor' ? path.join(root, 'supervisor/session-start.mjs') : '' };
}
export function sessionHookArguments(kind, context, root) {
  if (context.role !== 'supervisor') return [];
  const command = `${quote(process.execPath)} ${quote(path.join(root, 'supervisor/session-start.mjs'))}`;
  const matcher = '^(startup|resume|clear|compact)$';
  if (kind === 'claude') return ['--settings', JSON.stringify({ hooks: { SessionStart: [{ matcher, hooks: [{ type: 'command', command, timeout: 30 }] }] } })];
  return ['-c', `hooks.SessionStart=[{matcher=${JSON.stringify(matcher)},hooks=[{type="command",command=${JSON.stringify(command)},timeout=30}]}]`];
}
