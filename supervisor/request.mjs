#!/usr/bin/env node
// Foreground request transport. The receiving identity owns its record and work.
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { randomUUID } from 'node:crypto';
import { bestEffort, mirrorDesk } from '../messages/mirror.mjs';
import fs from 'node:fs';
import { configHome, present, validateIdentity, markerRoot } from '../lib/config-home.mjs';
import { readPolicyFile } from '../lib/config-policy.mjs';
import { literalLaunch } from '../lib/owner-launch.mjs';

export async function request(argv = process.argv.slice(2), {
  env = process.env, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), execute = spawnSync,
  mirror = mirrorDesk, shadow,
} = {}) {
  const { positionals } = parseArgs({ usage: 'Usage: node supervisor/request.mjs <identity> <text>', args: argv, allowPositionals: true });
  const [identity, text] = positionals;
  if (positionals.length !== 2 || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(identity ?? '') || !text?.trim() || text.includes('\0'))
    throw Error('usage: request.mjs <identity> <text>; identity must be a single directory name');
  const name = `desk-${identity}`, identityFile = path.join(configHome(env), identity, 'identity.json');
  let cwd = path.join(env.HOME || os.homedir(), 'development', identity), launch;
  if (present(identityFile)) {
    const defaults = readPolicyFile(identityFile, 'identity', { env });
    validateIdentity(defaults, identityFile, identity);
    cwd = defaults.identity_root; launch = defaults.launch;
    const marked = markerRoot(cwd);
    if (marked ? marked !== cwd || path.basename(marked) !== identity : identity !== os.userInfo().username || fs.realpathSync(cwd) !== fs.realpathSync(env.HOME || os.homedir())) throw Error('desk identity root differs from verified owning identity');
  }
  const startupMs = 30000;
  const call = (args, timeout = 10000) => {
    const input = literalLaunch(env.HERDR_BIN_PATH || 'herdr', args, args[0] === 'agent' && args[1] === 'start' ? launch : undefined);
    const r = execute(input.command, input.args, {
      cwd, env, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024,
    });
    if (r.error || r.status !== 0) throw Error(`herdr ${args.slice(0, 2).join(' ')}: ${r.stderr || r.error?.message || r.stdout}; inspect the retained desk before retrying`);
    const reply = JSON.parse(r.stdout);
    if (reply.error || reply.ok === false || !reply.result) throw Error(`Herdr refused ${args.slice(0, 2).join(' ')}: ${JSON.stringify(reply.error ?? reply)}`);
    return reply.result;
  };
  const agents = call(['agent', 'list']).agents;
  if (!Array.isArray(agents)) throw Error('invalid Herdr agent inventory');
  const matching = agents.filter(agent => agent.name === name);
  if (matching.length > 1) throw Error(`multiple ${name} agents; inspect before delivery`);
  let agent = matching[0], workspace = agent?.workspace_id;
  if (!agent) {
    const created = call(['workspace', 'create', '--label', identity, '--cwd', cwd, '--no-focus']);
    workspace = created.workspace?.workspace_id;
    if (!workspace) throw Error('workspace creation returned no workspace id; inspect before retrying');
    const panes = call(['pane', 'list', '--workspace', workspace]).panes;
    if (!Array.isArray(panes) || panes.length !== 1 || !panes[0].pane_id) throw Error(`workspace ${workspace} has no unique initial pane; inspect before retrying`);
    const args = ['agent', 'start', name, '--kind', 'codex', '--pane', panes[0].pane_id, '--timeout', String(startupMs)];
    call(args, startupMs + 10000);
  }
  const deadline = now() + startupMs;
  while (now() < deadline) {
    agent = call(['agent', 'get', name], Math.max(1, Math.min(10000, deadline - now()))).agent;
    if (!agent || agent.name !== name) throw Error(`${name} is not a live desk; inspect before delivery`);
    if (['idle', 'done', 'working'].includes(agent.agent_status)) break;
    if (agent.agent_status === 'blocked') throw Error(`${name} is blocked; ask the operator to resolve it`);
    await sleep(100);
  }
  if (!['idle', 'done', 'working'].includes(agent?.agent_status)) throw Error(`${name} did not become ready; desk retained, request not sent`);
  call(['agent', 'prompt', name, text]);
  bestEffort(() => mirror({ id: randomUUID(), at: new Date().toISOString(), message: text, to: name,
    target: { identity, cwd } }, { env, ...shadow }), shadow);
  return { identity, desk: name, workspace: workspace ?? agent.workspace_id, pane: agent.pane_id, ...(launch ? { launch } : {}) };
}
if (isMain(import.meta.url)) {
  try {
    const sent = await request();
    console.log(`sent to ${sent.desk} (workspace ${sent.workspace ?? 'unknown'}, pane ${sent.pane ?? 'unknown'})`);
  } catch (error) { console.error(`request: ${error.message}`); process.exitCode = 1; }
}
