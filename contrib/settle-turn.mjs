// A foreign session may be skipped only with positive Git identity and no
// conflicting local run/callback binding. Names select candidates, not projects.
import fs from 'node:fs';
import path from 'node:path';
import { gitProject } from '../lib/project.mjs';
import { loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';

export function turnBlockers({ agents, cwd, org, getAgent }) {
  const candidates = agents.filter(a => /^(settle-|exec-)/.test(a.name ?? '') && a.agent_status === 'working');
  if (!candidates.length) return [];
  try {
    // Inherited Git selectors must not turn another checkout into this project.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const project = gitProject(cwd, { env }).identity;
    const loaded = loadEvents(org);
    if (loaded.tornTail) return candidates;
    const bound = new Set();
    for (const run of fold(loaded.events).runs.values()) {
      for (const name of [run.meta.agent, run.meta.settled_by]) if (name) bound.add(name);
    }
    const directory = path.join(org, 'retirement/occupants');
    if (fs.existsSync(directory)) for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.json'))) {
      const receipt = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
      if (receipt.schema !== 'retirement-occupant/v1' || !path.isAbsolute(receipt.common ?? '')) return candidates;
      // A retained claim is a reason to wait even if the current cwd disagrees.
      if (fs.realpathSync(receipt.common) === project && receipt.agent) bound.add(receipt.agent);
    }
    return candidates.filter(summary => {
      if (bound.has(summary.name)) return true;
      try {
        const agent = getAgent(summary.name);
        if (agent?.name !== summary.name || !path.isAbsolute(agent.cwd ?? '') ||
            ['pane_id', 'workspace_id', 'terminal_id'].some(key => summary[key] && summary[key] !== agent[key])) return true;
        return gitProject(agent.cwd, { env }).identity === project;
      } catch { return true; }
    });
  } catch { return candidates; } // Missing/malformed record or Git identity: wait.
}
