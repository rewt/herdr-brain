// Per-launch hooks; no user settings or hook trust records are written here.
import path from 'node:path';
import { gitProject } from '../lib/project.mjs';
import { quote } from '../lib/shell.mjs';
import { permissionProject, permissionDecision, permissionOutput, DENIAL_NUDGE } from '../brain/lib/permission-policy.mjs';
import { auditPermission } from '../brain/lib/permission-audit.mjs';
import { stewardConfig, operatorAlert } from '../brain/lib/steward.mjs';
import { HOME } from '../brain/lib/queue.mjs';

export async function handlePermission(event, binding, { env = process.env, home = HOME, alert = operatorAlert, deadline, timeoutMs = 1000, deferApproval = false, startAlert } = {}) {
  let project, config;
  let decision;
  try {
    config = stewardConfig(home);
    project = permissionProject(binding.workspace, env, { deadline, timeoutMs });
    if (project.identity !== binding.identity || project.checkout !== binding.canonical || project.record !== binding.org) throw Error('launch project binding changed');
    decision = permissionDecision(event, { kind: binding.kind, project, runTemp: binding.runTemp, deadline, timeoutMs });
    if (!config.enabled) decision = { behavior: 'deny', reason: 'Steward disabled', category: 'security', alert: false, message: DENIAL_NUDGE };
  } catch (error) { decision = { behavior: 'deny', reason: 'Unverified launch binding or configuration', category: 'security', alert: false, message: DENIAL_NUDGE }; }
  try {
    const notificationFor = audit => audit.notify ? { payload: { project: project?.name ?? 'unresolved', session: binding?.session, kind: audit.decision.reason }, config } : null;
    const audit = auditPermission(home, { ...binding, project: project?.name ?? 'unresolved' }, event ?? {}, decision, Date.now(), config, {
      deadline, deferApproval, onDurable: audit => {
        const notification = notificationFor(audit);
        if (notification && audit.decision.behavior === 'deny') startAlert?.(notification);
      },
    });
    decision = audit.decision;
    if (deadline !== undefined && Date.now() >= deadline) throw Error('permission decision deadline reached');
    const notification = notificationFor(audit);
    return { output: permissionOutput(decision), receipt: audit.receipt, notification, notify: notification ? () => alert(notification.payload, config).catch(error => process.stderr.write(`Steward alert failed: ${error.message}\n`)) : null };
  } catch (error) {
    process.stderr.write(`Steward permission audit refused: ${error.message}\n`);
    return { output: permissionOutput({ behavior: 'deny', message: `Permission audit unavailable. ${DENIAL_NUDGE}` }), notify: null };
  }
}

// Each native request runs independently of the launch adapter's lifetime.
export function permissionHookArguments(kind, context, root, runTemp, env = process.env) {
  let identity = context.identity;
  try { identity ??= gitProject(context.workspace).identity; } catch { /* Unbound launches deny. */ }
  const binding = { kind, identity,
    workspace: context.workspace, canonical: context.canonical, org: context.org, runTemp,
    session: env.HERDR_AGENT_NAME || env.MONITOR_SUPERVISOR_AGENT || 'native-session' };
  // A random temp path in the command would change Codex's trust fingerprint
  // every launch. The parent supplies the binding in the launch environment.
  const command = [process.execPath, path.join(root, 'supervisor/permission-hook.mjs')].map(quote).join(' ');
  const environment = { MONITOR_PERMISSION_BINDING: JSON.stringify(binding) };
  const group = { hooks: [{ type: 'command', command, timeout: 15 }] };
  if (kind === 'claude') return { binding, group, env: environment, args: ['--settings', JSON.stringify({ hooks: { PermissionRequest: [group] } })] };
  return { binding, group, env: environment, args: ['-c', `hooks.PermissionRequest=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=15}]}]`] };
}
