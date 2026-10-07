#!/usr/bin/env node
// A request to the session-scoped parent, not an arbitrary command executor.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { requestTimeout } from './deadlines.mjs';
import { parseArgs } from 'node:util';
import { joinFleet, fleetView, setFleetExcluded } from '../lib/fleet.mjs';
const [op, ...words] = process.argv.slice(2);
try {
  if (op === 'chat') {
    const { values, positionals } = parseArgs({ args: words, allowPositionals: true, options: {
      workspace: { type: 'string' }, identity: { type: 'string' }, kind: { type: 'string' }, route: { type: 'string' },
      to: { type: 'string' }, arg: { type: 'string', multiple: true }, 'no-focus': { type: 'boolean' },
    } });
    if (positionals.length !== 1 || (values.route && values.kind)) throw new Error('usage: monitor chat PROJECT [--workspace ID] [--kind codex|claude | --route NAME] [--to OPS] [--arg ARG] [--no-focus]');
    const { openProjectChat } = await import('../supervisor/chats.mjs');
    console.log(JSON.stringify(openProjectChat({ project: positionals[0], identity: values.identity, workspace: values.workspace,
      kind: values.kind, route: values.route, to: values.to, args: values.arg, focus: !values['no-focus'] }), null, 2));
    process.exit(0);
  }
  if (op === 'fleet') {
    const [action, ...args] = words;
    if (action === 'join') {
      const { values } = parseArgs({ args, options: { record: { type: 'string' }, worktrees: { type: 'string' }, temp: { type: 'string' }, layer: { type: 'string', multiple: true }, 'session-limit': { type: 'string' }, replace: { type: 'string' } } });
      console.log(JSON.stringify(joinFleet({ record: values.record, worktrees: values.worktrees, temp: values.temp, layers: values.layer,
        sessionLimit: values['session-limit'] === undefined ? undefined : Number(values['session-limit']), replace: values.replace }), null, 2));
    } else if (action === 'show' && !args.length) console.log(JSON.stringify(fleetView(), null, 2));
    else if (['exclude', 'include'].includes(action) && args.length === 1)
      console.log(JSON.stringify(setFleetExcluded({ root: args[0], excluded: action === 'exclude' }), null, 2));
    else throw new Error('usage: monitor fleet join [--replace NAME] [--record PATH] [--worktrees PATH] [--temp PATH] [--layer PATH] [--session-limit N] | monitor fleet show | monitor fleet <exclude|include> PATH');
    process.exit(0);
  }
  if (!op || ['--help', '-h', 'help'].includes(op)) {
    console.log('monitor <context|start TASK|resume ITEM|commit SUBJECT|check|promote|rebase|continue|abort|apply-routes|finish>');
    console.log('monitor fleet join [--replace NAME] [--session-limit N] | monitor fleet show | monitor fleet <exclude|include> PATH (available without entry)');
    console.log('monitor chat PROJECT [--workspace ID] [--kind codex|claude | --route NAME] [--to OPS] [--no-focus] (operator project chat; available without entry)');
    console.log('continue: stage the files you resolved through the bounded Git adapter and continue your paused rebase. No direct git add is required.');
    console.log('finish: ingest the exact run report; done requires successful promotion. A second different report is refused by record.');
    process.exit(0);
  }
  const root = process.env.MONITOR_REQUEST_DIR;
  if (!root) throw new Error('enter through the installed Monitor adapter first');
  const id = randomUUID();
  const request = path.join(root, `${id}.request.json`), reply = path.join(root, `${id}.reply.json`);
  fs.writeFileSync(`${request}.tmp`, JSON.stringify({ op, ...(words.length ? { text: words.join(' ') } : {}) }), { mode: 0o600 });
  fs.renameSync(`${request}.tmp`, request);
  const deadline = Date.now() + requestTimeout(op);
  while (!fs.existsSync(reply)) {
    if (Date.now() >= deadline) throw new Error('session adapter timed out; inspect before retrying a mutation');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const response = JSON.parse(fs.readFileSync(reply, 'utf8'));
  fs.rmSync(request); fs.rmSync(reply);
  if (response.error) throw new Error(response.error);
  console.log(typeof response.result === 'string' ? response.result : JSON.stringify(response.result, null, 2));
} catch (e) { console.error(`monitor: ${e.message}`); process.exitCode = 1; }
