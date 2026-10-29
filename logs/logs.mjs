#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { gitProject } from '../lib/project.mjs';
import { identityAt } from '../messages/identity.mjs';
import { LogJournal } from './journal.mjs';
import { shadowInput, recordInput, replay } from './inputs.mjs';
import { measure, selectEntries, render, coalesce } from './view.mjs';
import { directShadow } from './rules.mjs';

export async function main(args = process.argv.slice(2)) {
  const { values: o, positionals } = parseArgs({ args, allowPositionals: true,
    usage: 'Usage: node logs/logs.mjs view|replay|repair|retain|coalesce [--root DIR] [--identity NAME] [--common-dir DIR] [--from-shadow --shadow-root DIR] [--from-record --org DIR] [--since UTC] [--workspace UID] [--session UID] [--json]',
    options: Object.fromEntries([...['root', 'identity', 'common-dir', 'shadow-root', 'org', 'since', 'workspace', 'session'].map(k => [k, { type: 'string' }]), ...['from-shadow', 'from-record', 'json'].map(k => [k, { type: 'boolean' }])]) });
  const [command] = positionals;
  if (positionals.length !== 1 || !['view', 'replay', 'repair', 'retain', 'coalesce'].includes(command)) throw Error('expected view, replay, repair, retain or coalesce');
  if (command !== 'view' && !o.root) throw Error(`${command} requires an explicit --root; foreground writes stay there`);
  if (command === 'replay' && !o['from-shadow'] && !o['from-record']) throw Error('replay requires --from-shadow and/or --from-record');
  if (o['from-record'] && !o.org) throw Error('--from-record requires an explicit --org');
  if (command !== 'replay' && (o['from-shadow'] || o['from-record'])) throw Error('input flags require replay');
  if (command === 'replay' && o.org && (path.resolve(o.root) === path.resolve(o.org) || path.resolve(o.root).startsWith(path.resolve(o.org) + path.sep))) throw Error('replay root must be separate from the record');
  const commonDir = await fs.realpath(o['common-dir'] ?? gitProject().identity), identity = o.identity ?? await identityAt(commonDir);
  const journal = new LogJournal({ identity, commonDir, root: o.root });
  if (command === 'replay') {
    const inputs = [];
    if (o['from-shadow']) inputs.push(await shadowInput({ identity, commonDir, root: o['shadow-root'] }));
    if (o['from-record']) inputs.push(await recordInput({ identity, commonDir, org: o.org }));
    await replay(journal, inputs);
  } else if (command === 'repair') await journal.repair();
  else if (command === 'retain') await journal.retain();
  else if (command === 'coalesce') await coalesce(journal);
  const state = await journal.read();
  if (command === 'view' && !o.json) process.stdout.write(render(selectEntries(state.entries, o)));
  else {
    const result = command === 'view' ? selectEntries(state.entries, o) : measure(state);
    process.stdout.write(JSON.stringify(result, null, o.json ? 0 : 2) + '\n');
    // Shadow only: never enqueue, prompt, send or write shadow.jsonl.
    if (command === 'replay' && !o.json) for (const line of directShadow(state.entries)) process.stdout.write(line + '\n');
    return result;
  }
}
if (isMain(import.meta.url)) main().catch(error => { console.error(`logs: ${error.message}`); process.exitCode = 1; });
