#!/usr/bin/env node
// Native lifecycle transport for absolute executable, desktop and restored entry.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../lib/cli-help.mjs';
import { joinFleet } from '../lib/fleet.mjs';
import { gitProject } from '../lib/project.mjs';
import { sanitizeTerminal } from '../lib/sanitize.mjs';
import { supervisorBinding } from '../supervisor/session-binding.mjs';
import { enterSupervisor } from '../supervisor/entry.mjs';
import { quote } from '../lib/shell.mjs';
import { projectEntrySettings } from '../discovery/settings.mjs';

try {
  const { values } = parseArgs({ options: { bin: { type: 'string' }, fleet: { type: 'string' } } });
  const env = process.env;
  if (values.fleet) env.HERDR_MONITOR_FLEET = values.fleet;
  // Adapters already inject policy and their supervisor recovery hook.
  if (env.MONITOR_ENTRY_BYPASS !== '1' && !env.MONITOR_SESSION_ROLE && !env.MONITOR_REQUEST_DIR) {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (input.hook_event_name !== 'SessionStart' || !['startup', 'resume', 'clear', 'compact'].includes(input.source)) throw new Error('unrecognized SessionStart input');
    let project;
    try { project = gitProject(input.cwd); } catch { /* Outside a repository: leave the native session alone. */ }
    if (project && projectEntrySettings(project).enabled) {
      const fleet = joinFleet({ cwd: input.cwd });
      const binding = supervisorBinding(project, env.HERDR_PANE_ID);
      if (binding) enterSupervisor({ cwd: project.canonical, org: binding.org, role: 'supervisor', to: binding.to || 'supervisor-herdr' });
      else {
        const bin = values.bin ?? env.HERDR_MONITOR_ENTRY_BIN ?? path.join(env.HERDR_MONITOR_HOME ?? path.join(env.HOME, '.local/share/herdr-monitor'), 'entry/bin');
        const adapters = ['codex','claude'].map(kind => path.join(bin, `monitor-${kind}`)).filter(file => fs.existsSync(file)).map(quote).join(' or ');
        console.log(sanitizeTerminal(`Herdr Monitor: project ${fleet.name} joined ${fleet.file}; record ${fleet.project.record}; session limit ${fleet.session_limit} (advisory).
Read this project's AGENTS.md and CLAUDE.md. This native hook does not allocate a worker checkout or grant a supervisor role. Before making changes, enter through ${adapters} --repo ${quote(project.canonical)}. Those adapters supply the bounded worker workflow and promotion checks. Use the project supervisor to coordinate work; only its canonical supervisor entry starts default housekeeping.\n`));
      }
    }
  }
} catch (error) { console.log(sanitizeTerminal(`Monitor native entry: ${error.message}; inspect or use the installed entry adapter.\n`)); }
// Hook failures never block the native session or change its permission settings.
