// Per-launch hooks; no user settings or hook trust records are written here.
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { gitProject } from '../lib/project.mjs';
import { quote } from '../discovery/runtime.mjs';
import { permissionProject, permissionDecision, permissionOutput, DENIAL_NUDGE } from '../brain/lib/permission-policy.mjs';
import { auditPermission } from '../brain/lib/permission-audit.mjs';
import { stewardConfig, operatorAlert } from '../brain/lib/steward.mjs';
import { HOME } from '../brain/lib/queue.mjs';

export async function handlePermission(event, binding, { env = process.env, home = HOME, alert = operatorAlert } = {}) {
  let project, config;
  let decision;
  try {
    config = stewardConfig(home);
    project = permissionProject(binding.workspace, env);
    if (project.identity !== binding.identity || project.checkout !== binding.canonical || project.record !== binding.org) throw Error('launch project binding changed');
    decision = permissionDecision(event, { kind: binding.kind, project, runTemp: binding.runTemp });
    if (!config.enabled) decision = { behavior: 'deny', reason: 'Steward disabled', category: 'security', alert: false, message: DENIAL_NUDGE };
  } catch (error) { decision = { behavior: 'deny', reason: 'Unverified launch binding or configuration', category: 'security', alert: false, message: DENIAL_NUDGE }; }
  try {
    const audit = auditPermission(home, { ...binding, project: project?.name ?? 'unresolved' }, event ?? {}, decision, Date.now(), config);
    decision = audit.decision;
    // Deny immediately in the native response. Alert work runs after HTTP reply;
    // a command hook waits at most the channel deadline and never throws away its decision.
    return { output: permissionOutput(decision), notify: audit.notify ? () => alert({ project: project?.name ?? 'unresolved', session: binding.session, kind: decision.reason }, config).catch(error => process.stderr.write(`Steward alert failed: ${error.message}\n`)) : null };
  } catch (error) {
    process.stderr.write(`Steward permission audit refused: ${error.message}\n`);
    return { output: permissionOutput({ behavior: 'deny', message: `Permission audit unavailable. ${DENIAL_NUDGE}` }), notify: null };
  }
}

// Command registration also covers old Claude builds. Current Claude launches
// replace this hook with an authenticated loopback HTTP hook before spawning.
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

export function servePermissionHook(binding, options = {}) {
  const token = randomBytes(32).toString('hex');
  let closed = false;
  const server = http.createServer(async (request, response) => {
    const deny = message => { if (!response.writableEnded) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(permissionOutput({ behavior: 'deny', message }))); } };
    if (request.method !== 'POST' || request.url !== `/${token}`) { response.writeHead(403); response.end(); return; }
    let body = '', overflow = false;
    request.setTimeout(5000, () => { deny(DENIAL_NUDGE); request.destroy(); });
    request.on('data', chunk => { if (Buffer.byteLength(body) + chunk.length > 65536) { overflow = true; } else body += chunk; });
    request.on('end', async () => {
      try {
        let event = {};
        if (!overflow) try { event = JSON.parse(body); } catch { /* Audited malformed denial. */ }
        const result = await handlePermission(event, binding, options);
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result.output));
        result.notify?.();
      } catch { deny(DENIAL_NUDGE); }
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      if (closed) { server.close(); resolve(null); return; }
      resolve({ type: 'http', url: `http://127.0.0.1:${server.address().port}/${token}`, timeout: 15 });
    });
  });
  ready.catch(() => {});
  return { ready, close() { closed = true; server.close(); server.closeAllConnections(); } };
}
