#!/usr/bin/env node
// External launchers call this immediately after launch, before arming watch.
// Read the launched occupant directly; never consult the session registry.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/cli-help.mjs';

const { values: opt, positionals } = parseArgs({
  usage: 'Usage: node dispatch/record-worker.mjs R-n --agent NAME --pane ID --cwd DIR [--org DIR] [--worker-workspace ID] [--terminal-id ID] [--agent-session-id ID]',
  allowPositionals: true, options: Object.fromEntries(
    ['agent', 'pane', 'cwd', 'org', 'worker-workspace', 'terminal-id', 'agent-session-id'].map(key => [key, { type: 'string' }])),
});
try {
  if (positionals.length !== 1 || !/^R-\d+$/.test(positionals[0])) throw new Error('one run ID is required');
  for (const key of ['agent', 'pane', 'cwd']) if (!opt[key]?.trim()) throw new Error(`--${key} is required from the launch`);
  const env = { ...process.env, ...(opt.org ? { ORG_DIR: opt.org } : {}) };
  function command(exe, args) {
    const r = spawnSync(exe, args, { env, cwd: opt.cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw new Error((r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim());
    return r.stdout;
  }
  const response = JSON.parse(command('herdr', ['agent', 'get', opt.agent]));
  const agent = (response.result ?? response).agent;
  if (!agent || agent.name !== opt.agent || agent.pane_id !== opt.pane || !agent.workspace_id ||
      !agent.cwd || fs.realpathSync(agent.cwd) !== fs.realpathSync(opt.cwd)) throw new Error('launched worker name/pane/workspace/cwd mismatch');
  const ids = { 'worker-workspace': agent.workspace_id, 'terminal-id': agent.terminal_id, 'agent-session-id': agent.agent_session?.value };
  for (const [key, value] of Object.entries(ids)) {
    if (opt[key] !== undefined && opt[key] !== value) throw new Error(`launched worker ${key} mismatch`);
  }
  if (!ids['terminal-id'] && !ids['agent-session-id']) throw new Error('launched worker has no occupant identity');
  const args = ['worker', positionals[0], '--agent', opt.agent, '--pane', opt.pane, '--cwd', opt.cwd];
  for (const [key, value] of Object.entries(ids)) if (value) args.push(`--${key}`, value);
  process.stdout.write(command(process.execPath, [fileURLToPath(new URL('../bin/org.mjs', import.meta.url)), ...args]));
} catch (error) {
  process.stderr.write(`record-worker: ${error.message}\n`);
  process.exitCode = 1;
}
