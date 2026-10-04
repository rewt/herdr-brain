// Plugin panes start in the plugin directory. Use the selected workspace only
// to locate Git; canonical Git identity still controls all project operations.
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { gitProject } from '../lib/project.mjs';

try {
  let cwd = process.cwd();
  if (process.env.HERDR_PLUGIN_ROOT || process.env.HERDR_PLUGIN_CONTEXT_JSON) {
    const context = process.env.HERDR_PLUGIN_CONTEXT_JSON ? JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON) : {};
    const workspaceId = context.workspace_id ?? process.env.HERDR_WORKSPACE_ID;
    if (typeof workspaceId !== 'string' || !workspaceId) throw new Error('plugin supervisor requires a selected workspace');
    if (process.env.HERDR_WORKSPACE_ID && process.env.HERDR_WORKSPACE_ID !== workspaceId) throw new Error('plugin workspace context disagrees with its pane');
    cwd = context.workspace_cwd ?? context.focused_pane_cwd;
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('selected workspace has no project directory');
  }
  const project = gitProject(cwd).canonical;
  const bin = process.env.HERDR_MONITOR_ENTRY_BIN ?? path.join(process.env.HERDR_MONITOR_HOME ?? path.join(process.env.HOME, '.local/share/herdr-monitor'), 'entry/bin');
  const requested = process.env.HERDR_MONITOR_SUPERVISOR_HARNESS;
  if (requested && !['codex', 'claude'].includes(requested)) throw new Error('HERDR_MONITOR_SUPERVISOR_HARNESS must be codex or claude');
  const harness = requested || (fs.existsSync(path.join(bin, 'monitor-codex')) ? 'codex' : 'claude');
  if (!fs.existsSync(path.join(bin, `monitor-${harness}`))) throw new Error(`install native ${harness} and reinstall Monitor to open this supervisor`);
  const child = spawn(path.join(bin, `monitor-${harness}`), ['--repo', project, '--role', 'supervisor', '--', ...process.argv.slice(2)], { cwd: project, env: process.env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => { console.error(`supervisor: ${error.message}`); process.exitCode = 1; });
  child.on('close', (code, signal) => { process.exitCode = signal ? 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal] ?? 1) : code ?? 1; });
} catch (error) { console.error(`supervisor: ${error.message}`); process.exitCode = 1; }
