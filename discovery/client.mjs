#!/usr/bin/env node
// Machine fleet mapping and operator-created project chats.
import { parseArgs } from 'node:util';
import { joinFleet, fleetView } from '../lib/fleet.mjs';
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
      console.log(JSON.stringify(joinFleet({ record: values.record, worktrees: values.worktrees, layers: values.layer,
        sessionLimit: values['session-limit'] === undefined ? undefined : Number(values['session-limit']), replace: values.replace }), null, 2));
    } else if (action === 'show' && !args.length) console.log(JSON.stringify(fleetView(), null, 2));
    else throw new Error('usage: monitor fleet join [--record PATH] [--worktrees PATH] [--layer PATH] [--session-limit N] [--replace NAME] | monitor fleet show');
    process.exit(0);
  }
  if (!op || ['--help', '-h', 'help'].includes(op)) {
    console.log('Usage: monitor fleet join|show | monitor chat PROJECT [--kind codex|claude | --route NAME] [--to OPS] [--no-focus]');
    process.exit(0);
  }
  throw new Error('usage: monitor fleet join|show | monitor chat PROJECT');
} catch (e) { console.error(`monitor: ${e.message}`); process.exitCode = 1; }
