// Open the installed project controls in an existing workspace, without focus.
// No scheduling here: only the canonical supervisor's entry starts housekeeping.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sanitizeTerminal } from '../lib/sanitize.mjs';
import { gitProject } from '../lib/project.mjs';
import { writeFileAtomic } from '../lib/files.mjs';
import { withInstallationLock } from './entry-lock.mjs';

export function openProjectControls({ project, env = process.env, command = spawnSync, output = text => process.stderr.write(text) } = {}) {
  if (!env.HERDR_WORKSPACE_ID || env.MONITOR_ENTRY_BYPASS === '1' || env.MONITOR_SESSION_ROLE === 'supervisor') return;
  try {
    const call = args => {
      const result = command(env.HERDR_BIN_PATH || 'herdr', args, { cwd: project.canonical, env, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
      if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `exit ${result.status}`);
      return result.stdout;
    };
    const workspace = JSON.parse(call(['workspace', 'get', env.HERDR_WORKSPACE_ID])).result.workspace;
    if (gitProject(workspace.cwd).identity !== project.identity) throw new Error('Herdr workspace belongs to another project');
    const key = createHash('sha256').update(`${env.HERDR_SOCKET_PATH || env.HERDR_SESSION || 'default'}\0${env.HERDR_WORKSPACE_ID}`).digest('hex');
    const file = path.join(project.identity, 'monitor-controls', `${key}.json`);
    withInstallationLock(`${file}.lock`, () => {
      const panes = JSON.parse(call(['pane', 'list', '--workspace', env.HERDR_WORKSPACE_ID])).result.panes;
      if (!Array.isArray(panes)) throw new Error('Herdr returned no pane list');
      const receipt = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      for (const entrypoint of ['console', 'supervisor']) {
        if (panes.some(p => p.pane_id === receipt[entrypoint]?.pane_id && p.terminal_id === receipt[entrypoint]?.terminal_id)) continue;
        const opened = JSON.parse(call(['plugin', 'pane', 'open', '--plugin', 'rewt.herdr-monitor', '--entrypoint', entrypoint, '--workspace', env.HERDR_WORKSPACE_ID, '--no-focus'])).result.plugin_pane;
        if (opened?.plugin_id !== 'rewt.herdr-monitor' || opened.entrypoint !== entrypoint || !opened.pane?.pane_id || !opened.pane?.terminal_id) throw new Error('invalid plugin pane receipt');
        receipt[entrypoint] = { pane_id: opened.pane.pane_id, terminal_id: opened.pane.terminal_id };
        writeFileAtomic(file, JSON.stringify(receipt, null, 2) + '\n', 0o600);
      }
    });
  } catch (error) { output(sanitizeTerminal(`Monitor project controls: ${error.message}; use the plugin's console and supervisor actions.\n`)); }
}
