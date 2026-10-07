#!/usr/bin/env node
// Native command-hook adapter. Explicit launch receipts survive Herdr restore;
// worker role/bypass guards take precedence over any receipt.
import fs from 'node:fs';
import { sanitizeTerminal } from '../lib/sanitize.mjs';
import { supervisorBinding, rememberSupervisor } from './session-binding.mjs';
import { cliHelp } from '../lib/cli-help.mjs';
cliHelp(import.meta.url, "Usage: node supervisor/session-start.mjs < SESSION_START_JSON\nRead a native SessionStart hook from stdin.");
try {
  const env = process.env;
  if (env.MONITOR_ENTRY_BYPASS !== '1' && (!env.MONITOR_SESSION_ROLE || env.MONITOR_SESSION_ROLE === 'supervisor')) {
    const { gitProject } = await import('../lib/project.mjs');
    const { enterSupervisor } = await import('./entry.mjs');
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (input.hook_event_name !== 'SessionStart' || !['startup', 'resume', 'clear', 'compact'].includes(input.source)) throw new Error('unrecognized SessionStart input');
    const project = gitProject(input.cwd);
    let binding = supervisorBinding(project, env.HERDR_PANE_ID);
    if (!binding && env.MONITOR_SESSION_ROLE === 'supervisor') {
      if (project.checkout !== project.canonical || project.identity !== env.MONITOR_SUPERVISOR_IDENTITY ||
          project.canonical !== env.MONITOR_SUPERVISOR_REPO) throw new Error('session is not bound to the canonical supervisor checkout; skipped');
      if (!env.MONITOR_SUPERVISOR_ORG) throw new Error('supervisor record binding is missing');
      binding = { ...project, role: 'supervisor', org: env.MONITOR_SUPERVISOR_ORG, to: env.MONITOR_SUPERVISOR_AGENT };
      rememberSupervisor(binding, env);
    }
    if (binding) enterSupervisor({ cwd: project.canonical, org: binding.org, role: 'supervisor',
      to: binding.to?.trim() || env.MONITOR_SUPERVISOR_AGENT?.trim() || 'supervisor-herdr' });
  }
} catch (e) { process.stdout.write(sanitizeTerminal(`Supervisor entry: ${e.message}; session may continue.\n`)); }
// Never return a blocking hook output or a nonzero exit status.
