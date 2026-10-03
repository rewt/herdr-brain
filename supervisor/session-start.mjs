#!/usr/bin/env node
// Native command-hook adapter. Only an explicit, canonically bound supervisor
// launcher opts in; worker adapters overwrite this role even if inherited.
import fs from 'node:fs';
import { sanitizeTerminal } from '../lib/sanitize.mjs';
try {
  const env = process.env;
  if (env.MONITOR_SESSION_ROLE === 'supervisor' && env.MONITOR_ENTRY_BYPASS !== '1') {
    const { gitProject } = await import('../lib/project.mjs');
    const { enterSupervisor } = await import('./entry.mjs');
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (input.hook_event_name !== 'SessionStart' || !['startup', 'resume', 'clear', 'compact'].includes(input.source)) throw new Error('unrecognized SessionStart input');
    const project = gitProject(input.cwd);
    if (project.checkout !== project.canonical || project.identity !== env.MONITOR_SUPERVISOR_IDENTITY ||
        project.canonical !== env.MONITOR_SUPERVISOR_REPO) throw new Error('session is not bound to the canonical supervisor checkout; skipped');
    if (!env.MONITOR_SUPERVISOR_ORG) throw new Error('supervisor record binding is missing');
    enterSupervisor({ cwd: project.canonical, org: env.MONITOR_SUPERVISOR_ORG, role: 'supervisor', to: env.MONITOR_SUPERVISOR_AGENT });
  }
} catch (e) { process.stdout.write(sanitizeTerminal(`Supervisor entry: ${e.message}; session may continue.\n`)); }
// Never return a blocking hook output or a nonzero exit status.
